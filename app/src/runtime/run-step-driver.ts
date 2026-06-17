/**
 * Run 실행 드라이버 (D3 가동 1단계 — 증분2: 인터프리터 ↔ DB 전이 연결).
 *
 * claimed 상태의 run을 받아: claimed→running(R2) → scenario_versions(ir+compiled_ast) 로드 →
 * 인터프리터(runScenario)로 그래프 순회 실행 → terminal 결과를 DB 전이로 종료(running→completing→completed).
 * 각 전이는 독립 CAS 트랜잭션(applyRunTransition: UPDATE WHERE status=<cur> + 동일 tx outbox). 인터프리터(브라우저
 * 작업)는 트랜잭션 밖에서 수행한다(긴 작업으로 커넥션 점유 금지).
 *
 * 범위: success/success_empty → completed(R7→R21), fail_business → failed_business(R9), fail_system → failed_system(R8),
 * suspend → suspended(R4→포트→resume-token 발행→R11, driveSuspend). 그 외 terminal 은 미구현 — 조용히 흘리지 않고
 * throw로 표면화한다("조용한 false/unknown 금지").
 */
import type { Pool } from "pg";

import type { ClassifiedException, ExecutorPlugin, PageState, PageStateRef, PageStateResolver, RedactedString, RunContext, SecretRef } from "../../../ts/core-types";
import type { IsoDateTime, ResumeTokenCodec, ResumeTokenEnvelope } from "../../../ts/runtime-contract";
import type { RunId } from "../../../ts/security-middleware-contract";
import type { RunEvent, RunGuard, RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "./run-transition";
import type { ExecutorChallengeSuspensionPort } from "./executor-completion-coordinator";
import { compiledScenarioFrom } from "./ir-translate";
import { runScenario, type ScenarioOutcome, type SuspendContext } from "./ir-interpreter";

// ops-defaults.md resume_token.ttl=30m(expiresAt). 코드 상수 금지 규약 — inline 인용(RQ-017 패턴).
const RESUME_TOKEN_TTL_MS = 30 * 60 * 1000;

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
  /**
   * 자격증명 에셋 키 → SecretRef(또는 비밀 아닌 에셋 문자열) 바인딩. 시나리오 meta.assets 에서 유도해 주입하며,
   * 실행기 fill(secretRef) 이 ctx.assetRefs[key] 를 SecretStore 경유로 해소한다. 비밀/에셋 구분은 이 주입 지점이 권위.
   */
  readonly assetRefs?: Record<string, SecretRef | string>;
}

export interface DriveDeps {
  readonly pool: Pool;
  readonly executor: ExecutorPlugin;
  readonly resolver: PageStateResolver;
  readonly workerId: string;
  // suspend 경로(트리거 i) 주입 — 미주입 시 suspend terminal 은 loud throw(미구성). 둘 다 있어야 구동.
  readonly suspensionPort?: ExecutorChallengeSuspensionPort;
  readonly resumeTokenCodec?: ResumeTokenCodec;
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
  // claimed → running (R2, started_at). 이후 인터프리터 구동·terminal 매핑은 공유 driveScenario(scenario.start 부터).
  await transition(deps.pool, run, "claimed", { type: "run.started" }, { initOk: true }, deps.workerId);
  return driveScenario(run, deps);
}

/**
 * resume 구동(A.1 resume step4). worker handleRunResume 이 이미 R18(→running)을 적용 — R2 없이 resumeNodeId 부터
 * 재진입해 terminal 까지 구동한다. success/fail/suspend(재-suspend) 모두 driveScenario 의 terminal 매핑 재사용.
 */
export async function driveResumedRun(run: ClaimedRun, deps: DriveDeps, resumeNodeId: string): Promise<DriveResult> {
  return driveScenario(run, deps, resumeNodeId);
}

/**
 * scenario_versions(ir+compiled_ast) 로드 → 인터프리터(startNode 부터, 미지정 시 scenario.start) → terminal DB 전이.
 * 호출 전 run 은 'running' 이어야 한다(driveClaimedRun=R2, driveResumedRun=R18). 인터프리터(브라우저 작업)는 tx 밖.
 */
