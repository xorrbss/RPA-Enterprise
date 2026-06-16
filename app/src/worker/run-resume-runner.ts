// run_resume 잡 실행(세션 복원/재진입) — PgRuntimeWorker에서 분리한 협력 클래스. 로직 무변경.
import type pg from "pg";

import type {
  EventId,
  LeaseId,
  ResumeTokenEnvelope,
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
import { isRecord, stringField, unknownToReason, requireString } from "./worker-util";
import { BrowserLeaseManager } from "./browser-lease-manager";
import type { PgRuntimeWorkerOptions, RunRow } from "./runtime-worker";

type RunResumeRow = RunRow & { resume_token: unknown };
type RunResumeIntent = SessionRestoreInput;
type RunResumeTxAResult =
  | { kind: "ready"; intent: RunResumeIntent }
  | { kind: "job_result"; result: RuntimeJobResult };

export class RunResumeRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
    private readonly leases: BrowserLeaseManager,
  ) {}

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

      let lease = await this.leases.findActiveBrowserLeaseForRun(client, {
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
          return this.leases.acquireBrowserLease(client, { tenantId, runId, workerId, plan });
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

    return withTenantTx(this.pool, tenantId, async (client) => {
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
  }
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

function restoreTransitionFor(
  result: SessionRestoreResult,
  expectedPageStateRef: string,
):
  | { event: { type: "restore_ok" }; guard: { restoreOk: true } }
  | { event: { type: "restore_failed" }; guard: { loginBypassPossible: boolean } } {
  if (result.kind === "restored" && result.pageStateRef === expectedPageStateRef) {
    return { event: { type: "restore_ok" }, guard: { restoreOk: true } };
  }
  if (result.kind === "login_bypass") {
    return { event: { type: "restore_failed" }, guard: { loginBypassPossible: true } };
  }
  if (result.kind === "page_state_mismatch") {
    return {
      event: { type: "restore_failed" },
      guard: { loginBypassPossible: result.loginBypassPossible },
    };
  }
  return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
}

function isOnlyRestoreSessionPending(pending: readonly { kind: string }[]): boolean {
  return pending.length === 1 && pending[0]?.kind === "restoreSession";
}
