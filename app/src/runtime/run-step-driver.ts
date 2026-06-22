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
import type { Pool, PoolClient } from "pg";

import type {
  ClassifiedException,
  ExecutorPlugin,
  PageState,
  PageStateRef,
  PageStateResolver,
  RedactedString,
  RunContext,
  SecretRef,
} from "../../../ts/core-types";
import type {
  IsoDateTime,
  ResumeTokenCodec,
  ResumeTokenEnvelope,
  LeaseId,
  RunVideoRecording,
  VisualEvidenceVideoRecorder,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import type { RunEvent, RunGuard, RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import type { CdpSessionProvider } from "../executor/cdp-session";
import { clearCookies, getAllCookies, setCookies } from "../executor/raw-cdp";
import { applyRunTransition } from "./run-transition";
import { sessionKey, type BrowserSessionStore } from "./browser-session-store";
import type { ExecutorChallengeSuspensionPort, RuntimeJobEnqueuePort } from "./executor-ports";
import { StepRecordingExecutor } from "./run-step-driver-recording";
import {
  appendMergedExtractArtifact,
  appendRunVideoArtifact,
  enqueueArtifactLifecycleJobsForOutcome,
  systemFailureOutcome,
  videoPolicyFromIr,
  visualEvidenceLifecycleEnqueuerRequired,
} from "./run-step-driver-artifacts";
import { compiledScenarioFrom } from "./ir-translate";
import { InterpreterError, runScenario, type ScenarioOutcome, type SuspendContext } from "./ir-interpreter";
import { pauseLinkedWorkitemCheckout, settleLinkedWorkitemForRunTerminal, type RunTerminalKind } from "./workitem-settlement";
import { cancelLinkedHumanTasksForRunTerminal } from "./human-task-transition";
import { recordChallenge } from "../observability/telemetry";
import type { MergedExtractArtifactSink } from "./merged-extract-artifact";
import {
  VisualEvidenceExecutor,
  type VisualEvidenceRecorder,
} from "./visual-evidence";

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
  readonly networkAllowedDomains?: readonly string[];
  /** runs.params(실행 파라미터). navigate.url_ref 가 이 params 의 키로 해소된다. */
  readonly params?: Record<string, unknown>;
  /**
   * 자격증명 에셋 키 → SecretRef(또는 비밀 아닌 에셋 문자열) 바인딩. 시나리오 meta.assets 에서 유도해 주입하며,
   * 실행기 fill(secretRef) 이 ctx.assetRefs[key] 를 SecretStore 경유로 해소한다. 비밀/에셋 구분은 이 주입 지점이 권위.
   */
  readonly assetRefs?: Record<string, SecretRef | string>;
}

/**
 * terminalize/정산이 실제로 쓰는 run 식별 최소 형태. ClaimedRun 은 구조적으로 이에 할당 가능하며, resume 완료 tx 가
 * 좌초(영속 인프라 throw)해 전체 ClaimedRun 을 구성하지 못하는 실패 윈도우에서도 동일 종결 경로를 호출할 수 있다.
 */
export type RunTerminalRef = Pick<ClaimedRun, "tenantId" | "runId" | "correlationId">;

export interface DriveDeps {
  readonly pool: Pool;
  readonly executor: ExecutorPlugin;
  readonly resolver: PageStateResolver;
  readonly workerId: string;
  // suspend 경로(트리거 i) 주입 — 미주입 시 suspend terminal 은 loud throw(미구성). 둘 다 있어야 구동.
  readonly suspensionPort?: ExecutorChallengeSuspensionPort;
  readonly resumeTokenCodec?: ResumeTokenCodec;
  // 세션 재사용(방식 A) — 둘 다 주입돼야 동작(optional, 미주입 callers 무영향). sessionProvider 는 live CdpSession 핸들
  //   (driver 가 executor 추상화 너머 두 번째 런타임 포트에 의존 — 작지만 실 결합 증가, run-lifecycle 소유자라 정당).
  readonly sessionStore?: BrowserSessionStore;
  readonly sessionProvider?: CdpSessionProvider;
  /**
   * Optional visual evidence capture. When present with sessionProvider, node.policy.recording controls
   * screenshot artifact capture on the direct run-drive path. Rows are inserted as pending artifacts for
   * the redaction lifecycle; content/body disclosure remains gated by artifact RLS.
   */
  readonly visualEvidenceRecorder?: VisualEvidenceRecorder;
  /** Optional run-level video capture. Generation blocks video requests unless the deployment exposes this capability. */
  readonly visualEvidenceVideoRecorder?: VisualEvidenceVideoRecorder;
  /** Optional run-level final extract artifact capture for merged repeated/single extract results. */
  readonly mergedExtractArtifactSink?: MergedExtractArtifactSink;
  /** Direct run-drive artifacts must enter the redaction/retention lifecycle before they are user-visible. */
  readonly runtimeJobEnqueuer?: RuntimeJobEnqueuePort;
  /** Worker direct-drive path records executor started/completed rows before/after each executor invocation. */
  readonly recordExecutorSteps?: boolean;
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
  return driveScenarioWithSystemFailsafe(run, deps);
}

/**
 * resume 구동(A.1 resume step4). worker handleRunResume 이 이미 R18(→running)을 적용 — R2 없이 resumeNodeId 부터
 * 재진입해 terminal 까지 구동한다. success/fail/suspend(재-suspend) 모두 driveScenario 의 terminal 매핑 재사용.
 */
export async function driveResumedRun(run: ClaimedRun, deps: DriveDeps, resumeNodeId: string): Promise<DriveResult> {
  return driveScenarioWithSystemFailsafe(run, deps, resumeNodeId);
}

/**
 * driveScenario 를 system-failure 폴백으로 감싼다(C3 좀비 run 방지). R2/R18 로 running 진입 후 본문이 throw 하면
 * (scenario_version 부재·suspend 포트 미구성·미구현 terminal·전이 CAS 실패 등) run 이 running/completing 에 영구
 * 잔류한다. 이를 막기 위해 throw 를 failed_system 종결로 변환하고(연결 Workitem 도 system 정산) 원 예외는 진단
 * 로그로 표면화한다 — 미분류 예외를 system 으로 흡수("조용한 false/unknown 금지": system 이 loud 채널). 변환 불가
 * 상태(이미 종결/suspended 등)면 원 예외를 재던진다.
 */
async function driveScenarioWithSystemFailsafe(run: ClaimedRun, deps: DriveDeps, startNode?: string): Promise<DriveResult> {
  try {
    return await driveScenario(run, deps, startNode);
  } catch (err) {
    const terminalized = await terminalizeStuckRunAsSystemFailure(run, deps.pool);
    if (!terminalized) throw err;
    console.error(
      `run-step-driver: drive 예외를 failed_system 으로 종결(run ${run.runId.slice(0, 8)}) — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { state: "failed_system", outcome: systemFailureOutcome() };
  }
}

/**
 * 좀비 방지(C3): 현재 상태를 재read(FOR UPDATE)해 running→failed_system(R8) / completing→failed_system(R22) / resuming→failed_system(R20) /
 * suspending→failed_system(R12) 로 종결하고 연결 Workitem 을 system 정산한다(suspending 은 bookmark 저장 중
 * R4/R5 commit 후 resume-token 발행·저장이 tx 밖 외부 I/O라 부분 실패 윈도우 — R12 '일관성 복구'로 종결). 폴백이라
 * throw 금지 — 변환 불가(이미 종결/동시 CAS 변경/정산 실패)면 false 를 반환해 호출부가 원 예외를 재던지게 한다.
 */
export async function terminalizeStuckRunAsSystemFailure(run: RunTerminalRef, pool: Pool): Promise<boolean> {
  try {
    return await withTenantTx(pool, run.tenantId, async (client) => {
      const r = await client.query<{ status: RunState }>(
        `SELECT status FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
        [run.tenantId, run.runId],
      );
      const status = r.rows[0]?.status;
      if (status !== "running" && status !== "completing" && status !== "suspending" && status !== "resuming" && status !== "claimed") return false;
      const event: RunEvent =
        status === "running" ? { type: "unrecoverable_exception" }
          : status === "completing" ? { type: "finalize_failed" }
          : status === "suspending" ? { type: "bookmark_failed" }
          : status === "claimed" ? { type: "init_failed" } // R3b: 크래시한 INIT(좀비 claimed)을 system 실패로 종결
          : { type: "restore_failed" }; // resuming → R20(완료 전이 tx 자체가 좌초)
      const guard: RunGuard =
        status === "running" ? { exceptionClass: "system" }
          : status === "resuming" ? { loginBypassPossible: false } // R20: 재로그인 우회 불가 종결
          : status === "claimed" ? { initFailBelowThreshold: false } // R3b: 임계 초과 취급 → failed_system(재큐 금지)
          : {};
      const t = await applyRunTransition(client, {
        tenantId: run.tenantId,
        runId: run.runId,
        fromStatus: status,
        event,
        guard,
        correlationId: run.correlationId,
        eventIdempotencyKey: `${run.runId}:${event.type}`,
      });
      if (!t.applied) return false;
      await settleLinkedWorkitemFromRun(client, run, "system");
      // H7: run 종결(failed_system) 시 연결된 비종결 human_task 를 cancel — 인박스 orphan + resolve silent-false 차단.
      await cancelLinkedHumanTasksForRunTerminal(client, { tenantId: run.tenantId, runId: run.runId, correlationId: run.correlationId });
      return true;
    });
  } catch (e) {
    console.error(
      `run-step-driver: failed_system 폴백 종결 실패(run ${run.runId.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
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
  const videoPolicy = videoPolicyFromIr(irDoc);
  if (videoPolicy !== undefined && deps.visualEvidenceVideoRecorder === undefined) {
    const outcome = systemFailureOutcome();
    await failRunningRun(run, deps, outcome);
    return { state: "failed_system", outcome };
  }
  // Injected visual recorders can create pending artifact bytes; require lifecycle enqueue before session/executor access.
  if (visualEvidenceLifecycleEnqueuerRequired(deps) && deps.runtimeJobEnqueuer === undefined) {
    const outcome = systemFailureOutcome();
    await failRunningRun(run, deps, outcome);
    return { state: "failed_system", outcome };
  }

  const ctx: RunContext = {
    runId: run.runId,
    correlationId: run.correlationId,
    tenantId: run.tenantId,
    nodeId: startNode ?? scenario.start,
    attempt: 0,
    siteProfileId: run.siteProfileId,
    browserIdentityId: run.browserIdentityId,
    networkPolicyId: run.networkPolicyId,
    ...(run.networkAllowedDomains !== undefined ? { networkAllowedDomains: run.networkAllowedDomains } : {}),
    leaseId: run.leaseId,
    assetRefs: run.assetRefs ?? {},
    abortSignal: new AbortController().signal,
    pageState: seedPageState(),
  };
  // 세션 재사용(방식 A) 복원 — navigate 이전 유일 seam(driver). 저장된 쿠키가 있으면 주입 → 인증 상태로 진입(login 서브플로
  //   스킵은 시나리오의 observe/on[] 게이트가 결정). store+provider 둘 다 주입 시에만. 복원 CDP 실패는 표면화(조용히
  //   '유효 세션 가정' 금지) — 반-복원 세션으로 진행하지 않는다.
  if (deps.sessionStore !== undefined && deps.sessionProvider !== undefined) {
    const sess = deps.sessionProvider.forLease(run.leaseId);
    // 잔여 쿠키 제거 → 세션 상태는 저장소가 권위(dev 단일세션 재사용·prod 풀 재할당의 cross-run/lease 잔류 차단).
    await clearCookies(sess);
    const bundle = await deps.sessionStore.load(sessionKey(run.tenantId, run.siteProfileId, run.browserIdentityId));
    if (bundle !== null && bundle.cookies.length > 0) {
      await setCookies(sess, bundle.cookies);
    }
  }

  // startNode(resume): 인터프리터가 그 노드부터 재진입(미지정 시 scenario.start). run.params 를 스코프에 주입(on[].when params.*).
  let executor = deps.executor;
  const visualEvidence =
    deps.visualEvidenceRecorder !== undefined && deps.sessionProvider !== undefined
      ? { sessions: deps.sessionProvider, recorder: deps.visualEvidenceRecorder }
      : undefined;
  if (deps.recordExecutorSteps === true) {
    executor = new StepRecordingExecutor(deps.pool, executor, run, visualEvidence);
  } else if (visualEvidence !== undefined) {
    executor = new VisualEvidenceExecutor(executor, visualEvidence.sessions, visualEvidence.recorder);
  }
  let videoRecording: RunVideoRecording | undefined;
  let outcome: ScenarioOutcome;
  try {
    if (videoPolicy !== undefined && deps.visualEvidenceVideoRecorder !== undefined) {
      videoRecording = await deps.visualEvidenceVideoRecorder.startRunVideo({
        tenantId: run.tenantId as TenantId,
        runId: run.runId as RunId,
        leaseId: run.leaseId as LeaseId,
        correlationId: run.correlationId as CorrelationId,
        policy: videoPolicy,
      });
    }
    let scenarioOutcome: ScenarioOutcome;
    try {
      scenarioOutcome = await runScenario(scenario, ctx, { executor, resolver: deps.resolver, params: run.params, startNode });
    } catch (scenarioErr) {
      // 인터프리터 예외를 system 으로 흡수하되 조용히 묻지 않는다(조용한 false/unknown 금지 — system 은 loud 채널).
      //   InterpreterError 면 code 도 표면화(터미널 분류·디버깅 신호 보존). 종결(running→failed_system)은 driveScenario 가 처리.
      const code = scenarioErr instanceof InterpreterError ? `[${scenarioErr.code}] ` : "";
      console.error(
        `run-step-driver: 인터프리터 예외를 failed_system 으로 흡수(run ${run.runId.slice(0, 8)}) — ${code}${scenarioErr instanceof Error ? scenarioErr.message : String(scenarioErr)}`,
      );
      scenarioOutcome = systemFailureOutcome();
    }
    scenarioOutcome = await appendMergedExtractArtifact(scenarioOutcome, deps.mergedExtractArtifactSink, run);
    outcome = await appendRunVideoArtifact(scenarioOutcome, videoRecording, videoPolicy);
  } catch (driveErr) {
    // video 시작·아티팩트 append 실패를 system 으로 흡수하되 조용히 묻지 않는다(조용한 false 금지 — system 은 loud
    //   채널). 안쪽 인터프리터 예외(runScenario)는 위 catch 가 이미 로그하므로 이 외곽 catch 만 무로그였다.
    console.error(
      `run-step-driver: drive 외곽(video/artifact) 실패를 failed_system 으로 흡수(run ${run.runId.slice(0, 8)}) — ${driveErr instanceof Error ? driveErr.message : String(driveErr)}`,
    );
    if (videoRecording !== undefined) {
      await videoRecording.discard({ reason: "run_drive_error" });
    }
    outcome = systemFailureOutcome();
  }

  // terminal 결과를 DB 전이로 종료(run 은 이미 running — driveClaimedRun R2 / driveResumedRun R18).
  if (outcome.terminal === "success" || outcome.terminal === "success_empty") {
    await transition(deps.pool, run, "running", { type: "last_node_success" }, { flowTerminalReached: true });
    // R21(completing→completed) 과 동일 tx 에서 연결 Workitem 을 W2(successful)로 정산("1 Workitem = 1 Run", state-machine.md:76).
    await transition(deps.pool, run, "completing", { type: "finalize_ok" }, { finalizeOk: true }, undefined, async (client) => {
      await settleLinkedWorkitemFromRun(client, run, "success");
      await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
    });
    // 세션 재사용 캡처 — 성공 종료 후 현재 쿠키 스냅샷 저장(다음 run 재사용). run 은 이미 completed 이므로 캡처 실패는
    //   best-effort-but-loud(조용히 흘리지 않되 완료된 run 을 실패로 만들지 않음 — 다음 run 이 재로그인).
    if (deps.sessionStore !== undefined && deps.sessionProvider !== undefined) {
      try {
        const cookies = await getAllCookies(deps.sessionProvider.forLease(run.leaseId));
        await deps.sessionStore.save(sessionKey(run.tenantId, run.siteProfileId, run.browserIdentityId), { cookies });
      } catch (e) {
        console.error(`run-step-driver: 세션 캡처 실패(run ${run.runId.slice(0, 8)}, 완료는 유지) — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { state: "completed", outcome };
  }
  // 실패 terminal: success(2-hop R7→R21)와 달리 단일 전이(running→failed_*). applyRunTransition 이 run.failed_* emit + ended_at 설정.
  if (outcome.terminal === "fail_business") {
    // R9(running→failed_business) 과 동일 tx 에서 연결 Workitem 을 W3(failed_business)로 정산.
    await transition(deps.pool, run, "running", { type: "business_exception" }, { exceptionClass: "business" }, undefined, async (client) => {
      await settleLinkedWorkitemFromRun(client, run, "business");
      await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
    });
    return { state: "failed_business", outcome };
  }
  if (outcome.terminal === "fail_system") {
    // R8(running→failed_system) 과 동일 tx 에서 연결 Workitem 을 W4(retry)/W5(abandoned+dead_letter)로 정산.
    await transition(deps.pool, run, "running", { type: "unrecoverable_exception" }, { exceptionClass: "system" }, undefined, async (client) => {
      await settleLinkedWorkitemFromRun(client, run, "system");
      await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
    });
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

  // §E challenge_rate: challenge 자동 감지(인간개입 @human_task 트리거 제외) 카운트. bootstrap 전이면 no-op meter.
  if (s.kind !== "human_task") {
    recordChallenge({ tenant_id: run.tenantId });
  }

  // 멱등 키 per-cycle 스코프 해소(같은 노드 재suspend 시 키 충돌 방지 — resolveSuspendKeyAttempt 참조).
  const keyAttempt = await resolveSuspendKeyAttempt(deps.pool, run, s.stepId, s.attempt);

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
      eventIdempotencyKey: `${run.runId}:${s.stepId}:${keyAttempt}:${idemSuffix}`,
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
      attempt: keyAttempt,
      correlationId: run.correlationId,
      exception,
      pendingSideEffects: t.pending,
      // @human_task(R5)만 human_tasks 라우팅/타임아웃 정책 + bookmark reason 전달(challenge 는 omit → 기존 동작).
      ...(s.kind === "human_task"
        ? { assigneeRole: s.assigneeRole, onTimeout: s.onTimeout, reason: "human_task" }
        : {}),
    });
    // W9: suspend 시 연결 workitem 의 checkout timer pause(suspend 중 checkout 10m 만료로 회수/abandon 오발 방지).
    await pauseLinkedWorkitemCheckout(client, { tenantId: run.tenantId, runId: run.runId, correlationId: run.correlationId });
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
      eventIdempotencyKey: `${run.runId}:${s.stepId}:${keyAttempt}:bookmark_saved`,
    });
    if (!r11.applied) {
      throw new Error(`driveSuspend: R11 not applied (${r11.reason}, observed=${r11.observed ?? "none"})`);
    }
    await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
  });

  return { state: "suspended", outcome };
}

