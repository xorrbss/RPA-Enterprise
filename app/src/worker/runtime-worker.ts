/**
 * RuntimeWorker — Worker 잡 디스패처 (D2 골격, ts/runtime-contract.ts 구현).
 *
 * 계약: RuntimeWorker.handle(job: RuntimeWorkerJob) → RuntimeJobResult. job kind는
 * release-decisions.md #9의 닫힌 집합. 본 골격은 D2에서 검증 가능한 잡만 구현하고, D3(executor/lease)·
 * D6(pipeline)에 의존하는 잡은 **조용한 no-op 없이** 명시적으로 throw한다(가정 금지).
 *
 * 큐 런너(Graphile Worker) 연결은 D2.5 어댑터에서 본 handle()에 위임한다.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";

import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  checkBypassRlsUse,
  safeSerialize,
} from "../../../security/compliance-scaffold";
import type { ArtifactRef, ObjectRef, SecretRef } from "../../../ts/core-types";
import type { RunState, WorkitemState } from "../../../ts/state-machine-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
} from "../../../ts/runtime-contract";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleOperationalUseCase,
  ArtifactLifecycleTarget,
  ArtifactObjectIoEvidence,
  ArtifactObjectIoOperation,
  ArtifactObjectIoPortBinding,
  ArtifactRedactor,
  ArtifactRedactionDecision,
  ArtifactRetentionDeleteResult,
  ArtifactRetentionStore,
  EventId,
  IsoDateTime,
  LeaseCleanupPolicy,
  LeaseIsolation,
  LeaseId,
  LeaseRenewResult,
  RunAbortDrainInput,
  RunAbortDrainResult,
  RunAbortDrainer,
  ResumeTokenCodec,
  ResumeTokenEnvelope,
  RuntimeJobResult,
  RuntimeWorker,
  RuntimeWorkerJob,
  ScenarioGenerationId,
  VisualEvidenceVideoRecorder,
  SessionRestoreInput,
  SessionRestoreResult,
  SessionRestorer,
  SinkDeliveryPort,
  WorkerId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { SPAN, withSpan, recordSiteBlock, type CommonSpanAttrs } from "../observability/telemetry";
import { applyRunTransition } from "../runtime/run-transition";
import { applyWorkitemTransition } from "../runtime/workitem-transition";
import { insertWorkitemDeadLetter, WORKITEM_MAX_ATTEMPTS } from "../runtime/workitem-settlement";
import { relayOutbox } from "../runtime/outbox-relay";
import { deliverNormalizedRecord } from "../runtime/pipeline/sink-delivery";
import { driveClaimedRun, driveResumedRun } from "../runtime/run-step-driver";
import { handleClaimedInitFailure, type InitBackoffConfig } from "../runtime/run-init-failure";
import type { BrowserSessionStore } from "../runtime/browser-session-store";
import type { MergedExtractArtifactSink } from "../runtime/merged-extract-artifact";
import type { VisualEvidenceRecorder } from "../runtime/visual-evidence";
import { UtilityExecutor } from "../executor/utility-executor";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider, type BrowserSessionProvider } from "../executor/browser-session-provider";
import type { ExecutorChallengeSuspensionPort, RuntimeJobEnqueuePort } from "../runtime/executor-completion-coordinator";
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
  // suspend 구동(트리거 i): worker 경유 run 이 suspend(executor status='suspended')하면 driveClaimedRun/driveResumedRun →
  // driveSuspend 가 이 둘을 소비(R4+포트→resume-token 발행+R11→suspended). 미주입 시 suspend terminal 은 loud throw(미구성).
  // PgChallengeSuspensionPort=stateless, codec=deploy-time(SecretStore+signingKeyRef). 실 트리거(challenge 감지)는 DOM/vision executor 후행.
  readonly suspensionPort?: ExecutorChallengeSuspensionPort;
  readonly resumeTokenCodec?: ResumeTokenCodec;
  // run-drive executor seam: 기본=UtilityExecutor. suspend-가능 executor 주입 시 worker-driven suspend 가 트리거·검증된다.
  readonly executorFactory?: RunExecutorFactory;
}

export interface BrowserLeaseRenewInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly ttlMs: number;
}

export interface BrowserLeaseDrainInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly reason: "run_cancelled" | "run_completed" | "run_suspended" | "sweeper";
}

// A.1 run-drive: claim tx 에서 캡처해 tx 밖(Phase B)에서 driveClaimedRun 에 넘기는 입력(브라우저 작업은 커넥션 밖).
interface RunClaimDriveInputs {
  readonly scenarioVersionId: string;
  readonly model?: string;
  readonly correlationId: string;
  readonly leaseId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly browserIdentityVersion: number;
  readonly networkPolicyId: string;
  readonly networkAllowedDomains: readonly string[];
  readonly isolation: LeaseIsolation;
  readonly cleanupPolicy: LeaseCleanupPolicy;
  readonly params?: Record<string, unknown>;
}

// runs.params(jsonb) 정규화: 문자열이면 파싱, null/부재면 undefined(빈 {} 와 구분 — navigate 키 해소가 loud 실패). run-loop 와 동형.
function normalizeRunParams(raw: unknown): Record<string, unknown> | undefined {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

type RunRow = { status: RunState; correlation_id: string };
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
type WorkitemRow = { status: WorkitemState };
type ArtifactLifecycleRow = {
  id: string;
  tenant_id: string;
  run_id: string | null;
  generation_id: string | null;
  step_id: string | null;
  attempt: number | null;
  type: string;
  redaction_status: ArtifactLifecycleTarget["redactionStatus"];
  redaction_attempts: number;
  sha256: string | null;
  object_ref: string;
  retention_until: string | null;
  legal_hold: boolean;
  quarantine: boolean;
  deleted_at: string | null;
  deleted_reason: string | null;
  deleted_by_job: string | null;
};
type ArtifactLifecycleClaimKind = "artifact_redaction" | "artifact_retention";
type ArtifactLifecycleClaim = {
  readonly claimId: string;
  readonly kind: ArtifactLifecycleClaimKind;
  readonly tenantId: string;
  readonly workerId: string;
  readonly correlationId: string;
  readonly artifact: ArtifactLifecycleTarget;
};
type ArtifactLifecycleClaimResult =
  | { readonly kind: "claimed"; readonly claim: ArtifactLifecycleClaim }
  | { readonly kind: "deferred"; readonly retryAfterMs: number }
  | { readonly kind: "empty" };
type ArtifactLifecycleJobScope = {
  readonly runId: RunId | undefined;
  readonly generationId: ScenarioGenerationId | undefined;
};
type LifecycleAuditAppendInput = {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly workerId: string;
  readonly useCase: ArtifactLifecycleOperationalUseCase;
  readonly jobKind: "artifact_redaction" | "artifact_retention";
  readonly reasonCode: string;
  readonly artifact: ArtifactLifecycleTarget;
  readonly jobId: string;
  readonly retentionDays: number;
  readonly portBinding?: ArtifactObjectIoPortBinding;
  readonly objectIoEvidence?: ArtifactObjectIoEvidence;
};
const DEFAULT_BROWSER_LEASE_TTL_MS = 300_000;
const DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS = 300_000;
const DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS = 3;
// sink failed(상한 미달) 재전달 backoff 기본(ops-defaults #sink.delivery.retry_backoff base 5s).
const DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS = 5_000;
const DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS = 60_000;
const DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_RUN_ABORT_TIMEOUT_MS = 30_000;
// ops-defaults.md #workitem.checkout_timeout=10m. W1 checkout 시 checkout_expires_at 설정, W6/W7 sweeper 가 만료 판정. 코드 상수 금지 규약 — inline 인용.
const WORKITEM_CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;

export async function renewBrowserLease(
  client: pg.PoolClient,
  input: BrowserLeaseRenewInput,
): Promise<LeaseRenewResult> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("renewBrowserLease: ttlMs must be a positive integer");
  }
  const renewed = await client.query<{ expires_at: string }>(
    `UPDATE browser_leases
        SET heartbeat_at = now(),
            expires_at = now() + ($4::int * interval '1 millisecond')
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')
        AND expires_at >= now()
      RETURNING expires_at::text`,
    [input.tenantId, input.leaseId, input.workerId, input.ttlMs],
  );
  const row = renewed.rows[0];
  if (row !== undefined) return { kind: "renewed", expiresAt: row.expires_at as IsoDateTime };
  return {
    kind: "lost",
    code: "BROWSER_LEASE_EXPIRED",
    reason: "lease missing, owned by another worker, drained, cross-tenant, or expired",
  };
}

export async function drainBrowserLease(
  client: pg.PoolClient,
  input: BrowserLeaseDrainInput,
): Promise<void> {
  await client.query(
    `UPDATE browser_leases
        SET state = CASE WHEN $4 = 'sweeper' THEN 'expired' ELSE 'draining' END,
            expires_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')`,
    [input.tenantId, input.leaseId, input.workerId, input.reason],
  );
}

/**
 * INIT 실패(R3a/R3b) 시 Phase A 에서 예약(active)만 된 browser lease 행을 **삭제**한다. INIT 실패는 bind 가 throw 한
 * 경우라 라이브 세션이 열린 적이 없어 teardown 이 불요하고, drain('draining' 잔류)은 종결자가 없어 누적된다(행 누수).
 * 더 중요한 건 재-claim 이 신규 lease 를 INSERT 해 run 당 lease 가 2행이 되면 abort 의 claimAbortBrowserLeaseForRun
 * (run_id 별 LIMIT 2)이 'multiple'→CONTROL_PLANE_INTERNAL_ERROR 로 wedge 되는 것(적대리뷰 B1) — 행을 삭제해
 * 'run 당 활성 lease ≤1' 불변식을 복원한다. owner 가드(다른 워커 lease 미삭제).
 */
