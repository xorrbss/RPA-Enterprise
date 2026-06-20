/**
 * INIT 실패 처리 (state-machine.md §1 INIT 규칙 — R3a/R3b 런타임 배선).
 *
 * INIT = `claimed`→`running` 셋업 구간(워커 Phase B: drive-input/세션 bind/page-state config/executor·resolver).
 * 이 셋업이 `status='claimed'`에서 throw하면(좀비 잔류) 본 핸들러가 `init_failed` 이벤트로 R3a/R3b를 적용한다:
 *   - 연속 INIT 실패(`runs.consecutive_init_failures`) +1 < 임계 → **R3a**: `queued` 재큐(attempts/counter+1, 백오프 재인큐).
 *   - 임계 이상 → **R3b**: `failed_system` + 연결 workitem system 정산(DLQ=W5, run_id 포함) + run.failed_system emit.
 *
 * 순환의존 회피: lease 해제(drainBrowserLease)와 run_claim 재인큐는 워커가 콜백으로 주입한다(본 모듈은 worker 미참조).
 * openCircuit(R3b side-effect)은 대상 엔티티 미결정이라 실행하지 않고 loud 보류한다(조용한 false 금지 — 버리지 않고 표면화).
 */
import type { Pool, PoolClient } from "pg";

import type { RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "./run-transition";
import { settleLinkedWorkitemForRunTerminal } from "./workitem-settlement";

// ops-defaults.md §1: run.init_fail_threshold=3 / run.init_backoff base 2s·factor 2·max 60s. 코드 상수 금지 규약 — inline 인용.
const DEFAULT_INIT_FAIL_THRESHOLD = 3;
const DEFAULT_INIT_BACKOFF: InitBackoffConfig = { baseMs: 2_000, factor: 2, maxMs: 60_000 };

export interface InitBackoffConfig {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
}

export interface ClaimedInitFailureDeps {
  readonly pool: Pool;
  /** ops-defaults run.init_fail_threshold(기본 3). 테스트 sim 오버라이드. */
  readonly initFailThreshold?: number;
  /** ops-defaults run.init_backoff(기본 base 2s·factor 2·max 60s). 테스트 sim 오버라이드(base 10ms·max 50ms). */
  readonly initBackoff?: InitBackoffConfig;
  /** 결정론 테스트용 jitter 주입(기본 ±20% 랜덤). 1.0 고정 시 백오프 결정적. */
  readonly jitter?: () => number;
}

export interface ClaimedInitFailureInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly correlationId: string;
  /** Phase A 브라우저 lease 해제(같은 init-failure tx). 누수 방지 — R3a/R3b 및 비-claimed 모두 호출. */
  readonly drainLease: (client: PoolClient) => Promise<void>;
  /**
   * 재큐 가능 여부(=run_claim enqueuer 주입됨). false 면 R3a(재큐) 불가이므로 임계 미만이어도 R3b(failed_system)로
   * 강등한다 — 재큐 enqueuer 부재 시 좀비 claimed 잔류 대신 단말 정산으로 표면화(적대리뷰 B2). reenqueueRunClaim 은
   * canRequeue=true 일 때만 호출된다(throw 로 tx 롤백→좀비 경로 제거).
   */
  readonly canRequeue: boolean;
  /** R3a: delayMs 후 run_claim 재인큐(같은 tx — 상태변경+인큐 원자). canRequeue=true 일 때만 호출됨. */
  readonly reenqueueRunClaim: (client: PoolClient, delayMs: number) => Promise<void>;
}

/** ±20% jitter 지수 백오프. priorFailures = 이번 실패 직전 연속 실패 수(0-base 지수). */
function initBackoffMs(priorFailures: number, cfg: InitBackoffConfig, jitter: () => number): number {
  const raw = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(cfg.factor, Math.max(0, priorFailures)));
  return Math.max(1, Math.round(raw * jitter()));
}

/** ±20% 랜덤 jitter 배수(0.8~1.2). */
function defaultJitter(): number {
  return 1 + (Math.random() * 0.4 - 0.2);
}

/**
 * claimed INIT 실패를 R3a/R3b로 전이한다(한 tenant tx: 전이 + lease 해제 + (R3a)재인큐/(R3b)정산 원자).
 * 반환: 적용된 다음 상태("queued"=R3a / "failed_system"=R3b), 또는 null(run 부재·비-claimed·CAS 경합 — init_failed 미적용).
 */
