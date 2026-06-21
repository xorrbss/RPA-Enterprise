/**
 * POST /v1/runs/{run_id}/abort 핸들러(abortRun) + 상태별 abort 적용(applyAbort, CAS 경합 재조회) + 멱등 선검사·
 * abort 가능성 가드·claimed browser-lease 만료 보조. 어휘 체인 abort→aborting→cancelled→run.cancelled(api-surface §1).
 */
import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { ERROR_CATALOG } from "../../../ts/error-catalog";
import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import type { RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "../runtime/outbox";
import { applyRunTransition } from "../runtime/run-transition";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import type { RunEnqueuer } from "./run-queue";
import {
  apiErrorBody,
  isRecord,
  requirePrincipal,
  UUID_RE,
  IDEMPOTENCY_TTL_MS,
  type ApiServerDeps,
  type CommandResponse,
} from "./server-shared";

/** state-machine §1: Run 종결 상태 — abort 거부(RUN_ALREADY_TERMINAL). */
const RUN_TERMINAL_SET: ReadonlySet<RunState> = new Set<RunState>([
  "completed",
  "cancelled",
  "failed_business",
  "failed_system",
]);

/**
 * Run abort 명령(멱등). 흐름: 형식/키 선검사 → 멱등 예약 이전 상태 선검사(부재/종결/completing/suspending은
 * 부작용 없는 거부라 키 미소모) → 예약 → 작업 tx에서 상태별 적용(dispatcher 취소 또는 abort_requested 전이,
 * CAS 경합은 재조회). 결정론적 비-retryable 실패만 saveFailure로 영속(동일 키 재요청이 같은 응답 재생).
 */
export async function abortRun(deps: ApiServerDeps, runId: string, request: FastifyRequest): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  // 형식 무효 id는 존재할 수 없다 → 404(존재 비노출, FK/cast 500 회피).
  if (!UUID_RE.test(runId)) {
    throw new ApiResponseError("RUN_NOT_FOUND");
  }

  // body: optional reason만 허용(닫힌 shape). reason은 v1 비영속(runs에 컬럼 없음) — 수신만 허용.
  if (request.body !== undefined && request.body !== null) {
    if (!isRecord(request.body) || Object.keys(request.body).some((k) => k !== "reason")) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_abort_request" });
    }
    if (request.body.reason !== undefined && typeof request.body.reason !== "string") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_abort_reason" });
    }
  }

  // Idempotency-Key 필수(api-surface §0.4). 누락 → 422(예약 이전, 키 소모 없음).
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  // 예약 이전 선검사: 부작용 없는 거부 경로(부재/종결/completing/suspending)는 멱등 키를 소모하지 않는다.
  // suspending은 bookmark-cancel port/durable abort intent가 없으므로 retry-after-suspended로 fail-closed한다.
  const requestHash = canonicalRequestHash("POST", `/v1/runs/${runId}/abort`, request.body ?? null);
  const existingIdempotency = await readAbortIdempotencyExisting(
    deps.pool,
    principal.tenantId,
    idempotencyKey,
    requestHash,
  );
  if (existingIdempotency.kind === "replay") {
    return existingIdempotency.response;
  }
  if (existingIdempotency.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  if (existingIdempotency.kind === "none") {
    const preStatus = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const r = await c.query<{ status: RunState }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
      return r.rows[0]?.status ?? null;
    });
    rejectIfNotAbortable(preStatus);
  }

  // (부작용 명령) → 멱등 예약(release-decisions #7).
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "abortRun",
    key: idempotencyKey as IdempotencyKey,
    requestHash: requestHash as CanonicalRequestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  if (reservation.kind === "replay") {
    return { status: reservation.response.status, body: reservation.response.body };
  }
  if (reservation.kind === "in_flight") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "idempotency_in_flight" });
  }
  if (reservation.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  const recordId = reservation.recordId;
  try {
    return await withTenantTx(deps.pool, principal.tenantId, (c) =>
      applyAbort(c, deps.enqueuer, principal.tenantId, runId, request.correlationId, recordId),
    );
  } catch (err) {
    // 결정론적(비-retryable) 실패만 'failed'로 저장 → 동일 키 재요청이 같은 응답을 재생.
    // retryable(경합/transient)은 저장하지 않고 재던진다(예약 'processing' 유지, TTL 회수).
    if (err instanceof ApiResponseError && !ERROR_CATALOG[err.code].retryable) {
      await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
    }
    throw err;
  }
}

