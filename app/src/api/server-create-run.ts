/**
 * POST /v1/runs 핸들러(createRun) + 공유 run 생성 tx(createRunInTx) + 생성 실패 분류·엄격 ISO-8601 검증 헬퍼.
 * server.ts(buildServer)와 내부 명령(approval.decide)이 createRunInTx 를 공유한다(api-surface §1).
 */
import { randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { ERROR_CATALOG } from "../../../ts/error-catalog";
import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "../runtime/outbox";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import type { RunEnqueuer, RunPriority } from "./run-queue";
import {
  apiErrorBody,
  isRecord,
  requirePrincipal,
  UUID_RE,
  IDEMPOTENCY_TTL_MS,
  type ApiServerDeps,
  type CommandResponse,
} from "./server-shared";

// 엄격 ISO-8601(date-time). Date.parse는 느슨하고 calendar-invalid 값을 보정하므로 직접 검증한다(api-surface §0.6).
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * run 생성(멱등 명령). 흐름: 키/본문 선검사(422) → 멱등 예약(replay/in-flight 409/hash mismatch 412) →
 * reserved면 작업(scenario_version 존재 확인 → runs(queued) + run.created outbox + run_claim enqueue, 동일 tx)
 * → saveResult. 작업 실패는 saveFailure로 표시(동일 키 재요청은 저장 실패 응답 재생, in-flight 무한 방지).
 */
export async function createRun(deps: ApiServerDeps, request: FastifyRequest): Promise<CommandResponse> {
  const principal = requirePrincipal(request);

  // (1) 멱등 키 필수(api-surface §0.4 / #7). 누락 → IR_SCHEMA_INVALID(422). 예약 이전 — 키 소모 없음.
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  // (2) 본문 형상 검증(scenario_version_id). 예약 이전 — 형상 오류는 키 소모 없음.
  if (!isRecord(request.body)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const body = request.body as {
    scenario_version_id?: unknown;
    params?: unknown;
    workitem_id?: unknown;
    model?: unknown;
    priority?: unknown;
  };
  for (const key of Object.keys(body)) {
    if (key !== "scenario_version_id" && key !== "params" && key !== "workitem_id" && key !== "model" && key !== "priority") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  const priority = parseRunPriority(body.priority);
  // Gap2(B+C): optional model. 형식 검증은 예약 이전, 정책 존재/해소는 작업 tx(RLS 스코프).
  let model: string | null = null;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }
    model = body.model;
  }
  if (typeof body.scenario_version_id !== "string" || !UUID_RE.test(body.scenario_version_id)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_id_required" });
  }
  const scenarioVersionId = body.scenario_version_id;
  // optional workitem_id(1 Workitem = 1 Run, api-surface §1). 형식 검증은 예약 이전, 존재 검증은 작업 tx.
  let workitemId: string | null = null;
  if (body.workitem_id !== undefined && body.workitem_id !== null) {
    if (typeof body.workitem_id !== "string" || !UUID_RE.test(body.workitem_id)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_workitem_id" });
    }
    workitemId = body.workitem_id;
  }
  if (!isRecord(body.params)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  }
  const params = body.params;
  // params.as_of 1회 고정(api-surface §0.6): 명시 시 그 값(엄격 ISO-8601), 미지정 시 서버 생성 시각.
  //   무효 형식은 예약 이전 IR_SCHEMA_INVALID(422)로 거부 — ::timestamptz cast 500 회피("조용한 false 금지").
  let asOf: string;
  if (params.as_of === undefined) {
    asOf = new Date().toISOString();
  } else if (typeof params.as_of === "string" && isStrictIsoDateTime(params.as_of)) {
    asOf = params.as_of;
  } else {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }

  // (3) 멱등 예약(release-decisions #7).
  const requestHash = canonicalRequestHash("POST", "/v1/runs", request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "createRun",
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

  // (4) reserved → 작업 수행(동일 tx).
  const recordId = reservation.recordId;
  const runId = randomUUID();
  const response: CommandResponse = { status: 201, body: { run_id: runId, status: "queued", as_of: asOf, priority } };
  try {
    await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      // run 생성 핵심(scenario_version 확인·model 해소·workitem 확인·INSERT·run.created outbox·run_claim enqueue)은
      //   createRunInTx 로 공유(approval.decide 등 내부 명령이 동일 tx에서 재사용). runId 는 응답에 미리 쓰였으므로 주입.
      await createRunInTx(c, deps.enqueuer, {
        runId,
        tenantId: principal.tenantId,
        scenarioVersionId,
        params,
        asOf,
        correlationId: request.correlationId,
        workitemId,
        model,
        priority,
      });
      // 멱등 성공 기록을 동일 tx에 원자화(작업 커밋 == 'succeeded' 커밋). 별도 tx 불일치 창 제거.
      await completeIdempotencyInTx(c, recordId, response);
    });
    return response;
  } catch (err) {
    const apiErr = classifyRunCreateFailure(err);
    // 결정론적(분류·non-retryable) 실패만 'failed'로 저장 → 동일 키 재요청이 같은 응답을 재생.
    // 미분류/일시(인프라)·retryable 실패는 저장하지 않고 재던진다 → 예약 'processing' 유지(TTL 회수),
    //   클라이언트 at-least-once 재시도는 in-flight(409, retryable)로 안전 진행(api-surface §0.4).
    if (apiErr !== undefined) {
      if (shouldPersistRunCreateFailure(apiErr)) {
        await deps.idempotency.saveFailure(recordId, apiErrorBody(apiErr, request.correlationId));
      }
      throw apiErr;
    }
    throw err;
  }
}

