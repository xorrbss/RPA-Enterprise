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

import { requireString } from "./runtime-worker-parse";
import { handleWorkitemCheckout, handleWorkitemCheckoutSweeper } from "./runtime-worker-workitem-checkout";
import { handleHumanTaskTimeoutSweeper } from "./runtime-worker-human-task-timeout";
import { WorkerRunDrive } from "./runtime-worker-run-drive";
import { WorkerRunResume } from "./runtime-worker-run-resume";
import { ArtifactRedactionProcessor, type SupersededObjectStore } from "./artifact-redaction-processor";
import { ArtifactRetentionProcessor } from "./artifact-retention-processor";
import { TenantOffboardingPurgeProcessor } from "./tenant-offboarding-purge";
import { ArtifactIntegrityProcessor, type IntegrityObjectStore, type IntegrityMismatch } from "./artifact-integrity-processor";
import { ArtifactOrphanProcessor, type OrphanInventoryStore } from "./artifact-orphan-processor";
import {
  INTEGRATION_HANDOFF_DISPATCH_MAX_ATTEMPTS_DEFAULT,
  INTEGRATION_HANDOFF_DISPATCH_RETRY_AFTER_MS_DEFAULT,
  OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT,
  OPS_NOTIFICATION_DELIVERY_RETRY_AFTER_MS_DEFAULT,
} from "../../../ts/runtime-contract";
import type {
  ArtifactRedactor,
  ArtifactRetentionStore,
  EventId,
  LeaseCleanupPolicy,
  LeaseIsolation,
  RunAbortDrainer,
  RunAbortDrainInput,
  ResumeTokenCodec,
  RuntimeJobResult,
  RuntimeWorker,
  RuntimeWorkerJob,
  VisualEvidenceVideoRecorder,
  SessionRestorer,
  SinkDeliveryPort,
  OpsNotificationDeliveryPort,
  IntegrationHandoffDispatchPort,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { relayOutbox } from "../runtime/outbox-relay";
import { terminalizeStuckRunAsSystemFailure } from "../runtime/run-step-driver";
import { deliverNormalizedRecord } from "../runtime/pipeline/sink-delivery";
import { deliverOpsNotificationAttempt } from "../runtime/ops-notification-delivery";
import { dispatchIntegrationHandoffAttempt } from "../runtime/integration-handoff-dispatch";
import type { InitBackoffConfig } from "../runtime/run-init-failure";
import type { SiteCircuitConfig } from "../runtime/site-circuit";
import type { BrowserSessionStore } from "../runtime/browser-session-store";
import type { MergedExtractArtifactSink } from "../runtime/merged-extract-artifact";
import type { VisualEvidenceRecorder } from "../runtime/visual-evidence";
import type { BrowserSessionProvider } from "../executor/browser-session-provider";
import type { ExecutorChallengeSuspensionPort, RuntimeJobEnqueuePort } from "../runtime/executor-ports";
import type { CdpSessionProvider } from "../executor/cdp-session";
import type { ExecutorPlugin } from "../../../ts/core-types";
import type { RunEnqueuer } from "../api/run-queue";
import type { ArtifactObjectReader } from "../api/server-shared";
import { fanOutCollectionRun } from "../api/approval-fan-out";
import { processRunTriggerFireJob } from "./run-trigger-scheduler";
import { errText, workerLog } from "../observability/log";
import { DEFAULT_WORKER_CIRCUIT_OPEN_MS } from "./runtime-worker-run-context";
import { handleAuditVerifierJob } from "./audit-verifier-worker";

/** 만료 lease 세션 teardown 대기(ops-defaults run.abort_timeout 30s 동형 — close 미완 시 timeout 처리). */
const DEFAULT_LEASE_SWEEP_TEARDOWN_TIMEOUT_MS = 30_000;

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
export type RunVideoRecorderFactory = (provider: CdpSessionProvider) => VisualEvidenceVideoRecorder;

export interface PgRuntimeWorkerOptions {
  readonly workerId?: string;
  readonly browserLeasePlanResolver?: BrowserLeasePlanResolver;
  readonly sessionRestorer?: SessionRestorer;
  readonly runAbortDrainer?: RunAbortDrainer;
  readonly artifactRedactor?: ArtifactRedactor;
  readonly artifactRetentionStore?: ArtifactRetentionStore;
  /** AUD-9: redaction 후 대체된 원본 평문 객체 삭제용(redacted-at-rest). */
  readonly artifactSupersededObjectStore?: SupersededObjectStore;
  /** AUD-10 impl-contracts §B artifact_integrity_checker: sha256 ↔ object 실제 해시 대조용 raw 바이트 read. */
  readonly artifactIntegrityObjectStore?: IntegrityObjectStore;
  readonly artifactIntegrityBatchLimit?: number;
  readonly onIntegrityMismatch?: (info: IntegrityMismatch) => void;
  /** AUD-10 impl-contracts §B artifact_orphan_sweeper: object-store 인벤토리 열거+삭제(참조 없는 object 회수). */
  readonly artifactOrphanInventoryStore?: OrphanInventoryStore;
  readonly artifactOrphanGraceMs?: number;
  readonly artifactOrphanBatchLimit?: number;
  readonly artifactOrphanMaxDeletesPerTick?: number;
  readonly allowTestArtifactLifecyclePorts?: boolean;
  /** O4 tenant_offboarding_purge per-tick cap — 행 삭제/artifact 드레인 상한(초과 시 deferred 로 재시도 연속). */
  readonly offboardingPurgeRowCapPerTick?: number;
  readonly offboardingPurgeArtifactCapPerTick?: number;
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
  readonly opsNotificationDeliveryPort?: OpsNotificationDeliveryPort;
  readonly opsNotificationDeliveryMaxAttempts?: number;
  readonly opsNotificationDeliveryRetryAfterMs?: number;
  readonly allowTestOpsNotificationDeliveryPort?: boolean;
  readonly integrationHandoffDispatchPort?: IntegrationHandoffDispatchPort;
  readonly integrationHandoffDispatchMaxAttempts?: number;
  readonly integrationHandoffDispatchRetryAfterMs?: number;
  readonly allowTestIntegrationHandoffDispatchPort?: boolean;
  // A.1 run-drive: claim 후 lease 에 라이브 세션을 바인딩해 driveClaimedRun 으로 구동(미주입 시 claimed 까지만 = 기존 동작).
  // test_fake 포트는 allowTestBrowserSessionProvider opt-in 필수(gateBrowserSessionProvider, sink 포트와 동형 fail-closed).
  readonly browserSessionProvider?: BrowserSessionProvider;
  readonly allowTestBrowserSessionProvider?: boolean;
  readonly sessionStore?: BrowserSessionStore;
  readonly visualEvidenceRecorder?: VisualEvidenceRecorder;
  readonly visualEvidenceVideoRecorderFactory?: RunVideoRecorderFactory;
  readonly mergedExtractArtifactSink?: MergedExtractArtifactSink;
  // 결재 fan-out 자동 트리거(②): approval_fan_out_sweeper 가 수집 artifact 를 읽을 reader. 미주입 시 sweeper 는
  //   loud throw(자동 fan-out 스케줄됐는데 reader 미구성=오구성). ObjectStore 가 구조적으로 이 shape(get/getBytes)를 충족.
  readonly approvalFanOutArtifactReader?: ArtifactObjectReader;
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

// sink failed(상한 미달) 재전달 backoff 기본(ops-defaults #sink.delivery.retry_backoff base 5s).
const DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS = 5_000;

export class PgRuntimeWorker implements RuntimeWorker {
  private readonly artifactRedaction: ArtifactRedactionProcessor;
  private readonly artifactRetention: ArtifactRetentionProcessor;
  private readonly artifactIntegrity: ArtifactIntegrityProcessor;
  private readonly artifactOrphan: ArtifactOrphanProcessor;
  private readonly offboardingPurge: TenantOffboardingPurgeProcessor;
  private readonly runDrive: WorkerRunDrive;
  private readonly runResume: WorkerRunResume;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {
    this.artifactRedaction = new ArtifactRedactionProcessor(pool, options);
    this.artifactRetention = new ArtifactRetentionProcessor(pool, options);
    this.artifactIntegrity = new ArtifactIntegrityProcessor(pool, options);
    this.artifactOrphan = new ArtifactOrphanProcessor(pool, options);
    // O4: 오프보딩 purge 는 artifact 드레인에 기존 retention 경로(claim→object delete→tombstone)를 재사용한다.
    this.offboardingPurge = new TenantOffboardingPurgeProcessor(pool, options, this.artifactRetention);
    this.runDrive = new WorkerRunDrive(pool, options);
    this.runResume = new WorkerRunResume(pool, options);
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
        return this.runDrive.handleRunClaim(job);

      case "run_abort":
        return this.runDrive.handleRunAbort(job);

      case "lease_sweeper":
        return this.handleLeaseSweeper(job);

      case "workitem_checkout_sweeper":
        return handleWorkitemCheckoutSweeper(this.pool, job);

      case "human_task_timeout_sweeper":
        return handleHumanTaskTimeoutSweeper(this.pool, job);

      case "approval_fan_out_sweeper":
        return this.handleApprovalFanOutSweeper(job);

      case "workitem_checkout":
        return handleWorkitemCheckout(this.pool, this.options.workerId, job);

      case "run_resume":
        return this.runResume.handleRunResume(job);

      // D3(executor/lease)·D6(pipeline) 의존 — D2 골격 미구현. 조용한 no-op 금지: 명시적 throw.
      case "artifact_redaction":
        return this.artifactRedaction.handle(job);

      case "artifact_retention":
        return this.artifactRetention.handle(job);

      case "tenant_offboarding_purge":
        return this.offboardingPurge.handle(job);

      case "artifact_integrity":
        return this.artifactIntegrity.handle(job);

      case "artifact_orphan":
        return this.artifactOrphan.handle(job);

      case "sink_deliver":
        return this.handleSinkDeliver(job);

      case "ops_notification_send":
        return this.handleOpsNotificationSend(job);

      case "integration_handoff_dispatch":
        return this.handleIntegrationHandoffDispatch(job);

      case "trigger_fire":
        return this.handleTriggerFire(job);

      case "audit_verifier":
        return handleAuditVerifierJob(this.pool, job);

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
      return {
        kind: "deferred",
        retryAfterMs: this.options.sinkDeliveryRetryAfterMs ?? DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS,
        code: "SINK_DELIVERY_FAILED",
      };
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

  private async handleTriggerFire(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "trigger_fire.tenantId");
    const triggerId = requireString(job.triggerId, "trigger_fire.triggerId");
    const scheduledFor = requireString(job.scheduledFor, "trigger_fire.scheduledFor");
    const correlationId = requireString(job.correlationId, "trigger_fire.correlationId");
    const runtimeJobEnqueuer = this.options.runtimeJobEnqueuer;
    if (runtimeJobEnqueuer === undefined) {
      throw new Error("RuntimeWorker: trigger_fire requires runtimeJobEnqueuer to enqueue created run_claim jobs");
    }

    await processRunTriggerFireJob(this.pool, {
      tenantId,
      triggerId,
      scheduledFor,
      enqueuer: runtimeJobEnqueuerAsRunEnqueuer(runtimeJobEnqueuer),
      correlationId: () => correlationId,
    });

    return { kind: "completed", emittedEvents: [] };
  }

  // 결재 fan-out 자동 트리거(②): auto_fan_out 수집 시나리오의 최근 완료 run 중 아직 fan-out 안 된(claim 없음) 것을
  //   찾아 검토 인박스로 fan-out. 멱등(approval_row_claims UNIQUE) + 최근-윈도우(무한 재스윕 방지). per-run 격리 tx.
  private async handleApprovalFanOutSweeper(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "approval_fan_out_sweeper.tenantId");
    const correlationId = requireString(job.correlationId, "approval_fan_out_sweeper.correlationId");
    const runtimeJobEnqueuer = this.options.runtimeJobEnqueuer;
    const artifactReader = this.options.approvalFanOutArtifactReader;
    if (runtimeJobEnqueuer === undefined || artifactReader === undefined) {
      // 자동 fan-out 이 스케줄됐는데 reader/enqueuer 미구성 = 오구성 → loud(조용한 no-op 금지). 수동 버튼(API)은 별개 경로.
      throw new Error("RuntimeWorker: approval_fan_out_sweeper requires approvalFanOutArtifactReader + runtimeJobEnqueuer");
    }
    const deps = { artifactStore: artifactReader, enqueuer: runtimeJobEnqueuerAsRunEnqueuer(runtimeJobEnqueuer) };
    // 대상: 최근(1일) 완료 + auto_fan_out=true + 아직 claim 없음(있으면 이미 fan-out — 멱등). ended_at 윈도우로 무한 재스윕 차단.
    const candidates = await withTenantTx(this.pool, tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT r.id::text AS id
           FROM runs r
           JOIN scenario_versions sv ON sv.id = r.scenario_version_id AND sv.tenant_id = r.tenant_id
           JOIN scenarios s ON s.id = sv.scenario_id AND s.tenant_id = sv.tenant_id
          WHERE r.tenant_id = $1::uuid AND r.status = 'completed' AND s.auto_fan_out = true
            AND r.ended_at IS NOT NULL AND r.ended_at > now() - interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM approval_row_claims cl WHERE cl.tenant_id = r.tenant_id AND cl.source_run_id = r.id)
            -- 오프보딩 잠금(O3): approved/purging 테넌트는 자동 fan-out(검토 run 스폰) 제외 — 신규 활동 금지.
            AND NOT EXISTS (SELECT 1 FROM tenant_offboarding_requests o WHERE o.tenant_id = r.tenant_id AND o.status IN ('approved','purging'))
          ORDER BY r.ended_at ASC LIMIT 50`,
        [tenantId],
      );
      return r.rows.map((row) => row.id);
    });
    const asOf = new Date().toISOString();
    for (const sourceRunId of candidates) {
      try {
        await withTenantTx(this.pool, tenantId, (c) => fanOutCollectionRun(c, tenantId, sourceRunId, correlationId, asOf, deps));
      } catch (err) {
        // per-run 격리 — 한 run 의 실패(artifact 부재·검토 시나리오 미시드 등)가 스윕 전체를 멈추지 않게(로그+계속).
        workerLog("error", { at: "approval_fan_out_sweeper", msg: "run fan-out 실패", tenant_id: tenantId, source_run_id: sourceRunId, correlation_id: correlationId, error: errText(err) });
      }
    }
    return { kind: "completed", emittedEvents: [] };
  }

  private async handleOpsNotificationSend(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "ops_notification_send.tenantId");
    const correlationId = requireString(job.correlationId, "ops_notification_send.correlationId");
    const attemptId = requireString(job.opsNotification?.attemptId, "ops_notification_send.opsNotification.attemptId");
    const port = this.options.opsNotificationDeliveryPort;
    if (port === undefined) {
      throw new Error("RuntimeWorker: ops_notification_send requires an injected OpsNotificationDeliveryPort (fail-closed)");
    }
    if (port.binding.kind === "test_fake" && this.options.allowTestOpsNotificationDeliveryPort !== true) {
      throw new Error("RuntimeWorker: test_fake ops notification port requires explicit allowTestOpsNotificationDeliveryPort opt-in");
    }
    const enqueuer = this.options.runtimeJobEnqueuer;
    if (enqueuer === undefined) {
      throw new Error("RuntimeWorker: ops_notification_send requires runtimeJobEnqueuer for retry scheduling");
    }
    const maxAttempts = this.options.opsNotificationDeliveryMaxAttempts ?? OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT;
    const retryAfterMs =
      this.options.opsNotificationDeliveryRetryAfterMs ?? OPS_NOTIFICATION_DELIVERY_RETRY_AFTER_MS_DEFAULT;
    const outcome = await deliverOpsNotificationAttempt(
      {
        pool: this.pool,
        port,
        enqueuer,
        retryAfterMs,
        policy: { source: "ops-defaults.md#ops.notification.delivery", maxAttempts },
      },
      { tenantId, attemptId, correlationId },
    );
    return { kind: "completed", emittedEvents: [] };
  }

  private async handleIntegrationHandoffDispatch(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "integration_handoff_dispatch.tenantId");
    const correlationId = requireString(job.correlationId, "integration_handoff_dispatch.correlationId");
    const attemptId = requireString(job.integrationHandoff?.attemptId, "integration_handoff_dispatch.integrationHandoff.attemptId");
    const port = this.options.integrationHandoffDispatchPort;
    if (port === undefined) {
      throw new Error("RuntimeWorker: integration_handoff_dispatch requires an injected IntegrationHandoffDispatchPort (fail-closed)");
    }
    if (port.binding.kind === "test_fake" && this.options.allowTestIntegrationHandoffDispatchPort !== true) {
      throw new Error("RuntimeWorker: test_fake integration handoff dispatch port requires explicit allowTestIntegrationHandoffDispatchPort opt-in");
    }
    const enqueuer = this.options.runtimeJobEnqueuer;
    if (enqueuer === undefined) {
      throw new Error("RuntimeWorker: integration_handoff_dispatch requires runtimeJobEnqueuer for retry scheduling");
    }
    const maxAttempts =
      this.options.integrationHandoffDispatchMaxAttempts ?? INTEGRATION_HANDOFF_DISPATCH_MAX_ATTEMPTS_DEFAULT;
    const retryAfterMs =
      this.options.integrationHandoffDispatchRetryAfterMs ?? INTEGRATION_HANDOFF_DISPATCH_RETRY_AFTER_MS_DEFAULT;
    await dispatchIntegrationHandoffAttempt(
      {
        pool: this.pool,
        port,
        enqueuer,
        retryAfterMs,
        policy: { source: "ops-defaults.md#integration.handoff.dispatch", maxAttempts },
      },
      { tenantId, attemptId, correlationId },
    );
    return { kind: "completed", emittedEvents: [] };
  }

  private async handleLeaseSweeper(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "lease_sweeper.tenantId");
    const expiredBrowser = await withTenantTx(this.pool, tenantId, async (client) => {
      // migration #7 sweeper 계약: UPDATE ... RETURNING * → 반환 row 의 프로세스 kill + cleanup(idempotent). RETURNING 으로
      //   만료된 browser_lease 를 수집해 tx 밖에서 세션 teardown 한다(아래).
      const r = await client.query<{ id: string; run_id: string | null; owner_worker_id: string; run_correlation_id: string | null }>(
        `UPDATE browser_leases
            SET state = 'expired'
          WHERE tenant_id = $1::uuid
            AND state IN ('reserved','active')
            AND expires_at < now()
        RETURNING id::text AS id, run_id::text AS run_id, owner_worker_id::text AS owner_worker_id,
                  (SELECT r.correlation_id::text FROM runs r
                    WHERE r.tenant_id = browser_leases.tenant_id AND r.id = browser_leases.run_id) AS run_correlation_id`,
        [tenantId],
      );
      // credential_leases 는 OS 자원 없는 DB slot — 만료만(teardown 불요).
      await client.query(
        `UPDATE credential_leases
            SET status = 'expired'
          WHERE tenant_id = $1::uuid
            AND status = 'active'
            AND locked_until < now()`,
        [tenantId],
      );
      return r.rows;
    });

    await this.isolateWorkersForExpiredBrowserLeases(expiredBrowser);

    // 좀비 run 회수(감사 클러스터 B): 만료 lease 의 연결 run 이 비종결(claimed/running/completing/suspending/resuming)이면
    //   소유 워커가 크래시/wedge(heartbeat 미갱신 5분 — 클러스터 A 배선 후 expired=dead-worker 신호) → failed_system 종결.
    //   run-state 회수는 세션 불요라 cross-worker(어느 워커든 수행) + idempotent CAS(이미 종결됐으면 no-op). best-effort·loud(내부 흡수).
    for (const lease of expiredBrowser) {
      if (lease.run_id === null) continue;
      await terminalizeStuckRunAsSystemFailure(
        { tenantId, runId: lease.run_id, correlationId: lease.run_correlation_id ?? job.correlationId ?? tenantId },
        this.pool,
      );
    }

    // XRT-1: 만료 browser_lease 의 라이브 세션 teardown(프로세스 close + 격리 다운로드 디렉토리 제거) — migration #7 sweeper
    //   계약의 'kill + cleanup'. drainAbort 는 leaseId 로 **이 워커가 bind 한 세션만** teardown 하고, 미바운드(타 워커 소유·
    //   이미 release)면 no-op(transient_failed). 따라서 OS 자원 회수는 자기 워커가 연 세션으로 한정되며, 죽은 타 워커의
    //   프로세스는 다른 호스트라 sweeper 가 직접 kill 불가 → 그 워커의 컨테이너 teardown 이 회수한다(DB 만료는 위에서 완료).
    //   DB tx 밖에서 수행(브라우저 I/O 가 DB 커넥션 점유 금지). best-effort·idempotent — 실패는 잡을 깨지 않게 흡수(loud).
    const drainer = this.options.runAbortDrainer;
    const workerId = this.options.workerId;
    if (drainer !== undefined && workerId !== undefined) {
      const timeoutMs = this.options.runAbortTimeoutMs ?? DEFAULT_LEASE_SWEEP_TEARDOWN_TIMEOUT_MS;
      for (const lease of expiredBrowser) {
        // 자기 워커 + run 연결(active) lease 만 — reserved(run_id NULL)는 bind 전이라 세션 없음.
        if (lease.owner_worker_id !== workerId || lease.run_id === null) continue;
        await drainer
          .drainAbort({
            tenantId,
            runId: lease.run_id,
            leaseId: lease.id,
            workerId,
            correlationId: job.correlationId ?? tenantId,
            timeoutMs,
          } as RunAbortDrainInput)
          .catch((e: unknown) =>
            workerLog("error", { at: "runtime-worker", msg: "lease_sweeper 세션 teardown 실패", run_id: lease.run_id, lease_id: lease.id, correlation_id: job.correlationId ?? tenantId, tenant_id: tenantId, worker_id: workerId, error: errText(e) }),
          );
      }
    }

    return { kind: "completed", emittedEvents: [] };
  }

  private async isolateWorkersForExpiredBrowserLeases(
    expiredBrowser: readonly { readonly owner_worker_id: string }[],
  ): Promise<void> {
    const workerIds = [...new Set(expiredBrowser.map((lease) => lease.owner_worker_id))];
    if (workerIds.length === 0) return;

    const openMs = this.options.workerCircuitOpenMs ?? DEFAULT_WORKER_CIRCUIT_OPEN_MS;
    if (!Number.isInteger(openMs) || openMs <= 0) {
      throw new Error("RuntimeWorker: workerCircuitOpenMs must be a positive integer");
    }

    await this.pool.query(
      `UPDATE workers
          SET circuit_state = 'open',
              circuit_until = GREATEST(
                COALESCE(circuit_until, '-infinity'::timestamptz),
                now() + ($2::int * interval '1 millisecond')
              ),
              consecutive_init_failures = 0,
              half_open_successes = 0
        WHERE id = ANY($1::uuid[])
          AND kind = 'browser'
          AND status = 'active'`,
      [workerIds, openMs],
    );
  }
}

function runtimeJobEnqueuerAsRunEnqueuer(port: RuntimeJobEnqueuePort): RunEnqueuer {
  return {
    async enqueueRunClaim(client, input) {
      await port.enqueueRuntimeJob(client, {
        kind: "run_claim",
        tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
        runId: input.runId as RuntimeWorkerJob["runId"],
        correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
      });
    },
    async enqueueRunAbort() {
      throw new Error("trigger_fire RunEnqueuer adapter does not support run_abort");
    },
    async enqueueSinkDeliver() {
      throw new Error("trigger_fire RunEnqueuer adapter does not support sink_deliver");
    },
  };
}
