/**
 * D4.5 통합 테스트 — DLQ replay(api-surface §4) POST /v1/dlq/{id}/replay = W10(workitem abandoned→new).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-dlq.int.ts
 *
 * 검증: W10 복원(attempts 리셋·DLQ 마킹), 상태별 거부(미존재/비복원/non-abandoned), 멱등, 인가/RLS.
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
const SCHEMA = "rpa_dlq_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const ABSENT = "60000000-0000-0000-0000-0000000000ff";

// workitem + dead_letter 쌍(상태별).
const WI_ABANDONED = "61000000-0000-0000-0000-000000000001";
const WI_NEW = "61000000-0000-0000-0000-000000000002";
const WI_IDEM = "61000000-0000-0000-0000-000000000003";
const WI_VIEWER = "61000000-0000-0000-0000-000000000004";
const WI_B = "62000000-0000-0000-0000-000000000001";
const DL_OK = "63000000-0000-0000-0000-000000000001";
const DL_NOTREPLAYABLE = "63000000-0000-0000-0000-000000000002";
const DL_NOWORKITEM = "63000000-0000-0000-0000-000000000003";
const DL_NOTABANDONED = "63000000-0000-0000-0000-000000000004";
const DL_IDEM = "63000000-0000-0000-0000-000000000005";
const DL_VIEWER = "63000000-0000-0000-0000-000000000006";
const DL_B = "64000000-0000-0000-0000-000000000001";

const SECRET = new TextEncoder().encode("d45-dlq-int-secret-do-not-use-in-prod-0123456789");
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

async function seedWorkitem(pool: Pool, tenant: string, id: string, ref: string, status: string, attempts: number): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
       VALUES ($1,$2,'d45dlq',$3,$4,$5)`,
      [id, tenant, ref, status, attempts],
    ),
  );
}

async function seedDeadLetter(
  pool: Pool,
  tenant: string,
  id: string,
  workitemId: string | null,
  replayable: boolean,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable)
       VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',$4)`,
      [id, tenant, workitemId, replayable],
    ),
  );
}

async function workitem(pool: Pool, tenant: string, id: string): Promise<{ status: string; attempts: number } | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM workitems WHERE id=$1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  });
}

async function replayedAt(pool: Pool, tenant: string, id: string): Promise<boolean> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ done: boolean }>(`SELECT replayed_at IS NOT NULL AS done FROM dead_letter WHERE id=$1::uuid`, [id]);
    return r.rows[0]?.done ?? false;
  });
}

async function idemRowCount(pool: Pool, tenant: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM control_plane_idempotency_keys WHERE endpoint='replayDeadLetter' AND idempotency_key=$1`,
      [key],
    );
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

    await seedWorkitem(pool, TENANT_A, WI_ABANDONED, "wi-abandoned", "abandoned", 5);
    await seedWorkitem(pool, TENANT_A, WI_NEW, "wi-new", "new", 0);
    await seedWorkitem(pool, TENANT_A, WI_IDEM, "wi-idem", "abandoned", 3);
    await seedWorkitem(pool, TENANT_A, WI_VIEWER, "wi-viewer", "abandoned", 2);
    await seedWorkitem(pool, TENANT_B, WI_B, "wi-b", "abandoned", 1);
    await seedDeadLetter(pool, TENANT_A, DL_OK, WI_ABANDONED, true);
    await seedDeadLetter(pool, TENANT_A, DL_NOTREPLAYABLE, WI_VIEWER, false);
    await seedDeadLetter(pool, TENANT_A, DL_NOWORKITEM, null, true);
    await seedDeadLetter(pool, TENANT_A, DL_NOTABANDONED, WI_NEW, true);
    await seedDeadLetter(pool, TENANT_A, DL_IDEM, WI_IDEM, true);
    await seedDeadLetter(pool, TENANT_A, DL_VIEWER, WI_VIEWER, true);
    await seedDeadLetter(pool, TENANT_B, DL_B, WI_B, true);
    console.log("seeded workitems + dead letters");

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
      const op = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });

      const replay = (id: string, key: string, token = op) =>
        app.inject({
          method: "POST",
          url: `/v1/dlq/${id}/replay`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        });

      // 1) abandoned + replay → 202 new; attempts 리셋; dead_letter.replayed_at 마킹(W10).
      const r1 = await replay(DL_OK, "dlq-ok");
      check("replay abandoned → 202", r1.statusCode === 202, r1.body);
      check("replay → status new", r1.json().status === "new", r1.body);
      const wi1 = await workitem(pool, TENANT_A, WI_ABANDONED);
      check("workitem → new + attempts reset", wi1?.status === "new" && wi1?.attempts === 0, JSON.stringify(wi1));
      check("dead_letter marked replayed_at", (await replayedAt(pool, TENANT_A, DL_OK)) === true);

      // 2) 같은 dead_letter 재replay(다른 키): workitem은 이미 new → 409 WORKITEM_CHECKOUT_CONFLICT.
      const r2 = await replay(DL_OK, "dlq-ok-again");
      check("replay already-restored → 409", r2.statusCode === 409, r2.body);
      check("already-restored → WORKITEM_CHECKOUT_CONFLICT", r2.json().code === "WORKITEM_CHECKOUT_CONFLICT", r2.body);

      // 3) 미존재 dead_letter → 404.
      const r3 = await replay(ABSENT, "dlq-absent");
      check("absent dead_letter → 404 RESOURCE_NOT_FOUND", r3.statusCode === 404 && r3.json().code === "RESOURCE_NOT_FOUND", r3.body);

      // 4) replayable=false → 422 not_replayable.
      const r4 = await replay(DL_NOTREPLAYABLE, "dlq-notreplayable");
      check("not replayable → 422", r4.statusCode === 422, r4.body);
      check("not replayable → not_replayable", r4.json().details?.reason === "not_replayable", r4.body);

      // 5) workitem 미연결(sink/none) → 422 not_replayable.
      const r5 = await replay(DL_NOWORKITEM, "dlq-noworkitem");
      check("no workitem → 422 not_replayable", r5.statusCode === 422 && r5.json().details?.reason === "not_replayable", r5.body);

      // 6) workitem이 abandoned가 아님 → 409 WORKITEM_CHECKOUT_CONFLICT.
      const r6 = await replay(DL_NOTABANDONED, "dlq-notabandoned");
      check("workitem not abandoned → 409", r6.statusCode === 409 && r6.json().details?.reason === "workitem_not_abandoned", r6.body);

      // 7) cross-tenant → 404(RLS).
      const r7 = await replay(DL_B, "dlq-cross");
      check("cross-tenant → 404", r7.statusCode === 404 && r7.json().code === "RESOURCE_NOT_FOUND", r7.body);
      check("tenant B workitem untouched", (await workitem(pool, TENANT_B, WI_B))?.status === "abandoned");

      // 8) RBAC viewer → 403(키 미소모).
      const r8 = await replay(DL_VIEWER, "dlq-viewer", viewer);
      check("viewer replay → 403 AUTHZ_FORBIDDEN", r8.statusCode === 403 && r8.json().code === "AUTHZ_FORBIDDEN", r8.body);
      check("viewer deny key unused", (await idemRowCount(pool, TENANT_A, "dlq-viewer")) === 0);
      check("viewer workitem unchanged", (await workitem(pool, TENANT_A, WI_VIEWER))?.status === "abandoned");

      // 9) 멱등 재생: 동일 키 재요청 → 최초 202 재생(중복 W10 없음).
      const i1 = await replay(DL_IDEM, "dlq-idem");
      check("idem first → 202 new", i1.statusCode === 202 && i1.json().status === "new", i1.body);
      const i2 = await replay(DL_IDEM, "dlq-idem");
      check("idem replay → 202 new (same)", i2.statusCode === 202 && i2.json().status === "new", i2.body);
      check("idem workitem attempts reset once", (await workitem(pool, TENANT_A, WI_IDEM))?.attempts === 0);

      // 10) Idempotency-Key 누락 → 422.
      const noKey = await app.inject({ method: "POST", url: `/v1/dlq/${DL_OK}/replay`, headers: { authorization: `Bearer ${op}` } });
      check("missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);
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
  console.log("\nPASS: D4.5 dlq replay integration green");
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
