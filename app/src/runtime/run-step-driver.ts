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
  ArtifactRef,
  ClassifiedException,
  ExecutorPlugin,
  IRActionType,
  PageState,
  PageStateRef,
  PageStateResolver,
  RedactedString,
  RunContext,
  SecretRef,
  StepResult,
} from "../../../ts/core-types";
import type {
  IsoDateTime,
  ExecutorInvocationArtifactMetadata,
  ResumeTokenCodec,
  ResumeTokenEnvelope,
  RuntimeWorkerJob,
  LeaseId,
  RunVideoRecording,
  VisualEvidenceVideoPolicy,
  VisualEvidenceVideoRecorder,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import type { RunEvent, RunGuard, RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import type { CdpSessionProvider } from "../executor/cdp-session";
import { clearCookies, getAllCookies, setCookies } from "../executor/raw-cdp";
import { applyRunTransition } from "./run-transition";
import { sessionKey, type BrowserSessionStore } from "./browser-session-store";
import type { ExecutorChallengeSuspensionPort, RuntimeJobEnqueuePort } from "./executor-completion-coordinator";
import { PgExecutorStepAttemptStore } from "./executor-step-attempt-store";
import { PgExecutorInvocationRecorder } from "./executor-invocation-recorder";
import { executorFailureStepResult } from "./executor-step-orchestrator";
import { compiledScenarioFrom } from "./ir-translate";
import { runScenario, type ScenarioOutcome, type SuspendContext } from "./ir-interpreter";
import type { MergedExtractArtifactSink } from "./merged-extract-artifact";
import { VisualEvidenceExecutor, type VisualEvidenceRecorder } from "./visual-evidence";

// ops-defaults.md resume_token.ttl=30m(expiresAt). 코드 상수 금지 규약 — inline 인용(RQ-017 패턴).
const RESUME_TOKEN_TTL_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const videoPolicy = videoPolicyFromIr(irDoc);
  if (videoPolicy !== undefined && deps.visualEvidenceVideoRecorder === undefined) {
    const outcome = systemFailureOutcome();
    await failRunningRun(run, deps, outcome);
    return { state: "failed_system", outcome };
  }

  const ctx: RunContext = {
    runId: run.runId,
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
  if (deps.visualEvidenceRecorder !== undefined && deps.sessionProvider !== undefined) {
    executor = new VisualEvidenceExecutor(executor, deps.sessionProvider, deps.visualEvidenceRecorder);
  }
  if (deps.recordExecutorSteps === true) {
    executor = new StepRecordingExecutor(deps.pool, executor, run);
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
    } catch {
      scenarioOutcome = systemFailureOutcome();
    }
    scenarioOutcome = await appendMergedExtractArtifact(scenarioOutcome, deps.mergedExtractArtifactSink, run);
    outcome = await appendRunVideoArtifact(scenarioOutcome, videoRecording, videoPolicy);
  } catch {
    if (videoRecording !== undefined) {
      await videoRecording.discard({ reason: "run_drive_error" });
    }
    outcome = systemFailureOutcome();
  }

  // terminal 결과를 DB 전이로 종료(run 은 이미 running — driveClaimedRun R2 / driveResumedRun R18).
  if (outcome.terminal === "success" || outcome.terminal === "success_empty") {
    await transition(deps.pool, run, "running", { type: "last_node_success" }, { flowTerminalReached: true });
    await transition(deps.pool, run, "completing", { type: "finalize_ok" }, { finalizeOk: true }, undefined, (client) =>
      enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome),
    );
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
    await transition(deps.pool, run, "running", { type: "business_exception" }, { exceptionClass: "business" }, undefined, (client) =>
      enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome),
    );
    return { state: "failed_business", outcome };
  }
  if (outcome.terminal === "fail_system") {
    // R8 pending(captureFailureScreenshot·evaluateDeadLetter)은 다운스트림 디스패처 소유 — driver 미소비(success 경로와 동일).
    await transition(deps.pool, run, "running", { type: "unrecoverable_exception" }, { exceptionClass: "system" }, undefined, (client) =>
      enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome),
    );
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
    await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
  });

  return { state: "suspended", outcome };
}

// 단일 전이를 자체 CAS 트랜잭션으로 적용. eventIdempotencyKey는 이벤트별 접미(outbox UNIQUE 충돌 방지).
function videoPolicyFromIr(irDoc: unknown): VisualEvidenceVideoPolicy | undefined {
  if (!isRecord(irDoc)) return undefined;
  const meta = irDoc.meta;
  if (!isRecord(meta)) return undefined;
  const evidence = meta.evidence;
  if (!isRecord(evidence)) return undefined;
  const video = evidence.video;
  if (video === "always" || video === "failure") return video;
  return undefined;
}

function systemFailureOutcome(): ScenarioOutcome {
  return { terminal: "fail_system", visited: [], steps: [], artifacts: [] };
}