async function driveScenario(run: ClaimedRun, deps: DriveDeps, startNode?: string): Promise<DriveResult> {
  const sv = await withTenantTx(deps.pool, run.tenantId, async (c) => {
    const r = await c.query<{ ir: unknown; compiled_ast: unknown }>(
      `SELECT ir, compiled_ast FROM scenario_versions WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [run.scenarioVersionId, run.tenantId],
    );
    return r.rows[0] ?? null;
  });
  if (sv === null) {
    throw new Error(`driveScenario: scenario_version '${run.scenarioVersionId}' not found (tenant ${run.tenantId})`);
  }
  // ir=jsonb(객체), compiled_ast=text(JSON 문자열) — 컬럼 타입에 맞춰 정규화.
  const irDoc = typeof sv.ir === "string" ? (JSON.parse(sv.ir) as unknown) : sv.ir;
  const compiledAst = typeof sv.compiled_ast === "string" ? (JSON.parse(sv.compiled_ast) as unknown) : sv.compiled_ast;
  const scenario = compiledScenarioFrom(irDoc, compiledAst, run.params);

  const ctx: RunContext = {
    runId: run.runId,
    tenantId: run.tenantId,
    nodeId: startNode ?? scenario.start,
    attempt: 0,
    siteProfileId: run.siteProfileId,
    browserIdentityId: run.browserIdentityId,
    networkPolicyId: run.networkPolicyId,
    leaseId: run.leaseId,
    assetRefs: run.assetRefs ?? {},
    abortSignal: new AbortController().signal,
    pageState: seedPageState(),
  };
  // startNode(resume): 인터프리터가 그 노드부터 재진입(미지정 시 scenario.start). run.params 를 스코프에 주입(on[].when params.*).
  const outcome = await runScenario(scenario, ctx, { executor: deps.executor, resolver: deps.resolver, params: run.params, startNode });

  // terminal 결과를 DB 전이로 종료(run 은 이미 running — driveClaimedRun R2 / driveResumedRun R18).
  if (outcome.terminal === "success" || outcome.terminal === "success_empty") {
    await transition(deps.pool, run, "running", { type: "last_node_success" }, { flowTerminalReached: true });
    await transition(deps.pool, run, "completing", { type: "finalize_ok" }, { finalizeOk: true });
    return { state: "completed", outcome };
  }
  // 실패 terminal: success(2-hop R7→R21)와 달리 단일 전이(running→failed_*). applyRunTransition 이 run.failed_* emit + ended_at 설정.
  if (outcome.terminal === "fail_business") {
    await transition(deps.pool, run, "running", { type: "business_exception" }, { exceptionClass: "business" });
    return { state: "failed_business", outcome };
  }
  if (outcome.terminal === "fail_system") {
    // R8 pending(captureFailureScreenshot·evaluateDeadLetter)은 다운스트림 디스패처 소유 — driver 미소비(success 경로와 동일).
    await transition(deps.pool, run, "running", { type: "unrecoverable_exception" }, { exceptionClass: "system" });
    return { state: "failed_system", outcome };
  }
  // suspend(트리거 i challenge=R4 / 트리거 ii @human_task=R5; resume 중 재-suspend 포함): running→suspending+포트→resume-token+R11→suspended.
  if (outcome.terminal === "suspend") {
    return driveSuspend(run, deps, outcome);
  }
  // 그 외 terminal: 미구현 — 조용히 흘리지 않고 throw로 표면화(terminal 은 string). @challenge IR 노드는 인터프리터에서 loud throw(미도달).
  throw new Error(`driveScenario: terminal '${outcome.terminal}' 종료 전이 미구현(success/success_empty/fail_business/fail_system/suspend 외). 후속 증분에서 추가.`);
}

/**
 * suspend 경로(A.1 step2+3). 인터프리터 suspend outcome → R4(running→suspending)+human_task 포트 → resume-token 발행+R11(→suspended).
 * R4+포트는 한 tx(R4 pending=[createHumanTask,startBookmark] 를 포트에 전달). 토큰 발행은 SecretStore.resolve(tx 밖, 네트워크).
 * 토큰 save+R11 은 한 tx(원자: 토큰 없이 suspended 금지). R11 pending(issueResumeToken/releaseLease)은 driver 미소비
 * (success/fail 경로와 동일 — lease 회수는 deferred lease lifecycle; 토큰은 R11 전에 이미 발행·저장).
 */
async function driveSuspend(run: ClaimedRun, deps: DriveDeps, outcome: ScenarioOutcome): Promise<DriveResult> {
  const s: SuspendContext | undefined = outcome.suspend;
  if (s === undefined) {
    throw new Error("driveSuspend: terminal 'suspend' 인데 suspend 컨텍스트 부재(인터프리터 불변 위반)");
  }
  const port = deps.suspensionPort;
  const codec = deps.resumeTokenCodec;
  if (port === undefined || codec === undefined) {
    throw new Error("driveSuspend: suspend 경로는 suspensionPort + resumeTokenCodec 주입 필요(미구성)");
  }

  // 1) R4(challenge)/R5(@human_task)(running→suspending) + 포트(human_task INSERT + human_task.created + bookmark) — 한 tenant tx.
  //    두 트리거 모두 pending=[createHumanTask(kind), startBookmark] → 같은 포트가 소비. event/idem 키만 kind 로 분기.
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const event =
      s.kind === "human_task"
        ? ({ type: "human_task_required", humanTaskKind: s.humanTaskKind } as const)
        : ({ type: "step.challenge_detected", challengeKind: s.challengeKind } as const);
    const idemSuffix = s.kind === "human_task" ? "human-task-required" : "challenge-detected";
    const rule = s.kind === "human_task" ? "R5" : "R4";
    const t = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "running",
      event,
      guard: {},
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:${s.stepId}:${s.attempt}:${idemSuffix}`,
    });
    if (!t.applied) {
      throw new Error(`driveSuspend: ${rule} not applied (${t.reason}, observed=${t.observed ?? "none"})`);
    }
    // exception 은 포트가 미사용(vestigial 필수 파라미터) — 있으면 전달, 없으면 기본.
    const exception: ClassifiedException =
      s.exception ?? { class: "challenge", code: "CHALLENGE_UNRESOLVED", message: "suspend" as RedactedString };
    await port.suspendForChallenge(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      stepId: s.stepId,
      attempt: s.attempt,
      correlationId: run.correlationId,
      exception,
      pendingSideEffects: t.pending,
      // @human_task(R5)만 human_tasks 라우팅/타임아웃 정책 + bookmark reason 전달(challenge 는 omit → 기존 동작).
      ...(s.kind === "human_task"
        ? { assigneeRole: s.assigneeRole, onTimeout: s.onTimeout, reason: "human_task" }
        : {}),
    });
  });

  // 2) resume-token 발행(SecretStore.resolve — tx 밖). canonical bytes 로 로컬 HMAC 서명.
  const now = Date.now();
  const token: ResumeTokenEnvelope = await codec.issue({
    runId: run.runId as RunId,
    resumeNodeId: s.resumeNodeId,
    pageStateRef: s.pageStateRef as PageStateRef,
    issuedAt: new Date(now).toISOString() as IsoDateTime,
    expiresAt: new Date(now + RESUME_TOKEN_TTL_MS).toISOString() as IsoDateTime,
  });

  // 3) 토큰 save + R11(suspending→suspended) — 한 tx(원자). guard.resumeTokenIssued=true 는 실제 발행 후에만(stranding 금지).
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const saved = await client.query(
      `UPDATE runs SET resume_token = $3::jsonb, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'suspending'`,
      [run.tenantId, run.runId, JSON.stringify(token)],
    );
    if (saved.rowCount !== 1) {
      throw new Error(`driveSuspend: resume_token save affected ${saved.rowCount ?? 0} rows (run not in suspending)`);
    }
    const r11 = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "suspending",
      event: { type: "bookmark_saved" },
      guard: { resumeTokenIssued: true },
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:bookmark_saved`,
    });
    if (!r11.applied) {
      throw new Error(`driveSuspend: R11 not applied (${r11.reason}, observed=${r11.observed ?? "none"})`);
    }
  });

  return { state: "suspended", outcome };
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
