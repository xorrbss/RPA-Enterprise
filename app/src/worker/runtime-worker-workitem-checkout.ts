// PgRuntimeWorker god-class에서 추출한 workitem_checkout/checkout_sweeper 잡 처리(동작 무변경).
// 순수 leaf(다른 클러스터 호출 0). 상태=pool + workerId만. W1 체크아웃 전이 + W6/W7 만료 sweeper.
import type pg from "pg";

import type { EventId, RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { WorkitemState } from "../../../ts/state-machine-types";
import { requireString } from "./runtime-worker-parse";
import { withTenantTx } from "../db/pool";
import { applyWorkitemTransition } from "../runtime/workitem-transition";
import { insertWorkitemDeadLetter, WORKITEM_MAX_ATTEMPTS } from "../runtime/workitem-settlement";

// ops-defaults.md #workitem.checkout_timeout=10m. W1 checkout 시 checkout_expires_at 설정, W6/W7 sweeper 가 만료 판정. 코드 상수 금지 규약 — inline 인용.
const WORKITEM_CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;

type WorkitemRow = { status: WorkitemState };

export async function handleWorkitemCheckout(pool: pg.Pool, configuredWorkerId: string | undefined, job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "workitem_checkout.tenantId");
  const workitemId = requireString(job.workitemId, "workitem_checkout.workitemId");
  const correlationId = requireString(job.correlationId, "workitem_checkout.correlationId");
  const workerId = requireString(
    configuredWorkerId,
    "PgRuntimeWorkerOptions.workerId for workitem_checkout",
  );

  return withTenantTx(pool, tenantId, async (client) => {
    const current = await client.query<WorkitemRow>(
      `SELECT status
         FROM workitems
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [tenantId, workitemId],
    );
    const row = current.rows[0];
    if (row === undefined) {
      return { kind: "failed", code: "RESOURCE_NOT_FOUND" };
    }
    if (row.status !== "new") {
      return { kind: "failed", code: "WORKITEM_CHECKOUT_CONFLICT" };
    }

    const transition = await applyWorkitemTransition(client, {
      tenantId,
      workitemId,
      fromStatus: "new",
      event: { type: "checkout" },
      guard: { uniqueReferenceFree: true },
      correlationId,
      runId: job.runId,
      workerId,
      eventIdempotencyKey: `${workitemId}:workitem_checkout`,
    });

    if (!transition.applied) {
      throw new Error(
        `RuntimeWorker: workitem_checkout CAS conflict after row lock; observed=${transition.observed ?? "null"}`,
      );
    }
    if (transition.pending.length > 0) {
      throw new Error("RuntimeWorker: workitem_checkout produced unsupported pending side effects");
    }

    // W1 checkout TTL 확정: checkout_expires_at = now() + ops-defaults #workitem.checkout_timeout(10m).
    //   checkout-expiry sweeper(W6/W7)가 이 값으로 만료를 판정한다(이전엔 미설정이라 회수 불가 = C2 결함).
    await client.query(
      `UPDATE workitems SET checkout_expires_at = now() + ($3::bigint * interval '1 millisecond')
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, workitemId, WORKITEM_CHECKOUT_TIMEOUT_MS],
    );

    return {
      kind: "completed",
      emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
    };
  });
}

export async function handleWorkitemCheckoutSweeper(pool: pg.Pool, job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "workitem_checkout_sweeper.tenantId");
  const correlationId = requireString(job.correlationId, "workitem_checkout_sweeper.correlationId");
  await withTenantTx(pool, tenantId, async (client) => {
    const expired = await client.query<{ id: string; attempts: number; run_id: string | null }>(
      `SELECT w.id::text AS id, w.attempts, r.id::text AS run_id
         FROM workitems w
         LEFT JOIN runs r ON r.tenant_id = w.tenant_id AND r.workitem_id = w.id
        WHERE w.tenant_id = $1::uuid
          AND w.status = 'processing'
          AND w.checkout_paused_at IS NULL
          AND w.checkout_expires_at IS NOT NULL
          AND w.checkout_expires_at < now()
        FOR UPDATE OF w SKIP LOCKED`,
      [tenantId],
    );
    for (const w of expired.rows) {
      const t = await applyWorkitemTransition(client, {
        tenantId,
        workitemId: w.id,
        fromStatus: "processing",
        event: { type: "checkout_expired" },
        guard: { attemptsBelowMax: w.attempts + 1 < WORKITEM_MAX_ATTEMPTS },
        correlationId,
        ...(w.run_id !== null ? { runId: w.run_id } : {}),
        eventIdempotencyKey: `${w.id}:checkout_expired:${w.attempts}`,
      });
      if (!t.applied) continue; // 동시 변경(다른 워커가 이미 정산) — 흡수.
      if (t.next === "abandoned") {
        // W7: dead_letter 생성. run 연관은 runs.workitem_id(있으면) 로, 없으면 null.
        await insertWorkitemDeadLetter(client, {
          tenantId,
          workitemId: w.id,
          runId: w.run_id,
          reasonCode: "DEAD_LETTER",
        });
      }
    }
  });
  return { kind: "completed", emittedEvents: [] };
}
