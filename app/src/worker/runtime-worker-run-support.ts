/**
 * WorkerRunSupport — runtime-worker.ts 협력객체 분해(CLAUDE.md #7)의 지원 클러스터.
 *
 * run-claim/run-resume/run-abort 핸들러(PgRuntimeWorker)가 호출하는 leaf 지원 메서드를 모은다: run 행 적재
 * (loadExpectedRun)·구동 입력 적재(loadRunDriveInputs)·browser lease 획득(acquireBrowserLease)·worker 서킷
 * 게이트/기록(checkWorkerCircuit/recordWorkerInit*). 의존은 단방향(지원→leaf, 핸들러 역호출 0). 인-tx 메서드는
 * 호출자의 `client: pg.PoolClient` 를 그대로 받아 tx 경계를 보존하고, recordWorkerInit* 만 의도적으로 this.pool
 * 자동커밋 connection 으로 게이트(claim tx)와 분리한다 — 그래서 WorkerRunSupport 는 PgRuntimeWorker 와 동일한
 * pool 로 생성해야 한다(new WorkerRunSupport(pool, options)). BrowserLeasePlan/PgRuntimeWorkerOptions 는
 * import type 역참조(런타임 값 순환 없음).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { RunState } from "../../../ts/state-machine-types";
import type { RuntimeJobResult } from "../../../ts/runtime-contract";
import { recordSiteBlock } from "../observability/telemetry";
import { DEFAULT_SITE_CIRCUIT } from "../runtime/site-circuit";
import {
  DEFAULT_BROWSER_LEASE_TTL_MS,
  DEFAULT_WORKER_CIRCUIT_CLOSE_THRESHOLD,
  DEFAULT_WORKER_CIRCUIT_OPEN_MS,
  DEFAULT_WORKER_CIRCUIT_THRESHOLD,
  normalizeRunParams,
} from "./runtime-worker-run-context";
import type { RunClaimDriveInputs, RunRow } from "./runtime-worker-run-context";
import type { BrowserLeasePlan, PgRuntimeWorkerOptions } from "./runtime-worker";

export class WorkerRunSupport {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions,
  ) {}

  async loadExpectedRun(
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

  // A.1 run-drive: claim tx 에서 scenario_version_id + params 적재 + plan 의 identity 3-tuple 확정(networkPolicyId 필수).
  async loadRunDriveInputs(
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

  /**
   * worker 서킷 게이트 — **read-only 판정**(상태 전이 없음). true=진행 허용(프로브 포함), false=거부(격리).
   *  - open + cooldown(circuit_until 미설정 OR 아직 미래) → 거부(격리 유지). circuit_until=NULL(레거시/수동 open) 도 거부.
   *  - 그 외(closed · half_open · open+cooldown 경과) → 허용. open+cooldown 경과 claim 이 실제 프로브이며, 그 INIT 결과를
   *    recordWorkerInitSuccess/Failure 가 받아 open→half_open→closed / open 재진입을 **원자적으로** 처리한다.
   * 게이트에서 전이를 하지 않으므로, 프로브가 실제로 안 일어나는 경로(SESSION_LOCKED 등 조기반환·resume lease 재사용)는
   *   회로를 half_open limbo 로 남기지 않는다(적대리뷰: 전이↔프로브 정산 분리 결함 해소). worker 행 부재면 false.
   */
  async checkWorkerCircuit(client: pg.PoolClient, workerId: string): Promise<boolean> {
    const w = await client.query<{ blocked: boolean }>(
      `SELECT (circuit_state = 'open' AND (circuit_until IS NULL OR circuit_until > now())) AS blocked
         FROM workers WHERE id = $1::uuid`,
      [workerId],
    );
    const row = w.rows[0];
    if (row === undefined) return false;
    return !row.blocked;
  }

  async acquireBrowserLease(
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

    const worker = await client.query<{ kind: string; status: string }>(
      `SELECT kind, status FROM workers WHERE id = $1::uuid`,
      [input.workerId],
    );
    const workerRow = worker.rows[0];
    if (workerRow?.kind !== "browser" || workerRow.status !== "active") {
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }
    // worker 서킷(ops-defaults §3 worker.circuit): open+cooldown 이면 lease 거부(격리), cooldown 경과면 auto-close 후 진행.
    if (!(await this.checkWorkerCircuit(client, input.workerId))) {
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    // 사이트 서킷 게이트(ops-defaults §3 site.circuit)는 기존 site_profiles 판독에 접어 넣는다(별도 쿼리 회피). read-only 판정:
    //   circuit_blocked = open + cooldown(circuit_until 미설정 OR 미래). 전이는 전부 recordSiteCircuitOutcome(drive 후)에서.
    const siteOpenMs = this.options.siteCircuit?.openMs ?? DEFAULT_SITE_CIRCUIT.openMs;
    const identity = await client.query<{ risk: string; approved: boolean; circuit_blocked: boolean; retry_after_ms: number }>(
      `SELECT sp.risk, sp.approved,
              (sp.circuit_state = 'open' AND (sp.circuit_until IS NULL OR sp.circuit_until > now())) AS circuit_blocked,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(sp.circuit_until, now() + ($4::bigint * interval '1 millisecond')) - now())) * 1000))::int AS retry_after_ms
         FROM browser_identities bi
         JOIN site_profiles sp
           ON sp.tenant_id = bi.tenant_id
          AND sp.id = bi.site_profile_id
        WHERE bi.tenant_id = $1::uuid
          AND bi.id = $2::uuid
          AND sp.id = $3::uuid
        FOR UPDATE OF bi`,
      [input.tenantId, input.plan.browserIdentityId, input.plan.siteProfileId, siteOpenMs],
    );
    const site = identity.rows[0];
    if (site === undefined) {
      return { kind: "failed", code: "RESOURCE_NOT_FOUND" };
    }
    if (site.risk === "red" && !site.approved) {
      recordSiteBlock({ tenant_id: input.tenantId }); // §E site_block_rate. bootstrap 전이면 no-op meter.
      return { kind: "failed", code: "SITE_PROFILE_BLOCKED" };
    }
    // SITE_CIRCUIT_OPEN(503·retryable): 영구 승인게이트(SITE_PROFILE_BLOCKED) 통과 후 transient 차단 검사. 새 run state 없이
    //   deferred(=SESSION_LOCKED 와 동형)로 cooldown 남은 만큼 뒤 재시도 → run 은 queued 유지(R3a-류 재큐, 전이 무변).
    if (site.circuit_blocked) {
      return { kind: "deferred", code: "SITE_CIRCUIT_OPEN", retryAfterMs: site.retry_after_ms };
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

  /**
   * worker 서킷(ops-defaults §3 worker.circuit) — INIT **프로브 실패** 기록(상태 전이는 전부 여기서, 게이트는 read-only).
   *  - closed: per-worker 연속 실패 +1, 임계(consecutive_failures, 기본 5) 도달 시 open + cooldown(circuit_until).
   *  - open(=cooldown 경과 후 프로브)/half_open: **프로브 실패 → open 유지/재진입**(시험 중 한 번만 실패해도 재격리) + 새
   *    cooldown + half_open_successes reset. (게이트가 전이를 안 하므로 프로브 실패 시점에도 circuit_state 는 open/half_open.)
   * 단일 atomic UPDATE(Postgres 행잠금이 동시 프로브를 직렬화 — 두 번째 UPDATE 가 첫 commit 후 값 재평가). R3b per-run
   * 트리거(runs.*)를 직접 회로에 안 쓰고 per-worker 로 분리(과잉격리 회피, state-machine §1). workers 는 non-tenant infra.
   * ⚠ best-effort: record* 는 게이트(claim tx)와 다른 autocommit connection이라, 임계만큼의 동시 프로브 성공이 close 한
   *   '직후' 도착한 stale 프로브 실패는 closed +1 로 흡수될 수 있다(희귀·과소격리 방향, 임계 누적이 결국 재open — 수용).
   */
  async recordWorkerInitFailure(workerId: string): Promise<void> {
    const threshold = this.options.workerCircuitThreshold ?? DEFAULT_WORKER_CIRCUIT_THRESHOLD;
    const openMs = this.options.workerCircuitOpenMs ?? DEFAULT_WORKER_CIRCUIT_OPEN_MS;
    await this.pool.query(
      `UPDATE workers
          SET consecutive_init_failures = CASE WHEN circuit_state = 'closed' THEN consecutive_init_failures + 1 ELSE 0 END,
              half_open_successes = 0,
              circuit_state = CASE
                WHEN circuit_state IN ('open','half_open') THEN 'open'
                WHEN consecutive_init_failures + 1 >= $2::int THEN 'open'
                ELSE 'closed' END,
              circuit_until = CASE
                WHEN circuit_state IN ('open','half_open') OR consecutive_init_failures + 1 >= $2::int
                THEN now() + ($3::int * interval '1 millisecond') ELSE circuit_until END
        WHERE id = $1::uuid`,
      [workerId, threshold, openMs],
    );
  }

  /**
   * INIT **프로브 성공** 기록(상태 전이는 전부 여기서).
   *  - closed: 연속 실패 streak 종료 → consecutive_init_failures = 0(상태 유지).
   *  - open(=cooldown 경과 후 첫 프로브)/half_open: 프로브 성공 → half_open_successes +1; close 임계
   *    (half_open_close_threshold, 기본 2) 도달 시 closed(회복 확정·카운터/cooldown reset), 미달 시 half_open(첫 성공은
   *    open→half_open 진입). 단일 atomic UPDATE(행잠금 직렬화 — 동시 프로브 성공 누적 정확).
   * WHERE 가드: closed·실패0·half_open_successes0 이면 무비용.
   */
  async recordWorkerInitSuccess(workerId: string): Promise<void> {
    const closeThreshold = this.options.workerCircuitCloseThreshold ?? DEFAULT_WORKER_CIRCUIT_CLOSE_THRESHOLD;
    await this.pool.query(
      `UPDATE workers
          SET consecutive_init_failures = 0,
              half_open_successes = CASE
                WHEN circuit_state IN ('open','half_open') AND half_open_successes + 1 < $2::int THEN half_open_successes + 1
                ELSE 0 END,
              circuit_state = CASE
                WHEN circuit_state IN ('open','half_open') AND half_open_successes + 1 >= $2::int THEN 'closed'
                WHEN circuit_state = 'open' THEN 'half_open'
                ELSE circuit_state END,
              circuit_until = CASE
                WHEN circuit_state IN ('open','half_open') AND half_open_successes + 1 >= $2::int THEN NULL
                WHEN circuit_state = 'open' THEN NULL
                ELSE circuit_until END
        WHERE id = $1::uuid AND (consecutive_init_failures > 0 OR circuit_state <> 'closed')`,
      [workerId, closeThreshold],
    );
  }
}
