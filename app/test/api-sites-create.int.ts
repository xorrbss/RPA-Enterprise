/**
 * 통합 — POST /v1/sites (신규 등록) + PATCH /v1/sites/{id} (이름 수정, site.update). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-sites-create.int.ts
 * 검증: operator 생성→201 + DB 행, page_state_selectors 영속(parse 가능), RBAC 거부(viewer→403),
 *       422(malformed body·비-origin url_pattern·무효 risk·무효 selectors·중복 name·멱등키 누락),
 *       멱등 replay(중복 행 없음), cross-tenant 격리(동일 name이라도 테넌트별 독립).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { parseSitePageStateConfig } from "../src/executor/site-page-state-config";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_sites_create_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const OPERATOR_SUB = "11111111-0000-0000-0000-000000000001";

const SECRET = new TextEncoder().encode("sites-create-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

const SELECTORS = {
  authenticatedWhen: { selector: ".user-menu" },
  flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

interface SiteRow {
  id: string;
  name: string;
  url_pattern: string;
  risk: string;
  approved: boolean;
  page_state_selectors: unknown;
}

interface DefaultTargetRows {
  browser_identity_count: string;
  network_policy_count: string;
  allowed_domains: string[] | null;
}

async function sitesOf(pool: Pool, tenant: string): Promise<SiteRow[]> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<SiteRow>(
      `SELECT id::text AS id, name, url_pattern, risk, approved, page_state_selectors
         FROM site_profiles ORDER BY name`,
    );
    return r.rows;
  });
}

async function defaultTargetsOf(
  pool: Pool,
  tenant: string,
  siteId: string,
  browserIdentityId: string,
  networkPolicyId: string,
): Promise<DefaultTargetRows> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<DefaultTargetRows>(
      `SELECT
         (SELECT count(*)::text
            FROM browser_identities
           WHERE tenant_id=$1::uuid AND id=$3::uuid AND site_profile_id=$2::uuid AND version=1) AS browser_identity_count,
         (SELECT count(*)::text
            FROM network_policies
           WHERE tenant_id=$1::uuid AND id=$4::uuid) AS network_policy_count,
         (SELECT allowed_domains
            FROM network_policies
           WHERE tenant_id=$1::uuid AND id=$4::uuid) AS allowed_domains`,
      [tenant, siteId, browserIdentityId, networkPolicyId],
    );
    return r.rows[0] ?? { browser_identity_count: "0", network_policy_count: "0", allowed_domains: null };
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: OPERATOR_SUB, tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "v1", tenant_id: TENANT_A, roles: ["viewer"] });
      const operatorB = await mint({ sub: "11111111-0000-0000-0000-0000000000b1", tenant_id: TENANT_B, roles: ["operator"] });

      const post = (token: string, key?: string, body?: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/sites",
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });

      const patch = (token: string, id: string, key?: string, body?: unknown) =>
        app.inject({
          method: "PATCH",
          url: `/v1/sites/${id}`,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });

      // 1) operator 생성(green + selectors) → 201 + DB 행
      const ok = await post(operator, "k-create-1", {
        name: "하이웍스",
        url_pattern: "https://login.office.hiworks.com",
        page_state_selectors: SELECTORS,
      });
      check("operator create → 201", ok.statusCode === 201, ok.body);
      const created = ok.json();
      check("201 body: name·url_pattern·risk=green·approved=false", created.name === "하이웍스" && created.url_pattern === "https://login.office.hiworks.com" && created.risk === "green" && created.approved === false, ok.body);
      const rowsA1 = await sitesOf(pool, TENANT_A);
      const hi = rowsA1.find((r) => r.name === "하이웍스");
      check("DB: 행 생성, url_pattern·risk 기록", hi !== undefined && hi.url_pattern === "https://login.office.hiworks.com" && hi.risk === "green");
      check("DB: page_state_selectors 영속 + parse 가능", hi !== undefined && hi.page_state_selectors !== null && parseSitePageStateConfig(hi.page_state_selectors).flags.reviews_visible?.kind === "min_count");
      check("DB: id 일치", hi?.id === created.site_profile_id);
      check("201 body: 기본 실행 타깃 ID 포함", typeof created.default_browser_identity_id === "string" && typeof created.default_network_policy_id === "string", ok.body);
      const defaults = await defaultTargetsOf(
        pool,
        TENANT_A,
        created.site_profile_id,
        created.default_browser_identity_id,
        created.default_network_policy_id,
      );
      check(
        "DB: 기본 browser_identity 생성 및 site 연결",
        defaults.browser_identity_count === "1",
        JSON.stringify(defaults),
      );
      check(
        "DB: 기본 network_policy 생성 및 origin host 허용",
        defaults.network_policy_count === "1" && defaults.allowed_domains?.includes("login.office.hiworks.com") === true,
        JSON.stringify(defaults),
      );

      // 2) 멱등 replay(동일 키·동일 body) → 동일 201, 행 추가 없음
      const replay = await post(operator, "k-create-1", {
        name: "하이웍스",
        url_pattern: "https://login.office.hiworks.com",
        page_state_selectors: SELECTORS,
      });
      check("replay → 201 동일 id", replay.statusCode === 201 && replay.json().site_profile_id === created.site_profile_id, replay.body);
      check("replay: 행 추가 없음(1건 유지)", (await sitesOf(pool, TENANT_A)).filter((r) => r.name === "하이웍스").length === 1);

      // 3) 중복 name(다른 키) → 422 site_name_already_exists
      const dup = await post(operator, "k-create-dup", { name: "하이웍스", url_pattern: "https://other.example" });
      check("duplicate name → 422 IR_SCHEMA_INVALID", dup.statusCode === 422 && dup.json().code === "IR_SCHEMA_INVALID", dup.body);
      check("duplicate: 행 추가 없음", (await sitesOf(pool, TENANT_A)).filter((r) => r.name === "하이웍스").length === 1);

      // 4) RBAC: viewer → 403 AUTHZ_FORBIDDEN (site.create 미보유)
      const vDeny = await post(viewer, "k-v", { name: "v-site", url_pattern: "https://v.example" });
      check("viewer create → 403 AUTHZ_FORBIDDEN", vDeny.statusCode === 403 && vDeny.json().code === "AUTHZ_FORBIDDEN", vDeny.body);

      // 5) body 형상 무효 → 422 (키 소모 이전)
      const noName = await post(operator, "k-noname", { url_pattern: "https://x.example" });
      check("missing name → 422", noName.statusCode === 422 && noName.json().code === "IR_SCHEMA_INVALID", noName.body);
      const badUrl = await post(operator, "k-badurl", { name: "bad-url", url_pattern: "not-a-url" });
      check("non-origin url_pattern → 422", badUrl.statusCode === 422, badUrl.body);
      const fileUrl = await post(operator, "k-fileurl", { name: "file-url", url_pattern: "file:///etc/passwd" });
      check("non-http(s) url_pattern → 422 (opaque origin 거부)", fileUrl.statusCode === 422, fileUrl.body);
      const badRisk = await post(operator, "k-badrisk", { name: "bad-risk", url_pattern: "https://r.example", risk: "purple" });
      check("invalid risk → 422", badRisk.statusCode === 422, badRisk.body);
      const badSel = await post(operator, "k-badsel", { name: "bad-sel", url_pattern: "https://s.example", page_state_selectors: { flags: { bogus_flag: { kind: "present", selector: ".x" } } } });
      check("invalid page_state_selectors(닫힌 레지스트리 밖) → 422", badSel.statusCode === 422, badSel.body);
      const extra = await post(operator, "k-extra", { name: "extra", url_pattern: "https://e.example", bogus: 1 });
      check("unexpected field → 422", extra.statusCode === 422, extra.body);
      check("무효 요청들은 행 미생성", (await sitesOf(pool, TENANT_A)).every((r) => r.name === "하이웍스"));

      // 6) 멱등 키 누락 → 422
      const noKey = await post(operator, undefined, { name: "nokey", url_pattern: "https://n.example" });
      check("missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      // 7) red 사이트 생성 → 201, approved=false(승인 워크플로우 대상)
      const red = await post(operator, "k-red", { name: "red-site", url_pattern: "https://red.example/*", risk: "red" });
      check("red site create → 201 approved=false", red.statusCode === 201 && red.json().risk === "red" && red.json().approved === false, red.body);

      // 8) cross-tenant: tenant B가 동일 name(하이웍스) 생성 → 201(테넌트별 독립), A는 1건 유지(격리)
      const okB = await post(operatorB, "k-b", { name: "하이웍스", url_pattern: "https://login.office.hiworks.com" });
      check("tenant B 동일 name create → 201", okB.statusCode === 201, okB.body);
      check("tenant A '하이웍스' 여전히 1건(RLS 격리)", (await sitesOf(pool, TENANT_A)).filter((r) => r.name === "하이웍스").length === 1);
      check("tenant B '하이웍스' 1건", (await sitesOf(pool, TENANT_B)).filter((r) => r.name === "하이웍스").length === 1);

      // 9) PATCH /v1/sites/{id} — 이름 수정(site.update)
      const hiId = created.site_profile_id as string;
      const redId = red.json().site_profile_id as string;

      // 9a) operator rename → 200 + DB 반영(id 동일, name 변경)
      const ren = await patch(operator, hiId, "k-ren-1", { name: "하이웍스-수정" });
      check("operator rename → 200", ren.statusCode === 200, ren.body);
      check("200 body: site_profile_id 동일·name 변경", ren.json().site_profile_id === hiId && ren.json().name === "하이웍스-수정", ren.body);
      check("DB: name 갱신됨", (await sitesOf(pool, TENANT_A)).some((r) => r.id === hiId && r.name === "하이웍스-수정"));
      check("DB: 옛 이름 '하이웍스' 부재", (await sitesOf(pool, TENANT_A)).every((r) => r.name !== "하이웍스"));

      // 9b) 멱등 replay(동일 키·body) → 200 동일, 변경 없음
      const renReplay = await patch(operator, hiId, "k-ren-1", { name: "하이웍스-수정" });
      check("rename replay → 200 동일", renReplay.statusCode === 200 && renReplay.json().name === "하이웍스-수정", renReplay.body);

      // 9c) 중복 name(red-site → '하이웍스-수정') → 422 site_name_already_exists, red 이름 불변
      const renDup = await patch(operator, redId, "k-ren-dup", { name: "하이웍스-수정" });
      check("rename to existing name → 422 IR_SCHEMA_INVALID", renDup.statusCode === 422 && renDup.json().code === "IR_SCHEMA_INVALID", renDup.body);
      check("중복 거부: red-site 이름 불변", (await sitesOf(pool, TENANT_A)).some((r) => r.id === redId && r.name === "red-site"));

      // 9d) body 형상 무효 → 422 (빈 name·예상 외 필드·name 누락)
      const renEmpty = await patch(operator, redId, "k-ren-empty", { name: "   " });
      check("empty name → 422", renEmpty.statusCode === 422, renEmpty.body);
      const renExtra = await patch(operator, redId, "k-ren-extra", { name: "x", risk: "red" });
      check("unexpected field → 422", renExtra.statusCode === 422, renExtra.body);
      const renNoName = await patch(operator, redId, "k-ren-noname", {});
      check("missing name → 422", renNoName.statusCode === 422, renNoName.body);

      // 9e) 미존재 id → 404, 형식 무효 id → 404(존재 비노출)
      const renMissing = await patch(operator, "70000000-0000-0000-0000-0000000000ff", "k-ren-404", { name: "ghost" });
      check("absent site → 404", renMissing.statusCode === 404, renMissing.body);
      const renBadId = await patch(operator, "not-a-uuid", "k-ren-badid", { name: "x" });
      check("malformed id → 404", renBadId.statusCode === 404, renBadId.body);

      // 9f) RBAC: viewer → 403 (site.update 미보유)
      const renViewer = await patch(viewer, hiId, "k-ren-v", { name: "viewer-edit" });
      check("viewer rename → 403 AUTHZ_FORBIDDEN", renViewer.statusCode === 403 && renViewer.json().code === "AUTHZ_FORBIDDEN", renViewer.body);

      // 9g) 멱등 키 누락 → 422
      const renNoKey = await patch(operator, hiId, undefined, { name: "nokey" });
      check("missing Idempotency-Key → 422", renNoKey.statusCode === 422 && renNoKey.json().code === "IR_SCHEMA_INVALID", renNoKey.body);

      // 9h) cross-tenant: tenant B가 tenant A 사이트 PATCH → 404(RLS, 존재 비노출), A 이름 불변
      const renCross = await patch(operatorB, hiId, "k-ren-cross", { name: "stolen" });
      check("cross-tenant rename → 404", renCross.statusCode === 404, renCross.body);
      check("cross-tenant 거부: A 이름 불변", (await sitesOf(pool, TENANT_A)).some((r) => r.id === hiId && r.name === "하이웍스-수정"));
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: POST /v1/sites integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
