/**
 * Run terminal → 연결 Workitem 단말 정산 (state-machine.md §2 W2/W3/W4/W5 + dead_letter).
 *
 * "1 Workitem = 1 Run"(state-machine.md:76): Run 종결 시 연결 Workitem 도 같은 tx 에서 정산해야 한다 —
 * Run completed→W2(successful), failed_business→W3(failed_business), failed_system→W4(retry)/W5(abandoned+dead_letter).
 * production driver(run-step-driver.driveScenario)와 executor 완료 coordinator 가 이 함수를 공유한다(정산 로직 단일
 * 진실원천, 두 완료 경로 분기 방지). 호출자는 run 종결 전이가 적용된 동일 tx(PoolClient)에서 호출하고 runs.workitem_id 를
 * 전달한다. workitem 이 없으면(ad-hoc run) no-op.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { ErrorCode } from "../../../ts/error-catalog";
import type { SideEffectCmd, WorkitemState } from "../../../ts/state-machine-types";
import type { EmittedEvent } from "./outbox";
import { applyWorkitemTransition, type WorkitemTransitionOutcome } from "./workitem-transition";

// ops-defaults.md #workitem.max_attempts=3(system W4/W5 분기). 코드 상수 금지 규약 — inline 인용.
export const WORKITEM_MAX_ATTEMPTS = 3;

export type RunTerminalKind = "success" | "business" | "system";

export interface LinkedWorkitemSettlementInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly terminal: RunTerminalKind;
  /** outbox idempotency anchor(emitOutboxEvent 가 `:${event}` 접미). 호출자별 결정형 키. */
  readonly eventIdempotencyKey: string;
  readonly occurredAt?: Date;
  /** W4/W5 분기 임계(기본 ops-defaults #workitem.max_attempts=3). */
  readonly maxAttempts?: number;
  /** system terminal → abandoned(W5) dead_letter reason(미지정 시 DEAD_LETTER). */
  readonly systemReasonCode?: ErrorCode;
  readonly systemEvidenceRef?: string;
}

export interface LinkedWorkitemSettlementResult {
  /** runs.workitem_id 가 없으면(=ad-hoc run) false — no-op. */
  readonly settled: boolean;
  readonly next?: WorkitemState;
  readonly emitted: readonly EmittedEvent[];
  /** 이미 실행된 pending side effect(W5 createDeadLetter) — 호출자 정산 회계용. */
  readonly satisfiedPending: readonly SideEffectCmd[];
}

/**
 * Run 종결 전이와 동일 tx 에서 연결 Workitem 을 단말 정산한다. workitemId 는 호출자가 runs.workitem_id 로 해소해 전달
 * (driver: afterApplied 에서 SELECT, coordinator: run 행에서 이미 보유). 연결 workitem 은 반드시 'processing' 이어야
 * 하며 아니면 loud throw("조용한 false/unknown 금지").
 */
