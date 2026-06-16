/**
 * Run 실행 드라이버 (D3 가동 1단계 — 증분2: 인터프리터 ↔ DB 전이 연결).
 *
 * claimed 상태의 run을 받아: claimed→running(R2) → scenario_versions(ir+compiled_ast) 로드 →
 * 인터프리터(runScenario)로 그래프 순회 실행 → terminal 결과를 DB 전이로 종료(running→completing→completed).
 * 각 전이는 독립 CAS 트랜잭션(applyRunTransition: UPDATE WHERE status=<cur> + 동일 tx outbox). 인터프리터(브라우저
 * 작업)는 트랜잭션 밖에서 수행한다(긴 작업으로 커넥션 점유 금지).
 *
 * 범위(1단계): success/success_empty 종료 경로. fail_business/fail_system 등 실패 전이는 후속 증분 —
 * 미구현 경로는 조용히 흘리지 않고 throw로 표면화한다("조용한 false/unknown 금지").
 */
import type { Pool } from "pg";

import type { ExecutorPlugin, PageState, PageStateResolver, RunContext } from "../../../ts/core-types";
import type { RunEvent, RunGuard, RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "./run-transition";
import { compiledScenarioFrom } from "./ir-translate";
import { runScenario, type ScenarioOutcome } from "./ir-interpreter";

export interface ClaimedRun {
  readonly runId: string;
  readonly tenantId: string;
  readonly scenarioVersionId: string;
  readonly correlationId: string;
  readonly leaseId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly networkPolicyId: string;
  /** runs.params(실행 파라미터). navigate.url_ref 가 이 params 의 키로 해소된다. */
  readonly params?: Record<string, unknown>;
}

export interface DriveDeps {
  readonly pool: Pool;
  readonly executor: ExecutorPlugin;
  readonly resolver: PageStateResolver;
  readonly workerId: string;
}

export interface DriveResult {
  readonly state: RunState;
  readonly outcome: ScenarioOutcome;
}

function seedPageState(): PageState {
  return {
    url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
    dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
    auth: "anonymous",
    flags: {},
    matchedWhere: [],
  };
}

export async function driveClaimedRun(run: ClaimedRun, deps: DriveDeps): Promise<DriveResult> {
  // 1) claimed → running (R2, started_at).
  await transition(deps.pool, run, "claimed", { type: "run.started" }, { initOk: true }, deps.workerId);

  // 2) scenario_versions(ir + compiled_ast) 로드 (RLS 스코프).
  const sv = await withTenantTx(deps.pool, run.tenantId, async (c) => {
    const r = await c.query<{ ir: unknown; compiled_ast: unknown }>(
      `SELECT ir, compiled_ast FROM scenario_versions WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [run.scenarioVersionId, run.tenantId],
    );
    return r.rows[0] ?? null;
  });
  if (sv === null) {
    throw new Error(`driveClaimedRun: scenario_version '${run.scenarioVersionId}' not found (tenant ${run.tenantId})`);
  }
  // ir=jsonb(객체), compiled_ast=text(JSON 문자열) — 컬럼 타입에 맞춰 정규화.
  const irDoc = typeof sv.ir === "string" ? (JSON.parse(sv.ir) as unknown) : sv.ir;
  const compiledAst = typeof sv.compiled_ast === "string" ? (JSON.parse(sv.compiled_ast) as unknown) : sv.compiled_ast;
  // navigate.url_ref 는 run.params 의 키로 해소된다(URL_REF_* 실패는 InterpreterError 로 표면화).
  const scenario = compiledScenarioFrom(irDoc, compiledAst, run.params);

  // 3) 인터프리터로 그래프 순회 실행 (트랜잭션 밖).
  const ctx: RunContext = {
    runId: run.runId,
    tenantId: run.tenantId,
    nodeId: scenario.start,
    attempt: 0,
    siteProfileId: run.siteProfileId,
    browserIdentityId: run.browserIdentityId,
    networkPolicyId: run.networkPolicyId,
    leaseId: run.leaseId,
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: seedPageState(),
  };
  // run.params 를 인터프리터 스코프에 주입(on[].when 의 params.* 참조). navigate url_ref 해소와 동일 출처.
  const outcome = await runScenario(scenario, ctx, { executor: deps.executor, resolver: deps.resolver, params: run.params });

  // 4) terminal 결과를 DB 전이로 종료.
  if (outcome.terminal === "success" || outcome.terminal === "success_empty") {
    await transition(deps.pool, run, "running", { type: "last_node_success" }, { flowTerminalReached: true });
    await transition(deps.pool, run, "completing", { type: "finalize_ok" }, { finalizeOk: true });
    return { state: "completed", outcome };
  }

  // fail_business/fail_system 등: 1단계 미구현 — 조용한 false 금지로 표면화(후속 증분에서 R-rule 전이 추가).
  throw new Error(`driveClaimedRun: terminal '${outcome.terminal}' 종료 전이 미구현(1단계는 success 경로). 후속 증분에서 추가.`);
}

// 단일 전이를 자체 CAS 트랜잭션으로 적용. eventIdempotencyKey는 이벤트별 접미(outbox UNIQUE 충돌 방지).
async function transition(
  pool: Pool,
  run: ClaimedRun,
  fromStatus: RunState,
  event: RunEvent,
  guard: RunGuard,
  workerId?: string,
): Promise<void> {
  const outcome = await withTenantTx(pool, run.tenantId, (c) =>
    applyRunTransition(c, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus,
      event,
      guard,
      correlationId: run.correlationId,
      workerId,
      eventIdempotencyKey: `${run.runId}:${event.type}`,
    }),
  );
  if (!outcome.applied) {
    throw new Error(`driveClaimedRun: transition '${event.type}' from '${fromStatus}' not applied (${outcome.reason}, observed=${outcome.observed ?? "none"})`);
  }
}
