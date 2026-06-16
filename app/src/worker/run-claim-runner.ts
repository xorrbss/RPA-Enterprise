// run_claim 잡 실행(claim→drive→완료) — PgRuntimeWorker에서 분리한 협력 클래스. 로직 무변경.
import type pg from "pg";

import type {
  EventId,
  LeaseCleanupPolicy,
  LeaseIsolation,
  RuntimeJobResult,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { SPAN, withSpan, type CommonSpanAttrs } from "../observability/telemetry";
import { applyRunTransition } from "../runtime/run-transition";
import { driveClaimedRun } from "../runtime/run-step-driver";
import { UtilityExecutor } from "../executor/utility-executor";
import { SitePageStateResolver } from "../executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../executor/site-page-state-config";
import { gateBrowserSessionProvider } from "../executor/browser-session-provider";
import { requireString } from "./worker-util";
import { BrowserLeaseManager } from "./browser-lease-manager";
import type { BrowserLeasePlan, PgRuntimeWorkerOptions } from "./runtime-worker";

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

export class RunClaimRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
    private readonly leases: BrowserLeaseManager,
  ) {}

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
        const run = await this.leases.loadExpectedRun(client, tenantId, runId, "queued");
        if (run.kind !== "ok") return { result: run.result };

        // §E 필수 span: run.claim(루트) ⊃ browser.lease.acquire. 공통속성은 적재된 run의 correlation_id.
        const correlationId = job.correlationId ?? run.row.correlation_id;
        const common: CommonSpanAttrs = { tenant_id: tenantId, run_id: runId, correlation_id: correlationId };
        return withSpan(SPAN.runClaim, common, { worker_id: workerId }, async () => {
          const plan = await leasePlanResolver(client, { tenantId, runId });
          const lease = await withSpan(SPAN.browserLeaseAcquire, common, {}, async () =>
            this.leases.acquireBrowserLease(client, { tenantId, runId, workerId, plan }),
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
}

// runs.params(jsonb) 정규화: 문자열이면 파싱, null/부재면 undefined(빈 {} 와 구분 — navigate 키 해소가 loud 실패). run-loop 와 동형.
function normalizeRunParams(raw: unknown): Record<string, unknown> | undefined {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
