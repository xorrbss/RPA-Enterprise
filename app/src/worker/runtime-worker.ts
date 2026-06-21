/**
 * RuntimeWorker — Worker 잡 디스패처 (D2 골격, ts/runtime-contract.ts 구현).
 *
 * 계약: RuntimeWorker.handle(job: RuntimeWorkerJob) → RuntimeJobResult. job kind는
 * release-decisions.md #9의 닫힌 집합. 본 골격은 D2에서 검증 가능한 잡만 구현하고, D3(executor/lease)·
 * D6(pipeline)에 의존하는 잡은 **조용한 no-op 없이** 명시적으로 throw한다(가정 금지).
 *
 * 큐 런너(Graphile Worker) 연결은 D2.5 어댑터에서 본 handle()에 위임한다.
 */
import type pg from "pg";

import {
  claimAbortBrowserLeaseForRun,
  deleteInitReservedBrowserLease,
  finalizeRunAbort,
  findActiveBrowserLeaseForRun,
  hasOpenAbortBrowserLeaseForRun,
  releaseAbortBrowserDrainClaim,
} from "./runtime-worker-browser-lease";
import {
  isOnlyRestoreSessionPending,
  parseResumeTokenEnvelope,
  requireString,
  restoreTransitionFor,
  unknownToReason,
} from "./runtime-worker-parse";
import { handleWorkitemCheckout, handleWorkitemCheckoutSweeper } from "./runtime-worker-workitem-checkout";
import type { RunClaimDriveInputs, RunRow } from "./runtime-worker-run-context";
import { WorkerRunSupport } from "./runtime-worker-run-support";
import { ArtifactRedactionProcessor } from "./artifact-redaction-processor";
import { ArtifactRetentionProcessor } from "./artifact-retention-processor";
import type {
  ArtifactRedactor,
  ArtifactRetentionStore,
  EventId,
  LeaseCleanupPolicy,
  LeaseIsolation,
  LeaseId,
  RunAbortDrainInput,
  RunAbortDrainResult,
  RunAbortDrainer,
  ResumeTokenCodec,
  RuntimeJobResult,
  RuntimeWorker,
  RuntimeWorkerJob,
  VisualEvidenceVideoRecorder,
  SessionRestoreInput,
  SessionRestoreResult,
  SessionRestorer,
  SinkDeliveryPort,
  WorkerId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { SPAN, withSpan, type CommonSpanAttrs } from "../observability/telemetry";
import { applyRunTransition } from "../runtime/run-transition";
import { relayOutbox } from "../runtime/outbox-relay";
import { deliverNormalizedRecord } from "../runtime/pipeline/sink-delivery";
import { driveClaimedRun, driveResumedRun } from "../runtime/run-step-driver";
import { handleClaimedInitFailure, type InitBackoffConfig } from "../runtime/run-init-failure";
import { recordSiteCircuitOutcome, DEFAULT_SITE_CIRCUIT, type SiteCircuitConfig } from "../runtime/site-circuit";
import type { BrowserSessionStore } from "../runtime/browser-session-store";
import type { MergedExtractArtifactSink } from "../runtime/merged-extract-artifact";
import type { VisualEvidenceRecorder } from "../runtime/visual-evidence";
import { UtilityExecutor } from "../executor/utility-executor";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider, type BrowserSessionProvider } from "../executor/browser-session-provider";
import type { ExecutorChallengeSuspensionPort, RuntimeJobEnqueuePort } from "../runtime/executor-ports";
import type { CdpSessionProvider } from "../executor/cdp-session";
import type { ExecutorPlugin } from "../../../ts/core-types";

export interface BrowserLeasePlan {
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  /** identity 3-tuple 의 셋째(RunContext.networkPolicyId). run-drive(A.1) 구동 시 필수 — 미공급이면 loud throw. */
  readonly networkPolicyId?: string;
  readonly isolation?: LeaseIsolation;
  readonly cleanupPolicy?: LeaseCleanupPolicy;
  readonly ttlMs?: number;
  readonly downloadDirRef?: string;
}

export type BrowserLeasePlanResolver = (
  client: pg.PoolClient,
  input: { tenantId: string; runId: string },
) => Promise<BrowserLeasePlan | null>;

/** executorFactory seam 에 run 단위로 넘기는 컨텍스트 — dom executor 의 ActionPlanCache 키 스코프(run-scoped).
 *  기본 UtilityExecutor 는 무시한다(인자 적은 함수는 그대로 할당 가능). dom-executor-factory 의 DomExecutorRunContext 와 동형. */
export interface RunExecutorContext {
  readonly scenarioVersionId: string;
  readonly browserIdentityVersion: number;
  /** run 테넌트 — 자격증명 fill executorPrincipal per-run 주입(감사 정합). dom-executor-factory DomExecutorRunContext 와 동형. */
  readonly tenantId?: string;
  /** Optional per-run model override frozen on runs.model by the control plane. */
  readonly model?: string;
}

/** run-drive 시 bound 세션 provider + run-scoped 컨텍스트에서 ExecutorPlugin 을 만드는 seam. 기본은 UtilityExecutor(결정형).
 *  dom/vision executor 주입(createDomUtilityExecutorFactory) 시 LLM 액션·worker-driven suspend 가 트리거·검증된다. */