/**
 * suspend-side outbox 멱등 키(R4/R5·human_task.created·R11)의 per-suspend-cycle 스코프. 인터프리터 ctx.attempt 은 매
 * 드라이브 0 에서 시작해 같은 노드 재suspend(resume 후 재진입) 시 키가 충돌(events_outbox UNIQUE)한다. 기록 executor 가
 * run_steps 에 (run,step)별 단조 증가 attempt(MAX+1)를 영속하므로 그 최댓값을 키 스코프로 쓴다 — per-cycle 고유 +
 * 재시도 안정(영속). 기록 미사용(ad-hoc) run 은 run_steps 부재 → fallback(s.attempt, 단일 사이클).
 */
async function resolveSuspendKeyAttempt(pool: Pool, run: RunTerminalRef, stepId: string, fallback: number): Promise<number> {
  return withTenantTx(pool, run.tenantId, async (client) => {
    const r = await client.query<{ attempt: number }>(
      `SELECT COALESCE(MAX(attempt), $3::int) AS attempt FROM run_steps WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$4`,
      [run.tenantId, run.runId, fallback, stepId],
    );
    return r.rows[0]?.attempt ?? fallback;
  });
}

// 단일 전이를 자체 CAS 트랜잭션으로 적용. eventIdempotencyKey는 이벤트별 접미(outbox UNIQUE 충돌 방지).
async function failRunningRun(run: ClaimedRun, deps: DriveDeps, outcome: ScenarioOutcome): Promise<void> {
  await transition(deps.pool, run, "running", { type: "unrecoverable_exception" }, { exceptionClass: "system" }, undefined, async (client) => {
    await settleLinkedWorkitemFromRun(client, run, "system");
    await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
  });
}