/** abort 불가 상태를 명시적으로 거부한다(조용한 false 금지). 적용 가능 상태면 반환 없이 통과. */
type ExistingAbortIdempotency =
  | { kind: "none" }
  | { kind: "processing" }
  | { kind: "blocked" }
  | { kind: "replay"; response: CommandResponse };

async function readAbortIdempotencyExisting(
  pool: Pool,
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ExistingAbortIdempotency> {
  return withTenantTx(pool, tenantId, async (client) => {
    const existing = await client.query<{
      request_hash: string;
      status: "processing" | "succeeded" | "failed";
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, status, response_status, response_body
         FROM control_plane_idempotency_keys
        WHERE tenant_id=$1::uuid
          AND endpoint='abortRun'
          AND idempotency_key=$2`,
      [tenantId, idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) return { kind: "none" };
    if (row.request_hash !== requestHash) return { kind: "blocked" };
    if (row.status === "processing") return { kind: "processing" };
    if (row.response_status === null || row.response_body === null) {
      throw new Error(`abortRun idempotency record is ${row.status} without stored response`);
    }
    return { kind: "replay", response: { status: row.response_status, body: row.response_body } };
  });
}

function rejectIfNotAbortable(status: RunState | null): void {
  if (status === null) {
    // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
    throw new ApiResponseError("RUN_NOT_FOUND");
  }
  if (RUN_TERMINAL_SET.has(status) || status === "completing") {
    // 종결 + completing(R25: finalize 우선, abort 거부) → RUN_ALREADY_TERMINAL.
    throw new ApiResponseError("RUN_ALREADY_TERMINAL", { status });
  }
  if (status === "suspending") {
    // R26: bookmark 취소 가능 여부(runtime guard)는 제어평면이 알 수 없다(가정 금지). suspending은 bookmark
    //   저장 중 전이 상태로 곧 suspended 도달 → 거기서 R16이 무조건 abort 가능. retryable 충돌로 재시도 유도
    //   (release-decisions #7의 in-flight와 동일한 retryable 409 코드 재사용).
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "run_bookmark_in_progress", status });
  }
}

/**
 * 작업 tx 내 abort 적용. 예약 이전 선검사 이후 상태가 바뀌었을 수 있어 재조회 후 CAS로 경합을 해소한다.
 *  - aborting: 이미 진행 중 → 202(idempotent).
 *  - queued/claimed: run.started 이전 → dispatcher CAS 취소 + 동일 tx run.cancelled.
 *  - running/suspended/resume_requested/resuming: abort_requested → aborting(D2 전이; run.cancelled는 worker).
 */
function isAbortSourceStatus(status: RunState | null): status is "running" | "suspended" | "resume_requested" | "resuming" {
  return status === "running" || status === "suspended" || status === "resume_requested" || status === "resuming";
}

async function applyAbort(
  client: PoolClient,
  enqueuer: RunEnqueuer,
  tenantId: string,
  runId: string,
  requestCorrelationId: string,
  recordId: string,
): Promise<CommandResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cur = await client.query<{
      status: RunState;
      correlation_id: string | null;
      worker_id: string | null;
      abort_source_status: RunState | null;
    }>(
      `SELECT status, correlation_id::text AS correlation_id, worker_id::text AS worker_id, abort_source_status
         FROM runs
        WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [runId, tenantId],
    );
    const row = cur.rows[0] ?? null;
    rejectIfNotAbortable(row?.status ?? null);
    if (row === null) {
      throw new ApiResponseError("RUN_NOT_FOUND");
    }
    const status = row.status;
    // run.cancelled는 run 생명주기 이벤트 → runs.correlation_id 사용(R23/R24 worker 경로와 일치).
    const correlationId = row?.correlation_id ?? requestCorrelationId;

    if (status === "aborting") {
      if (!isAbortSourceStatus(row.abort_source_status)) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "run_abort_missing_source_status" });
      }
      await enqueuer.enqueueRunAbort(client, { tenantId, runId, correlationId });
      const response: CommandResponse = { status: 202, body: { run_id: runId, status: "aborting" } };
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    }

    if (status === "queued" || status === "claimed") {
      // (id,status) CAS로 큐/claim 회수(state-machine §1 "abort 보편성"). 0 rows면 경합 → 재조회.
      const cancelled = await client.query(
        `UPDATE runs SET status='cancelled', updated_at=now(), ended_at=now()
          WHERE id=$1::uuid AND tenant_id=$2::uuid AND status=$3
        RETURNING id`,
        [runId, tenantId, status],
      );
      if (cancelled.rowCount === 0) continue;
      if (status === "claimed") {
        await expireClaimedAbortBrowserLease(client, tenantId, runId, row.worker_id);
      }
      await emitOutboxEvent(client, {
        tenantId,
        eventType: "run.cancelled",
        correlationId,
        runId,
        idempotencyKey: `${runId}:run.cancelled`,
        retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
      });
      const response: CommandResponse = { status: 202, body: { run_id: runId, status: "cancelled" } };
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    }

    // running/suspended/resume_requested/resuming → abort_requested → aborting.
    const outcome = await applyRunTransition(client, {
      tenantId,
      runId,
      fromStatus: status,
      event: { type: "abort_requested" },
      guard: {},
      correlationId,
    });
    if (!outcome.applied) continue; // cas_conflict → 재조회
    if (!isAbortDrainPending(status, outcome.pending)) {
      throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
        reason: "run_abort_pending_side_effects_unsupported",
        pending: pendingSideEffectKinds(outcome.pending),
      });
    }
    const sourceRecorded = await client.query(
      `UPDATE runs
          SET abort_source_status = $3
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'aborting'`,
      [tenantId, runId, status],
    );
    if (sourceRecorded.rowCount !== 1) {
      throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "run_abort_source_record_failed" });
    }
    await enqueuer.enqueueRunAbort(client, { tenantId, runId, correlationId });
    const response: CommandResponse = { status: 202, body: { run_id: runId, status: outcome.next } };
    await completeIdempotencyInTx(client, recordId, response);
    return response;
  }
  // CAS 경합 3회 — 조용한 false 금지: 재시도 가능 충돌로 표면화.
  throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "run_abort_cas_contention" });
}