export type RunExecutorFactory = (provider: CdpSessionProvider, run: RunExecutorContext) => ExecutorPlugin;
const defaultExecutorFactory: RunExecutorFactory = (provider) => new UtilityExecutor(provider);
export type RunVideoRecorderFactory = (provider: CdpSessionProvider) => VisualEvidenceVideoRecorder;

export interface PgRuntimeWorkerOptions {
  readonly workerId?: string;
  readonly browserLeasePlanResolver?: BrowserLeasePlanResolver;
  readonly sessionRestorer?: SessionRestorer;
  readonly runAbortDrainer?: RunAbortDrainer;
  readonly artifactRedactor?: ArtifactRedactor;
  readonly artifactRetentionStore?: ArtifactRetentionStore;
  readonly allowTestArtifactLifecyclePorts?: boolean;
  readonly defaultBrowserLeaseTtlMs?: number;
  readonly artifactRedactionMaxAttempts?: number;
  readonly artifactLifecycleClaimTtlMs?: number;
  readonly artifactLifecycleRetryAfterMs?: number;
  readonly artifactLifecycleAuditRetentionDays?: number;
  readonly runAbortTimeoutMs?: number;
  // D6 sink_deliver: 주입형 포트 + ops-defaults #sink.delivery 상한(코드 상수 금지).
  readonly sinkDeliveryPort?: SinkDeliveryPort;
  readonly sinkDeliveryMaxAttempts?: number;
  readonly sinkDeliveryRetryAfterMs?: number;
  readonly allowTestSinkDeliveryPort?: boolean;
  // A.1 run-drive: claim 후 lease 에 라이브 세션을 바인딩해 driveClaimedRun 으로 구동(미주입 시 claimed 까지만 = 기존 동작).
  // test_fake 포트는 allowTestBrowserSessionProvider opt-in 필수(gateBrowserSessionProvider, sink 포트와 동형 fail-closed).
  readonly browserSessionProvider?: BrowserSessionProvider;
  readonly allowTestBrowserSessionProvider?: boolean;
  readonly sessionStore?: BrowserSessionStore;
  readonly visualEvidenceRecorder?: VisualEvidenceRecorder;
  readonly visualEvidenceVideoRecorderFactory?: RunVideoRecorderFactory;
  readonly mergedExtractArtifactSink?: MergedExtractArtifactSink;
  readonly runtimeJobEnqueuer?: RuntimeJobEnqueuePort;
  // INIT R3a/R3b(state-machine §1): claimed→running 셋업 실패 분기 임계/백오프. 미주입 시 ops-defaults 기본(3 / base 2s·factor 2·max 60s).
  //   테스트 sim 오버라이드(작은 값·고정 jitter). 코드 상수 금지 규약 — 기본값은 run-init-failure.ts 가 ops-defaults 인용.
  readonly initFailThreshold?: number;
  readonly initBackoff?: InitBackoffConfig;
  readonly initBackoffJitter?: () => number;
  // worker 서킷(ops-defaults §3 worker.circuit): per-worker 연속 INIT 실패 임계/cooldown. 미주입 시 기본(5 / 1m). 테스트 sim 오버라이드.
  readonly workerCircuitThreshold?: number;
  readonly workerCircuitOpenMs?: number;
  readonly workerCircuitCloseThreshold?: number; // half_open 연속 프로브 성공 N회 → closed(ops-defaults half_open_close_threshold)
  // 사이트 서킷(ops-defaults §3 site.circuit): block_rate(blocks/total) over window. 미주입 시 기본(30% / 5m·min20 / 15m). 테스트 sim 오버라이드.
  readonly siteCircuit?: SiteCircuitConfig;
  // suspend 구동(트리거 i): worker 경유 run 이 suspend(executor status='suspended')하면 driveClaimedRun/driveResumedRun →
  // driveSuspend 가 이 둘을 소비(R4+포트→resume-token 발행+R11→suspended). 미주입 시 suspend terminal 은 loud throw(미구성).
  // PgChallengeSuspensionPort=stateless, codec=deploy-time(SecretStore+signingKeyRef). 실 트리거(challenge 감지)는 DOM/vision executor 후행.
  readonly suspensionPort?: ExecutorChallengeSuspensionPort;
  readonly resumeTokenCodec?: ResumeTokenCodec;
  // run-drive executor seam: 기본=UtilityExecutor. suspend-가능 executor 주입 시 worker-driven suspend 가 트리거·검증된다.
  readonly executorFactory?: RunExecutorFactory;
}

type RunResumeRow = RunRow & { resume_token: unknown };
type RunResumeIntent = SessionRestoreInput;
type RunResumeTxAResult =
  | { kind: "ready"; intent: RunResumeIntent }
  | { kind: "job_result"; result: RuntimeJobResult };
type RunAbortSourceStatus = "running" | "suspended" | "resume_requested" | "resuming";
type RunAbortTxAResult =
  | { kind: "ready"; intent: RunAbortDrainInput }
  | {
      kind: "finalize";
      event: "drain_ok" | "drain_timeout";
      correlationId: string;
      leaseId?: string;
      workerId?: string;
    }
  | { kind: "job_result"; result: RuntimeJobResult };
// sink failed(상한 미달) 재전달 backoff 기본(ops-defaults #sink.delivery.retry_backoff base 5s).
const DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS = 5_000;
const DEFAULT_RUN_ABORT_TIMEOUT_MS = 30_000;

