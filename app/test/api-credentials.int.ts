/**
 * 통합 — POST/DELETE /v1/credentials (DG-4 자격증명 *참조* 등록/삭제). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-credentials.int.ts
 *
 * 검증: admin 등록→200 + credential_concurrency_policies 행, upsert(max_concurrency 갱신),
 *   ⛔ **값 필드(password/token/…) 주입→422(negative control — 값 유입 차단)**, ref 문법/purpose
 *   화이트리스트 거부, 미존재 site→404, 멱등키 누락→422, RBAC(operator→403, admin 전용),
 *   RLS cross-tenant 격리, DELETE 활성 lease→409·release 후→200.
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
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
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
}

async function policiesOf(pool: Pool, tenant: string): Promise<PolicyRow[]> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<PolicyRow>(
      `SELECT credential_ref, site_profile_id::text AS site_profile_id, max_concurrency
         FROM credential_concurrency_policies ORDER BY credential_ref`,
    );
    return r.rows;
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
    const del = (token: string, key: string | undefined, ref: string, site: string) =>
      app.inject({
        method: "DELETE",
        url: `/v1/credentials?credential_ref=${encodeURIComponent(ref)}&site_profile_id=${site}`,
        headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
      });
    const getConc = (token: string) =>
      app.inject({ method: "GET", url: "/v1/credentials/concurrency", headers: { authorization: `Bearer ${token}` } });

    // 1) RBAC: operator(credential.manage 미보유) → 403 (DG4-D1 admin 전용)
    const opDeny = await post(operator, "k-op", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 1 });
    check("operator register → 403 AUTHZ_FORBIDDEN (admin 전용)", opDeny.statusCode === 403 && opDeny.json().code === "AUTHZ_FORBIDDEN", opDeny.body);

    // 2) admin 등록(valid) → 200 + DB 행
    const ok = await post(admin, "k-1", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 3 });
    check("admin register → 200", ok.statusCode === 200, ok.body);
    check("200 body: ref·site·max", ok.json().credential_ref === REF_OK && ok.json().max_concurrency === 3, ok.body);
    let rows = await policiesOf(pool, TENANT_A);
    check("DB: 정책 행 생성 max=3", rows.some((r) => r.credential_ref === REF_OK && r.max_concurrency === 3));

    // 3) upsert: 동일 (ref, site) 새 키 + max=5 → 200, max 갱신, 1행
    const up = await post(admin, "k-2", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 5, label: "운영계정" });
    check("upsert → 200 max=5 + label", up.statusCode === 200 && up.json().max_concurrency === 5 && up.json().label === "운영계정", up.body);
    rows = await policiesOf(pool, TENANT_A);
    check("DB: upsert 1행 유지 max=5", rows.filter((r) => r.credential_ref === REF_OK).length === 1 && rows.find((r) => r.credential_ref === REF_OK)?.max_concurrency === 5);

    // 4) ⛔ NEGATIVE CONTROL — 값 필드(password) 주입 → 422 secret_value_not_accepted, 행 미생성
    const withPw = await post(admin, "k-pw", { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 1, password: "hunter2" });
    check("⛔ password 필드 → 422 secret_value_not_accepted", withPw.statusCode === 422 && withPw.json().code === "IR_SCHEMA_INVALID" && withPw.json().details?.reason === "secret_value_not_accepted", withPw.body);
    const withToken = await post(admin, "k-tok", { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 1, token: "abc" });
    check("⛔ token 필드 → 422", withToken.statusCode === 422 && withToken.json().details?.reason === "secret_value_not_accepted", withToken.body);
    check("⛔ 값 필드 요청은 행 미생성(REF_OK2 부재)", (await policiesOf(pool, TENANT_A)).every((r) => r.credential_ref !== REF_OK2));

    // 5) ref 문법/purpose 거부
    const badPurpose = await post(admin, "k-bp", { credential_ref: REF_BAD_PURPOSE, site_profile_id: SITE_A, max_concurrency: 1 });
    check("ref purpose=resume_token_hmac → 422 credential_ref_invalid", badPurpose.statusCode === 422 && badPurpose.json().details?.reason === "credential_ref_invalid", badPurpose.body);
    const shortRef = await post(admin, "k-sr", { credential_ref: REF_SHORT, site_profile_id: SITE_A, max_concurrency: 1 });
    check("ref segs<5 → 422", shortRef.statusCode === 422 && shortRef.json().details?.reason === "credential_ref_invalid", shortRef.body);
    const pctRef = await post(admin, "k-pct", { credential_ref: REF_PCT, site_profile_id: SITE_A, max_concurrency: 1 });
    check("ref percent-encoding → 422", pctRef.statusCode === 422 && pctRef.json().details?.reason === "credential_ref_invalid", pctRef.body);

    // 6) 미존재 site → 404; 무효 max → 422; 멱등키 누락 → 422
    const ghostSite = await post(admin, "k-gs", { credential_ref: REF_OK2, site_profile_id: "70000000-0000-4000-8000-0000000000ff", max_concurrency: 1 });
    check("미존재 site → 404", ghostSite.statusCode === 404, ghostSite.body);
    const badMax = await post(admin, "k-bm", { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 0 });
    check("max_concurrency=0 → 422", badMax.statusCode === 422 && badMax.json().details?.reason === "invalid_max_concurrency", badMax.body);
    const noKey = await post(admin, undefined, { credential_ref: REF_OK2, site_profile_id: SITE_A, max_concurrency: 1 });
    check("멱등키 누락 → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

    // 7) GET D5 — admin 이 등록 바인딩을 본다 + DG-4 메타(label·registered_by) 투영
    const conc = await getConc(admin);
    const concItem = (conc.json().items as Array<{ credential_ref: string; max_concurrency: number; label: string | null; registered_by: string | null; registered_at: string }>).find((i) => i.credential_ref === REF_OK);
    check("GET concurrency → 200 REF_OK max=5", conc.statusCode === 200 && concItem?.max_concurrency === 5, conc.body);
    check("GET: 메타 label·registered_by·registered_at 투영", concItem?.label === "운영계정" && concItem?.registered_by === "admin-a" && typeof concItem?.registered_at === "string", JSON.stringify(concItem));

    // 8) RLS cross-tenant: tenant B admin 은 A 바인딩을 못 본다; B 가 site_A(타테넌트) 등록 → 404
    const concB = await getConc(adminB);
    check("tenant B GET: A 바인딩 비노출(RLS)", concB.statusCode === 200 && (concB.json().items as Array<{ credential_ref: string }>).every((i) => i.credential_ref !== REF_OK), concB.body);
    const crossSite = await post(adminB, "k-cross", { credential_ref: REF_OK, site_profile_id: SITE_A, max_concurrency: 1 });
    check("tenant B 가 site_A 로 등록 → 404(site RLS 비가시)", crossSite.statusCode === 404, crossSite.body);

    // 9) DELETE 활성 lease 가드(DG4-D2): 정책 등록 → active lease 시드 → DELETE 409 → release → 200
    const okLease = await post(admin, "k-lease", { credential_ref: REF_LEASE, site_profile_id: SITE_A, max_concurrency: 2 });
    check("lease 정책 등록 → 200", okLease.statusCode === 200, okLease.body);
    await withTenantTx(pool, TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
         VALUES ($1,$2,$3,0,$4,'active', now() + interval '10 minutes')`,
        [TENANT_A, REF_LEASE, SITE_A, RUN_A],
      );
    });
    const delBusy = await del(admin, "k-del-busy", REF_LEASE, SITE_A);
    check("DELETE 활성 lease → 409 WORKITEM_CHECKOUT_CONFLICT", delBusy.statusCode === 409 && delBusy.json().code === "WORKITEM_CHECKOUT_CONFLICT", delBusy.body);
    check("DELETE 거부: 정책 행 유지", (await policiesOf(pool, TENANT_A)).some((r) => r.credential_ref === REF_LEASE));
    await withTenantTx(pool, TENANT_A, async (c) => {
      await c.query(`UPDATE credential_leases SET status='released' WHERE tenant_id=$1::uuid AND credential_ref=$2`, [TENANT_A, REF_LEASE]);
    });
    const delOk = await del(admin, "k-del-ok", REF_LEASE, SITE_A);
    check("lease release 후 DELETE → 200", delOk.statusCode === 200 && delOk.json().deleted === true, delOk.body);
    check("DB: 바인딩 삭제됨", (await policiesOf(pool, TENANT_A)).every((r) => r.credential_ref !== REF_LEASE));

    // 10) DELETE 미존재 → 404; RBAC operator DELETE → 403
    const delGhost = await del(admin, "k-del-ghost", REF_LEASE, SITE_A);
    check("DELETE 미존재 바인딩 → 404", delGhost.statusCode === 404, delGhost.body);
    const delOp = await del(operator, "k-del-op", REF_OK, SITE_A);
    check("operator DELETE → 403", delOp.statusCode === 403 && delOp.json().code === "AUTHZ_FORBIDDEN", delOp.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} credential API check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: POST/DELETE /v1/credentials integration green");
}

main().catch((err) => {
  console.error("int fatal:", err);
  process.exit(1);
});