/**
 * Run 종결 전이와 동일 tx 에서 연결 Workitem 을 단말 정산한다(W2/W3/W4/W5 + dead_letter). runs.workitem_id 를 이 tx 에서
 * 해소해 공유 정산 함수에 전달 — workitem 미연결(ad-hoc run) 이면 no-op. driveClaimedRun(production) 의 두 완료 경로
 * 단절(workitem processing 영구잔류·DLQ 미발화)을 닫는다. coordinator 와 정산 로직을 공유한다(단일 진실원천).
 */
async function settleLinkedWorkitemFromRun(client: PoolClient, run: RunTerminalRef, terminal: RunTerminalKind): Promise<void> {
  const r = await client.query<{ workitem_id: string | null }>(
    `SELECT workitem_id::text FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [run.tenantId, run.runId],
  );
  await settleLinkedWorkitemForRunTerminal(client, r.rows[0]?.workitem_id ?? null, {
    tenantId: run.tenantId,
    runId: run.runId,
    correlationId: run.correlationId,
    terminal,
    eventIdempotencyKey: `${run.runId}:workitem-${terminal}`,
  });
}

async function transition(
  pool: Pool,
  run: ClaimedRun,
  fromStatus: RunState,
  event: RunEvent,
  guard: RunGuard,
  workerId?: string,
  afterApplied?: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await withTenantTx(pool, run.tenantId, async (c) => {
    const outcome = await applyRunTransition(c, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus,
      event,
      guard,
      correlationId: run.correlationId,
      workerId,
      eventIdempotencyKey: `${run.runId}:${event.type}`,
    });
    if (!outcome.applied) {
      throw new Error(`driveClaimedRun: transition '${event.type}' from '${fromStatus}' not applied (${outcome.reason}, observed=${outcome.observed ?? "none"})`);
    }
    if (afterApplied !== undefined) await afterApplied(c);
  });
}
