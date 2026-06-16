/**
 * DLQ(데드레터) replay 라우트 (D4.5 — api-surface §4; sink 분기 release-decisions D8-A3).
 *
 * `POST /v1/dlq/{dead_letter_id}/replay?kind=workitem|sink` — 운영자 재처리. 목록 엔드포인트(GET /v1/dlq?kind=)와
 * 동일한 kind 판별자로 두 소스를 한 운영자-대면 라우트로 묶는다(api-surface §4).
 *  - kind=workitem(기본): `dead_letter` 테이블(W5/W7) → W10(abandoned→new, attempts 리셋, DLQ 복원).
 *  - kind=sink: 데이터평면 `sink_deliveries.status='dead_letter'` → 새 sink_deliver attempt **인큐**
 *    (상태전이 아님; 새 attempt_no·동일 sink_idempotency_key를 worker가 산출 — D8-A3). 라우트는 인큐까지만
 *    책임지고 202(accepted)를 반환한다. 실 재전달은 worker의 SinkDeliveryPort(외부 egress, D6-2)에 의존하며
 *    egress 미바인딩 시 worker가 SINK_DELIVERY_FAILED로 표면화한다(라우트가 전달 성공을 가장하지 않는다).
 *
 * 에러 매핑(api-surface §4):
 *  - dead_letter/sink dead_letter 미존재(또는 cross-tenant RLS 은닉) → RESOURCE_NOT_FOUND(404).
 *  - (workitem) 재처리 불가(replayable=false 또는 workitem 미연결) → IR_SCHEMA_INVALID(422, not_replayable).
 *  - (workitem) workitem이 abandoned가 아님(이미 복원/진행) → WORKITEM_CHECKOUT_CONFLICT(409, retryable).
 *  - kind 무효 → IR_SCHEMA_INVALID(422, invalid_kind).
 *  - 권한 부족 → AUTHZ_FORBIDDEN(403). workitem=RBAC preHandler(dlq.replay); sink=in-handler(sink_dlq.replay,
 *    역할집합은 dlq.replay와 동일 — D8-A3). 키 소모 이전 거부.
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { WorkitemState } from "../../../ts/state-machine-types";
import { applyWorkitemTransition } from "../runtime/workitem-transition";
import { runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import type { SinkDeliverEnqueueInput } from "./run-queue";
import { requirePrincipal, type ApiServerDeps } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ?kind 판별(workitem|sink). 누락→workitem 기본, 무효→422(GET /v1/dlq?kind=와 동일 규약). */
function parseReplayKind(raw: unknown): "workitem" | "sink" {
  if (raw === undefined) return "workitem";
  if (raw === "workitem" || raw === "sink") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_kind", param: "kind" });
}

