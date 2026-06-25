/**
 * 통합 — DG-3 전용 워커 풀: /v1/worker-pools 관리 API + enqueue 의 pool:<key> flag 부착. 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-worker-pools.int.ts
 *
 * 검증: admin 풀 생성/배정/해제/삭제, operator→403(worker_pool.manage admin 전용), pool_key 형식 거부,
 *   **enqueueRunClaim 이 테넌트 배정에 따라 Graphile job 에 pool:<key> flag 부착**(배정→pool:pa, 미배정→pool:default),
 *   배정 중 풀 삭제→409(FK), 미존재 풀 배정→404, RLS cross-tenant 배정 격리.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";
import { runMigrations } from "graphile-worker";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import { PgGraphileRunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { RUNTIME_JOB_TASK } from "../src/worker/graphile-runner";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_worker_pools_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";

const SECRET = new TextEncoder().encode("worker-pools-int-secret-do-not-use-in-prod-0123456789");
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

function connectionString(): string {
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "postgres";
  const db = process.env.PGDATABASE ?? "postgres";
  const pw = process.env.PGPASSWORD;
  const auth = pw !== undefined && pw !== "" ? `${encodeURIComponent(user)}:${encodeURIComponent(pw)}` : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${port}/${db}`;
}

type Pool = ReturnType<typeof createPool>;

async function jobFlagsForRun(pool: Pool, runId: string): Promise<Record<string, boolean> | null> {
  const row = await pool.query<{ flags: Record<string, boolean> | null }>(
    `SELECT j.flags
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = $1 AND j.payload->>'runId' = $2`,
    [RUNTIME_JOB_TASK, runId],
  );
  return row.rows[0]?.flags ?? null;
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: new PgGraphileRunEnqueuer(),
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
    await runMigrations({ connectionString: connectionString() });
    await app.ready();

    const admin = await mint(["admin"]);
    const operator = await mint(["operator"], TENANT_A, "operator-a");
    const adminB = await mint(["admin"], TENANT_B, "admin-b");
    const realEnqueuer = new PgGraphileRunEnqueuer();

    const post = (token: string, key: string | undefined, body: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/v1/worker-pools", headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) }, payload: body });
    const put = (token: string, key: string, body: Record<string, unknown>) =>
      app.inject({ method: "PUT", url: "/v1/worker-pool", headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, payload: body });
    const unassign = (token: string, key: string) =>
      app.inject({ method: "DELETE", url: "/v1/worker-pool", headers: { authorization: `Bearer ${token}`, "idempotency-key": key } });
    const deletePool = (token: string, poolKey: string, key: string) =>
      app.inject({ method: "DELETE", url: `/v1/worker-pools/${poolKey}`, headers: { authorization: `Bearer ${token}`, "idempotency-key": key } });
    const getPools = (token: string) =>
      app.inject({ method: "GET", url: "/v1/worker-pools", headers: { authorization: `Bearer ${token}` } });

    // 1) RBAC + 형식: operator→403, 잘못된 pool_key→422, admin 생성→200
    const opDeny = await post(operator, "k-op", { pool_key: "pa" });
    check("operator create pool → 403 (admin 전용)", opDeny.statusCode === 403 && opDeny.json().code === "AUTHZ_FORBIDDEN", opDeny.body);
    for (const [bad, label] of [["default", "예약어 default"], ["BadCaps", "대문자"], ["bad key", "공백"]] as const) {
      const r = await post(admin, `k-bad-${bad}`, { pool_key: bad });
      check(`pool_key '${bad}'(${label}) → 422`, r.statusCode === 422 && r.json().details?.reason === "invalid_pool_key", r.body);
    }
    const okCreate = await post(admin, "k-pa", { pool_key: "pa", description: "민감 테넌트 전용" });
    check("admin create pool 'pa' → 200", okCreate.statusCode === 200 && okCreate.json().pool_key === "pa", okCreate.body);

    // 2) GET: 풀 목록 + 미배정
    const list1 = await getPools(admin);
    check("GET: 'pa' 목록 + assigned null", list1.statusCode === 200 && (list1.json().items as Array<{ pool_key: string }>).some((p) => p.pool_key === "pa") && list1.json().assigned_pool_key === null, list1.body);

    // 3) 미배정 테넌트 enqueue → pool:default flag
    await withTenantTx(pool, TENANT_A, async (client) => {
      await realEnqueuer.enqueueRunClaim(client, { tenantId: TENANT_A, runId: "aa000000-0000-4000-8000-000000000001", correlationId: "aa000000-0000-4000-8000-0000000000c1" });
    });
    const defFlags = await jobFlagsForRun(pool, "aa000000-0000-4000-8000-000000000001");
    check("미배정 enqueue → flag pool:default", defFlags !== null && defFlags["pool:default"] === true, JSON.stringify(defFlags));

    // 4) 배정 후 enqueue → pool:pa flag
    const assign = await put(admin, "k-assign", { pool_key: "pa" });
    check("admin assign A→'pa' → 200", assign.statusCode === 200 && assign.json().assigned_pool_key === "pa", assign.body);
    const list2 = await getPools(admin);
    check("GET: assigned_pool_key 'pa'", list2.json().assigned_pool_key === "pa", list2.body);
    await withTenantTx(pool, TENANT_A, async (client) => {
      await realEnqueuer.enqueueRunClaim(client, { tenantId: TENANT_A, runId: "aa000000-0000-4000-8000-000000000002", correlationId: "aa000000-0000-4000-8000-0000000000c2" });
    });
    const paFlags = await jobFlagsForRun(pool, "aa000000-0000-4000-8000-000000000002");
    check("배정 후 enqueue → flag pool:pa", paFlags !== null && paFlags["pool:pa"] === true && paFlags["pool:default"] === undefined, JSON.stringify(paFlags));

    // 5) 미존재 풀 배정 → 404(FK)
    const ghost = await put(admin, "k-ghost", { pool_key: "ghost" });
    check("미존재 풀 배정 → 404", ghost.statusCode === 404, ghost.body);

    // 6) 배정 중 풀 삭제 → 409(FK pool_in_use); 해제 후 삭제 → 200
    const delBusy = await deletePool(admin, "pa", "k-del-busy");
    check("배정 중 풀 삭제 → 409 pool_in_use", delBusy.statusCode === 409 && delBusy.json().code === "WORKITEM_CHECKOUT_CONFLICT", delBusy.body);
    const un = await unassign(admin, "k-unassign");
    check("배정 해제 → 200 null", un.statusCode === 200 && un.json().assigned_pool_key === null, un.body);
    const delOk = await deletePool(admin, "pa", "k-del-ok");
    check("해제 후 풀 삭제 → 200", delOk.statusCode === 200 && delOk.json().deleted === true, delOk.body);
    const delGhost = await deletePool(admin, "pa", "k-del-ghost");
    check("이미 삭제된 풀 삭제 → 404", delGhost.statusCode === 404, delGhost.body);

    // 7) RLS cross-tenant: B 배정은 A 와 독립. (pb 생성 후 B 배정 → A GET 은 여전히 영향 없음)
    await post(admin, "k-pb", { pool_key: "pb" });
    const assignB = await put(adminB, "k-assign-b", { pool_key: "pb" });
    check("tenant B assign → 200", assignB.statusCode === 200, assignB.body);
    const listA = await getPools(admin);
    const listB = await getPools(adminB);
    check("RLS: A assigned null(미배정), B assigned pb", listA.json().assigned_pool_key === null && listB.json().assigned_pool_key === "pb", `${listA.body} | ${listB.body}`);
  } finally {
    // 공유 graphile_worker 큐 정리: CI test:int 는 모든 통합 테스트가 한 DB 를 공유하고 graphile_worker 스키마는
    // 전역이라(앱 테이블은 per-test SCHEMA), 이 테스트가 flag 검증용으로 enqueue 한 run_claim job 을 남기면
    // 뒤따르는 queue-depth-gauge.int.ts(빈 큐 전제)를 오염시킨다. enqueue 한 job 을 제거해 큐를 원상복구한다.
    await pool.query(`DELETE FROM graphile_worker._private_jobs`).catch(() => undefined);
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} worker-pool API check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: /v1/worker-pools + enqueue pool flag integration green");
}

main().catch((err) => {
  console.error("int fatal:", err);
  process.exit(1);
});
