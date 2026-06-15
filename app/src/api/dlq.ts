/**
 * DLQ(데드레터) replay 라우트 (D4.5 — api-surface §4).
 *
 * `POST /v1/dlq/{dead_letter_id}/replay` — 운영자 재처리. W10(workitem abandoned→new, attempts 리셋, DLQ 복원).
 * 본 엔드포인트가 다루는 `dead_letter` 테이블은 workitem DLQ(W5/W7) 전용이다 — sink DLQ는 데이터평면
 * `sink_deliveries.status='dead_letter'`(별도 소스, D6)라 여기서 다루지 않는다.
 *
 * 에러 매핑(api-surface §4):
 *  - dead_letter 미존재 → RESOURCE_NOT_FOUND(404).
 *  - 재처리 불가(replayable=false 또는 workitem 미연결) → IR_SCHEMA_INVALID(422, not_replayable).
 *  - workitem이 abandoned가 아님(이미 복원/진행) → WORKITEM_CHECKOUT_CONFLICT(409, retryable).
 *  - 권한 부족 → AUTHZ_FORBIDDEN(403, RBAC preHandler; W10 operatorAuthorized).
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { WorkitemState } from "../../../ts/state-machine-types";
import { applyWorkitemTransition } from "../runtime/workitem-transition";
import { runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { type ApiServerDeps } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerDlqRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { id: string } }>(
    "/v1/dlq/:id/replay",
    { config: { rbacAction: "dlq.replay" } },
    async (request, reply) => {
      const id = request.params.id;
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
