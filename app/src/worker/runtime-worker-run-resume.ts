/**
 * WorkerRunResume — runtime-worker.ts 협력객체 분해(CLAUDE.md #7)의 run_resume 핸들러.
 *
 * Worker 잡 디스패처(PgRuntimeWorker.handle)가 위임하는 resume 생명주기: txA(resume_requested/resuming 잠금 + R17
 * 전이) → session.restore(tx 밖) → 완료 전이(R18/R19/R20) → Phase C 재진입 구동(driveResumedRun). 지원 메서드는 소유한
 * WorkerRunSupport(동일 pool)에 위임한다. 기본 executor seam(defaultExecutorFactory)은 WorkerRunDrive(run_claim)와
 * 공유 — 거기서 import. PgRuntimeWorkerOptions 는 import type 역참조(값 순환 없음).
 */
import type pg from "pg";

import { findActiveBrowserLeaseForRun } from "./runtime-worker-browser-lease";
import {
  isOnlyRestoreSessionPending,
  parseResumeTokenEnvelope,
  requireString,
  restoreTransitionFor,
  unknownToReason,
} from "./runtime-worker-parse";
import type { RunClaimDriveInputs, RunRow } from "./runtime-worker-run-context";
import { WorkerRunSupport } from "./runtime-worker-run-support";
import { defaultExecutorFactory } from "./runtime-worker-run-drive";
import type {
  EventId,
  LeaseId,
  RuntimeJobResult,
  RuntimeWorkerJob,
  SessionRestoreInput,
  SessionRestoreResult,
  WorkerId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { SPAN, withSpan, type CommonSpanAttrs } from "../observability/telemetry";
import { applyRunTransition } from "../runtime/run-transition";
import { driveResumedRun } from "../runtime/run-step-driver";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider } from "../executor/browser-session-provider";
import type { PgRuntimeWorkerOptions } from "./runtime-worker";

type RunResumeRow = RunRow & { resume_token: unknown };
type RunResumeIntent = SessionRestoreInput;
type RunResumeTxAResult =
  | { kind: "ready"; intent: RunResumeIntent }
  | { kind: "job_result"; result: RuntimeJobResult };

export class WorkerRunResume {
  private readonly runSupport: WorkerRunSupport;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions,
  ) {
    this.runSupport = new WorkerRunSupport(pool, options);
  }

  async handleRunResume(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
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
