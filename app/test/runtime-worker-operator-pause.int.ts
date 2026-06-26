/**
 * runtime-worker operator pause integration. Real PostgreSQL fixture.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/runtime-worker-operator-pause.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_operator_pause_int";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const WORKER = "9d000000-0000-4000-8000-0000000000a1";
const SITE = "41000000-0000-4000-8000-000000000001";
const IDENTITY = "41000000-0000-4000-8000-000000000002";
const NETWORK_POLICY = "41000000-0000-4000-8000-000000000003";
const SCENARIO = "75000000-0000-4000-8000-000000000001";
const SVER = "75000000-0000-4000-8000-000000000002";
const WORKITEM = "76000000-0000-4000-8000-000000000001";
const RUN = "77000000-0000-4000-8000-000000000001";
const PAUSE_REQUEST = "78000000-0000-4000-8000-000000000001";
const CORRELATION = "79000000-0000-4000-8000-000000000001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async () => ({
  siteProfileId: SITE,
  browserIdentityId: IDENTITY,
  networkPolicyId: NETWORK_POLICY,
});

const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-test", key: "operator-pause-signing-key" }) as unknown as PlainSecret,
};
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);

const scenarioIr = {
  meta: { name: "operator-pause-worker-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

type Pool = ReturnType<typeof createPool>;

async function runSnapshot(pool: Pool): Promise<{
  status: string;
  bookmark: { reason?: string; pauseRequestId?: string; stepId?: string } | null;
  resume_token: { kid?: string; hmac?: string; resumeNodeId?: string; pageStateRef?: string } | null;
}> {
  return withTenantTx(pool, TENANT, async (client) => {
    const result = await client.query<{
      status: string;
      bookmark: { reason?: string; pauseRequestId?: string; stepId?: string } | null;
      resume_token: { kid?: string; hmac?: string; resumeNodeId?: string; pageStateRef?: string } | null;
    }>(`SELECT status, bookmark, resume_token FROM runs WHERE id = $1::uuid`, [RUN]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("run row missing");
    return row;
  });
}

async function pauseRequestSnapshot(pool: Pool): Promise<{
  status: string;
  reason: string | null;
  accepted_by_worker_id: string | null;
  completed_at: Date | null;
}> {
  return withTenantTx(pool, TENANT, async (client) => {
    const result = await client.query<{
      status: string;
      reason: string | null;
      accepted_by_worker_id: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, reason, accepted_by_worker_id::text, completed_at
         FROM run_pause_requests
        WHERE id = $1::uuid`,
      [PAUSE_REQUEST],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("pause request row missing");
    return row;
  });
}

async function workitemSnapshot(pool: Pool): Promise<{ status: string; checkout_paused_at: Date | null; checkout_expires_at: Date | null }> {
  return withTenantTx(pool, TENANT, async (client) => {
    const result = await client.query<{ status: string; checkout_paused_at: Date | null; checkout_expires_at: Date | null }>(
      `SELECT status, checkout_paused_at, checkout_expires_at FROM workitems WHERE id = $1::uuid`,
      [WORKITEM],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("workitem row missing");
    return row;
  });
}

async function humanTaskCount(pool: Pool): Promise<number> {
  return withTenantTx(pool, TENANT, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM human_tasks WHERE run_id = $1::uuid`,
      [RUN],
    );
    return result.rows[0]?.n ?? 0;
  });
}

async function eventTypes(pool: Pool): Promise<readonly string[]> {
  return withTenantTx(pool, TENANT, async (client) => {
    const result = await client.query<{ event_type: string }>(
      `SELECT event_type FROM events_outbox WHERE correlation_id = $1::uuid ORDER BY created_at, event_type`,
      [CORRELATION],
    );
    return result.rows.map((row) => row.event_type);
  });
}

async function runStepCount(pool: Pool): Promise<number> {
  return withTenantTx(pool, TENANT, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM run_steps WHERE run_id = $1::uuid`,
      [RUN],
    );
    return result.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid)`, [TENANT]);
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
      await setup.query(
        `INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid, 'browser', 'active', 'closed')`,
        [WORKER],
      );
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (client) => {
      await client.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1::uuid, $2::uuid, 'operator-pause', 'https://ok.example/*', 'green', true, '{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await client.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'operator-pause')`,
        [IDENTITY, TENANT, SITE],
      );
      await client.query(
        `INSERT INTO network_policies (id, tenant_id, allowed_domains)
         VALUES ($1::uuid, $2::uuid, ARRAY['ok.example'])`,
        [NETWORK_POLICY, TENANT],
      );
      await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'operator-pause')`, [
        SCENARIO,
        TENANT,
      ]);
      await client.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'prod', $4::jsonb, $5)`,
        [SVER, TENANT, SCENARIO, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await client.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checkout_expires_at)
         VALUES ($1::uuid, $2::uuid, 'operator-pause', 'operator-pause-1', 'processing', 0, now() + interval '30 minutes')`,
        [WORKITEM, TENANT],
      );
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id, params)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', $5::uuid, '{"entry_url":"https://ok.example/landing"}'::jsonb)`,
        [RUN, TENANT, SVER, WORKITEM, CORRELATION],
      );
      await client.query(
        `INSERT INTO run_pause_requests (id, tenant_id, run_id, requested_by, reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'operator-a', 'inspect before submit')`,
        [PAUSE_REQUEST, TENANT, RUN],
      );
    });

    let driveSession: FakeCdpSession | null = null;
    const sessionProvider = new TestFakeBrowserSessionProvider({
      makeSession: (downloadDir) => {
        driveSession = new FakeCdpSession(downloadDir);
        return driveSession;
      },
    });
    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: sessionProvider,
      allowTestBrowserSessionProvider: true,
      resumeTokenCodec,
    });

    const result = await worker.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim operator pause job completed", result.kind === "completed", JSON.stringify(result));

    const run = await runSnapshot(pool);
    check("DB runs.status = suspended", run.status === "suspended", JSON.stringify(run));
    check(
      "bookmark persisted as operator_pause",
      run.bookmark?.reason === "operator_pause" &&
        run.bookmark.pauseRequestId === PAUSE_REQUEST &&
        run.bookmark.stepId === "open.operator_pause",
      JSON.stringify(run.bookmark),
    );
    check(
      "resume_token issued for same node resume",
      typeof run.resume_token?.kid === "string" &&
        typeof run.resume_token.hmac === "string" &&
        run.resume_token.resumeNodeId === "open" &&
        run.resume_token.pageStateRef === "ps_seed",
      JSON.stringify(run.resume_token),
    );
    if (run.resume_token !== null) {
      const verified = await resumeTokenCodec.verify(run.resume_token as unknown as Parameters<typeof resumeTokenCodec.verify>[0]);
      check("stored operator-pause resume_token verifies", verified.kind === "valid", verified.kind);
    }

    const pause = await pauseRequestSnapshot(pool);
    check(
      "pause request completed by worker",
      pause.status === "completed" &&
        pause.reason === "inspect before submit" &&
        pause.accepted_by_worker_id === WORKER &&
        pause.completed_at !== null,
      JSON.stringify(pause),
    );
    const workitem = await workitemSnapshot(pool);
    check(
      "linked workitem checkout timer paused",
      workitem.status === "processing" && workitem.checkout_paused_at !== null && workitem.checkout_expires_at !== null,
      JSON.stringify(workitem),
    );
    check("operator pause does not create human_tasks", (await humanTaskCount(pool)) === 0);
    check("operator pause exits before executing node action", (await runStepCount(pool)) === 0);

    const events = await eventTypes(pool);
    check("outbox includes run.started and run.suspended", events.includes("run.started") && events.includes("run.suspended"), events.join(","));
    check("outbox has no human_task.created", !events.includes("human_task.created"), events.join(","));
    check("browser session released", driveSession !== null && (driveSession as FakeCdpSession).closeCalls === 1);
    check("navigate was not executed after pause intent", driveSession !== null && (driveSession as FakeCdpSession).gotoCalls === 0);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} operator pause worker check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker operator pause drive integration green");
}

main().catch((err) => {
  console.error("runtime-worker-operator-pause integration fatal:", err);
  process.exit(1);
});