export async function deleteInitReservedBrowserLease(
  client: pg.PoolClient,
  input: { readonly tenantId: string; readonly leaseId: string; readonly workerId: string },
): Promise<void> {
  await client.query(
    `DELETE FROM browser_leases
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND owner_worker_id = $3::uuid`,
    [input.tenantId, input.leaseId, input.workerId],
  );
}

export class PgRuntimeWorker implements RuntimeWorker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {}

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
        return this.handleWorkitemCheckoutSweeper(job);

      case "workitem_checkout":
        return this.handleWorkitemCheckout(job);

      case "run_resume":
        return this.handleRunResume(job);

      // D3(executor/lease)·D6(pipeline) 의존 — D2 골격 미구현. 조용한 no-op 금지: 명시적 throw.
      case "artifact_redaction":
        return this.handleArtifactRedaction(job);

      case "artifact_retention":
        return this.handleArtifactRetention(job);

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
        const run = await this.loadExpectedRun(client, tenantId, runId, "queued");
        if (run.kind !== "ok") return { result: run.result };

        // §E 필수 span: run.claim(루트) ⊃ browser.lease.acquire. 공통속성은 적재된 run의 correlation_id.
        const correlationId = job.correlationId ?? run.row.correlation_id;
        const common: CommonSpanAttrs = { tenant_id: tenantId, run_id: runId, correlation_id: correlationId };
        return withSpan(SPAN.runClaim, common, { worker_id: workerId }, async () => {
          const plan = await leasePlanResolver(client, { tenantId, runId });
          const lease = await withSpan(SPAN.browserLeaseAcquire, common, {}, async () =>
            this.acquireBrowserLease(client, { tenantId, runId, workerId, plan }),
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
          const drive = await this.loadRunDriveInputs(client, tenantId, runId, plan, lease.leaseId, correlationId);
          return { result, drive };
        });
      },
    );

    // Phase B: 구동(tx 밖 — 브라우저 작업이 DB 커넥션 점유 금지). 미주입/미구동이면 claimed 결과 반환.
    // driveClaimedRun: success→completed, fail_business/fail_system→failed_*(2a). suspend/challenge 등 그 외 terminal 은
    // 미구현 throw 로 표면화(propagate). 세션은 어느 경로든 finally 에서 해제.
    if (claim.drive === undefined || sessionProvider === undefined) return claim.result;
    const d = claim.drive;

    // INIT phase(status='claimed'): site page-state config 적재 + 세션 bind(브라우저 I/O). 이 셋업이 throw 하면 좀비
    //   claimed 잔류 대신 init_failed(R3a 재큐 / R3b 종결)로 처리한다(state-machine §1 INIT 규칙). bind 성공 후엔 즉시
    //   setup 확정이라 init-catch 에 leaked 세션 없음 — Phase A 브라우저 lease 는 handleClaimedInitFailure 가 drainLease 로 해제.
    let setup: {
      bound: Awaited<ReturnType<typeof sessionProvider.bind>>;
      siteConfig: Awaited<ReturnType<typeof loadSitePageStateConfig>>;
    };
    try {
      const siteConfig = await withTenantTx(this.pool, tenantId, (c) =>
        loadSitePageStateConfig(c, tenantId, d.siteProfileId),
      );
      const bound = await sessionProvider.bind({
        tenantId,
        leaseId: d.leaseId,
        siteProfileId: d.siteProfileId,
        browserIdentityId: d.browserIdentityId,
        networkPolicyId: d.networkPolicyId,
        isolation: d.isolation,
        cleanupPolicy: d.cleanupPolicy,
      });
      setup = { bound, siteConfig };
    } catch (initErr) {
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
      return claim.result;
    }

    // DRIVE phase(R2→running, driveScenario failsafe). bound + siteConfig 보장. 세션은 어느 경로든 finally 에서 해제.
    try {
      const executor = (this.options.executorFactory ?? defaultExecutorFactory)(setup.bound.provider, {
        scenarioVersionId: d.scenarioVersionId,
        browserIdentityVersion: d.browserIdentityVersion,
        tenantId, // 자격증명 fill executorPrincipal per-run 테넌트(감사 정합).
        ...(d.model !== undefined ? { model: d.model } : {}),
      });
      const resolver = new SitePageStateResolver(setup.bound.provider, setup.siteConfig);
      await driveClaimedRun(
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
          executor,
          resolver,
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
    return claim.result;
  }

  // A.1 run-drive: claim tx 에서 scenario_version_id + params 적재 + plan 의 identity 3-tuple 확정(networkPolicyId 필수).
  private async loadRunDriveInputs(
    client: pg.PoolClient,
    tenantId: string,
    runId: string,
    plan: BrowserLeasePlan,
    leaseId: string,
    correlationId: string,
  ): Promise<RunClaimDriveInputs> {
    if (plan.networkPolicyId === undefined) {
      throw new Error(
        "RuntimeWorker: run-drive requires BrowserLeasePlan.networkPolicyId (identity 3-tuple); plan 미공급",
      );
    }
    // browser_identity_version: dom executor ActionPlanCache 키 스코프(StagehandDomExecutorConfig). plan.browserIdentityId 로 JOIN.
    const r = await client.query<{ scenario_version_id: string; model: string | null; params: unknown; browser_identity_version: number; allowed_domains: string[] }>(
      `SELECT r.scenario_version_id::text AS scenario_version_id, r.model, r.params,
              bi.version AS browser_identity_version,
              np.allowed_domains
         FROM runs r
         JOIN browser_identities bi ON bi.id = $3::uuid AND bi.tenant_id = $1::uuid
         JOIN network_policies np ON np.id = $4::uuid AND np.tenant_id = $1::uuid
        WHERE r.tenant_id = $1::uuid AND r.id = $2::uuid`,
      [tenantId, runId, plan.browserIdentityId, plan.networkPolicyId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new Error("RuntimeWorker: run-drive run/browser_identity/network_policy row not found in tenant scope");
    }
    return {
      scenarioVersionId: row.scenario_version_id,
      ...(row.model !== null ? { model: row.model } : {}),
      correlationId,
      leaseId,
      siteProfileId: plan.siteProfileId,
      browserIdentityId: plan.browserIdentityId,
      browserIdentityVersion: row.browser_identity_version,
      networkPolicyId: plan.networkPolicyId,
      networkAllowedDomains: row.allowed_domains,
      isolation: plan.isolation ?? "context",
      cleanupPolicy: plan.cleanupPolicy ?? "clear_all",
      params: normalizeRunParams(row.params),
    };
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
          (await this.hasOpenAbortBrowserLeaseForRun(client, { tenantId, runId, workerId: row.worker_id }))
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
      const claim = await this.claimAbortBrowserLeaseForRun(client, { tenantId, runId, workerId, timeoutMs });
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
      return this.finalizeRunAbort(tenantId, runId, txA);
    }

    const drainResult = await this.options.runAbortDrainer!.drainAbort(txA.intent).catch(
      (err): RunAbortDrainResult => ({
        kind: "transient_failed",
        reason: unknownToReason(err),
      }),
    );
    if (drainResult.kind === "transient_failed") {
      await this.releaseAbortBrowserDrainClaim(txA.intent);
      return {
        kind: "deferred",
        code: "CONTROL_PLANE_INTERNAL_ERROR",
        retryAfterMs: drainResult.retryAfterMs ?? 1_000,
      };
    }
    if (drainResult.kind === "terminal_failed") {
      await this.releaseAbortBrowserDrainClaim(txA.intent);
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    return this.finalizeRunAbort(tenantId, runId, {
      event: drainResult.kind === "timeout" ? "drain_timeout" : "drain_ok",
      correlationId: txA.intent.correlationId,
      leaseId: txA.intent.leaseId,
      workerId: txA.intent.workerId,
    });
  }

  private async handleWorkitemCheckout(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "workitem_checkout.tenantId");
    const workitemId = requireString(job.workitemId, "workitem_checkout.workitemId");
    const correlationId = requireString(job.correlationId, "workitem_checkout.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for workitem_checkout",
    );

    return withTenantTx(this.pool, tenantId, async (client) => {
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
  private async handleWorkitemCheckoutSweeper(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "workitem_checkout_sweeper.tenantId");
    const correlationId = requireString(job.correlationId, "workitem_checkout_sweeper.correlationId");
    await withTenantTx(this.pool, tenantId, async (client) => {
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

      let lease = await this.findActiveBrowserLeaseForRun(client, {
        tenantId,
        runId,
        workerId,
      });
      if (lease === null) {
        // §E browser.lease.acquire — resume 경로의 lease 확보도 동일 span으로 계측.
        const resumeCommon: CommonSpanAttrs = {
          tenant_id: tenantId,
          run_id: runId,
          correlation_id: job.correlationId ?? row.correlation_id,
        };
        const acquired = await withSpan(SPAN.browserLeaseAcquire, resumeCommon, {}, async () => {
          const plan = await leasePlanResolver(client, { tenantId, runId });
          return this.acquireBrowserLease(client, { tenantId, runId, workerId, plan });
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
      return this.loadRunDriveInputs(client, tenantId, runId, plan, txA.intent.leaseId, txA.intent.correlationId);
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

  private async handleArtifactRedaction(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_redaction.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_redaction.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_redaction",
    );
    const redactor = this.options.artifactRedactor;
    if (redactor === undefined) {
      throw new Error("RuntimeWorker: artifact_redaction requires an explicit ArtifactRedactor");
    }
    const portBinding = requireArtifactObjectIoPortBinding(
      redactor.binding,
      "artifact_redaction",
      this.options.allowTestArtifactLifecyclePorts === true,
    );
    const maxAttempts = this.options.artifactRedactionMaxAttempts ?? DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("RuntimeWorker: artifact_redaction maxAttempts must be a positive integer");
    }
    const scope = artifactLifecycleJobScope(job, "artifact_redaction");

    const claim = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_redaction_job", "artifact_lifecycle.redaction.claim");
      return this.claimRedactionArtifact(client, {
        tenantId,
        runId: scope.runId,
        artifactId: optionalString(job.artifactId, "artifact_redaction.artifactId") as ArtifactRef | undefined,
        generationId: scope.generationId,
        workerId,
        correlationId,
        claimTtlMs: this.lifecycleClaimTtlMs(),
        maxAttempts,
        portBinding,
      });
    });
    if (claim.kind === "deferred") {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: claim.retryAfterMs };
    }
    if (claim.kind === "empty") {
      return { kind: "completed", emittedEvents: [] };
    }

    const audit = lifecycleOperationalAudit({
      useCase: "artifact_redaction_job",
      correlationId,
      reasonCode: "artifact_lifecycle.redaction.object_io",
    });
    const decision = await redactor.redact({
      tenantId: tenantId as TenantId,
      correlationId: correlationId as CorrelationId,
      artifact: claim.claim.artifact,
      policy: { maxAttempts },
      portBinding,
      audit,
    }).catch(() => ({ kind: "retryable_failed", reason: "redactor_exception" }) as const);
    validateArtifactRedactionDecision(decision, {
      operation: "redact",
      artifactRef: claim.claim.artifact.artifactRef,
      correlationId,
      portBinding,
    });

    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_redaction_job", "artifact_lifecycle.redaction.finalize");
      await this.finalizeRedactionDecision(client, { claim: claim.claim, decision, maxAttempts, portBinding });
    });
    return { kind: "completed", emittedEvents: [] };
  }

  private async handleArtifactRetention(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_retention.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_retention.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_retention",
    );
    const retentionStore = this.options.artifactRetentionStore;
    if (retentionStore === undefined) {
      throw new Error("RuntimeWorker: artifact_retention requires an explicit ArtifactRetentionStore");
    }
    const scope = artifactLifecycleJobScope(job, "artifact_retention");
    const portBinding = requireArtifactObjectIoPortBinding(
      retentionStore.binding,
      "artifact_retention",
      this.options.allowTestArtifactLifecyclePorts === true,
    );

    const claim = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_retention_sweeper", "artifact_lifecycle.retention.claim");
      return this.claimRetentionArtifact(client, {
        tenantId,
        runId: scope.runId,
        generationId: scope.generationId,
        workerId,
        correlationId,
        claimTtlMs: this.lifecycleClaimTtlMs(),
        portBinding,
      });
    });
    if (claim.kind === "deferred") {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: claim.retryAfterMs };
    }
    if (claim.kind === "empty") {
      return { kind: "completed", emittedEvents: [] };
    }

    const audit = lifecycleOperationalAudit({
      useCase: "artifact_retention_sweeper",
      correlationId,
      reasonCode: "artifact_lifecycle.retention.object_delete",
    });
    const deleteResult = await retentionStore.deleteObject({
      tenantId: tenantId as TenantId,
      correlationId: correlationId as CorrelationId,
      artifact: claim.claim.artifact,
      jobId: claim.claim.claimId,
      policy: { deleteReason: "retention_expired" },
      portBinding,
      audit,
    }).catch(() => ({ kind: "transient_failed", reason: "retention_store_exception" }) as const);
    validateArtifactRetentionDeleteResult(deleteResult, {
      operation: "delete",
      artifactRef: claim.claim.artifact.artifactRef,
      correlationId,
      portBinding,
    });

    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_retention_sweeper", "artifact_lifecycle.retention.finalize");
      await this.finalizeRetentionDecision(client, { claim: claim.claim, deleteResult, portBinding });
    });
    return { kind: "completed", emittedEvents: [] };
  }

  private async loadExpectedRun(
    client: pg.PoolClient,
    tenantId: string,
    runId: string,
    expectedStatus: RunState,
  ): Promise<{ kind: "ok"; row: RunRow } | { kind: "failed"; result: RuntimeJobResult }> {
    const run = await client.query<RunRow>(
      `SELECT status, correlation_id::text
         FROM runs
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [tenantId, runId],
    );
    const row = run.rows[0];
    if (row === undefined) {
      return { kind: "failed", result: { kind: "failed", code: "RUN_NOT_FOUND" } };
    }
    if (row.status !== expectedStatus) {
      if (expectedStatus === "queued" && row.status === "cancelled") {
        // A queued/claimed run can be cancelled by the API before its stale run_claim job is consumed.
        return { kind: "failed", result: { kind: "completed", emittedEvents: [] } };
      }
      return { kind: "failed", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
    }
    return { kind: "ok", row };
  }

  private async acquireBrowserLease(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      workerId: string;
      plan: BrowserLeasePlan | null;
    },
  ): Promise<RuntimeJobResult | { kind: "acquired"; leaseId: string }> {
    if (input.plan === null) {
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    const ttlMs = input.plan.ttlMs ?? this.options.defaultBrowserLeaseTtlMs ?? DEFAULT_BROWSER_LEASE_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("RuntimeWorker: browser lease ttlMs must be a positive integer");
    }
    const isolation = input.plan.isolation ?? "context";
    const cleanupPolicy = input.plan.cleanupPolicy ?? "clear_all";

    const worker = await client.query<{ kind: string; status: string; circuit_state: string }>(
      `SELECT kind, status, circuit_state FROM workers WHERE id = $1::uuid`,
      [input.workerId],
    );
    const workerRow = worker.rows[0];
    if (workerRow?.kind !== "browser" || workerRow.status !== "active" || workerRow.circuit_state === "open") {
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    const identity = await client.query<{ risk: string; approved: boolean }>(
      `SELECT sp.risk, sp.approved
         FROM browser_identities bi
         JOIN site_profiles sp
           ON sp.tenant_id = bi.tenant_id
          AND sp.id = bi.site_profile_id
        WHERE bi.tenant_id = $1::uuid
          AND bi.id = $2::uuid
          AND sp.id = $3::uuid
        FOR UPDATE OF bi`,
      [input.tenantId, input.plan.browserIdentityId, input.plan.siteProfileId],
    );
    const site = identity.rows[0];
    if (site === undefined) {
      return { kind: "failed", code: "RESOURCE_NOT_FOUND" };
    }
    if (site.risk === "red" && !site.approved) {
      recordSiteBlock({ tenant_id: input.tenantId }); // §E site_block_rate. bootstrap 전이면 no-op meter.
      return { kind: "failed", code: "SITE_PROFILE_BLOCKED" };
    }

    await client.query(
      `UPDATE browser_leases
          SET state = 'expired'
        WHERE tenant_id = $1::uuid
          AND site_profile_id = $2::uuid
          AND browser_identity_id = $3::uuid
          AND state IN ('reserved','active')
          AND expires_at < now()`,
      [input.tenantId, input.plan.siteProfileId, input.plan.browserIdentityId],
    );

    const active = await client.query<{ retry_after_ms: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now())) * 1000))::int AS retry_after_ms
         FROM browser_leases
        WHERE tenant_id = $1::uuid
          AND site_profile_id = $2::uuid
          AND browser_identity_id = $3::uuid
          AND state IN ('reserved','active')
          AND expires_at >= now()
        ORDER BY expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.plan.siteProfileId, input.plan.browserIdentityId],
    );
    const activeLease = active.rows[0];
    if (activeLease !== undefined) {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: activeLease.retry_after_ms };
    }

    const leaseId = randomUUID();
    await client.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7, 'active', $8, $9, now() + ($10::int * interval '1 millisecond')
       )`,
      [
        leaseId,
        input.tenantId,
        input.plan.siteProfileId,
        input.plan.browserIdentityId,
        input.runId,
        input.workerId,
        isolation,
        cleanupPolicy,
        input.plan.downloadDirRef ?? null,
        ttlMs,
      ],
    );

    return { kind: "acquired", leaseId };
  }

  private async findActiveBrowserLeaseForRun(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      workerId: string;
    },
  ): Promise<string | null> {
    const lease = await client.query<{ id: string }>(
      `SELECT id::text
         FROM browser_leases
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND owner_worker_id = $3::uuid
          AND state IN ('reserved','active')
          AND expires_at >= now()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId, input.workerId],
    );
    return lease.rows[0]?.id ?? null;
  }

  private async hasOpenAbortBrowserLeaseForRun(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      workerId: string;
    },
  ): Promise<boolean> {
    const lease = await client.query<{ id: string }>(
      `SELECT id::text
         FROM browser_leases
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND owner_worker_id = $3::uuid
          AND state IN ('reserved','active','draining')
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId, input.workerId],
    );
    return lease.rows.length > 0;
  }

  private async claimAbortBrowserLeaseForRun(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      workerId: string;
      timeoutMs: number;
    },
  ): Promise<
    | { kind: "claimed"; leaseId: string }
    | { kind: "expired"; leaseId: string }
    | { kind: "deferred"; retryAfterMs: number }
    | { kind: "missing" }
    | { kind: "multiple" }
  > {
    const lease = await client.query<{ id: string; state: string; deadline_expired: boolean; retry_after_ms: number }>(
      `SELECT id::text,
              state,
              (expires_at <= now()) AS deadline_expired,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now())) * 1000))::int AS retry_after_ms
         FROM browser_leases
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND owner_worker_id = $3::uuid
          AND state IN ('reserved','active','draining','expired')
        ORDER BY created_at DESC
        LIMIT 2
        FOR UPDATE`,
      [input.tenantId, input.runId, input.workerId],
    );
    if (lease.rows.length > 1) return { kind: "multiple" };
    const row = lease.rows[0];
    if (row === undefined) return { kind: "missing" };
    if (row.state === "expired" || row.deadline_expired) return { kind: "expired", leaseId: row.id };
    if (row.state === "draining") return { kind: "deferred", retryAfterMs: row.retry_after_ms };

    const claimed = await client.query<{ id: string }>(
      `UPDATE browser_leases
          SET state = 'draining',
              expires_at = LEAST(expires_at, now() + ($4::int * interval '1 millisecond'))
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND owner_worker_id = $3::uuid
          AND state IN ('reserved','active')
        RETURNING id::text`,
      [input.tenantId, row.id, input.workerId, input.timeoutMs],
    );
    if (claimed.rowCount !== 1) return { kind: "deferred", retryAfterMs: 1_000 };
    return { kind: "claimed", leaseId: row.id };
  }

  private async releaseAbortBrowserDrainClaim(input: RunAbortDrainInput): Promise<void> {
    await withTenantTx(this.pool, input.tenantId, async (client) => {
      const released = await client.query(
        `UPDATE browser_leases
            SET state = 'active'
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND run_id = $3::uuid
            AND owner_worker_id = $4::uuid
            AND state = 'draining'`,
        [input.tenantId, input.leaseId, input.runId, input.workerId],
      );
      if (released.rowCount !== 1) {
        throw new Error("RuntimeWorker: run_abort browser lease drain-claim release CAS conflict");
      }
    });
  }

  private async finalizeRunAbort(
    tenantId: string,
    runId: string,
    input: {
      event: "drain_ok" | "drain_timeout";
      correlationId: string;
      leaseId?: string;
      workerId?: string;
    },
  ): Promise<RuntimeJobResult> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const transition = await applyRunTransition(client, {
        tenantId,
        runId,
        fromStatus: "aborting",
        event: { type: input.event },
        guard: {},
        correlationId: input.correlationId,
        eventIdempotencyKey: `${runId}:run_abort`,
      });

      if (!transition.applied) {
        if (transition.observed === "cancelled") {
          return { kind: "completed", emittedEvents: [] };
        }
        throw new Error(`RuntimeWorker: run_abort CAS conflict after row lock; observed=${transition.observed ?? "null"}`);
      }
      if (!isOnlyAbortLeasePending(transition.pending, input.event)) {
        throw new Error("RuntimeWorker: run_abort finalization produced unsupported pending side effects");
      }

      if (input.leaseId !== undefined && input.workerId !== undefined) {
        await this.expireAbortBrowserLease(client, {
          tenantId,
          runId,
          leaseId: input.leaseId,
          workerId: input.workerId,
        });
      }

      return {
        kind: "completed",
        emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
      };
    });
  }

  private async expireAbortBrowserLease(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      leaseId: string;
      workerId: string;
    },
  ): Promise<void> {
    const expired = await client.query(
      `UPDATE browser_leases
          SET state = 'expired',
              expires_at = LEAST(expires_at, now())
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND run_id = $3::uuid
          AND owner_worker_id = $4::uuid
          AND state IN ('reserved','active','draining','expired')`,
      [input.tenantId, input.leaseId, input.runId, input.workerId],
    );
    if (expired.rowCount === 0) {
      throw new Error("RuntimeWorker: run_abort browser lease finalize CAS conflict");
    }
  }

  private async claimRedactionArtifact(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: RunId | undefined;
      artifactId: ArtifactRef | undefined;
      generationId: ScenarioGenerationId | undefined;
      workerId: string;
      correlationId: string;
      claimTtlMs: number;
      maxAttempts: number;
      portBinding: ArtifactObjectIoPortBinding;
    },
  ): Promise<ArtifactLifecycleClaimResult> {
    const active = await client.query<{ retry_after_ms: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (lifecycle_claim_expires_at - now())) * 1000))::int AS retry_after_ms
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND redaction_status = 'pending'
          AND redaction_attempts < $3::int
           AND deleted_at IS NULL
           AND quarantine = false
           AND ($4::uuid IS NULL OR id = $4::uuid)
           AND (
             ($2::uuid IS NULL AND $5::uuid IS NULL)
             OR ($2::uuid IS NOT NULL AND run_id = $2::uuid)
             OR ($5::uuid IS NOT NULL AND generation_id = $5::uuid)
           )
           AND lifecycle_claim_id IS NOT NULL
           AND lifecycle_claim_expires_at > now()
        ORDER BY lifecycle_claim_expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId ?? null, input.maxAttempts, input.artifactId ?? null, input.generationId ?? null],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined) {
      return { kind: "deferred", retryAfterMs: activeRow.retry_after_ms };
    }

    const artifact = await client.query<ArtifactLifecycleRow>(
      `SELECT id::text, tenant_id::text, run_id::text, generation_id::text, step_id, attempt, type,
              redaction_status, redaction_attempts, sha256, object_ref,
              retention_until::text, legal_hold, quarantine, deleted_at::text,
              deleted_reason, deleted_by_job
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND redaction_status = 'pending'
          AND redaction_attempts < $3::int
           AND deleted_at IS NULL
           AND quarantine = false
           AND ($4::uuid IS NULL OR id = $4::uuid)
           AND (
             ($2::uuid IS NULL AND $5::uuid IS NULL)
             OR ($2::uuid IS NOT NULL AND run_id = $2::uuid)
             OR ($5::uuid IS NOT NULL AND generation_id = $5::uuid)
           )
           AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [input.tenantId, input.runId ?? null, input.maxAttempts, input.artifactId ?? null, input.generationId ?? null],
    );
    const row = artifact.rows[0];
    if (row === undefined) {
      return { kind: "empty" };
    }

    const claimId = randomUUID();
    const target = artifactTargetFromRow(row);
    await appendLifecycleAuditWithClient(client, {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      workerId: input.workerId,
      useCase: "artifact_redaction_job",
      jobKind: "artifact_redaction",
      reasonCode: "artifact_lifecycle.redaction.claim",
      artifact: target,
      jobId: claimId,
      retentionDays: this.lifecycleAuditRetentionDays(),
      portBinding: input.portBinding,
    });

    const claimed = await client.query(
      `UPDATE artifacts
          SET lifecycle_claim_id = $3::uuid,
              lifecycle_claim_kind = 'artifact_redaction',
              lifecycle_claim_worker_id = $4::uuid,
              lifecycle_claim_correlation_id = $5::uuid,
              lifecycle_claimed_at = now(),
              lifecycle_claim_expires_at = now() + ($6::int * interval '1 millisecond')
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND redaction_status = 'pending'
           AND redaction_attempts < $7::int
           AND deleted_at IS NULL
           AND quarantine = false
           AND ($8::uuid IS NULL OR id = $8::uuid)
           AND ($9::uuid IS NULL OR generation_id = $9::uuid)
           AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())`,
      [
        input.tenantId,
        row.id,
        claimId,
        input.workerId,
        input.correlationId,
        input.claimTtlMs,
        input.maxAttempts,
        input.artifactId ?? null,
        input.generationId ?? null,
      ],
    );
    if (claimed.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_redaction claim CAS conflict");
    }
    return {
      kind: "claimed",
      claim: {
        claimId,
        kind: "artifact_redaction",
        tenantId: input.tenantId,
        workerId: input.workerId,
        correlationId: input.correlationId,
        artifact: target,
      },
    };
  }

  private async claimRetentionArtifact(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: RunId | undefined;
      generationId: ScenarioGenerationId | undefined;
      workerId: string;
      correlationId: string;
      claimTtlMs: number;
      portBinding: ArtifactObjectIoPortBinding;
    },
  ): Promise<ArtifactLifecycleClaimResult> {
    const active = await client.query<{ retry_after_ms: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (lifecycle_claim_expires_at - now())) * 1000))::int AS retry_after_ms
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()
          AND (
            ($2::uuid IS NULL AND $3::uuid IS NULL)
            OR ($2::uuid IS NOT NULL AND run_id = $2::uuid)
            OR ($3::uuid IS NOT NULL AND generation_id = $3::uuid)
          )
          AND lifecycle_claim_id IS NOT NULL
          AND lifecycle_claim_expires_at > now()
        ORDER BY lifecycle_claim_expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId ?? null, input.generationId ?? null],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined) {
      return { kind: "deferred", retryAfterMs: activeRow.retry_after_ms };
    }

    const artifact = await client.query<ArtifactLifecycleRow>(
      `SELECT id::text, tenant_id::text, run_id::text, generation_id::text, step_id, attempt, type,
              redaction_status, redaction_attempts, sha256, object_ref,
              retention_until::text, legal_hold, quarantine, deleted_at::text,
              deleted_reason, deleted_by_job
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()
          AND (
            ($2::uuid IS NULL AND $3::uuid IS NULL)
            OR ($2::uuid IS NOT NULL AND run_id = $2::uuid)
            OR ($3::uuid IS NOT NULL AND generation_id = $3::uuid)
          )
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())
        ORDER BY retention_until ASC, created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [input.tenantId, input.runId ?? null, input.generationId ?? null],
    );
    const row = artifact.rows[0];
    if (row === undefined) {
      return { kind: "empty" };
    }

    const claimId = randomUUID();
    const target = artifactTargetFromRow(row);
    await appendLifecycleAuditWithClient(client, {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      workerId: input.workerId,
      useCase: "artifact_retention_sweeper",
      jobKind: "artifact_retention",
      reasonCode: "artifact_lifecycle.retention.claim",
      artifact: target,
      jobId: claimId,
      retentionDays: this.lifecycleAuditRetentionDays(),
      portBinding: input.portBinding,
    });

    const claimed = await client.query(
      `UPDATE artifacts
          SET lifecycle_claim_id = $3::uuid,
              lifecycle_claim_kind = 'artifact_retention',
              lifecycle_claim_worker_id = $4::uuid,
              lifecycle_claim_correlation_id = $5::uuid,
              lifecycle_claimed_at = now(),
              lifecycle_claim_expires_at = now() + ($6::int * interval '1 millisecond')
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())`,
      [input.tenantId, row.id, claimId, input.workerId, input.correlationId, input.claimTtlMs],
    );
    if (claimed.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_retention claim CAS conflict");
    }
    return {
      kind: "claimed",
      claim: {
        claimId,
        kind: "artifact_retention",
        tenantId: input.tenantId,
        workerId: input.workerId,
        correlationId: input.correlationId,
        artifact: target,
      },
    };
  }

  private async finalizeRedactionDecision(
    client: pg.PoolClient,
    input: {
      claim: ArtifactLifecycleClaim;
      decision: ArtifactRedactionDecision;
      maxAttempts: number;
      portBinding: ArtifactObjectIoPortBinding;
    },
  ): Promise<void> {
    if (input.claim.kind !== "artifact_redaction") {
      throw new Error("RuntimeWorker: artifact_redaction finalize received the wrong claim kind");
    }

    const nextAttempts = input.claim.artifact.redactionAttempts + 1;
    let status: "pending" | "redacted" | "failed" | "not_required";
    let redactedObjectRef: ObjectRef | undefined;
    let sha256: string | undefined;
    switch (input.decision.kind) {
      case "redacted":
        status = "redacted";
        redactedObjectRef = input.decision.redactedObjectRef;
        sha256 = input.decision.sha256;
        break;
      case "not_required":
        status = "not_required";
        break;
      case "retryable_failed":
        status = nextAttempts >= input.maxAttempts ? "failed" : "pending";
        break;
      case "terminal_failed":
        status = "failed";
        break;
      default:
        throw new Error(
          `RuntimeWorker: artifact_redaction unknown port result kind ${String(
            (input.decision as { kind?: unknown }).kind ?? "missing",
          )}`,
        );
    }

    await appendLifecycleAuditWithClient(client, {
      tenantId: input.claim.tenantId,
      correlationId: input.claim.correlationId,
      workerId: input.claim.workerId,
      useCase: "artifact_redaction_job",
      jobKind: "artifact_redaction",
      reasonCode: "artifact_lifecycle.redaction.finalize",
      artifact: input.claim.artifact,
      jobId: `${input.claim.claimId}:finalize`,
      retentionDays: this.lifecycleAuditRetentionDays(),
      portBinding: input.portBinding,
      objectIoEvidence: evidenceFromRedactionDecision(input.decision),
    });

    const updated = await client.query(
      `UPDATE artifacts
          SET redaction_status = $3,
              redaction_attempts = redaction_attempts + 1,
              object_ref = COALESCE($4, object_ref),
              sha256 = COALESCE($5, sha256),
              lifecycle_claim_id = NULL,
              lifecycle_claim_kind = NULL,
              lifecycle_claim_worker_id = NULL,
              lifecycle_claim_correlation_id = NULL,
              lifecycle_claimed_at = NULL,
              lifecycle_claim_expires_at = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND lifecycle_claim_id = $6::uuid
          AND lifecycle_claim_kind = 'artifact_redaction'
          AND lifecycle_claim_worker_id = $7::uuid
          AND lifecycle_claim_correlation_id = $8::uuid
          AND lifecycle_claim_expires_at > now()
          AND redaction_status = 'pending'
          AND deleted_at IS NULL
          AND quarantine = false`,
      [
        input.claim.tenantId,
        input.claim.artifact.artifactRef,
        status,
        redactedObjectRef ?? null,
        sha256 ?? null,
        input.claim.claimId,
        input.claim.workerId,
        input.claim.correlationId,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_redaction finalize CAS conflict after object I/O");
    }
  }

  private async finalizeRetentionDecision(
    client: pg.PoolClient,
    input: {
      claim: ArtifactLifecycleClaim;
      deleteResult: ArtifactRetentionDeleteResult;
      portBinding: ArtifactObjectIoPortBinding;
    },
  ): Promise<void> {
    if (input.claim.kind !== "artifact_retention") {
      throw new Error("RuntimeWorker: artifact_retention finalize received the wrong claim kind");
    }

    let markDeleted: boolean;
    switch (input.deleteResult.kind) {
      case "deleted":
      case "not_found":
        markDeleted = true;
        break;
      case "transient_failed":
        markDeleted = false;
        break;
      default:
        throw new Error(
          `RuntimeWorker: artifact_retention unknown port result kind ${String(
            (input.deleteResult as { kind?: unknown }).kind ?? "missing",
          )}`,
        );
    }

    await appendLifecycleAuditWithClient(client, {
      tenantId: input.claim.tenantId,
      correlationId: input.claim.correlationId,
      workerId: input.claim.workerId,
      useCase: "artifact_retention_sweeper",
      jobKind: "artifact_retention",
      reasonCode: "artifact_lifecycle.retention.finalize",
      artifact: input.claim.artifact,
      jobId: `${input.claim.claimId}:finalize`,
      retentionDays: this.lifecycleAuditRetentionDays(),
      portBinding: input.portBinding,
      objectIoEvidence: evidenceFromRetentionDeleteResult(input.deleteResult),
    });

    const updated = await client.query(
      `UPDATE artifacts
          SET deleted_at = CASE WHEN $6::boolean THEN now() ELSE deleted_at END,
              deleted_reason = CASE WHEN $6::boolean THEN 'retention_expired' ELSE deleted_reason END,
              deleted_by_job = CASE WHEN $6::boolean THEN $3::text ELSE deleted_by_job END,
              lifecycle_claim_id = NULL,
              lifecycle_claim_kind = NULL,
              lifecycle_claim_worker_id = NULL,
              lifecycle_claim_correlation_id = NULL,
              lifecycle_claimed_at = NULL,
              lifecycle_claim_expires_at = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND lifecycle_claim_id = $3::uuid
          AND lifecycle_claim_kind = 'artifact_retention'
          AND lifecycle_claim_worker_id = $4::uuid
          AND lifecycle_claim_correlation_id = $5::uuid
          AND lifecycle_claim_expires_at > now()
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()`,
      [
        input.claim.tenantId,
        input.claim.artifact.artifactRef,
        input.claim.claimId,
        input.claim.workerId,
        input.claim.correlationId,
        markDeleted,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_retention finalize CAS conflict after object deletion");
    }
  }

  private lifecycleClaimTtlMs(): number {
    const claimTtlMs = this.options.artifactLifecycleClaimTtlMs ?? DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS;
    if (!Number.isInteger(claimTtlMs) || claimTtlMs <= 0) {
      throw new Error("RuntimeWorker: artifact lifecycle claimTtlMs must be a positive integer");
    }
    return claimTtlMs;
  }

  private lifecycleRetryAfterMs(): number {
    const retryAfterMs = this.options.artifactLifecycleRetryAfterMs ?? DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS;
    if (!Number.isInteger(retryAfterMs) || retryAfterMs <= 0) {
      throw new Error("RuntimeWorker: artifact lifecycle retryAfterMs must be a positive integer");
    }
    return retryAfterMs;
  }

  private lifecycleAuditRetentionDays(): number {
    const days = this.options.artifactLifecycleAuditRetentionDays ?? DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS;
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("RuntimeWorker: artifact lifecycle audit retention days must be a positive integer");
    }
    return days;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`RuntimeWorker: ${label} is required`);
}