async function expireClaimedAbortBrowserLease(
  client: PoolClient,
  tenantId: string,
  runId: string,
  workerId: string | null,
): Promise<void> {
  if (workerId === null) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "claimed_abort_missing_worker_id" });
  }

  const expired = await client.query<{ id: string }>(
    `UPDATE browser_leases
        SET state = 'expired',
            expires_at = LEAST(expires_at, now())
      WHERE tenant_id = $1::uuid
        AND run_id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')
      RETURNING id::text`,
    [tenantId, runId, workerId],
  );
  if (expired.rowCount !== 1) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
      reason: expired.rowCount === 0 ? "claimed_abort_missing_active_browser_lease" : "claimed_abort_multiple_active_browser_leases",
    });
  }
}

function pendingSideEffectKinds(pending: readonly { readonly kind: string }[]): string[] {
  return pending.map((cmd) => cmd.kind);
}

function isAbortDrainPending(sourceStatus: RunState, pending: readonly { readonly kind: string }[]): boolean {
  if (sourceStatus === "running" || sourceStatus === "resuming") {
    return (
      pending.length === 2 &&
      pending.some((cmd) => cmd.kind === "sseClose") &&
      pending.some((cmd) => cmd.kind === "browserDrain")
    );
  }
  if (sourceStatus === "suspended" || sourceStatus === "resume_requested") {
    return pending.length === 0;
  }
  return false;
}
