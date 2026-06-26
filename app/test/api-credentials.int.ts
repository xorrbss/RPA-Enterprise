/**
 * Integration: Credential reference lifecycle.
 *
 * Run:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-credentials.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_credentials_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SITE_A = "8a400000-0000-4000-8000-000000000001";
const SITE_B = "8b400000-0000-4000-8000-000000000001";
const SCEN_A = "8a000000-0000-4000-8000-000000000001";
const SVER_A = "8a000000-0000-4000-8000-000000000002";
const RUN_A = "8a100000-0000-4000-8000-000000000001";

const REF_OK = "rpa/test/runtime-worker/executor/login_password";
const REF_OK2 = "rpa/test/runtime-worker/executor/login_username";
const REF_LEASE = "rpa/test/runtime-worker/executor/lease_cred";
const REF_ROTATED = "rpa/test/runtime-worker/executor/lease_cred_v2";
const REF_BAD_PURPOSE = "rpa/test/api/resume_token_hmac/signing_key";
const REF_SHORT = "rpa/test/executor";
const REF_PCT = "rpa/test/runtime-worker/executor/..%2fresume_token_hmac";

const SECRET = new TextEncoder().encode("credentials-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

function mint(roles: string[], tenant = TENANT_A, sub = "admin-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

interface PolicyRow {
  credential_ref: string;
  site_profile_id: string;
  max_concurrency: number;
  label: string | null;
  status: "active" | "deprecated" | "revoked";
  owner_sub: string | null;
  rotation_policy: string;
  last_used_at: Date | null;
  replaced_by_credential_ref: string | null;
}

async function policiesOf(pool: Pool, tenant: string): Promise<PolicyRow[]> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<PolicyRow>(
      `SELECT credential_ref, site_profile_id::text AS site_profile_id, max_concurrency, label,
              status, owner_sub, rotation_policy, last_used_at, replaced_by_credential_ref
         FROM credential_concurrency_policies
        ORDER BY credential_ref`,
    );
    return r.rows;
  });
}

async function eventCount(pool: Pool, tenant: string, ref: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM credential_binding_events WHERE credential_ref=$1`,
      [ref],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function auditReasonCount(pool: Pool, tenant: string, reason: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='credential.manage' AND reason=$1`,
      [reason],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function seed(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'cred-a','https://cred-a.example/*')`, [SITE_A, TENANT_A]);
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'cred')`, [SCEN_A, TENANT_A]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
      [SVER_A, TENANT_A, SCEN_A],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,now(),now())`,
      [RUN_A, TENANT_A, SVER_A],
    );
  });
  await withTenantTx(pool, TENANT_B, async (c) => {
    await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'cred-b','https://cred-b.example/*')`, [SITE_B, TENANT_B]);
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
  });
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
    await seed(pool);
    await app.ready();

    const admin = await mint(["admin"]);
    const operator = await mint(["operator"], TENANT_A, "operator-a");
    const adminB = await mint(["admin"], TENANT_B, "admin-b");

    const post = (token: string, key: string | undefined, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/credentials",
        headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
        payload: body,
      });
    const rotate = (token: string, key: string | undefined, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/credentials/rotate",
        headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
        payload: body,
      });
    const decommission = (token: string, key: string | undefined, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/credentials/decommission",
        headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
        payload: body,
      });
    const del = (token: string, key: string | undefined, ref: string, site: string) =>
      app.inject({
        method: "DELETE",
        url: `/v1/credentials?credential_ref=${encodeURIComponent(ref)}&site_profile_id=${site}`,
        headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
      });
    const getConc = (token: string) =>
      app.inject({ method: "GET", url: "/v1/credentials/concurrency", headers: { authorization: `Bearer ${token}` } });

    const opDeny = await post(operator, "k-op", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 1 });
    check("operator register is denied", opDeny.statusCode === 403 && opDeny.json().code === "AUTHZ_FORBIDDEN", opDeny.body);

    const ok = await post(admin, "k-1", {
      credential_ref: REF_OK,
      site_profile_id: SITE_A,
      max_concurrency: 3,
      owner_sub: "cred-owner",
      rotation_policy: "periodic_90d",
    });
    check("admin register returns active lifecycle metadata", ok.statusCode === 200 && ok.json().status === "active", ok.body);
    let rows = await policiesOf(pool, TENANT_A);
    check(
      "DB register stores owner, status, rotation policy",
      rows.some((r) => r.credential_ref === REF_OK && r.max_concurrency === 3 && r.status === "active" && r.owner_sub === "cred-owner" && r.rotation_policy === "periodic_90d"),
    );

    const up = await post(admin, "k-2", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 5, label: "ops account" });
    check("upsert updates max and label", up.statusCode === 200 && up.json().max_concurrency === 5 && up.json().label === "ops account", up.body);
    rows = await policiesOf(pool, TENANT_A);
    check(
      "DB upsert keeps one row",
      rows.filter((r) => r.credential_ref === REF_OK).length === 1 && rows.find((r) => r.credential_ref === REF_OK)?.max_concurrency === 5,
    );

    const withPw = await post(admin, "k-pw", { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 1, password: "hunter2" });
    check("password field is rejected", withPw.statusCode === 422 && withPw.json().details?.reason === "secret_value_not_accepted", withPw.body);
    const withToken = await rotate(admin, "k-tok", {
      credential_ref: REF_OK,
      new_credential_ref: REF_OK2,
      site_profile_id: SITE_A,
      token: "abc",
    });
    check("rotate rejects token field", withToken.statusCode === 422 && withToken.json().details?.reason === "secret_value_not_accepted", withToken.body);
    check("secret-value requests do not create REF_OK2", (await policiesOf(pool, TENANT_A)).every((r) => r.credential_ref !== REF_OK2));

    const badPurpose = await post(admin, "k-bp", { credential_ref: REF_BAD_PURPOSE, site_profile_id: SITE_A, max_concurrency: 1 });
    check("bad purpose is rejected", badPurpose.statusCode === 422 && badPurpose.json().details?.reason === "credential_ref_invalid", badPurpose.body);
    const shortRef = await post(admin, "k-sr", { credential_ref: REF_SHORT, site_profile_id: SITE_A, max_concurrency: 1 });
    check("short ref is rejected", shortRef.statusCode === 422 && shortRef.json().details?.reason === "credential_ref_invalid", shortRef.body);
    const pctRef = await post(admin, "k-pct", { credential_ref: REF_PCT, site_profile_id: SITE_A, max_concurrency: 1 });
    check("percent encoded ref is rejected", pctRef.statusCode === 422 && pctRef.json().details?.reason === "credential_ref_invalid", pctRef.body);

    const ghostSite = await post(admin, "k-gs", { credential_ref: REF_OK2, site_profile_id: "70000000-0000-4000-8000-0000000000ff", max_concurrency: 1 });
    check("missing site returns 404", ghostSite.statusCode === 404, ghostSite.body);
    const badMax = await post(admin, "k-bm", { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 0 });
    check("max_concurrency=0 is rejected", badMax.statusCode === 422 && badMax.json().details?.reason === "invalid_max_concurrency", badMax.body);
    const noKey = await post(admin, undefined, { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 1 });
    check("missing idempotency key is rejected", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

    const conc = await getConc(admin);
    const concItem = (conc.json().items as Array<{ credential_ref: string; status: string; owner_sub: string | null; rotation_policy: string }>).find((i) => i.credential_ref === REF_OK);
    check("GET includes lifecycle metadata", conc.statusCode === 200 && concItem?.status === "active" && concItem.owner_sub === "admin-a" && concItem.rotation_policy === "manual", JSON.stringify(concItem));

    const concB = await getConc(adminB);
    check("tenant B does not see tenant A binding", concB.statusCode === 200 && (concB.json().items as Array<{ credential_ref: string }>).every((i) => i.credential_ref !== REF_OK), concB.body);
    const crossSite = await post(adminB, "k-cross", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 1 });
    check("tenant B cannot bind tenant A site", crossSite.statusCode === 404, crossSite.body);

    const okLease = await post(admin, "k-lease", { credential_ref: REF_LEASE, site_profile_id: SITE_A, max_concurrency: 2 });
    check("lease policy register ok", okLease.statusCode === 200, okLease.body);
    await withTenantTx(pool, TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
         VALUES ($1,$2,$3,0,$4,'active', now() + interval '10 minutes')`,
        [TENANT_A, REF_LEASE, SITE_A, RUN_A],
      );
    });
    rows = await policiesOf(pool, TENANT_A);
    check("active lease marks last_used_at", rows.find((r) => r.credential_ref === REF_LEASE)?.last_used_at instanceof Date);

    const rotateBusy = await rotate(admin, "k-rot-busy", {
      credential_ref: REF_LEASE,
      new_credential_ref: REF_ROTATED,
      site_profile_id: SITE_A,
    });
    check("rotate is blocked while active lease exists", rotateBusy.statusCode === 409 && rotateBusy.json().code === "WORKITEM_CHECKOUT_CONFLICT", rotateBusy.body);
    const decommBusy = await decommission(admin, "k-decomm-busy", { credential_ref: REF_LEASE, site_profile_id: SITE_A });
    check("decommission is blocked while active lease exists", decommBusy.statusCode === 409 && decommBusy.json().code === "WORKITEM_CHECKOUT_CONFLICT", decommBusy.body);
    const delBusy = await del(admin, "k-del-busy", REF_LEASE, SITE_A);
    check("delete remains blocked while active lease exists", delBusy.statusCode === 409 && delBusy.json().code === "WORKITEM_CHECKOUT_CONFLICT", delBusy.body);

    await withTenantTx(pool, TENANT_A, async (c) => {
      await c.query(`UPDATE credential_leases SET status='released' WHERE tenant_id=$1::uuid AND credential_ref=$2`, [TENANT_A, REF_LEASE]);
    });
    const rotOk = await rotate(admin, "k-rot-ok", {
      credential_ref: REF_LEASE,
      new_credential_ref: REF_ROTATED,
      site_profile_id: SITE_A,
      reason: "scheduled rotation",
    });
    check("rotate succeeds after lease release", rotOk.statusCode === 200 && rotOk.json().replacement?.credential_ref === REF_ROTATED, rotOk.body);
    rows = await policiesOf(pool, TENANT_A);
    check(
      "rotate deprecates old ref and creates active replacement",
      rows.some((r) => r.credential_ref === REF_LEASE && r.status === "deprecated" && r.replaced_by_credential_ref === REF_ROTATED) &&
        rows.some((r) => r.credential_ref === REF_ROTATED && r.status === "active"),
    );
    check("rotation events are recorded", (await eventCount(pool, TENANT_A, REF_LEASE)) >= 2 || (await eventCount(pool, TENANT_A, REF_ROTATED)) >= 1);
    check("rotation audit is recorded", (await auditReasonCount(pool, TENANT_A, "credential_binding_rotated")) === 1);

    let deprecatedLeaseRejected = false;
    try {
      await withTenantTx(pool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
           VALUES ($1,$2,$3,1,$4,'active', now() + interval '10 minutes')`,
          [TENANT_A, REF_LEASE, SITE_A, RUN_A],
        );
      });
    } catch {
      deprecatedLeaseRejected = true;
    }
    check("deprecated credential cannot acquire a new active lease", deprecatedLeaseRejected);

    const decommOk = await decommission(admin, "k-decomm-ok", {
      credential_ref: REF_ROTATED,
      site_profile_id: SITE_A,
      reason: "retired account",
    });
    check("decommission marks replacement revoked", decommOk.statusCode === 200 && decommOk.json().status === "revoked", decommOk.body);
    rows = await policiesOf(pool, TENANT_A);
    check("DB status is revoked after decommission", rows.some((r) => r.credential_ref === REF_ROTATED && r.status === "revoked"));
    check("decommission audit is recorded", (await auditReasonCount(pool, TENANT_A, "credential_binding_decommissioned")) === 1);

    const delGhost = await del(admin, "k-del-ghost", "rpa/test/runtime-worker/executor/missing", SITE_A);
    check("delete missing binding returns 404", delGhost.statusCode === 404, delGhost.body);
    const delOp = await del(operator, "k-del-op", REF_OK, SITE_A);
    check("operator delete is denied", delOp.statusCode === 403 && delOp.json().code === "AUTHZ_FORBIDDEN", delOp.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} credential API check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: credential lifecycle integration green");
}

main().catch((err) => {
  console.error("int fatal:", err);
  process.exit(1);
});