function parseResumeTokenEnvelope(value: unknown, expectedRunId: string): ResumeTokenEnvelope | null {
  if (!isRecord(value)) return null;
  const runId = stringField(value, "runId");
  const resumeNodeId = stringField(value, "resumeNodeId");
  const pageStateRef = stringField(value, "pageStateRef");
  const issuedAt = stringField(value, "issuedAt");
  const expiresAt = stringField(value, "expiresAt");
  const kid = stringField(value, "kid");
  const hmac = stringField(value, "hmac");
  if (
    runId === null ||
    runId !== expectedRunId ||
    resumeNodeId === null ||
    pageStateRef === null ||
    issuedAt === null ||
    expiresAt === null ||
    kid === null ||
    hmac === null
  ) {
    return null;
  }

  const loopContext = parseLoopContext(value.loopContext);
  if (loopContext === false) return null;
  return {
    runId: runId as RunId,
    resumeNodeId,
    pageStateRef,
    ...(loopContext === undefined ? {} : { loopContext }),
    issuedAt: issuedAt as ResumeTokenEnvelope["issuedAt"],
    expiresAt: expiresAt as ResumeTokenEnvelope["expiresAt"],
    kid,
    hmac,
  };
}

function parseLoopContext(
  value: unknown,
): { iteration: number; pageCount: number } | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const iteration = value.iteration;
  const pageCount = value.pageCount;
  if (
    typeof iteration !== "number" ||
    typeof pageCount !== "number" ||
    !Number.isInteger(iteration) ||
    !Number.isInteger(pageCount) ||
    iteration < 0 ||
    pageCount < 0
  ) {
    return false;
  }
  return { iteration, pageCount };
}