// NOTE(god-class 분해 진행 — CLAUDE.md #7): worker-run-support 협력객체(loadExpectedRun·loadRunDriveInputs·
//   acquireBrowserLease·checkWorkerCircuit·recordWorkerInit*)는 runtime-worker-run-support.ts 로 분리 완료.
//   잔여는 run-claim/run-resume/run-abort 핸들러 코어가 browser-lease 획득·worker-circuit·run-state 전이를
//   동일 tx 안에서 엮은 라이브 엔진 핵심이다(의존은 실측 DAG — 핸들러→지원 단방향, 역호출 0). 다음 PR(run-drive
//   협력객체)에서 handleRunClaim/Resume/Abort 를 분리해 ≤500 을 달성한다 — claim/resume 회귀 위험이 최고라
//   전체 runtime-worker int 스위트(claim/resume/resume-drive/abort/drive/circuit)로 차단.
export class PgRuntimeWorker implements RuntimeWorker {
  private readonly artifactRedaction: ArtifactRedactionProcessor;
  private readonly artifactRetention: ArtifactRetentionProcessor;
  private readonly runSupport: WorkerRunSupport;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {
    this.artifactRedaction = new ArtifactRedactionProcessor(pool, options);
    this.artifactRetention = new ArtifactRetentionProcessor(pool, options);
    this.runSupport = new WorkerRunSupport(pool, options);
  }

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    switch (job.kind) {
      case "outbox_relay": {
        if (job.tenantId === undefined) {
          throw new Error("RuntimeWorker: outbox_relay requires tenantId (RLS-scoped relay)");
        }
        const { publishedEventIds } = await withTenantTx(this.pool, job.tenantId, (c) => relayOutbox(c));
        return { kind: "completed", emittedEvents: publishedEventIds as readonly EventId[] };
      }

      case "run_claim":
        return this.handleRunClaim(job);

      case "run_abort":
        return this.handleRunAbort(job);

      case "lease_sweeper":
        return this.handleLeaseSweeper(job);

      case "workitem_checkout_sweeper":
        return handleWorkitemCheckoutSweeper(this.pool, job);

      case "workitem_checkout":
        return handleWorkitemCheckout(this.pool, this.options.workerId, job);

      case "run_resume":
        return this.handleRunResume(job);

      // D3(executor/lease)·D6(pipeline) 의존 — D2 골격 미구현. 조용한 no-op 금지: 명시적 throw.
      case "artifact_redaction":
        return this.artifactRedaction.handle(job);

      case "artifact_retention":
        return this.artifactRetention.handle(job);

      case "sink_deliver":
        return this.handleSinkDeliver(job);

      case "dlq_replay":
        throw new Error(
          `RuntimeWorker: job kind '${job.kind}' is not implemented in D2 (pending D3 executor/lease or D6 pipeline)`,
        );

      default: {
        // 닫힌 union 외 값 — 컴파일 타임 exhaustiveness + 런타임 방어.
        const exhaustive: never = job.kind;
        throw new Error(`RuntimeWorker: unknown job kind ${String(exhaustive)}`);
      }
    }
  }

  /**
   * D6 sink_deliver: 데이터평면 외부 전달. 주입형 SinkDeliveryPort(real|test_fake) + ops-defaults 상한 필수.
   * failed(상한 미달) → deferred(SINK_DELIVERY_FAILED 재전달), delivered/already_delivered/dead_letter → completed.
   * test_fake 포트는 명시 opt-in 없이는 거부(실 전달 증거 위조 방지 — artifact 포트와 동형 fail-closed).
   */
  private async handleSinkDeliver(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "sink_deliver.tenantId");
    const correlationId = requireString(job.correlationId, "sink_deliver.correlationId");
    const target = job.sinkDelivery;
    if (target === undefined) {
      throw new Error("RuntimeWorker: sink_deliver requires sinkDelivery payload (closed job input)");
    }
    const port = this.options.sinkDeliveryPort;
    if (port === undefined) {
      throw new Error("RuntimeWorker: sink_deliver requires an injected SinkDeliveryPort (fail-closed)");
    }
    if (port.binding.kind === "test_fake" && this.options.allowTestSinkDeliveryPort !== true) {
      throw new Error("RuntimeWorker: test_fake sink port requires explicit allowTestSinkDeliveryPort opt-in");
    }
    const maxAttempts = this.options.sinkDeliveryMaxAttempts;
    if (maxAttempts === undefined || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("RuntimeWorker: sink_deliver requires sinkDeliveryMaxAttempts (ops-defaults #sink.delivery)");
    }
    const outcome = await deliverNormalizedRecord(
      { pool: this.pool, port, policy: { source: "ops-defaults.md#sink.delivery", maxAttempts } },
      {
        tenantId,
        normalizedRecordId: target.normalizedRecordId,
        sinkConfigId: target.sinkConfigId,
        correlationId,
      },
    );
    if (outcome.status === "failed") {
      // 상한 미달 일시 실패 → 재전달. 조용한 성공 금지: 실패를 deferred로 표면화.
      return {
        kind: "deferred",
        retryAfterMs: this.options.sinkDeliveryRetryAfterMs ?? DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS,
        code: "SINK_DELIVERY_FAILED",
      };
    }
    // delivered / already_delivered / dead_letter → 처리 완료(DLQ도 종결 처리). emitted 이벤트 전달.
    return {
      kind: "completed",
      emittedEvents: outcome.emitted ? [outcome.emitted.eventId as EventId] : [],
    };
  }

  private async handleRunClaim(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "run_claim.tenantId");
    const runId = requireString(job.runId, "run_claim.runId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for run_claim",
    );
    const leasePlanResolver = this.options.browserLeasePlanResolver;
    if (leasePlanResolver === undefined) {
      throw new Error("RuntimeWorker: run_claim requires an explicit BrowserLeasePlanResolver");
    }
    // A.1 run-drive: provider 주입 시 claim 후 run 을 구동(test_fake 는 opt-in 게이트). 미주입 → claimed 까지만(기존 동작).
    const sessionProvider = gateBrowserSessionProvider(
      this.options.browserSessionProvider,
      this.options.allowTestBrowserSessionProvider === true,
    );

    // Phase A: claim 을 tx 안에서. 구동 입력은 캡처해 tx 밖(Phase B)으로 — 브라우저 작업이 DB 커넥션을 점유하지 않게.
    const claim = await withTenantTx(
      this.pool,
      tenantId,
      async (client): Promise<{ result: RuntimeJobResult; drive?: RunClaimDriveInputs }> => {
        const run = await this.runSupport.loadExpectedRun(client, tenantId, runId, "queued");
        if (run.kind !== "ok") return { result: run.result };

        // §E 필수 span: run.claim(루트) ⊃ browser.lease.acquire. 공통속성은 적재된 run의 correlation_id.
        const correlationId = job.correlationId ?? run.row.correlation_id;
        const common: CommonSpanAttrs = { tenant_id: tenantId, run_id: runId, correlation_id: correlationId };
        return withSpan(SPAN.runClaim, common, { worker_id: workerId }, async () => {
          const plan = await leasePlanResolver(client, { tenantId, runId });
          const lease = await withSpan(SPAN.browserLeaseAcquire, common, {}, async () =>
            this.runSupport.acquireBrowserLease(client, { tenantId, runId, workerId, plan }),
          );
          if (lease.kind !== "acquired") return { result: lease };

          const transition = await applyRunTransition(client, {
            tenantId,
            runId,
            fromStatus: "queued",
            event: { type: "worker.claimed" },
            guard: { leaseAcquired: true },
            correlationId,
            workerId,
            eventIdempotencyKey: `${runId}:run_claim`,
          });
          if (!transition.applied) {
            throw new Error(
              `RuntimeWorker: run_claim CAS conflict after row lock; observed=${transition.observed ?? "null"}`,
            );
          }
          if (transition.pending.length > 0) {
            throw new Error("RuntimeWorker: run_claim produced unsupported pending side effects");
          }
          const result: RuntimeJobResult = {
            kind: "completed",
            emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
          };
          // provider 미주입(또는 plan null)이면 구동 안 함 → claimed 까지만(기존 동작).
          if (sessionProvider === undefined || plan === null) return { result };
          const drive = await this.runSupport.loadRunDriveInputs(client, tenantId, runId, plan, lease.leaseId, correlationId);
          return { result, drive };
        });
      },
    );

    // Phase B: 구동(tx 밖 — 브라우저 작업이 DB 커넥션 점유 금지). 미주입/미구동이면 claimed 결과 반환.
    // driveClaimedRun: success→completed, fail_business/fail_system→failed_*(2a). suspend/challenge 등 그 외 terminal 은
    // 미구현 throw 로 표면화(propagate). 세션은 어느 경로든 finally 에서 해제.
    if (claim.drive === undefined || sessionProvider === undefined) return claim.result;
    const d = claim.drive;

    // INIT phase(status='claimed', state-machine §1 INIT 정의 = drive-input 적재 + 세션 bind + executor/resolver 구성).
    //   이 셋업이 throw 하면 좀비 claimed 잔류 대신 init_failed(R3a 재큐 / R3b 종결)로 처리한다. bind 후 executor/resolver
    //   구성이 throw 하면(주입형 dom/vision factory 셋업, 적대리뷰 B2) 그 bound 세션을 init-catch 가 해제한다(누수 방지).
    //   Phase A 브라우저 lease 는 handleClaimedInitFailure 가 drainLease 로 해제.
    let setup: {
      bound: Awaited<ReturnType<typeof sessionProvider.bind>>;
      executor: ExecutorPlugin;
      resolver: SitePageStateResolver;
    };
    let boundForInitCleanup: Awaited<ReturnType<typeof sessionProvider.bind>> | undefined;
    try {
      const siteConfig = await withTenantTx(this.pool, tenantId, (c) =>
        loadSitePageStateConfig(c, tenantId, d.siteProfileId),
      );
      boundForInitCleanup = await sessionProvider.bind({
        tenantId,
        leaseId: d.leaseId,
        siteProfileId: d.siteProfileId,
        browserIdentityId: d.browserIdentityId,
        networkPolicyId: d.networkPolicyId,
        isolation: d.isolation,
        cleanupPolicy: d.cleanupPolicy,
      });
      const executor = (this.options.executorFactory ?? defaultExecutorFactory)(boundForInitCleanup.provider, {
        scenarioVersionId: d.scenarioVersionId,
        browserIdentityVersion: d.browserIdentityVersion,
        tenantId, // 자격증명 fill executorPrincipal per-run 테넌트(감사 정합).
        ...(d.model !== undefined ? { model: d.model } : {}),
      });
      const resolver = new SitePageStateResolver(boundForInitCleanup.provider, siteConfig);
      setup = { bound: boundForInitCleanup, executor, resolver };
    } catch (initErr) {
      // bind 후 executor/resolver 구성이 throw 했으면 bound 세션 해제(적대리뷰 B2). bind 자체 실패면 boundForInitCleanup=undefined.
      if (boundForInitCleanup !== undefined) {
        try {
          await boundForInitCleanup.release();
        } catch (relErr) {
          console.error(`runtime-worker: INIT 실패 후 세션 해제 실패(run ${runId.slice(0, 8)}) — ${relErr instanceof Error ? relErr.message : String(relErr)}`);
        }
      }
      console.error(
        `runtime-worker: INIT 셋업 실패(run ${runId.slice(0, 8)}) — ${initErr instanceof Error ? initErr.message : String(initErr)}`,
      );
      const enqueuer = this.options.runtimeJobEnqueuer;
      const outcome = await handleClaimedInitFailure(
        {
          pool: this.pool,
          initFailThreshold: this.options.initFailThreshold,
          initBackoff: this.options.initBackoff,
          jitter: this.options.initBackoffJitter,
        },
        {
          tenantId,
          runId,
          correlationId: d.correlationId,
          // INIT 실패 lease 는 행 삭제(라이브 세션 미오픈)로 'run 당 lease ≤1' 불변식 복원 — drain('draining' 누적)
          //   금지(적대리뷰 B1: 누적 행이 abort claimAbortBrowserLeaseForRun 'multiple' wedge·행 누수 유발).
          drainLease: (c) => deleteInitReservedBrowserLease(c, { tenantId, leaseId: d.leaseId, workerId }),
          // 재큐 enqueuer 부재면 R3a 불가 → 좀비 claimed 대신 R3b 단말 정산으로 강등(canRequeue=false, 적대리뷰 B2).
          //   tx 안 throw 가 전이+drain 을 롤백해 좀비를 만드는 것을 원천 차단(throw 경로 제거).
          canRequeue: enqueuer !== undefined,
          reenqueueRunClaim: async (c, delayMs) => {
            // canRequeue=true 일 때만 R3a 도달 → 여기서 enqueuer 는 항상 정의됨. 방어적 단정.
            if (enqueuer === undefined) {
              throw new Error("runtime-worker: INIT R3a requeue reached without enqueuer (canRequeue invariant violated)");
            }
            await enqueuer.enqueueRuntimeJob(
              c,
              { kind: "run_claim", tenantId, runId, correlationId: d.correlationId } as RuntimeWorkerJob,
              delayMs,
            );
          },
        },
      );
      console.warn(`runtime-worker: INIT 실패 처리(run ${runId.slice(0, 8)}) → ${outcome ?? "미적용(비-claimed/경합)"}`);
      // worker 서킷: per-worker 연속 INIT 실패 누적(+1, 임계 도달 시 open) — R3b openCircuit 의 worker-격리를 per-worker
      //   누적으로 실현(per-run 직결 과잉격리 회피). **적대리뷰 B1**: outcome=null(run 부재·비-claimed·CAS 경합 =
      //   init_failed 미적용; 취소·경합 패배는 이 워커의 INIT 실패 아님)은 카운터 미증가 → spurious open 방지. best-effort
      //   기록(별도 tx)이라 실패는 잡을 깨지 않게 흡수(loud).
      if (outcome !== null) {
        await this.runSupport.recordWorkerInitFailure(workerId).catch((e) =>
          console.error(`runtime-worker: worker 서킷 실패기록 실패(run ${runId.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return claim.result;
    }
    // INIT 전체(config+bind+executor+resolver) 성공 → per-worker 연속 실패 카운터 reset + (open 이었으면)회로 닫힘(건강 증명).
    await this.runSupport.recordWorkerInitSuccess(workerId);

    // DRIVE phase(R2→running, driveScenario failsafe). setup(bound/executor/resolver) 보장. 세션은 어느 경로든 finally 에서 해제.
    let driveResult: Awaited<ReturnType<typeof driveClaimedRun>> | undefined;
    try {
      driveResult = await driveClaimedRun(
        {
          runId,
          tenantId,
          scenarioVersionId: d.scenarioVersionId,
          correlationId: d.correlationId,
          leaseId: d.leaseId,
          siteProfileId: d.siteProfileId,
          browserIdentityId: d.browserIdentityId,
          networkPolicyId: d.networkPolicyId,
          networkAllowedDomains: d.networkAllowedDomains,
          params: d.params,
        },
        {
          pool: this.pool,
          executor: setup.executor,
          resolver: setup.resolver,
          workerId,
          suspensionPort: this.options.suspensionPort,
          resumeTokenCodec: this.options.resumeTokenCodec,
          sessionStore: this.options.sessionStore,
          sessionProvider: setup.bound.provider,
          visualEvidenceRecorder: this.options.visualEvidenceRecorder,
          visualEvidenceVideoRecorder: this.options.visualEvidenceVideoRecorderFactory?.(setup.bound.provider),
          mergedExtractArtifactSink: this.options.mergedExtractArtifactSink,
          runtimeJobEnqueuer: this.options.runtimeJobEnqueuer,
          recordExecutorSteps: true,
        },
      );
    } finally {
      await setup.bound.release();
    }
    // 사이트 서킷 표본(ops-defaults §3 site.circuit): drive 1회=표본 1행. blocked=challenge 자동감지(suspended +
    //   suspend.kind<>'human_task' = 사이트가 봇을 차단). @human_task suspend·완료·실패는 정상 시도(분모). best-effort
    //   기록(별도 tenant tx)이라 실패는 잡을 깨지 않게 흡수(loud). throw 로 끝난 drive(driveResult undefined)는 표본 제외.
    if (driveResult !== undefined) {
      const blocked =
        driveResult.state === "suspended" &&
        driveResult.outcome.suspend !== undefined &&
        driveResult.outcome.suspend.kind !== "human_task";
      await recordSiteCircuitOutcome(this.pool, this.options.siteCircuit ?? DEFAULT_SITE_CIRCUIT, {
        tenantId,
        siteProfileId: d.siteProfileId,
        correlationId: d.correlationId,
        blocked,
      }).catch((e) =>
        console.error(`runtime-worker: 사이트 서킷 표본기록 실패(run ${runId.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return claim.result;
  }

  private async handleRunAbort(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "run_abort.tenantId");
    const runId = requireString(job.runId, "run_abort.runId");
    const timeoutMs = job.abortTimeoutMs ?? this.options.runAbortTimeoutMs ?? DEFAULT_RUN_ABORT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("RuntimeWorker: run_abort timeoutMs must be a positive integer");
    }

    const txA = await withTenantTx(this.pool, tenantId, async (client): Promise<RunAbortTxAResult> => {
      const run = await client.query<RunRow & { worker_id: string | null; abort_source_status: RunAbortSourceStatus | null }>(
        `SELECT status, correlation_id::text, worker_id::text, abort_source_status
           FROM runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, runId],
      );
      const row = run.rows[0];
      if (row === undefined) {
        return { kind: "job_result", result: { kind: "failed", code: "RUN_NOT_FOUND" } };
      }
      if (row.status === "cancelled") {
        return { kind: "job_result", result: { kind: "completed", emittedEvents: [] } };
      }
      if (row.status !== "aborting") {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }

      const correlationId = job.correlationId ?? row.correlation_id;
      if (row.abort_source_status === "suspended" || row.abort_source_status === "resume_requested") {
        if (
          row.worker_id !== null &&
          (await hasOpenAbortBrowserLeaseForRun(client, { tenantId, runId, workerId: row.worker_id }))
        ) {
          return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
        }
        return { kind: "finalize", event: "drain_ok", correlationId };
      }
      if (row.abort_source_status !== "running" && row.abort_source_status !== "resuming") {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }
      if (row.worker_id === null) {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }

      const drainer = this.options.runAbortDrainer;
      if (drainer === undefined) {
        throw new Error("RuntimeWorker: run_abort requires an explicit RunAbortDrainer when a browser lease is present");
      }

      const workerId = row.worker_id;
      const claim = await claimAbortBrowserLeaseForRun(client, { tenantId, runId, workerId, timeoutMs });
      if (claim.kind === "multiple" || claim.kind === "missing") {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }
      if (claim.kind === "deferred") {
        return {
          kind: "job_result",
          result: { kind: "deferred", code: "CONTROL_PLANE_INTERNAL_ERROR", retryAfterMs: claim.retryAfterMs },
        };
      }
      if (claim.kind === "expired") {
        return { kind: "finalize", event: "drain_timeout", correlationId, leaseId: claim.leaseId, workerId };
      }

      return {
        kind: "ready",
        intent: {
          tenantId: tenantId as TenantId,
          runId: runId as RunId,
          leaseId: claim.leaseId as LeaseId,
          workerId: workerId as WorkerId,
          correlationId: correlationId as CorrelationId,
          timeoutMs,
        },
      };
    });

    if (txA.kind === "job_result") return txA.result;
    if (txA.kind === "finalize") {
      return finalizeRunAbort(this.pool, tenantId, runId, txA);
    }

    const drainResult = await this.options.runAbortDrainer!.drainAbort(txA.intent).catch(
      (err): RunAbortDrainResult => ({
        kind: "transient_failed",
        reason: unknownToReason(err),
      }),
    );
    if (drainResult.kind === "transient_failed") {
      await releaseAbortBrowserDrainClaim(this.pool, txA.intent);
      return {
        kind: "deferred",
        code: "CONTROL_PLANE_INTERNAL_ERROR",
        retryAfterMs: drainResult.retryAfterMs ?? 1_000,
      };
    }
    if (drainResult.kind === "terminal_failed") {
      await releaseAbortBrowserDrainClaim(this.pool, txA.intent);
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    return finalizeRunAbort(this.pool, tenantId, runId, {
      event: drainResult.kind === "timeout" ? "drain_timeout" : "drain_ok",
      correlationId: txA.intent.correlationId,
      leaseId: txA.intent.leaseId,
      workerId: txA.intent.workerId,
    });
  }

  private async handleLeaseSweeper(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "lease_sweeper.tenantId");
    await withTenantTx(this.pool, tenantId, async (client) => {
      await client.query(
        `UPDATE browser_leases
            SET state = 'expired'
          WHERE tenant_id = $1::uuid
            AND state IN ('reserved','active')
            AND expires_at < now()`,
        [tenantId],
      );
      await client.query(
        `UPDATE credential_leases
            SET status = 'expired'
          WHERE tenant_id = $1::uuid
            AND status = 'active'
            AND locked_until < now()`,
        [tenantId],
      );
    });
    return { kind: "completed", emittedEvents: [] };
  }

  /**
   * checkout-expiry sweeper(C2 — state-machine.md W6/W7). 만료된 processing workitem(checkout_expires_at < now())을
   * 회수한다: attempts<max → W6 retry(백오프 후 재checkout 대상), attempts>=max → W7 abandoned + dead_letter.
   * W9 pause 중(checkout_paused_at IS NOT NULL)인 suspend workitem 은 제외(만료 오발 방지). 워커 크래시로 끊긴 checkout
   * 의 유일한 자동 회수 안전망 — 이게 없으면 끊긴 작업은 영구 정지(운영자 수동 개입 필요).
   */
  private async handleRunResume(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "run_resume.tenantId");
    const runId = requireString(job.runId, "run_resume.runId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for run_resume",
    );
    const leasePlanResolver = this.options.browserLeasePlanResolver;
    if (leasePlanResolver === undefined) {
      throw new Error("RuntimeWorker: run_resume requires an explicit BrowserLeasePlanResolver");
    }
    const sessionRestorer = this.options.sessionRestorer;
    if (sessionRestorer === undefined) {
      throw new Error("RuntimeWorker: run_resume requires an explicit SessionRestorer");
    }

    const txA = await withTenantTx(this.pool, tenantId, async (client): Promise<RunResumeTxAResult> => {
      const run = await client.query<RunResumeRow>(
        `SELECT status, correlation_id::text, resume_token
           FROM runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, runId],
      );
      const row = run.rows[0];
      if (row === undefined) {
        return { kind: "job_result", result: { kind: "failed", code: "RUN_NOT_FOUND" } };
      }
      if (row.status !== "resume_requested" && row.status !== "resuming") {
        return {
          kind: "job_result",
          result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" },
        };
      }

      const token = parseResumeTokenEnvelope(row.resume_token, runId);
      if (token === null) {
        return {
          kind: "job_result",
          result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" },
        };
      }

      let lease = await findActiveBrowserLeaseForRun(client, {
        tenantId,
        runId,
        workerId,
      });
      // 적대리뷰 B4: lease 재사용 분기는 acquireBrowserLease(유일한 서킷 게이트)를 건너뛴다 — resume 도 worker 서킷
      //   격리를 적용한다(open+cooldown 이면 거부). null 분기는 아래 acquireBrowserLease 가 동일 게이트를 수행.
      if (lease !== null && !(await this.runSupport.checkWorkerCircuit(client, workerId))) {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }
      if (lease === null) {
        // §E browser.lease.acquire — resume 경로의 lease 확보도 동일 span으로 계측.
        const resumeCommon: CommonSpanAttrs = {
          tenant_id: tenantId,
          run_id: runId,
          correlation_id: job.correlationId ?? row.correlation_id,
        };
        const acquired = await withSpan(SPAN.browserLeaseAcquire, resumeCommon, {}, async () => {
          const plan = await leasePlanResolver(client, { tenantId, runId });
          return this.runSupport.acquireBrowserLease(client, { tenantId, runId, workerId, plan });
        });
        if (acquired.kind !== "acquired") return { kind: "job_result", result: acquired };
        lease = acquired.leaseId;
      }

      if (row.status === "resume_requested") {
        const transition = await applyRunTransition(client, {
          tenantId,
          runId,
          fromStatus: "resume_requested",
          event: { type: "worker.claimed" },
          guard: { leaseAcquired: true },
          correlationId: job.correlationId ?? row.correlation_id,
          workerId,
          eventIdempotencyKey: `${runId}:run_resume:r17`,
        });

        if (!transition.applied) {
          throw new Error(
            `RuntimeWorker: run_resume R17 CAS conflict after row lock; observed=${transition.observed ?? "null"}`,
          );
        }
        if (!isOnlyRestoreSessionPending(transition.pending)) {
          throw new Error("RuntimeWorker: run_resume R17 produced unsupported pending side effects");
        }
      }

      await client.query(
        `UPDATE runs
            SET worker_id = $3::uuid,
                updated_at = now()
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND status = 'resuming'`,
        [tenantId, runId, workerId],
      );

      return {
        kind: "ready",
        intent: {
          tenantId: tenantId as TenantId,
          runId: runId as RunId,
          leaseId: lease as LeaseId,
          workerId: workerId as WorkerId,
          correlationId: (job.correlationId ?? row.correlation_id) as CorrelationId,
          token,
          expectedPageStateRef: token.pageStateRef,
          resumeNodeId: token.resumeNodeId,
        },
      };
    });

    if (txA.kind === "job_result") return txA.result;

    // §E 필수 span: session.restore — restoreSession은 DB 트랜잭션 밖(외부 I/O)에서 실행되며 그 경계를 계측.
    //   예외는 withSpan이 record+ERROR로 표면화 후 재던지고, 바깥 catch가 terminal_failure로 흡수(제어흐름).
    const restoreResult = await withSpan(
      SPAN.sessionRestore,
      { tenant_id: txA.intent.tenantId, run_id: txA.intent.runId, correlation_id: txA.intent.correlationId },
      {},
      () => sessionRestorer.restoreSession(txA.intent),
    ).catch(
      (err): SessionRestoreResult => ({
        kind: "terminal_failure",
        reason: unknownToReason(err),
      }),
    );

    const result: RuntimeJobResult = await withTenantTx(this.pool, tenantId, async (client) => {
      const run = await client.query<RunRow>(
        `SELECT status, correlation_id::text
           FROM runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, runId],
      );
      const row = run.rows[0];
      if (row === undefined) {
        return { kind: "failed", code: "RUN_NOT_FOUND" };
      }
      if (row.status !== "resuming") {
        return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
      }

      const next = restoreTransitionFor(restoreResult, txA.intent.expectedPageStateRef);
      const transition = await applyRunTransition(client, {
        tenantId,
        runId,
        fromStatus: "resuming",
        event: next.event,
        guard: next.guard,
        correlationId: job.correlationId ?? row.correlation_id,
        workerId,
        eventIdempotencyKey: `${runId}:run_resume`,
      });

      if (!transition.applied) {
        throw new Error(
          `RuntimeWorker: run_resume ${next.event.type} CAS conflict after row lock; observed=${
            transition.observed ?? "null"
          }`,
        );
      }
      if (transition.pending.length > 0) {
        throw new Error("RuntimeWorker: run_resume completion produced unsupported pending side effects");
      }

      return {
        kind: "completed",
        emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
      };
    });

    // Phase C: resume 구동(tx 밖 — 브라우저 작업이 DB 커넥션 점유 금지). handleRunClaim Phase B 와 동일 패턴.
    //   R18/R19 로 running 도달 + provider 주입 시에만 resumeNodeId 부터 재진입 구동. R20(failed_system)·provider 미주입은 전이만.
    const sessionProvider = gateBrowserSessionProvider(
      this.options.browserSessionProvider,
      this.options.allowTestBrowserSessionProvider === true,
    );
    if (result.kind !== "completed" || sessionProvider === undefined) return result;
    const drive = await withTenantTx(this.pool, tenantId, async (client): Promise<RunClaimDriveInputs | null> => {
      // R18(restore_ok)·R19(login_bypass) 면 running. R20(restore 실패·bypass 불가)은 failed_system — 구동하지 않는다.
      const cur = await client.query<{ status: string }>(
        `SELECT status FROM runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, runId],
      );
      if (cur.rows[0]?.status !== "running") return null;
      const plan = await leasePlanResolver(client, { tenantId, runId });
      if (plan === null) return null;
      return this.runSupport.loadRunDriveInputs(client, tenantId, runId, plan, txA.intent.leaseId, txA.intent.correlationId);
    });
    if (drive === null) return result;

    const siteConfig = await withTenantTx(this.pool, tenantId, (c) =>
      loadSitePageStateConfig(c, tenantId, drive.siteProfileId),
    );
    const bound = await sessionProvider.bind({
      tenantId,
      leaseId: drive.leaseId,
      siteProfileId: drive.siteProfileId,
      browserIdentityId: drive.browserIdentityId,
      networkPolicyId: drive.networkPolicyId,
      isolation: drive.isolation,
      cleanupPolicy: drive.cleanupPolicy,
    });
    try {
      const executor = (this.options.executorFactory ?? defaultExecutorFactory)(bound.provider, {
        scenarioVersionId: drive.scenarioVersionId,
        browserIdentityVersion: drive.browserIdentityVersion,
        tenantId, // 자격증명 fill executorPrincipal per-run 테넌트(감사 정합).
        ...(drive.model !== undefined ? { model: drive.model } : {}),
      });
      const resolver = new SitePageStateResolver(bound.provider, siteConfig);
      // R18 후 run 은 running — driveResumedRun 은 R2 없이 resumeNodeId 부터 재진입(success→completed / fail→failed_*).
      await driveResumedRun(
        {
          runId,
          tenantId,
          scenarioVersionId: drive.scenarioVersionId,
          correlationId: drive.correlationId,
          leaseId: drive.leaseId,
          siteProfileId: drive.siteProfileId,
          browserIdentityId: drive.browserIdentityId,
          networkPolicyId: drive.networkPolicyId,
          networkAllowedDomains: drive.networkAllowedDomains,
          params: drive.params,
        },
        {
          pool: this.pool,
          executor,
          resolver,
          workerId,
          suspensionPort: this.options.suspensionPort,
          resumeTokenCodec: this.options.resumeTokenCodec,
          sessionStore: this.options.sessionStore,
          sessionProvider: bound.provider,
          visualEvidenceRecorder: this.options.visualEvidenceRecorder,
          visualEvidenceVideoRecorder: this.options.visualEvidenceVideoRecorderFactory?.(bound.provider),
          mergedExtractArtifactSink: this.options.mergedExtractArtifactSink,
          runtimeJobEnqueuer: this.options.runtimeJobEnqueuer,
          recordExecutorSteps: true,
        },
        txA.intent.resumeNodeId,
      );
    } finally {
      await bound.release();
    }
    return result;
  }

}
