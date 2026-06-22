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
import { WorkerRunDrive } from "./runtime-worker-run-drive";
import { WorkerRunResume } from "./runtime-worker-run-resume";
import { ArtifactRedactionProcessor } from "./artifact-redaction-processor";
import { ArtifactRetentionProcessor } from "./artifact-retention-processor";
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
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { relayOutbox } from "../runtime/outbox-relay";
import { terminalizeStuckRunAsSystemFailure } from "../runtime/run-step-driver";
import { deliverNormalizedRecord } from "../runtime/pipeline/sink-delivery";
import type { InitBackoffConfig } from "../runtime/run-init-failure";
import type { SiteCircuitConfig } from "../runtime/site-circuit";
import type { BrowserSessionStore } from "../runtime/browser-session-store";
import type { MergedExtractArtifactSink } from "../runtime/merged-extract-artifact";
import type { VisualEvidenceRecorder } from "../runtime/visual-evidence";
import type { BrowserSessionProvider } from "../executor/browser-session-provider";
import type { ExecutorChallengeSuspensionPort, RuntimeJobEnqueuePort } from "../runtime/executor-ports";
import type { CdpSessionProvider } from "../executor/cdp-session";
import type { ExecutorPlugin } from "../../../ts/core-types";

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

// sink failed(상한 미달) 재전달 backoff 기본(ops-defaults #sink.delivery.retry_backoff base 5s).
const DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS = 5_000;

export class PgRuntimeWorker implements RuntimeWorker {
  private readonly artifactRedaction: ArtifactRedactionProcessor;
  private readonly artifactRetention: ArtifactRetentionProcessor;
  private readonly runDrive: WorkerRunDrive;
  private readonly runResume: WorkerRunResume;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {
    this.artifactRedaction = new ArtifactRedactionProcessor(pool, options);
    this.artifactRetention = new ArtifactRetentionProcessor(pool, options);
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

      case "workitem_checkout":
        return handleWorkitemCheckout(this.pool, this.options.workerId, job);

      case "run_resume":
        return this.runResume.handleRunResume(job);

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
            console.error(
              `runtime-worker: lease_sweeper 세션 teardown 실패(lease ${lease.id.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      }
    }
    return { kind: "completed", emittedEvents: [] };
  }

}