export async function settleLinkedWorkitemForRunTerminal(
  client: PoolClient,
  workitemId: string | null,
  input: LinkedWorkitemSettlementInput,
): Promise<LinkedWorkitemSettlementResult> {
  if (workitemId === null) return { settled: false, emitted: [], satisfiedPending: [] };

  const maxAttempts = input.maxAttempts ?? WORKITEM_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error(`settleLinkedWorkitem: maxAttempts must be a positive integer; got ${String(maxAttempts)}`);
  }

  const wi = await client.query<{ status: WorkitemState; attempts: number }>(
    `SELECT status, attempts FROM workitems WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
    [input.tenantId, workitemId],
  );
  const row = wi.rows[0];
  if (row?.status !== "processing") {
    throw new Error(
      `settleLinkedWorkitem: linked workitem must be 'processing' on run terminal '${input.terminal}'; got ${row?.status ?? "missing"}`,
    );
  }

  const base = {
    tenantId: input.tenantId,
    workitemId,
    fromStatus: "processing" as const,
    correlationId: input.correlationId,
    runId: input.runId,
    eventIdempotencyKey: input.eventIdempotencyKey,
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
  };

  if (input.terminal === "success") {
    // W2: processing + run_succeeded(sink 정책 만족) → successful + workitem.completed.
    const applied = assertApplied(
      await applyWorkitemTransition(client, { ...base, event: { type: "run_succeeded" }, guard: { sinkPolicyMet: true } }),
      "W2",
    );
    assertNoPending(applied.pending, "W2");
    return { settled: true, next: applied.next, emitted: applied.emitted, satisfiedPending: [] };
  }

  if (input.terminal === "business") {
    // W3: processing + business_exception → failed_business.
    const applied = assertApplied(
      await applyWorkitemTransition(client, { ...base, event: { type: "business_exception" }, guard: {} }),
      "W3",
    );
    assertNoPending(applied.pending, "W3");
    return { settled: true, next: applied.next, emitted: applied.emitted, satisfiedPending: [] };
  }

  // W4/W5: processing + system_exception → retry(attempts+1<max) / abandoned(attempts+1>=max, dead_letter 생성).
  const applied = assertApplied(
    await applyWorkitemTransition(client, {
      ...base,
      event: { type: "system_exception" },
      guard: { attemptsBelowMax: row.attempts + 1 < maxAttempts },
    }),
    "W4/W5",
  );
  if (applied.next === "abandoned") {
    assertExactPendingKinds(applied.pending, ["createDeadLetter"], "W5");
    await insertWorkitemDeadLetter(client, {
      tenantId: input.tenantId,
      workitemId,
      runId: input.runId,
      reasonCode: input.systemReasonCode ?? "DEAD_LETTER",
      ...(input.systemEvidenceRef !== undefined ? { evidenceRef: input.systemEvidenceRef } : {}),
    });
    return { settled: true, next: applied.next, emitted: applied.emitted, satisfiedPending: applied.pending };
  }
  assertNoPending(applied.pending, "W4");
  return { settled: true, next: applied.next, emitted: applied.emitted, satisfiedPending: [] };
}

type AppliedOutcome = Extract<WorkitemTransitionOutcome, { applied: true }>;

function assertApplied(outcome: WorkitemTransitionOutcome, label: string): AppliedOutcome {
  if (!outcome.applied) {
    throw new Error(`settleLinkedWorkitem: ${label} CAS conflict; observed=${outcome.observed ?? "null"}`);
  }
  return outcome;
}

function assertNoPending(pending: readonly SideEffectCmd[], label: string): void {
  if (pending.length > 0) {
    throw new Error(
      `settleLinkedWorkitem: ${label} produced unsupported pending side effects: ${pending.map((p) => p.kind).join(",")}`,
    );
  }
}

function assertExactPendingKinds(
  pending: readonly SideEffectCmd[],
  kinds: readonly SideEffectCmd["kind"][],
  label: string,
): void {
  const allowed = new Set<string>(kinds);
  for (const cmd of pending) {
    if (!allowed.has(cmd.kind)) throw new Error(`settleLinkedWorkitem: ${label} unexpected pending side effect ${cmd.kind}`);
  }
  for (const kind of kinds) {
    if (!pending.some((cmd) => cmd.kind === kind)) {
      throw new Error(`settleLinkedWorkitem: ${label} missing pending side effect ${kind}`);
    }
  }
}

/**
 * workitem 차원 dead_letter INSERT (W5 run-system-failure / W7 checkout-expired 공용). run_id 는 nullable —
 * checkout_expired(W7)는 run 연관이 runs.workitem_id 로만 존재해 미연결(null)일 수 있다(dead_letter.run_id 는 nullable FK).
 */
export async function insertWorkitemDeadLetter(
  client: PoolClient,
  input: { tenantId: string; workitemId: string; runId: string | null; reasonCode: ErrorCode; evidenceRef?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO dead_letter (id, tenant_id, workitem_id, run_id, reason_code, evidence_ref, replayable)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, true)`,
    [randomUUID(), input.tenantId, input.workitemId, input.runId, input.reasonCode, input.evidenceRef ?? null],
  );
}
