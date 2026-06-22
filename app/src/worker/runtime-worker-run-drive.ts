/**
 * WorkerRunDrive — runtime-worker.ts 협력객체 분해(CLAUDE.md #7)의 run_claim/run_abort 핸들러.
 *
 * Worker 잡 디스패처(PgRuntimeWorker.handle)가 위임하는 run 생명주기 핸들러: run_claim(handleRunClaim — claim tx +
 * lease 획득 + INIT/bind + driveClaimedRun)·run_abort(handleRunAbort — drain claim + finalize). browser-lease 획득·
 * worker-circuit 게이트·run-state 전이를 동일 tx 안에서 엮는 라이브 엔진 코어다. 지원 메서드는 소유한 WorkerRunSupport
 * (동일 pool)에 위임한다(의존 단방향, 역호출 0). run_resume(WorkerRunResume)와 공유하는 기본 executor seam은
 * defaultExecutorFactory 로 export. PgRuntimeWorkerOptions/RunExecutorFactory 는 import type 역참조(값 순환 없음).
 */
import type pg from "pg";

import {
  claimAbortBrowserLeaseForRun,
  deleteInitReservedBrowserLease,
  finalizeRunAbort,
  hasOpenAbortBrowserLeaseForRun,
  releaseAbortBrowserDrainClaim,
  renewBrowserLease,
  startBrowserLeaseHeartbeat,
} from "./runtime-worker-browser-lease";
import { requireString, unknownToReason } from "./runtime-worker-parse";
import { DEFAULT_BROWSER_LEASE_HEARTBEAT_MS, DEFAULT_BROWSER_LEASE_TTL_MS } from "./runtime-worker-run-context";
import type { RunClaimDriveInputs, RunRow } from "./runtime-worker-run-context";
import { WorkerRunSupport } from "./runtime-worker-run-support";
import type {
  EventId,
  LeaseId,
  RunAbortDrainInput,
  RunAbortDrainResult,
  RuntimeJobResult,
  RuntimeWorkerJob,
  WorkerId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { SPAN, withSpan, type CommonSpanAttrs } from "../observability/telemetry";
import { applyRunTransition } from "../runtime/run-transition";
import { driveClaimedRun } from "../runtime/run-step-driver";
import { handleClaimedInitFailure } from "../runtime/run-init-failure";
import { recordSiteCircuitOutcome, DEFAULT_SITE_CIRCUIT } from "../runtime/site-circuit";
import { UtilityExecutor } from "../executor/utility-executor";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider } from "../executor/browser-session-provider";
import type { ExecutorPlugin } from "../../../ts/core-types";
import type { PgRuntimeWorkerOptions, RunExecutorFactory } from "./runtime-worker";

export const defaultExecutorFactory: RunExecutorFactory = (provider) => new UtilityExecutor(provider);

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
const DEFAULT_RUN_ABORT_TIMEOUT_MS = 30_000;

export class WorkerRunDrive {
  private readonly runSupport: WorkerRunSupport;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions,
  ) {
    this.runSupport = new WorkerRunSupport(pool, options);
  }

  async handleRunClaim(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
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
    // browser_lease heartbeat: drive 동안 주기 갱신해 ttl 만료→lease_sweeper drain(감사 클러스터 A) 방지. finally 에서 정지.
    const leaseTtlMs = this.options.defaultBrowserLeaseTtlMs ?? DEFAULT_BROWSER_LEASE_TTL_MS;
    const heartbeat = startBrowserLeaseHeartbeat({
      intervalMs: DEFAULT_BROWSER_LEASE_HEARTBEAT_MS,
      renew: () =>
        withTenantTx(this.pool, tenantId, (c) =>
          renewBrowserLease(c, { tenantId, leaseId: d.leaseId, workerId, ttlMs: leaseTtlMs }),
        ),
      onLost: (reason) =>
        console.error(`runtime-worker: browser-lease heartbeat lost (run ${runId.slice(0, 8)}) — ${reason}`),
    });
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
      heartbeat.stop();
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

  async handleRunAbort(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
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
}
