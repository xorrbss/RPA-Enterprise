/**
 * 통합 테스트 — Principal 디렉터리(name-picker, api-surface §3 `GET /v1/principals` + JWT name upsert). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-principals.int.ts
 *
 * 검증: 커서 페이지(created_at,id DESC keyset)·RLS 테넌트 격리·principal.read RBAC(viewer+/미보유 403/미인증 401)·
 *   JWT `name` 클레임 best-effort upsert(source='jwt', name 부재→미동기화)·기존 행 갱신 시 source 보존·멱등.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { PgPrincipalDirectory } from "../src/api/principal-directory";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_principals_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";

const SECRET = new TextEncoder().encode("principals-int-secret-do-not-use-in-prod-0123456789");
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

function ts(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

async function seedPrincipal(
  pool: Pool,
  tenant: string,
  id: string,
  sub: string,
  name: string,
  email: string | null,
  source: string,
  createdAt: string,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO principals (id, tenant_id, sub, display_name, email, source, created_at)
       VALUES ($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::timestamptz)`,
      [id, tenant, sub, name, email, source, createdAt],
    ),
  );
}

interface PrincipalDbRow {
  sub: string;
  display_name: string;
  email: string | null;
  source: string;
}

async function principalBySub(pool: Pool, tenant: string, sub: string): Promise<PrincipalDbRow | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<PrincipalDbRow>(
      `SELECT sub, display_name, email, source FROM principals WHERE sub = $1::text`,
      [sub],
    );
    return r.rows[0] ?? null;
  });
}

async function countPrincipals(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM principals`);
    return r.rows[0]?.n ?? 0;
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
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    // tenant A: 수동 등록 3건(created_at 오름차 0..2). tenant B: 1건(격리 확인용).
    await seedPrincipal(pool, TENANT_A, "a1000000-0000-0000-0000-000000000001", "auth0|alice", "앨리스", "alice@ex.com", "manual", ts(0));
    await seedPrincipal(pool, TENANT_A, "a1000000-0000-0000-0000-000000000002", "auth0|bob", "밥", null, "manual", ts(1));
    await seedPrincipal(pool, TENANT_A, "a1000000-0000-0000-0000-000000000003", "auth0|carol", "캐롤", "carol@ex.com", "manual", ts(2));
    await seedPrincipal(pool, TENANT_B, "b1000000-0000-0000-0000-000000000001", "auth0|dave", "데이브", null, "manual", ts(0));

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      principalDirectory: new PgPrincipalDirectory(pool),
      signedCommandRegistry,
    });
    await app.ready();
    try {
      // 토큰: name 클레임 없는 운영/뷰어(upsert no-op)와 name 클레임 보유(upsert) 분리.
      const operatorNoName = await mint({ sub: "svc|operator", tenant_id: TENANT_A, roles: ["operator"] });
      const viewerNoName = await mint({ sub: "svc|viewer", tenant_id: TENANT_A, roles: ["viewer"] });
      const noRole = await mint({ sub: "svc|norole", tenant_id: TENANT_A, roles: [] });
      const operatorB = await mint({ sub: "svc|opB", tenant_id: TENANT_B, roles: ["operator"] });

      const get = (url: string, token = operatorNoName) =>
        app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

      // ===== 목록(GET /v1/principals) =====
      // 1) 전체: tenant A 수동 3건만(name 없는 operator 토큰이라 upsert no-op). created_at DESC.
      const all = await get("/v1/principals");
      check("listPrincipals → 200", all.statusCode === 200, all.body);
      const allBody = all.json();
      check("listPrincipals returns 3 items (RLS A only)", allBody.items?.length === 3, JSON.stringify(allBody.items?.length));
      check(
        "listPrincipals DESC by created_at",
        allBody.items[0].sub === "auth0|carol" && allBody.items[2].sub === "auth0|alice",
        JSON.stringify(allBody.items.map((p: { sub: string }) => p.sub)),
      );
      const carol = allBody.items[0];
      check(
        "item shape (principal_id/sub/display_name/email/source)",
        typeof carol.principal_id === "string" &&
          carol.sub === "auth0|carol" &&
          carol.display_name === "캐롤" &&
          carol.email === "carol@ex.com" &&
          carol.source === "manual",
        JSON.stringify(carol),
      );
      check("null email round-trip", allBody.items[1].sub === "auth0|bob" && allBody.items[1].email === null, JSON.stringify(allBody.items[1]));

      // 2) 커서 페이지: limit=2 → 2건 + next_cursor, 다음 페이지 1건.
      const page1 = await get("/v1/principals?limit=2");
      const p1 = page1.json();
      check("page limit=2 → 2 items + cursor", p1.items.length === 2 && typeof p1.next_cursor === "string", JSON.stringify(p1));
      const page2 = await get(`/v1/principals?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`);
      const p2 = page2.json();
      check("page 2 → remaining 1 item, cursor null", p2.items.length === 1 && p2.next_cursor === null && p2.items[0].sub === "auth0|alice", JSON.stringify(p2));
      const badCursor = await get("/v1/principals?cursor=not-base64url-json");
      check("invalid cursor → 422", badCursor.statusCode === 422 && badCursor.json().details?.reason === "invalid_cursor", badCursor.body);

      // ===== RBAC(principal.read = viewer+) =====
      const asViewer = await get("/v1/principals", viewerNoName);
      check("viewer → 200 (principal.read viewer+)", asViewer.statusCode === 200, asViewer.body);
      const asNoRole = await get("/v1/principals", noRole);
      check("no-role → 403 AUTHZ_FORBIDDEN", asNoRole.statusCode === 403 && asNoRole.json().code === "AUTHZ_FORBIDDEN", asNoRole.body);
      const unauth = await app.inject({ method: "GET", url: "/v1/principals" });
      check("missing token → 401 UNAUTHENTICATED", unauth.statusCode === 401 && unauth.json().code === "UNAUTHENTICATED", unauth.body);

      // ===== cross-tenant 격리 =====
      const bView = await get("/v1/principals", operatorB);
      const bBody = bView.json();
      // operatorB(name 없음)는 upsert no-op → tenant B 수동 1건(dave)만.
      check("tenant B sees only B principals", bBody.items.length === 1 && bBody.items[0].sub === "auth0|dave", JSON.stringify(bBody.items));

      // ===== JWT name 클레임 best-effort upsert =====
      // 3) name 클레임 보유 토큰으로 인증 요청 → principals 자동 등록(source='jwt').
      const newAssignee = await mint({ sub: "auth0|erin", tenant_id: TENANT_A, roles: ["operator"], name: "에린", email: "erin@ex.com" });
      check("erin absent before first auth", (await principalBySub(pool, TENANT_A, "auth0|erin")) === null);
      await get("/v1/principals", newAssignee); // 인증 preHandler가 upsert 수행
      const erinRow = await principalBySub(pool, TENANT_A, "auth0|erin");
      check(
        "JWT name upsert → row created (source=jwt)",
        erinRow !== null && erinRow.display_name === "에린" && erinRow.email === "erin@ex.com" && erinRow.source === "jwt",
        JSON.stringify(erinRow),
      );

      // 4) name 클레임 없는 토큰 → 디렉터리 미동기화(표시이름 없는 행 금지).
      const beforeNoName = await countPrincipals(pool, TENANT_A);
      await get("/v1/principals", await mint({ sub: "auth0|frank", tenant_id: TENANT_A, roles: ["operator"] }));
      check("no name claim → not upserted", (await principalBySub(pool, TENANT_A, "auth0|frank")) === null);
      check("no-name request did not grow directory", (await countPrincipals(pool, TENANT_A)) === beforeNoName);

      // 5) 멱등: 동일 name 재요청 → 행 1개 유지(중복 생성 없음).
      await get("/v1/principals", newAssignee);
      const erinDupe = await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM principals WHERE sub='auth0|erin'`);
        return r.rows[0]?.n ?? 0;
      });
      check("upsert idempotent → single erin row", erinDupe === 1, String(erinDupe));

      // 6) 갱신: name 변경 토큰 → display_name 갱신(같은 sub).
      const erinRenamed = await mint({ sub: "auth0|erin", tenant_id: TENANT_A, roles: ["operator"], name: "에린 박", email: "erin@ex.com" });
      await get("/v1/principals", erinRenamed);
      const erinAfter = await principalBySub(pool, TENANT_A, "auth0|erin");
      check("upsert updates display_name on change", erinAfter?.display_name === "에린 박", JSON.stringify(erinAfter));

      // 7) source 보존: 수동(manual) 등록 행을 JWT upsert가 갱신해도 source는 'manual' 유지(admin 등록 비파괴).
      const aliceTokenWithName = await mint({ sub: "auth0|alice", tenant_id: TENANT_A, roles: ["operator"], name: "앨리스 김" });
      await get("/v1/principals", aliceTokenWithName);
      const aliceAfter = await principalBySub(pool, TENANT_A, "auth0|alice");
      check(
        "JWT upsert preserves manual source + updates name",
        aliceAfter?.source === "manual" && aliceAfter?.display_name === "앨리스 김",
        JSON.stringify(aliceAfter),
      );

      // 8) 방어심층: 과대 name 클레임 → 256자로 truncate 저장(적대/오설정 IdP의 응답 bloat 방지).
      const overlong = await mint({ sub: "auth0|grace", tenant_id: TENANT_A, roles: ["operator"], name: "가".repeat(500) });
      await get("/v1/principals", overlong);
      const graceRow = await principalBySub(pool, TENANT_A, "auth0|grace");
      check("overlong name truncated to 256", graceRow !== null && graceRow.display_name.length === 256, String(graceRow?.display_name.length));
    } finally {
      await app.close();
    }

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} principals integration checks failed`);
      process.exit(1);
    }
    console.log("\nPASS: principals directory (GET /v1/principals + JWT name upsert) integration green");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