export function registerDlqRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/v1/dlq/:id/replay",
    { config: { rbacAction: "dlq.replay" } },
    async (request, reply) => {
      const id = request.params.id;
      const kind = parseReplayKind(request.query.kind);

      if (kind === "sink") {
        // sink 분기 인가는 in-handler(sink_dlq.replay) — 키 소모 이전. 역할집합은 dlq.replay와 동일(D8-A3)이라
        // preHandler(dlq.replay)를 통과한 principal은 동일하게 허용되지만, sink capability를 명시 게이트한다.
        const principal = requirePrincipal(request);
        const decision = await deps.rbac.authorize(principal, {
          action: "sink_dlq.replay",
          tenantId: principal.tenantId,
        });
        if (decision.kind === "deny") {
          request.log.warn(
            { action: decision.action, code: decision.code, reason: decision.reason, correlation_id: request.correlationId },
            "sink_dlq.replay denied",
          );
          throw new ApiResponseError(decision.code);
        }
        if (!UUID_RE.test(id)) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const result = await runIdempotentCommand(
          deps,
          request,
          "replaySinkDeadLetter",
          `/v1/dlq/${id}/replay?kind=sink`,
          (client, tenantId) => applySinkDeadLetterReplay(deps, client, tenantId, id, request.correlationId),
        );
        reply.code(result.status).send(result.body);
        return;
      }

      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const result = await runIdempotentCommand(
        deps,
        request,
        "replayDeadLetter",
        `/v1/dlq/${id}/replay`,
        (client, tenantId) => applyDeadLetterReplay(client, tenantId, id, request.correlationId),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

/**
 * sink-DLQ replay 적용(작업 tx). sink_deliveries.status='dead_letter' 행을 tenant-scope 조회 →
 * 새 sink_deliver attempt를 같은 tx로 인큐(상태전이 아님 — D8-A3). 인큐와 멱등 'succeeded' 기록을 원자화한다.
 * 행 미존재(또는 RLS 은닉 cross-tenant) → RESOURCE_NOT_FOUND(존재 비노출). 실 재전달은 worker egress 의존.
 */
async function applySinkDeadLetterReplay(
  deps: ApiServerDeps,
  client: PoolClient,
  tenantId: string,
  sinkDeadLetterId: string,
  correlationId: string,
): Promise<CommandResponse> {
  const dlq = await client.query<{ normalized_record_id: string; sink_config_id: string }>(
    `SELECT normalized_record_id::text AS normalized_record_id, sink_config_id::text AS sink_config_id
       FROM sink_deliveries WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='dead_letter'`,
    [sinkDeadLetterId, tenantId],
  );
  const row = dlq.rows[0] ?? null;
  if (row === null) {
    // dead_letter 아님/미존재/타테넌트(RLS 은닉) 모두 동일하게 not-found(존재 비노출).
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  const input: SinkDeliverEnqueueInput = {
    tenantId,
    normalizedRecordId: row.normalized_record_id,
    sinkConfigId: row.sink_config_id,
    correlationId,
  };
  // D8-A3: 새 attempt 인큐(상태전이 아님). worker가 attempt_no=MAX+1·동일 멱등키 산출, 실 전달은 egress 의존.
  await deps.enqueuer.enqueueSinkDeliver(client, input);
  return { status: 202, body: { dead_letter_id: sinkDeadLetterId, kind: "sink", status: "enqueued" } };
}

interface DeadLetterRow {
  workitem_id: string | null;
  replayable: boolean;
  replayed_at: Date | null;
}

/**
 * dead_letter replay 적용(작업 tx). dead_letter 조회 → W10(abandoned→new, attempts 리셋) CAS →
 * dead_letter.replayed_at 마킹(replayed_at IS NULL CAS). 경합은 재조회.
 */
async function applyDeadLetterReplay(
  client: PoolClient,
  tenantId: string,
  deadLetterId: string,
  correlationId: string,
): Promise<CommandResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dlq = await client.query<DeadLetterRow>(
      `SELECT workitem_id::text AS workitem_id, replayable, replayed_at
         FROM dead_letter WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [deadLetterId, tenantId],
    );
    const dl = dlq.rows[0] ?? null;
    if (dl === null) {
      // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
      throw new ApiResponseError("RESOURCE_NOT_FOUND");
    }
    if (!dl.replayable || dl.workitem_id === null) {
      // workitem 미연결(sink/비복원) 또는 replayable=false → W10 대상 아님(영구 조건).
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "not_replayable" });
    }
    const workitemId = dl.workitem_id;

    const wi = await client.query<{ status: WorkitemState }>(
      `SELECT status FROM workitems WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [workitemId, tenantId],
    );
    const workitemStatus = wi.rows[0]?.status ?? null;
    if (workitemStatus === null) {
      throw new ApiResponseError("RESOURCE_NOT_FOUND");
    }
    if (workitemStatus !== "abandoned") {
      // 이미 복원/진행 — 조용한 false 금지: retryable 충돌로 표면화(동일 키 재요청은 멱등 재생).
      throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "workitem_not_abandoned", status: workitemStatus });
    }

    // W10: abandoned + manual_replay (operatorAuthorized=RBAC 통과) → new (attempts 리셋).
    const outcome = await applyWorkitemTransition(client, {
      tenantId,
      workitemId,
      fromStatus: "abandoned",
      event: { type: "manual_replay" },
      guard: { operatorAuthorized: true },
      correlationId,
    });
    if (!outcome.applied) continue; // cas_conflict → 재조회

    // DLQ에서 복원 마킹(replayed_at IS NULL CAS — 중복 복원 방지).
    await client.query(
      `UPDATE dead_letter SET replayed_at=now() WHERE id=$1::uuid AND tenant_id=$2::uuid AND replayed_at IS NULL`,
      [deadLetterId, tenantId],
    );
    return { status: 202, body: { dead_letter_id: deadLetterId, workitem_id: workitemId, status: outcome.next } };
  }
  // CAS 경합 3회 — 조용한 false 금지: 재시도 가능 충돌로 표면화.
  throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "dlq_replay_cas_contention" });
}