// SessionRestoreResult → R18(restore_ok)/R19·R20(restore_failed) 전이. 모든 변형을 명시 처리 + never 가드로
// 미정의 변형을 loud throw(조용한 unknown 금지 — catch-all 흡수 금지). loginBypassPossible=true 만 R19(재로그인 우회),
// false 는 R20(failed_system). resume-token 검증 실패(invalid_token)는 신뢰 불가 토큰이라 우회 불가 → R20(security-contracts §5).
function restoreTransitionFor(
  result: SessionRestoreResult,
  expectedPageStateRef: string,
):
  | { event: { type: "restore_ok" }; guard: { restoreOk: true } }
  | { event: { type: "restore_failed" }; guard: { loginBypassPossible: boolean } } {
  switch (result.kind) {
    case "restored":
      // pageStateRef 대조 — 일치 시에만 R18. 불일치(restorer 자기모순)는 fail-closed R20(우회 불가).
      return result.pageStateRef === expectedPageStateRef
        ? { event: { type: "restore_ok" }, guard: { restoreOk: true } }
        : { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
    case "login_bypass":
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: true } };
    case "page_state_mismatch":
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: result.loginBypassPossible } };
    case "invalid_token":
      // resume-token 검증 실패(만료=CHALLENGE_UNRESOLVED / 위변조·kid 불일치=IR_EXPRESSION_RUNTIME, security-contracts §5).
      // 신뢰 불가 토큰의 resumeNodeId 로 재로그인 우회 금지 → R20 failed_system("resume 거부 → system 예외"). 조용히 흘리지 않음.
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
    case "terminal_failure":
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
    default: {
      // 미정의 SessionRestoreResult 변형 — catch-all 흡수(조용한 unknown) 금지. 컴파일 시 exhaustive 강제 + 런타임 loud throw.
      const exhaustive: never = result;
      throw new Error(`restoreTransitionFor: unhandled SessionRestoreResult kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

function isOnlyRestoreSessionPending(pending: readonly { kind: string }[]): boolean {
  return pending.length === 1 && pending[0]?.kind === "restoreSession";
}

function isOnlyAbortLeasePending(
  pending: readonly { kind: string; lease?: string }[],
  event: "drain_ok" | "drain_timeout",
): boolean {
  const expectedKind = event === "drain_timeout" ? "killLease" : "releaseLease";
  return pending.length === 1 && pending[0]?.kind === expectedKind && pending[0]?.lease === "browser";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function unknownToReason(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) return value.message;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "session restore failed";
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`RuntimeWorker: ${label} must be a non-empty string when provided`);
}

function artifactLifecycleJobScope(job: RuntimeWorkerJob, kind: ArtifactLifecycleClaimKind): ArtifactLifecycleJobScope {
  const runId = optionalString(job.runId, `${kind}.runId`) as RunId | undefined;
  const generationId = optionalString(job.generationId, `${kind}.generationId`) as ScenarioGenerationId | undefined;
  if (runId !== undefined && generationId !== undefined) {
    throw new Error(`RuntimeWorker: ${kind} job cannot set both runId and generationId`);
  }
  return { runId, generationId };
}

function artifactTargetFromRow(row: ArtifactLifecycleRow): ArtifactLifecycleTarget {
  return {
    tenantId: row.tenant_id as TenantId,
    artifactRef: row.id as ArtifactRef,
    objectRef: row.object_ref as ObjectRef,
    ...(row.run_id === null ? {} : { runId: row.run_id as RunId }),
    ...(row.generation_id === null ? {} : { generationId: row.generation_id as ScenarioGenerationId }),
    ...(row.step_id === null ? {} : { stepId: row.step_id as StepId }),
    ...(row.attempt === null ? {} : { attempt: row.attempt }),
    type: row.type,
    redactionStatus: row.redaction_status,
    redactionAttempts: row.redaction_attempts,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(row.retention_until === null ? {} : { retentionUntil: row.retention_until as IsoDateTime }),
    legalHold: row.legal_hold,
    quarantine: row.quarantine,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at as IsoDateTime }),
    ...(row.deleted_reason === null ? {} : { deletedReason: row.deleted_reason }),
    ...(row.deleted_by_job === null ? {} : { deletedByJob: row.deleted_by_job }),
  };
}

function lifecycleOperationalAudit<TUseCase extends ArtifactLifecycleOperationalUseCase>(input: {
  useCase: TUseCase;
  correlationId: string;
  reasonCode: string;
}): ArtifactLifecycleOperationalAudit & { useCase: TUseCase } {
  return {
    useCase: input.useCase,
    action: "bypassrls.use",
    failClosed: true,
    correlationId: input.correlationId as CorrelationId,
    reasonCode: input.reasonCode,
  };
}

function requireArtifactObjectIoPortBinding(
  value: unknown,
  jobKind: ArtifactLifecycleClaimKind,
  allowTestPort: boolean,
): ArtifactObjectIoPortBinding {
  if (!isRecord(value)) {
    throw new Error(`RuntimeWorker: ${jobKind} requires a real object-store port binding with SecretRef`);
  }
  const kind = value.kind;
  if (kind === "real_object_store") {
    const backendAlias = stringField(value, "backendAlias");
    const credentialRef = stringField(value, "credentialRef");
    const mayBeUsedAsStagingEvidence = value.mayBeUsedAsStagingEvidence;
    if (
      backendAlias === null ||
      credentialRef === null ||
      value.evidenceSchemaRef !== ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF ||
      typeof mayBeUsedAsStagingEvidence !== "boolean"
    ) {
      throw new Error(`RuntimeWorker: ${jobKind} real object-store port binding requires backendAlias, SecretRef, artifact/object-io-evidence@1, and explicit staging evidence flag`);
    }
    return {
      kind,
      backendAlias,
      credentialRef: credentialRef as SecretRef,
      evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      mayBeUsedAsStagingEvidence,
    };
  }
  if (kind === "test_fake") {
    if (!allowTestPort) {
      throw new Error(
        `RuntimeWorker: ${jobKind} test_fake artifact lifecycle port is local-test-only and cannot be used as staging object-store evidence`,
      );
    }
    if (
      value.backendAlias !== "local-test-fake" ||
      value.evidenceSchemaRef !== ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF ||
      value.testOnly !== true
    ) {
      throw new Error(`RuntimeWorker: ${jobKind} test_fake port binding must use artifact/object-io-local-test@1`);
    }
    return {
      kind,
      backendAlias: "local-test-fake",
      evidenceSchemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
      testOnly: true,
    };
  }
  throw new Error(`RuntimeWorker: ${jobKind} requires a real object-store port binding with SecretRef`);
}

function validateArtifactRedactionDecision(
  decision: ArtifactRedactionDecision,
  expected: {
    operation: ArtifactObjectIoOperation;
    artifactRef: ArtifactRef;
    correlationId: string;
    portBinding: ArtifactObjectIoPortBinding;
  },
): void {
  switch (decision.kind) {
    case "redacted":
      if (typeof decision.redactedObjectRef !== "string" || decision.redactedObjectRef.trim().length === 0) {
        throw new Error("RuntimeWorker: artifact_redaction redacted result requires redactedObjectRef");
      }
      if (typeof decision.sha256 !== "string" || decision.sha256.trim().length === 0) {
        throw new Error("RuntimeWorker: artifact_redaction redacted result requires sha256 evidence");
      }
      validateArtifactObjectIoEvidence(decision.evidence, expected, decision.sha256);
      return;
    case "not_required":
      validateArtifactObjectIoEvidence(decision.evidence, expected);
      return;
    case "retryable_failed":
    case "terminal_failed":
      if (decision.evidence !== undefined) validateArtifactObjectIoEvidence(decision.evidence, expected);
      return;
    default:
      throw new Error(
        `RuntimeWorker: artifact_redaction unknown port result kind ${String(
          (decision as { kind?: unknown }).kind ?? "missing",
        )}`,
      );
  }
}

function validateArtifactRetentionDeleteResult(
  result: ArtifactRetentionDeleteResult,
  expected: {
    operation: ArtifactObjectIoOperation;
    artifactRef: ArtifactRef;
    correlationId: string;
    portBinding: ArtifactObjectIoPortBinding;
  },
): void {
  switch (result.kind) {
    case "deleted":
    case "not_found":
      validateArtifactObjectIoEvidence(result.evidence, expected);
      return;
    case "transient_failed":
      return;
    default:
      throw new Error(
        `RuntimeWorker: artifact_retention unknown port result kind ${String(
          (result as { kind?: unknown }).kind ?? "missing",
        )}`,
      );
  }
}

function validateArtifactObjectIoEvidence(
  evidence: ArtifactObjectIoEvidence | undefined,
  expected: {
    operation: ArtifactObjectIoOperation;
    artifactRef: ArtifactRef;
    correlationId: string;
    portBinding: ArtifactObjectIoPortBinding;
  },
  expectedSha256?: string,
): void {
  if (!isRecord(evidence)) {
    throw new Error("RuntimeWorker: artifact lifecycle success requires object I/O evidence");
  }
  if (
    evidence.operation !== expected.operation ||
    evidence.artifactRef !== expected.artifactRef ||
    evidence.correlationId !== expected.correlationId ||
    evidence.objectRefInternalOnly !== true ||
    stringField(evidence, "receiptId") === null
  ) {
    throw new Error("RuntimeWorker: artifact lifecycle object I/O evidence does not match the claim");
  }
  if (expectedSha256 !== undefined && evidence.sha256 !== expectedSha256) {
    throw new Error("RuntimeWorker: artifact lifecycle object I/O evidence sha256 mismatch");
  }

  if (expected.portBinding.kind === "real_object_store") {
    assertOnlyEvidenceKeys(evidence, [
      "schemaRef",
      "portKind",
      "backendAlias",
      "credentialRef",
      "operation",
      "artifactRef",
      "correlationId",
      "receiptId",
      "objectRefInternalOnly",
      "mayBeUsedAsStagingEvidence",
      "sha256",
    ]);
    if (
      evidence.schemaRef !== ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF ||
      evidence.portKind !== "real_object_store" ||
      evidence.backendAlias !== expected.portBinding.backendAlias ||
      evidence.credentialRef !== expected.portBinding.credentialRef ||
      evidence.mayBeUsedAsStagingEvidence !== expected.portBinding.mayBeUsedAsStagingEvidence
    ) {
      throw new Error("RuntimeWorker: real object-store evidence must match the SecretRef-backed port binding and staging evidence flag");
    }
    return;
  }

  assertOnlyEvidenceKeys(evidence, [
    "schemaRef",
    "portKind",
    "backendAlias",
    "operation",
    "artifactRef",
    "correlationId",
    "receiptId",
    "objectRefInternalOnly",
    "mayBeUsedAsStagingEvidence",
    "sha256",
  ]);
  if (
    evidence.schemaRef !== ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF ||
    evidence.portKind !== "test_fake" ||
    evidence.backendAlias !== "local-test-fake" ||
    evidence.mayBeUsedAsStagingEvidence !== false
  ) {
    throw new Error("RuntimeWorker: test_fake object I/O evidence must remain local-test-only");
  }
}

function assertOnlyEvidenceKeys(evidence: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(evidence)) {
    if (!allowedSet.has(key)) {
      throw new Error(`RuntimeWorker: artifact lifecycle object I/O evidence has unsupported field ${key}`);
    }
  }
}

function evidenceFromRedactionDecision(decision: ArtifactRedactionDecision): ArtifactObjectIoEvidence | undefined {
  switch (decision.kind) {
    case "redacted":
    case "not_required":
    case "retryable_failed":
    case "terminal_failed":
      return decision.evidence;
  }
}

function evidenceFromRetentionDeleteResult(result: ArtifactRetentionDeleteResult): ArtifactObjectIoEvidence | undefined {
  switch (result.kind) {
    case "deleted":
    case "not_found":
      return result.evidence;
    case "transient_failed":
      return undefined;
  }
}

async function assertLifecycleBypassUse(
  client: pg.PoolClient,
  useCase: ArtifactLifecycleOperationalUseCase,
  reasonCode: string,
): Promise<void> {
  const policyDecision = checkBypassRlsUse({
    useCase,
    applicationRole: false,
    servesUserTraffic: false,
    reasonCode,
    immutableAuditAppendConfigured: true,
  });
  if (policyDecision.kind === "deny") {
    throw new Error(`RuntimeWorker: ${useCase} BYPASSRLS denied: ${policyDecision.reasons.join("; ")}`);
  }

  const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`,
  );
  const row = role.rows[0];
  if (row?.rolsuper === true || row?.rolbypassrls !== true) {
    throw new Error(`RuntimeWorker: ${useCase} requires a non-SUPERUSER dedicated BYPASSRLS operational role`);
  }
}

