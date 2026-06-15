/**
 * 통합 — POST /v1/sites/{id}/approve (api-surface §6). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-sites-approve.int.ts
 * 검증: approver 승인→200 + approved=true + 감사 행, RBAC 거부(viewer/operator→403), 404(미존재/cross-tenant),
 *       422(malformed body·멱등키 누락), 멱등 replay(중복 승인 행 없음).
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
const SCHEMA = "rpa_sites_approve_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SITE_RED = "7a000000-0000-0000-0000-000000000001";
const SITE_B = "7b000000-0000-0000-0000-000000000001";
const APPROVER_SUB = "11111111-0000-0000-0000-000000000001";

const SECRET = new TextEncoder().encode("sites-approve-int-secret-do-not-use-in-prod-0123456789");
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

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedSite(pool: Pool, tenant: string, id: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, circuit_state)
       VALUES ($1,$2,'red-site',$3,'red',false,'closed')`,
      [id, tenant, `https://red.example/*`],
    ),
  );
}

async function siteState(pool: Pool, tenant: string, id: string): Promise<{ approved: boolean; by: string | null; approvals: number }> {
  return withTenantTx(pool, tenant, async (c) => {
    const s = await c.query<{ approved: boolean; approved_by: string | null }>(
      `SELECT approved, approved_by::text AS approved_by FROM site_profiles WHERE id=$1::uuid`,
      [id],
    );
    const a = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM site_profile_approvals WHERE site_profile_id=$1::uuid`, [id]);
    return { approved: s.rows[0]?.approved ?? false, by: s.rows[0]?.approved_by ?? null, approvals: Number(a.rows[0]!.n) };
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
    await seedSite(pool, TENANT_A, SITE_RED);
    await seedSite(pool, TENANT_B, SITE_B);
    console.log("seeded red sites (tenant A + B)");

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {} };
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
      const approver = await mint({ sub: APPROVER_SUB, tenant_id: TENANT_A, roles: ["approver"] });
      const viewer = await mint({ sub: "v1", tenant_id: TENANT_A, roles: ["viewer"] });
      const operator = await mint({ sub: "o1", tenant_id: TENANT_A, roles: ["operator"] });
      const approverB = await mint({ sub: "11111111-0000-0000-0000-0000000000b1", tenant_id: TENANT_B, roles: ["approver"] });

      const post = (url: string, token: string, key?: string, body?: unknown) =>
        app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });

      // 1) approver 승인 → 200 + approved=true + 감사 행
      const ok = await post(`/v1/sites/${SITE_RED}/approve`, approver, "k-approve-1", { reason: "검토 완료" });
      check("approver approve → 200", ok.statusCode === 200, ok.body);
      check("response approved=true + approved_by", ok.json().approved === true && ok.json().approved_by === APPROVER_SUB, ok.body);
      const after = await siteState(pool, TENANT_A, SITE_RED);
      check("DB: approved=true, approved_by 기록", after.approved === true && after.by === APPROVER_SUB);
      check("DB: 감사 행 1건", after.approvals === 1);

      // 2) 멱등 replay(동일 키) → 동일 200, 감사 행 추가 없음
      const replay = await post(`/v1/sites/${SITE_RED}/approve`, approver, "k-approve-1", { reason: "검토 완료" });
      check("replay → 200 동일", replay.statusCode === 200);
      check("replay: 감사 행 그대로 1건(중복 승인 없음)", (await siteState(pool, TENANT_A, SITE_RED)).approvals === 1);

      // 3) RBAC: viewer/operator → 403 AUTHZ_FORBIDDEN (site.approve 미보유)
      const vDeny = await post(`/v1/sites/${SITE_RED}/approve`, viewer, "k-v");
      check("viewer approve → 403 AUTHZ_FORBIDDEN", vDeny.statusCode === 403 && vDeny.json().code === "AUTHZ_FORBIDDEN", vDeny.body);
      const oDeny = await post(`/v1/sites/${SITE_RED}/approve`, operator, "k-o");
      check("operator approve → 403", oDeny.statusCode === 403, oDeny.body);

      // 4) 미존재 site → 404, cross-tenant → 404(RLS)
      const absent = await post(`/v1/sites/70000000-0000-0000-0000-0000000000ff/approve`, approver, "k-absent");
      check("absent site → 404 RESOURCE_NOT_FOUND", absent.statusCode === 404 && absent.json().code === "RESOURCE_NOT_FOUND", absent.body);
      const cross = await post(`/v1/sites/${SITE_B}/approve`, approver, "k-cross");
      check("cross-tenant site → 404 (RLS, 존재 비노출)", cross.statusCode === 404, cross.body);
      check("cross-tenant: tenant B site 미변경", (await siteState(pool, TENANT_B, SITE_B)).approved === false);
      const malId = await post(`/v1/sites/not-a-uuid/approve`, approver, "k-mal");
      check("malformed id → 404", malId.statusCode === 404, malId.body);

      // 5) body 형상 무효 → 422 (키 소모 이전)
      const badBody = await post(`/v1/sites/${SITE_RED}/approve`, approver, "k-bad", { bogus: 1 });
      check("unexpected field → 422 IR_SCHEMA_INVALID", badBody.statusCode === 422 && badBody.json().code === "IR_SCHEMA_INVALID", badBody.body);
      const badExpiry = await post(`/v1/sites/${SITE_RED}/approve`, approver, "k-bad2", { expires_at: "not-a-date" });
      check("invalid expires_at → 422", badExpiry.statusCode === 422, badExpiry.body);

      // 6) 멱등 키 누락 → 422
      const noKey = await post(`/v1/sites/${SITE_RED}/approve`, approver);
      check("missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      // 7) tenant B approver는 자기 사이트 승인 가능(격리 양방향)
      const okB = await post(`/v1/sites/${SITE_B}/approve`, approverB, "k-b");
      check("tenant B approver approves own site → 200", okB.statusCode === 200, okB.body);
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
  console.log("\nPASS: POST /v1/sites/{id}/approve integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
