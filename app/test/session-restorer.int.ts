/**
 * PgSessionRestorer integration gate.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/session-restorer.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type {
  LeaseId,
  ResumeTokenCodec,
  ResumeTokenEnvelope,
  ResumeTokenVerification,
  SessionRestoreInput,
  WorkerId,
} from "../../ts/runtime-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { DevPlaintextSessionEncryptor, PgBrowserSessionStore, sessionKey } from "../src/runtime/browser-session-store";
import { PgSessionRestorer } from "../src/runtime/session-restorer";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_session_restorer_int";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "10000000-0000-0000-0000-000000000001";
const LEASE = "20000000-0000-0000-0000-000000000001";
const CORRELATION = "30000000-0000-0000-0000-000000000001";

const SITE_OK = "40000000-0000-0000-0000-000000000001";
const IDENTITY_OK = "50000000-0000-0000-0000-000000000001";
const SITE_NO_SESSION = "40000000-0000-0000-0000-000000000002";
const IDENTITY_NO_SESSION = "50000000-0000-0000-0000-000000000002";
const SITE_EMPTY = "40000000-0000-0000-0000-000000000003";
const IDENTITY_EMPTY = "50000000-0000-0000-0000-000000000003";

const SCEN = "60000000-0000-0000-0000-000000000001";
const SVER_OK = "70000000-0000-0000-0000-000000000001";
const SVER_NO_SESSION = "70000000-0000-0000-0000-000000000002";
const SVER_EMPTY = "70000000-0000-0000-0000-000000000003";
const SVER_NO_TARGET = "70000000-0000-0000-0000-000000000004";
const RUN_OK = "80000000-0000-0000-0000-000000000001";
const RUN_NO_SESSION = "80000000-0000-0000-0000-000000000002";
const RUN_EMPTY = "80000000-0000-0000-0000-000000000003";
const RUN_NO_TARGET = "80000000-0000-0000-0000-000000000004";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

class FakeResumeTokenCodec implements ResumeTokenCodec {
  constructor(private readonly result?: ResumeTokenVerification | Error) {}

  async issue(input: Omit<ResumeTokenEnvelope, "kid" | "hmac">): Promise<ResumeTokenEnvelope> {
    return { ...input, kid: "kid://test", hmac: "test-hmac" };
  }

  async verify(token: ResumeTokenEnvelope): Promise<ResumeTokenVerification> {
    if (this.result instanceof Error) throw this.result;
    return this.result ?? { kind: "valid", token };
  }
}

function token(runId: string, resumeNodeId = "resume_node", pageStateRef = "page-state://expected"): ResumeTokenEnvelope {
  return {
    runId: runId as RunId,
    resumeNodeId,
    pageStateRef: pageStateRef as ResumeTokenEnvelope["pageStateRef"],
    issuedAt: "2026-06-15T00:00:00.000Z" as ResumeTokenEnvelope["issuedAt"],
    expiresAt: "2026-06-16T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"],
    kid: "kid://test",
    hmac: "test-hmac",
  };
}

function input(runId: string, envelope = token(runId)): SessionRestoreInput {
  return {
    tenantId: TENANT as TenantId,
    runId: runId as RunId,
    leaseId: LEASE as LeaseId,
    workerId: WORKER as WorkerId,
    correlationId: CORRELATION as CorrelationId,
    token: envelope,
    expectedPageStateRef: envelope.pageStateRef,
    resumeNodeId: envelope.resumeNodeId,
  };
}

async function seedScenarioVersion(
  pool: ReturnType<typeof createPool>,
  id: string,
  version: number,
  ir: Record<string, unknown>,
): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,$4,'draft',$5::jsonb)`,
      [id, TENANT, SCEN, version, JSON.stringify(ir)],
    );
  });
}

async function seedRun(pool: ReturnType<typeof createPool>, runId: string, scenarioVersionId: string): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, resume_token, correlation_id)
       VALUES ($1,$2,$3,'resume_requested',$4::jsonb,$5)`,
      [runId, TENANT, scenarioVersionId, JSON.stringify(token(runId)), CORRELATION],
    );
  });
}

function irFor(siteProfileId: string, browserIdentityId: string): Record<string, unknown> {
  return {
    meta: { name: "session-restorer-test", version: 1 },
    start: "resume_node",
    target: { site_profile_id: siteProfileId, browser_identity_id: browserIdentityId },
    nodes: { resume_node: { terminal: "success" } },
  };
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const store = new PgBrowserSessionStore(
    { pool, encryptor: new DevPlaintextSessionEncryptor() },
    { allowDevPlaintext: true },
  );

  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'session-restorer')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true),
                ($3,$2,'missing','https://missing.example/*','green',true),
                ($4,$2,'empty','https://empty.example/*','green',true)`,
        [SITE_OK, TENANT, SITE_NO_SESSION, SITE_EMPTY],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1,$2,$3,'ok'), ($4,$2,$5,'missing'), ($6,$2,$7,'empty')`,
        [IDENTITY_OK, TENANT, SITE_OK, IDENTITY_NO_SESSION, SITE_NO_SESSION, IDENTITY_EMPTY, SITE_EMPTY],
      );
    });
    await seedScenarioVersion(pool, SVER_OK, 1, irFor(SITE_OK, IDENTITY_OK));
    await seedScenarioVersion(pool, SVER_NO_SESSION, 2, irFor(SITE_NO_SESSION, IDENTITY_NO_SESSION));
    await seedScenarioVersion(pool, SVER_EMPTY, 3, irFor(SITE_EMPTY, IDENTITY_EMPTY));
    await seedScenarioVersion(pool, SVER_NO_TARGET, 4, { nodes: [] });
    await seedRun(pool, RUN_OK, SVER_OK);
    await seedRun(pool, RUN_NO_SESSION, SVER_NO_SESSION);
    await seedRun(pool, RUN_EMPTY, SVER_EMPTY);
    await seedRun(pool, RUN_NO_TARGET, SVER_NO_TARGET);
    await store.save(sessionKey(TENANT, SITE_OK, IDENTITY_OK), {
      cookies: [{ name: "sess", value: "cookie-value", domain: "ok.example", path: "/" }],
    });
    await store.save(sessionKey(TENANT, SITE_EMPTY, IDENTITY_EMPTY), { cookies: [] });

    const restorer = new PgSessionRestorer({
      pool,
      resumeTokenCodec: new FakeResumeTokenCodec(),
      sessionStore: store,
    });
    const ok = await restorer.restoreSession(input(RUN_OK));
    check("valid token + stored cookies returns login_bypass", ok.kind === "login_bypass", JSON.stringify(ok));
    check("production restorer does not claim exact restored state", ok.kind !== "restored", JSON.stringify(ok));

    const invalid = await new PgSessionRestorer({
      pool,
      resumeTokenCodec: new FakeResumeTokenCodec({
        kind: "invalid",
        code: "IR_EXPRESSION_RUNTIME",
        reason: "bad hmac",
      }),
      sessionStore: store,
    }).restoreSession(input(RUN_OK));
    check(
      "invalid resume token maps to invalid_token",
      invalid.kind === "invalid_token" && invalid.code === "IR_EXPRESSION_RUNTIME",
      JSON.stringify(invalid),
    );

    const expired = await new PgSessionRestorer({
      pool,
      resumeTokenCodec: new FakeResumeTokenCodec({
        kind: "expired",
        code: "CHALLENGE_UNRESOLVED",
        reason: "expired",
      }),
      sessionStore: store,
    }).restoreSession(input(RUN_OK));
    check(
      "expired resume token maps to invalid_token",
      expired.kind === "invalid_token" && expired.code === "CHALLENGE_UNRESOLVED",
      JSON.stringify(expired),
    );

    const mismatchedEnvelope = token(RUN_OK, "signed_node");
    const mismatch = await restorer.restoreSession({
      ...input(RUN_OK, mismatchedEnvelope),
      resumeNodeId: "requested_node",
    });
    check(
      "verified token envelope mismatch is rejected",
      mismatch.kind === "invalid_token" && mismatch.code === "IR_EXPRESSION_RUNTIME",
      JSON.stringify(mismatch),
    );

    const noSession = await restorer.restoreSession(input(RUN_NO_SESSION));
    check("missing browser session is terminal_failure", noSession.kind === "terminal_failure", JSON.stringify(noSession));

    const empty = await restorer.restoreSession(input(RUN_EMPTY));
    check("empty browser session is terminal_failure", empty.kind === "terminal_failure", JSON.stringify(empty));

    const noTarget = await restorer.restoreSession(input(RUN_NO_TARGET));
    check("missing scenario target is terminal_failure", noTarget.kind === "terminal_failure", JSON.stringify(noTarget));

    const thrown = await new PgSessionRestorer({
      pool,
      resumeTokenCodec: new FakeResumeTokenCodec(new Error("verify exploded")),
      sessionStore: store,
    }).restoreSession(input(RUN_OK));
    check("codec throw is terminal_failure", thrown.kind === "terminal_failure", JSON.stringify(thrown));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: PgSessionRestorer integration green");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: session-restorer integration threw:", err);
  process.exit(1);
});
