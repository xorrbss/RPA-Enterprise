/**
 * 통합 테스트 — 사이트 risk 승인(POST /v1/sites/{id}/approve, api-surface §7). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/api-sites.int.ts
 *
 * 검증: approver 승인(200)·pending→approved·감사행·멱등 재생·viewer 403·404(미존재/cross-tenant)·422(키/바디).
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
const SCHEMA = "rpa_sites_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SITE_A = "7a000000-0000-0000-0000-0000000000a1";
const SITE_B = "7b000000-0000-0000-0000-0000000000b1";
const APPROVER_SUB = "9a000000-0000-0000-0000-0000000000a1"; // approved_by uuid 컬럼 호환
const ABSENT = "7a000000-0000-0000-0000-0000000000ff";
const SECRET = new TextEncoder().encode("sites-int-secret-do-not-use-in-prod-0123456789");

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
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, circuit_state, created_at)
       VALUES ($1,$2,'red-site','https://red.example/*','red',false,'closed','2026-06-15T10:00:00Z')`,
      [id, tenant],
    ),
  );
}

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
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
    await seedSite(pool, TENANT_A, SITE_A);
    await seedSite(pool, TENANT_B, SITE_B);

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
      const viewer = await mint({ sub: "70000000-0000-0000-0000-0000000000c1", tenant_id: TENANT_A, roles: ["viewer"] });
      const approve = (siteId: string, token: string, key: string | undefined, body: unknown = {}) =>
        app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/approve`,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body,
        });
      const getSite = (siteId: string, token: string) =>
        app.inject({ method: "GET", url: `/v1/sites/${siteId}`, headers: { authorization: `Bearer ${token}` } });

      // 0) 사전: pending.
      check("seed site pending", (await getSite(SITE_A, approver)).json().approval_status === "pending");

      // 1) viewer 승인 → 403(RBAC, 명령 이전 차단).
      const v = await approve(SITE_A, viewer, "k-viewer");
      check("viewer approve → 403 AUTHZ_FORBIDDEN", v.statusCode === 403 && v.json().code === "AUTHZ_FORBIDDEN", v.body);

      // 2) approver 승인 → 200 + approval_status.
      const a = await approve(SITE_A, approver, "k-approve-a", { reason: "감사 승인" });
      check("approver approve → 200 approved", a.statusCode === 200 && a.json().approval_status === "approved", a.body);
      check("after approve GET → approved", (await getSite(SITE_A, approver)).json().approval_status === "approved");

      // 3) DB: approved=true + 감사행 1.
      await withTenantTx(pool, TENANT_A, async (c) => {
        const s = await c.query<{ approved: boolean; approved_by: string }>(
          `SELECT approved, approved_by::text AS approved_by FROM site_profiles WHERE id=$1::uuid`,
          [SITE_A],
        );
        check("site_profiles.approved=true + approved_by=approver", s.rows[0]?.approved === true && s.rows[0]?.approved_by === APPROVER_SUB, JSON.stringify(s.rows[0]));
        const audit = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM site_profile_approvals WHERE site_profile_id=$1::uuid`, [SITE_A]);
        check("site_profile_approvals 감사행 1", audit.rows[0]?.n === "1", JSON.stringify(audit.rows[0]));
      });

      // 4) 멱등 재생(같은 키) → 200, 감사행 추가 없음.
      const replay = await approve(SITE_A, approver, "k-approve-a", { reason: "감사 승인" });
      check("idempotent replay → 200", replay.statusCode === 200 && replay.json().approval_status === "approved", replay.body);
      await withTenantTx(pool, TENANT_A, async (c) => {
        const audit = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM site_profile_approvals WHERE site_profile_id=$1::uuid`, [SITE_A]);
        check("replay → 감사행 여전히 1(중복 없음)", audit.rows[0]?.n === "1", JSON.stringify(audit.rows[0]));
      });

      // 5) 미존재 → 404.
      const nf = await approve(ABSENT, approver, "k-nf");
      check("absent site → 404 RESOURCE_NOT_FOUND", nf.statusCode === 404 && nf.json().code === "RESOURCE_NOT_FOUND", nf.body);

      // 6) cross-tenant(approver A가 B 사이트) → 404(RLS 비노출).
      const cross = await approve(SITE_B, approver, "k-cross");
      check("cross-tenant site → 404", cross.statusCode === 404, cross.body);

      // 7) Idempotency-Key 누락 → 422.
      const noKey = await approve(SITE_A, approver, undefined);
      check("missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().details?.reason === "missing_idempotency_key", noKey.body);

      // 8) malformed body(reason 비문자열) → 422(키 소모 이전).
      const badBody = await approve(SITE_A, approver, "k-bad", { reason: 123 });
      check("reason non-string → 422", badBody.statusCode === 422 && badBody.json().details?.reason === "reason_must_be_string", badBody.body);
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
  console.log("\nPASS: site approve integration green");
}

main().catch((err) => {
  console.error("FAIL: sites integration threw:", err);
  process.exit(1);
});