const EXECUTOR_ACTIONS = new Set<string>(["act", "observe", "extract", "navigate", "download", "upload", "api_call", "file", "human_task", "shell"]);

class StepRecordingExecutor implements ExecutorPlugin {
  private readonly attemptStore: PgExecutorStepAttemptStore;
  private readonly recorder: PgExecutorInvocationRecorder;

  constructor(
    private readonly pool: Pool,
    private readonly inner: ExecutorPlugin,
    private readonly run: ClaimedRun,
  ) {
    this.attemptStore = new PgExecutorStepAttemptStore(pool);
    this.recorder = new PgExecutorInvocationRecorder(pool);
  }

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return this.inner.capabilities();
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    const actionType = actionTypeFromExecutorAction(action);
    const startedAt = new Date().toISOString();
    const started = await this.attemptStore.begin({
      tenantId: this.run.tenantId as TenantId,
      runId: this.run.runId as RunId,
      stepId: stepId as StepId,
      nodeId: ctx.nodeId,
      action: actionType,
      correlationId: this.run.correlationId as CorrelationId,
      startedAt: startedAt as IsoDateTime,
    });
    const stepCtx: RunContext = {
      ...ctx,
      tenantId: this.run.tenantId,
      runId: this.run.runId,
      nodeId: ctx.nodeId,
      attempt: started.key.attempt,
    };

    let result: StepResult;
    try {
      result = await this.inner.execute(stepId, action, stepCtx);
    } catch (error) {
      result = executorFailureStepResult({ stepId, actionType }, stepCtx, startedAt, error);
    }

    const stepArtifacts = await loadPersistedStepArtifactMetadata(this.pool, {
      tenantId: this.run.tenantId,
      runId: this.run.runId,
      stepId,
      attempt: started.key.attempt,
      artifactRefs: result.artifacts,
    });
    const recordResult =
      stepArtifacts.length === result.artifacts.length
        ? result
        : { ...result, artifacts: stepArtifacts.map((artifact) => artifact.artifactRef) };
    await this.recorder.record({
      key: started.key,
      nodeId: ctx.nodeId,
      correlationId: this.run.correlationId as CorrelationId,
      result: recordResult,
      artifacts: stepArtifacts,
    });
    await preserveHiddenPersistedArtifactRefs(this.pool, {
      tenantId: this.run.tenantId,
      runId: this.run.runId,
      stepId,
      attempt: started.key.attempt,
      nodeId: ctx.nodeId,
      action: actionType,
      artifactRefs: result.artifacts,
      recordedArtifactRefs: recordResult.artifacts,
    });
    return result;
  }

  verify(criteria: unknown, ctx: RunContext) {
    return this.inner.verify(criteria, ctx);
  }
}

interface HiddenPersistedArtifactRefInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly nodeId: string;
  readonly action: IRActionType;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly recordedArtifactRefs: readonly ArtifactRef[];
}

async function preserveHiddenPersistedArtifactRefs(
  pool: Pool,
  input: HiddenPersistedArtifactRefInput,
): Promise<void> {
  const refs = input.artifactRefs.filter(isUuidArtifactRef);
  if (refs.length === 0) return;
  const uniqueRefs = [...new Set(refs)];
  if (sameRefs(uniqueRefs, input.recordedArtifactRefs)) return;

  await withTenantTx(pool, input.tenantId, async (client) => {
    const updated = await client.query(
      `UPDATE run_steps
          SET artifacts=$1::text[]
        WHERE tenant_id=$2::uuid
          AND run_id=$3::uuid
          AND step_id=$4
          AND attempt=$5::int
          AND node_id=$6
          AND action=$7`,
      [uniqueRefs, input.tenantId, input.runId, input.stepId, input.attempt, input.nodeId, input.action],
    );
    if (updated.rowCount !== 1) {
      throw new Error("driveScenario: failed to preserve hidden persisted artifact refs on run_steps");
    }
  });
}