export interface CreateRunInTxInput {
  readonly tenantId: string;
  readonly scenarioVersionId: string;
  readonly params: Record<string, unknown>;
  readonly asOf: string;
  readonly correlationId: string;
  readonly workitemId?: string | null;
  /** 명시 model(미지정/null → default·단일정책 자동해소; 0건 → null). */
  readonly model?: string | null;
  readonly priority?: RunPriority;
  /** 미지정 시 생성(POST /v1/runs 는 응답에 미리 쓴 runId 를 주입). */
  readonly runId?: string;
}

/**
 * run 생성 핵심 — scenario_version 존재 확인 · model 1회 해소·동결 · workitem 확인 · runs(queued) INSERT ·
 * run.created outbox · run_claim enqueue 를 **주어진 tx(client)** 에서 수행하고 runId 를 반환한다.
 * POST /v1/runs(createRun)과 내부 명령(approval.decide 의 결재 처리 run)이 공유한다(엔탱글 회피·동작 단일화).
 * 멱등 예약/검증/응답은 호출측 책임(이 함수는 작업만). 검증 실패는 ApiResponseError(IR_SCHEMA_INVALID 등)로 throw.
 */
export async function createRunInTx(
  client: PoolClient,
  enqueuer: RunEnqueuer,
  input: CreateRunInTxInput,
): Promise<string> {
  const runId = input.runId ?? randomUUID();
  const workitemId = input.workitemId ?? null;
  const priority = input.priority ?? "medium";
  // correlation_id 저장 coerce — runs.correlation_id/event envelope 는 uuid(format:uuid). 비-UUID 요청 헤더(에러 echo 엔
  //   그대로 실리되 추적용)는 저장 시점에 서버 UUID 로 대체해 ::uuid 캐스트 22P02→미분류 500 을 막는다(review 후속).
  const correlationId = UUID_RE.test(input.correlationId) ? input.correlationId : randomUUID();
  // scenario_version 존재 확인(RLS 스코프) + 아카이브된 시나리오 거부(origin 머지). 부재/archived → IR_SCHEMA_INVALID(FK 500 회피).
  const sv = await client.query<{ target: unknown }>(
    `SELECT sv.ir -> 'target' AS target FROM scenario_versions sv JOIN scenarios s ON s.tenant_id = sv.tenant_id AND s.id = sv.scenario_id
      WHERE sv.id = $1::uuid AND s.archived_at IS NULL`,
    [input.scenarioVersionId],
  );
  if (sv.rowCount === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_not_found" });
  }
  // run-create 게이트: 시나리오는 구동 가능한 target 을 선언해야 한다. ir.target 은 schema 상 선택적이나
  //   (ir.schema.json target.required=[site_profile_id,browser_identity_id,network_policy_id]) 미설정/형식오류면
  //   워커가 구동 불가 → run 이 queued 에 영구 잔류(BrowserLeasePlanResolver→null→lease 실패→재시도 소진).
  //   drive-time fail-closed(loud throw) 대신 생성 시점에 거부해 운영자에게 즉시 표면화(조용한 false 금지).
  //   shape 검사는 pgBrowserLeasePlanResolver 와 동형(런타임 미러). 존재성/승인은 lease 단계에서 확인.
  const declaredTarget = sv.rows[0]?.target;
  if (declaredTarget === null || declaredTarget === undefined || typeof declaredTarget !== "object") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "run_target_unresolved" });
  }
  const targetIds = declaredTarget as { site_profile_id?: unknown; browser_identity_id?: unknown; network_policy_id?: unknown };
  if (
    typeof targetIds.site_profile_id !== "string" ||
    typeof targetIds.browser_identity_id !== "string" ||
    typeof targetIds.network_policy_id !== "string"
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "run_target_unresolved" });
  }
  // model 1회 해소·동결(runs.model). 명시 → (tenant,model) 존재확인. 미지정 → is_default → 단일정책 자동해소 → 0건 NULL.
  //   다정책+미지정+default없음 → model_required(조용한 false 금지). createRun 과 동일 규약(GET /v1/gateway/policy 동형).
  let resolvedModel: string | null = null;
  const model = input.model ?? null;
  if (model !== null) {
    const m = await client.query(`SELECT 1 FROM gateway_policies WHERE model = $1`, [model]);
    if (m.rowCount === 0) {
      throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "model_policy_not_found", model });
    }
    resolvedModel = model;
  } else {
    const def = await client.query<{ model: string }>(`SELECT model FROM gateway_policies WHERE is_default = true`);
    if (def.rowCount === 1) {
      resolvedModel = def.rows[0].model;
    } else {
      const all = await client.query<{ model: string }>(`SELECT model FROM gateway_policies`);
      if (all.rowCount === 1) {
        resolvedModel = all.rows[0].model;
      } else if (all.rowCount !== 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_required", available: all.rowCount });
      }
    }
  }
  if (workitemId !== null) {
    const wi = await client.query(`SELECT 1 FROM workitems WHERE id = $1::uuid`, [workitemId]);
    if (wi.rowCount === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "workitem_not_found" });
    }
    const existingRun = await client.query(`SELECT 1 FROM runs WHERE workitem_id = $1::uuid LIMIT 1`, [workitemId]);
    if (existingRun.rowCount !== 0) {
      throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "workitem_run_exists" });
    }
  }
  await client.query(
    `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, priority, params, as_of, correlation_id, model)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', $5, $6::jsonb, $7::timestamptz, $8::uuid, $9)`,
    [runId, input.tenantId, input.scenarioVersionId, workitemId, priority, JSON.stringify(input.params), input.asOf, correlationId, resolvedModel],
  );
  await emitOutboxEvent(client, {
    tenantId: input.tenantId,
    eventType: "run.created",
    correlationId,
    runId,
    idempotencyKey: `${runId}:run.created`,
    retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
  });
  await enqueuer.enqueueRunClaim(client, { tenantId: input.tenantId, runId, correlationId, priority });
  return runId;
}

function parseRunPriority(raw: unknown): RunPriority {
  if (raw === undefined || raw === null) return "medium";
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_priority" });
}

function classifyRunCreateFailure(error: unknown): ApiResponseError | undefined {
  if (error instanceof ApiResponseError) return error;
  if (
    isPgUniqueViolation(error) &&
    typeof error.constraint === "string" &&
    error.constraint === "idx_runs_one_per_workitem"
  ) {
    return new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "workitem_run_exists" });
  }
  return undefined;
}

function shouldPersistRunCreateFailure(error: ApiResponseError): boolean {
  return (
    !ERROR_CATALOG[error.code].retryable ||
    (error.code === "WORKITEM_CHECKOUT_CONFLICT" && hasReason(error.details, "workitem_run_exists"))
  );
}

function hasReason(details: unknown, reason: string): boolean {
  return typeof details === "object" && details !== null && "reason" in details && details.reason === reason;
}

function isPgUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isStrictIsoDateTime(value: string): boolean {
  const match = ISO_8601_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
