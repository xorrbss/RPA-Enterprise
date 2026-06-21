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
import { driveResumedRun, terminalizeStuckRunAsSystemFailure } from "../runtime/run-step-driver";
import { recordSiteCircuitOutcome, DEFAULT_SITE_CIRCUIT } from "../runtime/site-circuit";
import { resumeLinkedWorkitemCheckout } from "../runtime/workitem-settlement";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider } from "../executor/browser-session-provider";
import type { ExecutorPlugin } from "../../../ts/core-types";
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
          // 멱등 앵커는 resume 사이클별 고유해야 한다(run 이 suspend→resume 를 반복하면 동일 키가 events_outbox
          //   UNIQUE 충돌). 재개 대상 토큰의 issuedAt 은 suspend 사이클당 1회 발행이라 per-cycle 결정형 식별자다.
          eventIdempotencyKey: `${runId}:run_resume:r17:${token.issuedAt}`,
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

    let result: RuntimeJobResult;
    try {
    result = await withTenantTx(this.pool, tenantId, async (client) => {
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
        // R17 과 동일하게 resume 사이클별 토큰 issuedAt 으로 스코프(반복 resume 의 run.resumed outbox 키 충돌 방지).
        eventIdempotencyKey: `${runId}:run_resume:${txA.intent.token.issuedAt}`,
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

      // W11: R18/R19 로 running 도달 시 연결 workitem 의 checkout timer resume(잔여 TTL 부터). R20(failed_system)은 제외.
      const resumed = await client.query<{ status: string }>(
        `SELECT status FROM runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, runId],
      );
      if (resumed.rows[0]?.status === "running") {
        await resumeLinkedWorkitemCheckout(client, { tenantId, runId, correlationId: job.correlationId ?? row.correlation_id });
      }

      return {
        kind: "completed",
        emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
      };
    });
    } catch (completionErr) {
      // resume 완료 전이(R18/R19/R20) tx 가 영속 인프라 오류로 throw 하면 run 은 txA 가 커밋한 'resuming' 에서
      //   좌초한다(graphile 재시도도 같은 오류면 무한 — 좀비). suspend 측 R12 와 대칭으로
      //   terminalizeStuckRunAsSystemFailure 가 resuming→R20(failed_system)으로 종결하고 연결 workitem 을 system 정산한다.
      //   terminalize 가 false(동시 abort 등으로 더는 'resuming' 아님)면 원 예외를 재던져 graphile 에 위임한다.
      console.error(
        `runtime-worker: resume 완료 tx 좌초(run ${runId.slice(0, 8)}) — R20 종결 시도: ${completionErr instanceof Error ? completionErr.message : String(completionErr)}`,
      );
      const terminalized = await terminalizeStuckRunAsSystemFailure(
        { tenantId, runId, correlationId: txA.intent.correlationId },
        this.pool,
      );
      if (!terminalized) throw completionErr;
      return { kind: "completed", emittedEvents: [] };
    }

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

    // R18 후 run 은 running — driveResumedRun 재진입용 ClaimedRun(INIT 실패 종결·구동에 공유).
    const driveRun = {
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
    };

    // INIT phase(siteConfig 적재 + 세션 bind + executor/resolver 구성). claim Phase B 와 대칭: 이 셋업이 throw 하면
    //   run 은 이미 running(R18)이라 좌초한다 — terminalizeStuckRunAsSystemFailure(R8: running→failed_system)로 종결하고
    //   bound 세션을 해제한다(누수 방지). worker 서킷도 claim 과 동일하게 INIT 성공/실패를 per-worker 기록.
    let setup: { bound: Awaited<ReturnType<typeof sessionProvider.bind>>; executor: ExecutorPlugin; resolver: SitePageStateResolver };
    let boundForInitCleanup: Awaited<ReturnType<typeof sessionProvider.bind>> | undefined;
    try {
      const siteConfig = await withTenantTx(this.pool, tenantId, (c) =>
        loadSitePageStateConfig(c, tenantId, drive.siteProfileId),
      );
      boundForInitCleanup = await sessionProvider.bind({
        tenantId,
        leaseId: drive.leaseId,
        siteProfileId: drive.siteProfileId,
        browserIdentityId: drive.browserIdentityId,
        networkPolicyId: drive.networkPolicyId,
        isolation: drive.isolation,
        cleanupPolicy: drive.cleanupPolicy,
      });
      const executor = (this.options.executorFactory ?? defaultExecutorFactory)(boundForInitCleanup.provider, {
        scenarioVersionId: drive.scenarioVersionId,
        browserIdentityVersion: drive.browserIdentityVersion,
        tenantId, // 자격증명 fill executorPrincipal per-run 테넌트(감사 정합).
        ...(drive.model !== undefined ? { model: drive.model } : {}),
      });
      const resolver = new SitePageStateResolver(boundForInitCleanup.provider, siteConfig);
      setup = { bound: boundForInitCleanup, executor, resolver };
    } catch (initErr) {
      if (boundForInitCleanup !== undefined) {
        try {
          await boundForInitCleanup.release();
        } catch (relErr) {
          console.error(`runtime-worker: resume INIT 실패 후 세션 해제 실패(run ${runId.slice(0, 8)}) — ${relErr instanceof Error ? relErr.message : String(relErr)}`);
        }
      }
      console.error(
        `runtime-worker: resume INIT 셋업 실패(run ${runId.slice(0, 8)}) — ${initErr instanceof Error ? initErr.message : String(initErr)}`,
      );
      // run 은 R18로 이미 running — 좌초 방지로 R8(running→failed_system) 종결 + 연결 workitem system 정산.
      const terminalized = await terminalizeStuckRunAsSystemFailure(driveRun, this.pool);
      // worker 서킷: per-worker 연속 INIT 실패 누적(claim 과 대칭). **B1**: terminalize=false(run 이 이미 aborting/
      //   cancelled 등 — 취소·경합 패배는 이 워커의 INIT 실패 아님)면 카운터 미증가 → spurious open(과잉격리) 방지.
      //   best-effort(별도 tx)라 기록 실패는 잡을 깨지 않게 흡수(loud).
      if (terminalized) {
        await this.runSupport.recordWorkerInitFailure(workerId).catch((e) =>
          console.error(`runtime-worker: resume worker 서킷 실패기록 실패(run ${runId.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return result;
    }
    // INIT 성공 → per-worker 연속 실패 카운터 reset + (open 이었으면)회로 닫힘(claim 과 대칭).
    await this.runSupport.recordWorkerInitSuccess(workerId);

    // DRIVE phase. driveResumedRun 은 R2 없이 resumeNodeId 부터 재진입(success→completed / fail→failed_*). 세션은 finally 에서 해제.
    let driveResult: Awaited<ReturnType<typeof driveResumedRun>> | undefined;
    try {
      driveResult = await driveResumedRun(
        driveRun,
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
        txA.intent.resumeNodeId,
      );
    } finally {
      await setup.bound.release();
    }
    // 사이트 서킷 표본(claim 과 대칭): drive 1회=표본 1행. blocked=challenge 자동감지(suspended + suspend.kind<>'human_task').
    //   best-effort 기록(별도 tenant tx)이라 실패는 흡수(loud). throw 로 끝난 drive(driveResult undefined)는 표본 제외.
    if (driveResult !== undefined) {
      const blocked =
        driveResult.state === "suspended" &&
        driveResult.outcome.suspend !== undefined &&
        driveResult.outcome.suspend.kind !== "human_task";
      await recordSiteCircuitOutcome(this.pool, this.options.siteCircuit ?? DEFAULT_SITE_CIRCUIT, {
        tenantId,
        siteProfileId: drive.siteProfileId,
        correlationId: drive.correlationId,
        blocked,
      }).catch((e) =>
        console.error(`runtime-worker: resume 사이트 서킷 표본기록 실패(run ${runId.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return result;
  }
}
