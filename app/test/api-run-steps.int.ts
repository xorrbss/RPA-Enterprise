/**
 * 통합 — GET /v1/runs/{run_id}/steps (api-surface §1, run_steps 단계 트레이스). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-steps.int.ts
 * 검증: 시간 오름차순·비민감 요약(node/action/status/cache/duration/artifact_ids/exception{class,code})·stagehand 요약·
 *       **민감 본문 미노출**(output_ref/input_redacted_ref/exception.message/evidenceRefs/page_state)·커서 페이지·
 *       RLS 격리(cross-tenant 빈 트레이스)·run.read RBAC·404(malformed run_id).
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
const SCHEMA = "rpa_run_steps_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCEN_A = "70000000-0000-0000-0000-0000000000a3";
const SVER_A = "70000000-0000-0000-0000-0000000000a4";
const SCEN_B = "70000000-0000-0000-0000-0000000000b3";
const SVER_B = "70000000-0000-0000-0000-0000000000b4";
const RUN_A = "71000000-0000-0000-0000-0000000000a1";
const RUN_B = "71000000-0000-0000-0000-0000000000b1";
const ART_1 = "72000000-0000-0000-0000-000000000001";

const SECRET = new TextEncoder().encode("run-steps-int-secret-do-not-use-in-prod-0123456789");
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

async function seedScenarioRun(pool: Pool, tenant: string, scen: string, sver: string, run: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'steps')`, [scen, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scen],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
       VALUES ($1,$2,$3,'running',$1,1,'2026-06-15T00:00:00Z','2026-06-15T00:00:00Z')`,
      [run, tenant, sver],
    );
  });
}

interface StepSeed {
  stepId: string; nodeId: string; action: string; status: string;
  cacheMode?: string; artifacts?: string[]; exception?: unknown; pageStateBefore?: string;
  durationMs?: number; createdAt: string;
}
async function seedStep(pool: Pool, tenant: string, run: string, s: StepSeed): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO run_steps (id, run_id, tenant_id, step_id, node_id, attempt, action, status, cache_mode,
                              artifacts, exception, page_state_before, started_at, ended_at, duration_ms, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,0,$5,$6,$7,$8,$9::jsonb,$10,$11::timestamptz,$11::timestamptz,$12,$11::timestamptz)`,
      [run, tenant, s.stepId, s.nodeId, s.action, s.status, s.cacheMode ?? "bypass", s.artifacts ?? [],
       s.exception !== undefined ? JSON.stringify(s.exception) : null, s.pageStateBefore ?? null, s.createdAt, s.durationMs ?? null],
    ),
  );
}
async function seedStagehand(pool: Pool, tenant: string, run: string, stepId: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO stagehand_calls (id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model,
                                    transport, stream_status, ttfb_ms, input_tokens, output_tokens, cost, output_ref, input_redacted_ref)
       VALUES (gen_random_uuid(), $1,$2,$3,0,$4,'rh','gpt-4o-mini','sse','done',120,500,200,0.001234,'obj://SECRET-OUTPUT','obj://SECRET-INPUT')`,
      [tenant, run, stepId, `${run}:${stepId}:0`],
    ),
  );
}

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

    await seedScenarioRun(pool, TENANT_A, SCEN_A, SVER_A, RUN_A);
    await seedStep(pool, TENANT_A, RUN_A, { stepId: "s1", nodeId: "n1", action: "navigate", status: "success", pageStateBefore: "obj://SECRET-PAGESTATE", durationMs: 800, createdAt: "2026-06-15T00:00:01Z" });
    await seedStep(pool, TENANT_A, RUN_A, { stepId: "s2", nodeId: "n2", action: "extract", status: "success", cacheMode: "hit", artifacts: [ART_1], durationMs: 1200, createdAt: "2026-06-15T00:00:02Z" });
    await seedStep(pool, TENANT_A, RUN_A, { stepId: "s3", nodeId: "n3", action: "act", status: "failed_system",
      exception: { class: "system", code: "BROWSER_CRASH", message: "SECRET-EXCEPTION-MESSAGE", evidenceRefs: ["obj://SECRET-EVIDENCE"] }, durationMs: 50, createdAt: "2026-06-15T00:00:03Z" });
    await seedStagehand(pool, TENANT_A, RUN_A, "s2");
    // cross-tenant: tenant B run + step (A에게 비가시여야)
    await seedScenarioRun(pool, TENANT_B, SCEN_B, SVER_B, RUN_B);
    await seedStep(pool, TENANT_B, RUN_B, { stepId: "sb", nodeId: "nb", action: "observe", status: "success", createdAt: "2026-06-15T00:00:01Z" });
    console.log("seeded: tenant A run(3 steps + 1 stagehand) · tenant B run(1 step)");

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
      const viewer = await mint({ sub: "v1", tenant_id: TENANT_A, roles: ["viewer"] });
      const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

      // 1) viewer 트레이스 조회 → 200, 시간 오름차순(s1→s2→s3)
      const res = await get(`/v1/runs/${RUN_A}/steps`, viewer);
      check("viewer GET steps → 200", res.statusCode === 200, res.body);
      const items = res.json().items as Array<Record<string, unknown>>;
      check("3 steps 시간 오름차순", items.length === 3 && items[0]!.node_id === "n1" && items[1]!.node_id === "n2" && items[2]!.node_id === "n3", JSON.stringify(items.map((i) => i.node_id)));

      // 2) 비민감 요약 필드
      check("s1: action/status/duration", items[0]!.action === "navigate" && items[0]!.status === "success" && items[0]!.duration_ms === 800);
      check("s2: cache_mode=hit + artifact_ids 노출(본문 아님)", items[1]!.cache_mode === "hit" && Array.isArray(items[1]!.artifact_ids) && (items[1]!.artifact_ids as string[]).includes(ART_1));
      check("s3: exception {class,code}만(message/evidenceRefs 미노출)", JSON.stringify(items[2]!.exception) === JSON.stringify({ class: "system", code: "BROWSER_CRASH" }));
      check("s2: stagehand 요약(model/tokens/cost)", Array.isArray(items[1]!.stagehand_calls) && (items[1]!.stagehand_calls as Array<Record<string, unknown>>)[0]?.model === "gpt-4o-mini" && (items[1]!.stagehand_calls as Array<Record<string, unknown>>)[0]?.output_tokens === 200);

      // 3) **민감 본문/평문 미노출** — 응답 직렬화에 시크릿 마커 0건
      const body = res.body;
      for (const secret of ["SECRET-OUTPUT", "SECRET-INPUT", "SECRET-EXCEPTION-MESSAGE", "SECRET-EVIDENCE", "SECRET-PAGESTATE", "output_ref", "input_redacted_ref", "page_state"]) {
        check(`민감 미노출: '${secret}' 응답에 없음`, !body.includes(secret), secret);
      }

      // 4) 커서 페이지네이션(limit=2 → 2 + next_cursor → 다음 1)
      const p1 = await get(`/v1/runs/${RUN_A}/steps?limit=2`, viewer);
      const p1items = p1.json().items as unknown[];
      const next = p1.json().next_cursor as string | null;
      check("limit=2 → 2 items + next_cursor", p1items.length === 2 && typeof next === "string");
      const p2 = await get(`/v1/runs/${RUN_A}/steps?limit=2&cursor=${encodeURIComponent(next ?? "")}`, viewer);
      const p2items = p2.json().items as Array<Record<string, unknown>>;
      check("page2 → 마지막 1 step(n3)", p2items.length === 1 && p2items[0]!.node_id === "n3", JSON.stringify(p2items.map((i) => i.node_id)));

      // 5) cross-tenant: A가 B의 run 트레이스 → 빈 items(RLS, 존재 비노출)
      const cross = await get(`/v1/runs/${RUN_B}/steps`, viewer);
      check("cross-tenant run steps → 200 empty(RLS)", cross.statusCode === 200 && (cross.json().items as unknown[]).length === 0, cross.body);

      // 6) malformed run_id → 404
      const mal = await get(`/v1/runs/not-a-uuid/steps`, viewer);
      check("malformed run_id → 404 RESOURCE_NOT_FOUND", mal.statusCode === 404 && mal.json().code === "RESOURCE_NOT_FOUND", mal.body);
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
  console.log("\nPASS: GET /v1/runs/{id}/steps integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
