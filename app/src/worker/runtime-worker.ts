/**
 * RuntimeWorker — Worker 잡 디스패처 (D2 골격, ts/runtime-contract.ts 구현).
 *
 * 계약: RuntimeWorker.handle(job: RuntimeWorkerJob) → RuntimeJobResult. job kind는
 * release-decisions.md #9의 닫힌 집합. 본 골격은 D2에서 검증 가능한 잡만 구현하고, D3(executor/lease)·
 * D6(pipeline)에 의존하는 잡은 **조용한 no-op 없이** 명시적으로 throw한다(가정 금지).
 *
 * 큐 런너(Graphile Worker) 연결은 D2.5 어댑터에서 본 handle()에 위임한다.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { RunState, WorkitemState } from "../../../ts/state-machine-types";
import type {
  ArtifactRedactor,
  ArtifactRetentionStore,
  EventId,
  IsoDateTime,
  LeaseCleanupPolicy,
  LeaseIsolation,
  LeaseId,
  LeaseRenewResult,
  RunAbortDrainer,
  ResumeTokenEnvelope,
  RuntimeJobResult,
  RuntimeWorker,
  RuntimeWorkerJob,
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
import { applyWorkitemTransition } from "../runtime/workitem-transition";
import { relayOutbox } from "../runtime/outbox-relay";
import { deliverNormalizedRecord } from "../runtime/pipeline/sink-delivery";
import { driveClaimedRun } from "../runtime/run-step-driver";
import { UtilityExecutor } from "../executor/utility-executor";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider, type BrowserSessionProvider } from "../executor/browser-session-provider";
import { isRecord, stringField, unknownToReason, requireString } from "./worker-util";
import { ArtifactLifecycleRunner } from "./artifact-lifecycle-runner";
import { RunAbortRunner } from "./run-abort-runner";

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
  readonly correlationId: string;
  readonly leaseId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly networkPolicyId: string;
  readonly isolation: LeaseIsolation;
  readonly cleanupPolicy: LeaseCleanupPolicy;
  readonly params?: Record<string, unknown>;
}

// runs.params(jsonb) 정규화: 문자열이면 파싱, null/부재면 undefined(빈 {} 와 구분 — navigate 키 해소가 loud 실패). run-loop 와 동형.
function normalizeRunParams(raw: unknown): Record<string, unknown> | undefined {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export type RunRow = { status: RunState; correlation_id: string };
type RunResumeRow = RunRow & { resume_token: unknown };
type RunResumeIntent = SessionRestoreInput;
type RunResumeTxAResult =
  | { kind: "ready"; intent: RunResumeIntent }
  | { kind: "job_result"; result: RuntimeJobResult };
type WorkitemRow = { status: WorkitemState };
const DEFAULT_BROWSER_LEASE_TTL_MS = 300_000;
// sink failed(상한 미달) 재전달 backoff 기본(ops-defaults #sink.delivery.retry_backoff base 5s).
const DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS = 5_000;

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

export class PgRuntimeWorker implements RuntimeWorker {
  private readonly artifactLifecycle: ArtifactLifecycleRunner;
  private readonly runAbort: RunAbortRunner;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {
    this.artifactLifecycle = new ArtifactLifecycleRunner(this.pool, this.options);
    this.runAbort = new RunAbortRunner(this.pool, this.options);
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
        return this.runAbort.handleRunAbort(job);

      case "lease_sweeper":
        return this.handleLeaseSweeper(job);

      case "workitem_checkout":
        return this.handleWorkitemCheckout(job);

      case "run_resume":
        return this.handleRunResume(job);

      // D3(executor/lease)·D6(pipeline) 의존 — D2 골격 미구현. 조용한 no-op 금지: 명시적 throw.
      case "artifact_redaction":
        return this.artifactLifecycle.handleArtifactRedaction(job);

      case "artifact_retention":
        return this.artifactLifecycle.handleArtifactRetention(job);

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
    try {
      const executor = new UtilityExecutor(bound.provider);
      const resolver = new SitePageStateResolver(bound.provider, siteConfig);
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
          params: d.params,
        },
        { pool: this.pool, executor, resolver, workerId },
      );
    } finally {
      await bound.release();
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
    const r = await client.query<{ scenario_version_id: string; params: unknown }>(
      `SELECT scenario_version_id::text AS scenario_version_id, params
         FROM runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, runId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new Error("RuntimeWorker: run-drive run row not found in tenant scope");
    }
    return {
      scenarioVersionId: row.scenario_version_id,
      correlationId,
      leaseId,
      siteProfileId: plan.siteProfileId,
      browserIdentityId: plan.browserIdentityId,
      networkPolicyId: plan.networkPolicyId,
      isolation: plan.isolation ?? "context",
      cleanupPolicy: plan.cleanupPolicy ?? "clear_all",
      params: normalizeRunParams(row.params),
    };
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