async function appendLifecycleAudit(pool: pg.Pool, input: LifecycleAuditAppendInput): Promise<void> {
  await withTenantTx(pool, input.tenantId, (client) => appendLifecycleAuditWithClient(client, input));
}

async function appendLifecycleAuditWithClient(client: pg.PoolClient, input: LifecycleAuditAppendInput): Promise<void> {
  const occurredAt = new Date();
  const occurredAtIso = occurredAt.toISOString();
  const retentionUntilIso = new Date(
    occurredAt.getTime() + input.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const actor = {
    kind: "system",
    id: "runtime-worker",
    worker_id: input.workerId,
  };
  const payload = {
    decision_kind: "artifact_lifecycle.bypassrls_use",
    use_case: input.useCase,
    job_kind: input.jobKind,
    reason_code: input.reasonCode,
    artifact_ref: input.artifact.artifactRef,
    run_id: input.artifact.runId,
    step_id: input.artifact.stepId,
    attempt: input.artifact.attempt,
    redaction_status: input.artifact.redactionStatus,
    retention_until: input.artifact.retentionUntil,
    legal_hold: input.artifact.legalHold,
    quarantine: input.artifact.quarantine,
    deleted_at_present: input.artifact.deletedAt !== undefined,
    object_ref_internal_only: true,
    fail_closed: true,
    object_io_port_kind: input.portBinding?.kind,
    object_io_backend_alias: input.portBinding?.backendAlias,
    object_io_credential_ref:
      input.portBinding?.kind === "real_object_store" ? input.portBinding.credentialRef : undefined,
    object_io_evidence_schema_ref: input.objectIoEvidence?.schemaRef,
    object_io_operation: input.objectIoEvidence?.operation,
    object_io_receipt_id: input.objectIoEvidence?.receiptId,
    object_io_sha256_present: input.objectIoEvidence?.sha256 !== undefined,
    object_io_may_be_used_as_staging_evidence:
      input.objectIoEvidence?.mayBeUsedAsStagingEvidence ??
      (input.portBinding?.kind === "test_fake" ? false : undefined),
  };
  const payloadJson = safeSerialize(payload);
  const idempotencyKey = `${input.useCase}:${input.artifact.artifactRef}:${input.jobId}`;

  const previous = await client.query<{ sequence_no: string; hash: string }>(
    `SELECT sequence_no, hash
         FROM audit_log
        WHERE tenant_id = $1::uuid
        ORDER BY sequence_no DESC
        LIMIT 1
        FOR UPDATE`,
    [input.tenantId],
  );
  const previousRow = previous.rows[0];
  const sequence = previousRow === undefined ? 1 : Number(previousRow.sequence_no) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`RuntimeWorker: invalid lifecycle audit sequence for tenant ${input.tenantId}`);
  }
  const previousHash = previousRow?.hash ?? "GENESIS";
  const hash = hashLifecycleAuditRecord({
    tenantId: input.tenantId,
    sequence,
    actor,
    reason: input.reasonCode,
    correlationId: input.correlationId,
    idempotencyKey,
    occurredAt: occurredAtIso,
    retentionUntil: retentionUntilIso,
    payloadJson,
    previousHash,
  });

  await client.query(
    `INSERT INTO audit_log
         (id, tenant_id, sequence_no, actor, action, outcome, reason,
          correlation_id, idempotency_key, occurred_at, payload_schema_ref,
          payload, retention_until, previous_hash, hash)
       VALUES
         ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, 'bypassrls.use', 'allow', $5,
          $6::uuid, $7, $8::timestamptz, $9, $10::jsonb,
          $11::timestamptz, $12, $13)`,
    [
      randomUUID(),
      input.tenantId,
      sequence,
      JSON.stringify(actor),
      input.reasonCode,
      input.correlationId,
      idempotencyKey,
      occurredAtIso,
      SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
      payloadJson,
      retentionUntilIso,
      previousRow?.hash ?? null,
      hash,
    ],
  );
}

function hashLifecycleAuditRecord(input: {
  tenantId: string;
  sequence: number;
  actor: Readonly<Record<string, string>>;
  reason: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  retentionUntil: string;
  payloadJson: string;
  previousHash: string;
}): string {
  const canonical = canonicalize({
    tenantId: input.tenantId,
    sequence: input.sequence,
    actor: input.actor,
    action: "bypassrls.use",
    outcome: "allow",
    reason: input.reason,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    retentionUntil: input.retentionUntil,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: JSON.parse(input.payloadJson) as unknown,
    previousHash: input.previousHash,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}