function isUuidArtifactRef(ref: ArtifactRef): boolean {
  return UUID_RE.test(ref);
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface PersistedStepArtifactLookup {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly artifactRefs: readonly ArtifactRef[];
}

async function loadPersistedStepArtifactMetadata(
  pool: Pool,
  input: PersistedStepArtifactLookup,
): Promise<readonly ExecutorInvocationArtifactMetadata[]> {
  if (input.artifactRefs.length === 0) return [];
  const uniqueRefs = [...new Set(input.artifactRefs)];
  return withTenantTx(pool, input.tenantId, async (client) => {
    const rows = await client.query<{
      artifact_ref: string;
      object_ref: string;
      type: string;
      media_type: string | null;
      filename: string | null;
      byte_size: string | null;
      duration_ms: number | null;
      redaction_status: string;
      retention_until: Date | string | null;
      sha256: string | null;
      legal_hold: boolean;
      quarantine: boolean;
    }>(
      `SELECT id::text AS artifact_ref, object_ref, type, media_type, filename, byte_size::text,
              duration_ms, redaction_status, retention_until, sha256, legal_hold, quarantine
         FROM artifacts
        WHERE tenant_id=$1::uuid
          AND run_id=$2::uuid
          AND step_id=$3
          AND attempt=$4::int
          AND id::text = ANY($5::text[])
        ORDER BY array_position($5::text[], id::text)`,
      [input.tenantId, input.runId, input.stepId, input.attempt, uniqueRefs],
    );
    return rows.rows.map((row) => ({
      artifactRef: row.artifact_ref as ArtifactRef,
      objectRef: row.object_ref as ExecutorInvocationArtifactMetadata["objectRef"],
      type: row.type,
      ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
      ...(row.filename !== null ? { filename: row.filename } : {}),
      ...(row.byte_size !== null ? { byteSize: Number(row.byte_size) } : {}),
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      redactionStatus: "pending",
      retentionUntil: isoDateTime(row.retention_until, "artifact.retention_until"),
      ...(row.sha256 !== null ? { sha256: row.sha256 } : {}),
      legalHold: row.legal_hold,
      quarantine: row.quarantine,
      metadataStored: true,
    }));
  });
}

function actionTypeFromExecutorAction(action: unknown): IRActionType {
  if (typeof action === "object" && action !== null && "type" in action) {
    const type = (action as { type?: unknown }).type;
    if (typeof type === "string" && EXECUTOR_ACTIONS.has(type)) return type as IRActionType;
  }
  throw new Error("driveScenario: executor action missing supported type before step recording");
}

function isoDateTime(value: Date | string | null, label: string): IsoDateTime {
  if (value instanceof Date) return value.toISOString() as IsoDateTime;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString() as IsoDateTime;
  }
  throw new Error(`driveScenario: ${label} is required for step artifact metadata`);
}

async function failRunningRun(run: ClaimedRun, deps: DriveDeps, outcome: ScenarioOutcome): Promise<void> {
  await transition(deps.pool, run, "running", { type: "unrecoverable_exception" }, { exceptionClass: "system" }, undefined, (client) =>
    enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome),
  );
}

async function appendRunVideoArtifact(
  outcome: ScenarioOutcome,
  recording: RunVideoRecording | undefined,
  policy: VisualEvidenceVideoPolicy | undefined,
): Promise<ScenarioOutcome> {
  if (recording === undefined || policy === undefined) return outcome;
  if (policy === "failure" && (outcome.terminal === "success" || outcome.terminal === "success_empty")) {
    await recording.discard({ reason: "terminal_success" });
    return outcome;
  }
  const artifactRef = await recording.stopAndPersist({ terminal: knownTerminal(outcome.terminal) });
  if (artifactRef === undefined) return outcome;
  return { ...outcome, artifacts: [...outcome.artifacts, artifactRef] };
}

async function appendMergedExtractArtifact(
  outcome: ScenarioOutcome,
  sink: MergedExtractArtifactSink | undefined,
  run: ClaimedRun,
): Promise<ScenarioOutcome> {
  if (sink === undefined || outcome.mergedExtract === undefined) return outcome;
  const artifactRef = await sink.put({
    tenantId: run.tenantId,
    runId: run.runId,
    correlationId: run.correlationId,
    extractPages: outcome.extractPages ?? [],
    mergedExtract: outcome.mergedExtract,
  });
  return { ...outcome, artifacts: [...outcome.artifacts, artifactRef] };
}

function knownTerminal(terminal: string): "success" | "success_empty" | "fail_business" | "fail_system" | "suspend" {
  if (
    terminal === "success" ||
    terminal === "success_empty" ||
    terminal === "fail_business" ||
    terminal === "fail_system" ||
    terminal === "suspend"
  ) {
    return terminal;
  }
  throw new Error(`driveScenario: terminal '${terminal}' cannot finalize run video evidence`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function enqueueArtifactLifecycleJobsForOutcome(
  client: PoolClient,
  run: ClaimedRun,
  deps: DriveDeps,
  outcome: ScenarioOutcome,
): Promise<void> {
  const artifactRefs = [...new Set(outcome.artifacts)];
  if (artifactRefs.length === 0) return;
  const enqueuer = deps.runtimeJobEnqueuer;
  if (enqueuer === undefined) {
    throw new Error("driveScenario: artifacts produced on direct run-drive require RuntimeJobEnqueuePort for lifecycle jobs");
  }
  const jobs: RuntimeWorkerJob[] = [
    {
      kind: "artifact_redaction",
      tenantId: run.tenantId as RuntimeWorkerJob["tenantId"],
      runId: run.runId as RuntimeWorkerJob["runId"],
      correlationId: run.correlationId as RuntimeWorkerJob["correlationId"],
    },
    {
      kind: "artifact_retention",
      tenantId: run.tenantId as RuntimeWorkerJob["tenantId"],
      correlationId: run.correlationId as RuntimeWorkerJob["correlationId"],
    },
  ];
  for (const job of jobs) {
    await enqueuer.enqueueRuntimeJob(client, job);
  }
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
