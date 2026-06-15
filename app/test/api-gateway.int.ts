/**
 * A2 통합 테스트 — PUT /v1/gateway/policy(api-surface §6, release-decisions D8-A2)를 실 PostgreSQL로 검증.
 *
 * 실행: temp PG15 게이트 위에서 test:int 체인 (node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:api-gateway).
 * 검증: admin If-Match version CAS(성공→version+1+ETag), 멱등 replay(재-bump 없음), stale If-Match→412,
 *   If-Match 누락→412, Idempotency-Key 누락→422, 토큰 coherence 위반→422(LLM_CAPABILITY_MISMATCH),
 *   비-admin→403, cross-tenant 미존재→412.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { createPool, withTenantTx } from "../src/db/pool";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_gateway_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SECRET = new TextEncoder().encode("a2-int-test-secret-do-not-use-in-prod-0123456789");

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

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://test/registry" as never, commands: [] } };
  },
};

const CAPS = { domReasoning: true, vision: false, jsonMode: true, toolCall: false, sse: true, maxContextTokens: 8000 };
const BUDGET = { maxInputTokens: 1000, maxOutputTokens: 1000, maxCost: 10 };

async function seedPolicy(pool: ReturnType<typeof createPool>, tenantId: string, model: string): Promise<void> {
  await withTenantTx(pool, tenantId, async (c) => {
    await c.query(
      `INSERT INTO gateway_policies (id, tenant_id, model, version, capabilities, budget)
       VALUES ($1::uuid, $2::uuid, $3, 1, $4::jsonb, $5::jsonb)`,
      [randomUUID(), tenantId, model, JSON.stringify(CAPS), JSON.stringify(BUDGET)],
    );
  });
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "codex", capabilities: CAPS, budget: BUDGET, ...over };
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    await seedPolicy(pool, TENANT_A, "codex");

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      // JWT sub은 PrincipalId(uuid) — updated_by=$::uuid 규약(sites.ts approve와 동일).
      const admin = await mint({ sub: "11111111-0000-0000-0000-000000000a01", tenant_id: TENANT_A, roles: ["admin"] });
      const operator = await mint({ sub: "11111111-0000-0000-0000-000000000a02", tenant_id: TENANT_A, roles: ["operator"] });
      const adminB = await mint({ sub: "11111111-0000-0000-0000-000000000b01", tenant_id: TENANT_B, roles: ["admin"] });

      const put = (token: string, headers: Record<string, string>, payload: Record<string, unknown>) =>
        app.inject({ method: "PUT", url: "/v1/gateway/policy", headers: { authorization: `Bearer ${token}`, ...headers }, payload });

      // 성공: admin If-Match:1 → 200, version 2, ETag 2.
      const ok = await put(admin, { "if-match": "1", "idempotency-key": "gw-a" }, body());
      check("admin PUT If-Match:1 → 200 version 2", ok.statusCode === 200 && ok.json().version === 2, `${ok.statusCode} ${ok.body}`);
      check("ETag header = 2", ok.headers.etag === "2");

      // 멱등 replay: 동일 키 재제출 → 부작용 재실행 없이 최초 응답(version 2, 재-bump 없음).
      const replay = await put(admin, { "if-match": "1", "idempotency-key": "gw-a" }, body());
      check("replay same key → version 2 (no re-bump)", replay.statusCode === 200 && replay.json().version === 2, `${replay.statusCode} ${replay.body}`);

      // stale If-Match:1 (이미 2) + 새 키 → 412.
      const stale = await put(admin, { "if-match": "1", "idempotency-key": "gw-stale" }, body());
      check("stale If-Match:1 → 412 POLICY_VERSION_CONFLICT", stale.statusCode === 412 && stale.json().code === "POLICY_VERSION_CONFLICT", `${stale.statusCode} ${stale.body}`);

      // If-Match 누락 → 412 (멱등 키 소모 이전).
      const noMatch = await put(admin, { "idempotency-key": "gw-nomatch" }, body());
      check("missing If-Match → 412", noMatch.statusCode === 412 && noMatch.json().code === "POLICY_VERSION_CONFLICT", `${noMatch.statusCode} ${noMatch.body}`);

      // Idempotency-Key 누락 → 422.
      const noIdem = await put(admin, { "if-match": "2" }, body());
      check("missing Idempotency-Key → 422", noIdem.statusCode === 422 && noIdem.json().code === "IR_SCHEMA_INVALID", `${noIdem.statusCode} ${noIdem.body}`);

      // 토큰 coherence 위반(budget.maxInputTokens > maxContextTokens) → 422 LLM_CAPABILITY_MISMATCH.
      const incoherent = await put(admin, { "if-match": "2", "idempotency-key": "gw-incoherent" }, body({ budget: { maxInputTokens: 99999, maxOutputTokens: 1, maxCost: 1 } }));
      check("budget > maxContextTokens → 422 LLM_CAPABILITY_MISMATCH", incoherent.statusCode === 422 && incoherent.json().code === "LLM_CAPABILITY_MISMATCH", `${incoherent.statusCode} ${incoherent.body}`);

      // 비-admin(operator)은 gateway_policy.edit 미보유 → 403.
      const forbidden = await put(operator, { "if-match": "2", "idempotency-key": "gw-forbidden" }, body());
      check("operator PUT → 403 AUTHZ_FORBIDDEN", forbidden.statusCode === 403 && forbidden.json().code === "AUTHZ_FORBIDDEN", `${forbidden.statusCode} ${forbidden.body}`);

      // cross-tenant: tenant B admin이 codex 갱신 시도 → RLS로 미존재 → 412.
      const cross = await put(adminB, { "if-match": "2", "idempotency-key": "gw-cross" }, body());
      check("cross-tenant PUT → 412 (policy absent under tenant B)", cross.statusCode === 412 && cross.json().code === "POLICY_VERSION_CONFLICT", `${cross.statusCode} ${cross.body}`);

      // tenant A 정책은 cross-tenant 시도로 변하지 않았다(version 여전히 2).
      const after = await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ version: number }>(`SELECT version FROM gateway_policies WHERE model='codex'`);
        return r.rows[0]?.version ?? null;
      });
      check("tenant A policy untouched by cross-tenant attempt (version 2)", after === 2, `version=${after}`);
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
  console.log("\nPASS: A2 gateway policy PUT integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("integration fatal:", e);
  process.exit(1);
});