export async function handleClaimedInitFailure(
  deps: ClaimedInitFailureDeps,
  input: ClaimedInitFailureInput,
): Promise<RunState | null> {
  const threshold = deps.initFailThreshold ?? DEFAULT_INIT_FAIL_THRESHOLD;
  const backoff = deps.initBackoff ?? DEFAULT_INIT_BACKOFF;
  const jitter = deps.jitter ?? defaultJitter;

  return withTenantTx(deps.pool, input.tenantId, async (client) => {
    // 현재 상태/연속카운터 FOR UPDATE(동시 cancel/전이 경합 차단).
    const r = await client.query<{ status: RunState; consecutive_init_failures: number; workitem_id: string | null }>(
      `SELECT status, consecutive_init_failures, workitem_id::text AS workitem_id
         FROM runs WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE`,
      [input.runId, input.tenantId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      // run 부재(이미 정리). lease 누수 방지만.
      await input.drainLease(client);
      return null;
    }
    if (row.status !== "claimed") {
      // 이미 비-claimed(동시 cancel/다른 워커 전이). init_failed 는 claimed 한정(queued 등에서는 IllegalTransition) →
      //   적용하지 않고 lease 만 해제(조용한 false 금지: 호출측이 로그). 큐/claim 회수는 dispatcher 소관.
      await input.drainLease(client);
      return null;
    }

    const prior = row.consecutive_init_failures;
    // 재큐 불가(enqueuer 부재)면 임계 미만이어도 R3b 강등 — 좀비 claimed 대신 단말 정산(적대리뷰 B2).
    const belowThreshold = prior + 1 < threshold && input.canRequeue;

    const t = await applyRunTransition(client, {
      tenantId: input.tenantId,
      runId: input.runId,
      fromStatus: "claimed",
      event: { type: "init_failed" },
      guard: { initFailBelowThreshold: belowThreshold },
      correlationId: input.correlationId,
      // 멱등 앵커: 이번 실패 회차(prior+1) — 같은 회차 재실행은 동일 키(중복 outbox 차단). 회차마다 유일.
      eventIdempotencyKey: `${input.runId}:init_failed:${prior + 1}`,
    });
    if (!t.applied) {
      // CAS 경합(다른 워커가 이미 전이). lease 해제 후 미적용 보고.
      await input.drainLease(client);
      return null;
    }

    // lease 해제(R3a 재-claim 재획득 위해 'draining' / R3b 종결). 같은 tx 원자.
    await input.drainLease(client);

    if (t.next === "queued") {
      // R3a: 백오프 재인큐(같은 tx). attempts/consecutive_init_failures+1 은 applyRunTransition 이 영속.
      await input.reenqueueRunClaim(client, initBackoffMs(prior, backoff, jitter));
      return "queued";
    }

    // R3b: failed_system. applyRunTransition 이 run.failed_system + ended_at 확정. 연결 workitem system 정산(W4 retry /
    //   W5 abandoned+dead_letter(run_id 포함))이 R3b 'DLQ 판단'(evaluateDeadLetter side-effect)을 충족한다 — run-less 면 no-op.
    //   드리프트 차단(적대리뷰 B3): transitionRun 이 evaluateDeadLetter 를 실제로 내놓았는지 단정(향후 R3b sideEffect 구성 변경 감지).
    if (!t.pending.some((p) => p.kind === "evaluateDeadLetter")) {
      console.warn(
        `run-init-failure: R3b pending 에 evaluateDeadLetter 부재(run ${input.runId.slice(0, 8)}) — transitionRun R3b sideEffect 구성 변경 의심(workitem 정산이 DLQ 판단을 충족한다는 가정 재검토 필요).`,
      );
    }
    await settleLinkedWorkitemForRunTerminal(client, row.workitem_id, {
      tenantId: input.tenantId,
      runId: input.runId,
      correlationId: input.correlationId,
      terminal: "system",
      eventIdempotencyKey: `${input.runId}:workitem-system`,
    });

    // R3b openCircuit(per-run 신호)은 **worker 서킷**으로 결정됨(state-machine §1 INIT 규칙). 단 per-run 직결은 과잉격리라
    //   여기서 직접 열지 않고, 워커가 모든 INIT 실패(R3a/R3b 공통)를 per-worker 누적(worker.circuit.consecutive_failures)으로
    //   집계해 임계 도달 시 회로를 연다(runtime-worker.recordWorkerInitFailure). 즉 openCircuit 의도는 워커 계층에서 실현되며,
    //   본 핸들러(run 계층)는 failed_system+DLQ 종결만 책임진다 — 조용한 false 아님(설계상 분리, 계약 명문화).
    return "failed_system";
  });
}
