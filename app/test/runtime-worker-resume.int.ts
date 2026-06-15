/**
 * D3 runtime-worker resume integration gate.
 *
 * This proves PgRuntimeWorker handles R17-R20 without silently dropping the
 * R17 restoreSession side effect: DB claim/lease is committed first, restore
 * runs outside that transaction, and completion is persisted through R18/R19/R20.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type {
  ResumeTokenEnvelope,
  SessionRestoreInput,
  SessionRestoreResult,
  SessionRestorer,
} from "../../ts/runtime-contract";

import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_resume_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const WORKER = "10000000-0000-0000-0000-000000000010";
const OTHER_WORKER = "10000000-0000-0000-0000-000000000011";
const CORRELATION = "20000000-0000-0000-0000-000000000001";

const SCENARIO = "30000000-0000-0000-0000-000000000001";
const SCENARIO_VERSION = "30000000-0000-0000-0000-000000000002";
const RUN_RESTORED = "30000000-0000-0000-0000-000000000011";
const RUN_BYPASS = "30000000-0000-0000-0000-000000000012";
const RUN_FAIL = "30000000-0000-0000-0000-000000000013";
const RUN_RESUMING = "30000000-0000-0000-0000-000000000014";
const RUN_CONFLICT = "30000000-0000-0000-0000-000000000015";
const RUN_HOLDER = "30000000-0000-0000-0000-000000000016";

const SITE_RESTORED = "40000000-0000-0000-0000-000000000011";
const IDENTITY_RESTORED = "40000000-0000-0000-0000-000000000012";
const SITE_BYPASS = "40000000-0000-0000-0000-000000000013";
const IDENTITY_BYPASS = "40000000-0000-0000-0000-000000000014";
const SITE_FAIL = "40000000-0000-0000-0000-000000000015";
const IDENTITY_FAIL = "40000000-0000-0000-0000-000000000016";
const SITE_RESUMING = "40000000-0000-0000-0000-000000000017";
const IDENTITY_RESUMING = "40000000-0000-0000-0000-000000000018";
const SITE_CONFLICT = "40000000-0000-0000-0000-000000000019";
const IDENTITY_CONFLICT = "40000000-0000-0000-0000-00000000001a";
const RESUMING_LEASE = "50000000-0000-0000-0000-000000000014";
const CONFLICT_LEASE = "50000000-0000-0000-0000-000000000015";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async (_client, input) => {
  switch (input.runId) {
    case RUN_RESTORED:
      return { siteProfileId: SITE_RESTORED, browserIdentityId: IDENTITY_RESTORED };
    case RUN_BYPASS:
      return { siteProfileId: SITE_BYPASS, browserIdentityId: IDENTITY_BYPASS };
    case RUN_FAIL:
      return { siteProfileId: SITE_FAIL, browserIdentityId: IDENTITY_FAIL };
    case RUN_RESUMING:
      return { siteProfileId: SITE_RESUMING, browserIdentityId: IDENTITY_RESUMING };
    case RUN_CONFLICT:
      return { siteProfileId: SITE_CONFLICT, browserIdentityId: IDENTITY_CONFLICT };
    default:
      return null;
  }
};

function token(runId: string, pageStateRef: string): ResumeTokenEnvelope {
  return {
    runId: runId as RunId,
    resumeNodeId: `resume-${runId.slice(-2)}`,
    pageStateRef,
    issuedAt: "2026-06-15T00:00:00.000Z" as ResumeTokenEnvelope["issuedAt"],
    expiresAt: "2026-06-16T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"],
    kid: "kms://tenant-a/resume-token-key",
    hmac: "signed-envelope-hmac",
  };
}

async function seedTenant(pool: ReturnType<typeof createPool>, tenantId: string): Promise<void> {
  await withTenantTx(pool, tenantId, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [
      SCENARIO,
      tenantId,
      `runtime-resume-${tenantId}`,
    ]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [SCENARIO_VERSION, tenantId, SCENARIO],
    );
  });
}

async function seedRun(
  pool: ReturnType<typeof createPool>,
  runId: string,
  status: "resume_requested" | "resuming" | "claimed",
  pageStateRef: string,
  workerId?: string,
): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, worker_id, status, resume_token, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [runId, TENANT_A, SCENARIO_VERSION, workerId ?? null, status, JSON.stringify(token(runId, pageStateRef)), CORRELATION],
    );
  });
}

async function seedSitesAndWorkers(pool: ReturnType<typeof createPool>): Promise<void> {
  const setup = await pool.connect();
  try {
    await setup.query(
      `INSERT INTO workers (id, kind, status, circuit_state) VALUES
       ($1::uuid,'browser','active','closed'),
       ($2::uuid,'browser','active','closed')`,
      [WORKER, OTHER_WORKER],
    );
  } finally {
    setup.release();
  }

  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
       VALUES
       ($1,$2,'resume-restored','https://restored.example/*','green',false),
       ($3,$2,'resume-bypass','https://bypass.example/*','green',false),
       ($4,$2,'resume-fail','https://fail.example/*','green',false),
       ($5,$2,'resume-resuming','https://resuming.example/*','green',false),
       ($6,$2,'resume-conflict','https://conflict.example/*','green',false)`,
      [
        SITE_RESTORED,
        TENANT_A,
        SITE_BYPASS,
        SITE_FAIL,
        SITE_RESUMING,
        SITE_CONFLICT,
      ],
    );
    await c.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES
       ($1,$2,$3,'restored'),
       ($4,$2,$5,'bypass'),
       ($6,$2,$7,'fail'),
       ($8,$2,$9,'resuming'),
       ($10,$2,$11,'conflict')`,
      [
        IDENTITY_RESTORED,
        TENANT_A,
        SITE_RESTORED,
        IDENTITY_BYPASS,
        SITE_BYPASS,
        IDENTITY_FAIL,
        SITE_FAIL,
        IDENTITY_RESUMING,
        SITE_RESUMING,
        IDENTITY_CONFLICT,
        SITE_CONFLICT,
      ],
    );
  });
}

async function seedExistingLeases(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES
       ($1,$2,$3,$4,$5,$6,'context','active','clear_all','lease://resuming',now() + interval '5 minutes'),
       ($7,$2,$8,$9,$10,$11,'context','active','clear_all','lease://conflict',now() + interval '5 minutes')`,
      [
        RESUMING_LEASE,
        TENANT_A,
        SITE_RESUMING,
        IDENTITY_RESUMING,
        RUN_RESUMING,
        WORKER,
        CONFLICT_LEASE,
        SITE_CONFLICT,
        IDENTITY_CONFLICT,
        RUN_HOLDER,
        OTHER_WORKER,
      ],
    );
  });
}

async function runDetails(pool: ReturnType<typeof createPool>, runId: string): Promise<{
  status?: string;
  workerId?: string | null;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ status: string; worker_id: string | null }>(
      `SELECT status, worker_id::text FROM runs WHERE id=$1::uuid`,
      [runId],
    );
    return { status: row.rows[0]?.status, workerId: row.rows[0]?.worker_id };
  });
}

async function eventCount(pool: ReturnType<typeof createPool>, runId: string, eventType: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM events_outbox
        WHERE run_id=$1::uuid AND event_type=$2`,
      [runId, eventType],
    );
    return row.rows[0]?.n ?? -1;
  });
}

async function leaseCount(pool: ReturnType<typeof createPool>, runId: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM browser_leases
        WHERE run_id=$1::uuid
          AND owner_worker_id=$2::uuid
          AND state IN ('reserved','active')`,
      [runId, WORKER],
    );
    return row.rows[0]?.n ?? -1;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const restoreCalls: SessionRestoreInput[] = [];
  const restoreSawResuming: string[] = [];
  const restorer: SessionRestorer = {
    async restoreSession(input): Promise<SessionRestoreResult> {
      restoreCalls.push(input);
      const state = await runDetails(pool, input.runId);
      if (state.status === "resuming" && state.workerId === WORKER) {
        restoreSawResuming.push(input.runId);
      }
      if (input.runId === RUN_BYPASS) {
        return {
          kind: "page_state_mismatch",
          actualPageStateRef: "page-state://changed",
          loginBypassPossible: true,
          reason: "login flow can recover",
        };
      }
      if (input.runId === RUN_FAIL) {
        return { kind: "invalid_token", code: "IR_EXPRESSION_RUNTIME", reason: "bad token hmac" };
      }
      return { kind: "restored", pageStateRef: input.expectedPageStateRef };
    },
  };

  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency -> core)");

    await seedTenant(pool, TENANT_A);
    await seedSitesAndWorkers(pool);
    await seedRun(pool, RUN_RESTORED, "resume_requested", "page-state://restored");
    await seedRun(pool, RUN_BYPASS, "resume_requested", "page-state://bypass");
    await seedRun(pool, RUN_FAIL, "resume_requested", "page-state://fail");
    await seedRun(pool, RUN_RESUMING, "resuming", "page-state://resuming", WORKER);
    await seedRun(pool, RUN_CONFLICT, "resume_requested", "page-state://conflict");
    await seedRun(pool, RUN_HOLDER, "claimed", "page-state://holder", OTHER_WORKER);
    await seedExistingLeases(pool);
    console.log("seeded runtime resume fixtures");

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      sessionRestorer: restorer,
    });

    const restored = await worker.handle({
      kind: "run_resume",
      tenantId: TENANT_A as TenantId,
      runId: RUN_RESTORED as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_resume restored completes", restored.kind === "completed", JSON.stringify(restored));
    check("run_resume restored -> running", (await runDetails(pool, RUN_RESTORED)).status === "running");
    check("run_resume restored sets worker_id", (await runDetails(pool, RUN_RESTORED)).workerId === WORKER);
    check("run_resume restored emits run.resumed", (await eventCount(pool, RUN_RESTORED, "run.resumed")) === 1);
    check("restore saw committed resuming state", restoreSawResuming.includes(RUN_RESTORED));
    check("run_resume created browser lease", (await leaseCount(pool, RUN_RESTORED)) === 1);

    const bypass = await worker.handle({
      kind: "run_resume",
      tenantId: TENANT_A as TenantId,
      runId: RUN_BYPASS as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_resume login bypass completes", bypass.kind === "completed", JSON.stringify(bypass));
    check("run_resume login bypass -> running", (await runDetails(pool, RUN_BYPASS)).status === "running");
    check("run_resume login bypass emits run.resumed", (await eventCount(pool, RUN_BYPASS, "run.resumed")) === 1);

    const failed = await worker.handle({
      kind: "run_resume",
      tenantId: TENANT_A as TenantId,
      runId: RUN_FAIL as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_resume invalid token maps through R20", failed.kind === "completed", JSON.stringify(failed));
    check("run_resume invalid token -> failed_system", (await runDetails(pool, RUN_FAIL)).status === "failed_system");
    check("run_resume invalid token emits run.failed_system", (await eventCount(pool, RUN_FAIL, "run.failed_system")) === 1);

    const resumingRetry = await worker.handle({
      kind: "run_resume",
      tenantId: TENANT_A as TenantId,
      runId: RUN_RESUMING as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_resume retries existing resuming run", resumingRetry.kind === "completed", JSON.stringify(resumingRetry));
    check("run_resume retry -> running", (await runDetails(pool, RUN_RESUMING)).status === "running");
    check("run_resume retry reuses existing lease", (await leaseCount(pool, RUN_RESUMING)) === 1);

    const conflict = await worker.handle({
      kind: "run_resume",
      tenantId: TENANT_A as TenantId,
      runId: RUN_CONFLICT as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "run_resume active lease conflict defers",
      conflict.kind === "deferred" && conflict.code === "SESSION_LOCKED" && conflict.retryAfterMs > 0,
      JSON.stringify(conflict),
    );
    check("run_resume conflict leaves run resume_requested", (await runDetails(pool, RUN_CONFLICT)).status === "resume_requested");
    check("run_resume conflict does not set worker_id", (await runDetails(pool, RUN_CONFLICT)).workerId == null);

    const crossTenant = await worker.handle({
      kind: "run_resume",
      tenantId: TENANT_B as TenantId,
      runId: RUN_RESTORED as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("cross-tenant run_resume fails closed", crossTenant.kind === "failed" && crossTenant.code === "RUN_NOT_FOUND", JSON.stringify(crossTenant));

    try {
      await new PgRuntimeWorker(pool, {
        workerId: WORKER,
        browserLeasePlanResolver: planResolver,
      }).handle({
        kind: "run_resume",
        tenantId: TENANT_A as TenantId,
        runId: RUN_CONFLICT as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("run_resume without SessionRestorer throws", false, "expected throw");
    } catch (err) {
      check("run_resume without SessionRestorer throws", String(err).includes("SessionRestorer"), String(err));
    }

    check("restorer called for non-deferred resume jobs", restoreCalls.length === 4, `calls=${restoreCalls.length}`);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 runtime-worker resume integration green");
}

main().catch((err) => {
  console.error("FAIL: runtime-worker resume integration threw:", err);
  process.exit(1);
});
