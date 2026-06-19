/**
 * 통합 — GET /v1/runs/{run_id}/artifacts (api-surface §5, run 하위 artifact 목록). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-artifacts.int.ts
 * 검증: metadata-only(artifact_id/step_id/attempt/type/redaction_status/retention_until/legal_hold/created_at)·**민감 미노출**
 *       (content/object_ref/sha256)·RLS 가시성(pending/quarantine/deleted 누락)·newest-first 커서·cross-tenant 격리·
 *       artifact.read RBAC·404(malformed run_id).
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
const SCHEMA = "rpa_run_artifacts_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCEN_A = "70000000-0000-0000-0000-0000000000a3";
const SVER_A = "70000000-0000-0000-0000-0000000000a4";
const SCEN_B = "70000000-0000-0000-0000-0000000000b3";
const SVER_B = "70000000-0000-0000-0000-0000000000b4";
const RUN_A = "71000000-0000-0000-0000-0000000000a1";
const RUN_B = "71000000-0000-0000-0000-0000000000b1";
const GEN_LINKED = "71500000-0000-0000-0000-0000000000a1";
const GEN_UNLINKED = "71500000-0000-0000-0000-0000000000a2";
const GEN_B = "71500000-0000-0000-0000-0000000000b1";
const STEP_ARTIFACT_ID = "capture_start";

const SECRET = new TextEncoder().encode("run-artifacts-int-secret-do-not-use-in-prod-0123456789");
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
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'arts')`, [scen, tenant]);
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

async function seedScenarioGeneration(pool: Pool, tenant: string, generation: string, run: string | null): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO scenario_generations
         (id, tenant_id, mode, status, prompt_hash, planner, draft_ir, evidence_policy, blockers, run_id, created_by)
       VALUES ($1::uuid,$2::uuid,'save_and_run',$3,$4,'deterministic_mvp','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,$5::uuid,'test')`,
      [generation, tenant, run === null ? "saved" : "run_queued", `hash-${generation}`, run],
    ),
  );
}

async function seedRunStep(pool: Pool, tenant: string, run: string, stepId: string, attempt: number): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO run_steps (id, tenant_id, run_id, step_id, node_id, attempt, action, status, artifacts, started_at, ended_at, duration_ms)
       VALUES ('73000000-0000-0000-0000-0000000000a1'::uuid,$1::uuid,$2::uuid,$3,$3,$4,'observe','success',
               ARRAY['72000000-0000-0000-0000-0000000000a1'], '2026-06-15T00:00:00Z', '2026-06-15T00:00:01Z', 1000)`,
      [tenant, run, stepId, attempt],
    ),
  );
}

interface ArtSeed {
  id: string; type: string; redaction: string; quarantine?: boolean; deleted?: string | null;
  sha256: string; objectRef: string; createdAt: string;
  stepId?: string | null; attempt?: number | null;
  mediaType?: string; filename?: string; byteSize?: number; durationMs?: number;
}
async function seedArtifact(pool: Pool, tenant: string, run: string, a: ArtSeed): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, step_id, attempt, type, media_type, filename, byte_size, duration_ms, redaction_status, sha256, object_ref,
                              retention_until, quarantine, deleted_at, deleted_reason, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::int,$6,$7,$8,$9::bigint,$10::int,$11,$12,$13,'2026-09-01T00:00:00Z',$14,$15::timestamptz,$16,$17::timestamptz)`,
      [a.id, tenant, run, a.stepId ?? null, a.attempt ?? null, a.type, a.mediaType ?? null, a.filename ?? null, a.byteSize ?? null, a.durationMs ?? null,
       a.redaction, a.sha256, a.objectRef, a.quarantine ?? false,
       a.deleted ?? null, a.deleted !== undefined && a.deleted !== null ? "test" : null, a.createdAt],
    ),
  );
}

async function seedGenerationPlannerArtifact(pool: Pool, tenant: string, generation: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts
         (id, tenant_id, generation_id, type, media_type, byte_size, redaction_status, sha256, object_ref,
          retention_until, created_at)
       VALUES ('71600000-0000-0000-0000-0000000000a1'::uuid,$1::uuid,$2::uuid,
               'scenario_generation_llm_output','text/plain; charset=utf-8',42,'redacted',
               'SHA-SECRET-GEN','obj://SECRET-GEN','2026-09-01T00:00:00Z','2026-06-15T00:00:06Z')`,
      [tenant, generation],
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
    await seedScenarioGeneration(pool, TENANT_A, GEN_LINKED, RUN_A);
    await seedScenarioGeneration(pool, TENANT_A, GEN_UNLINKED, null);
    await seedRunStep(pool, TENANT_A, RUN_A, STEP_ARTIFACT_ID, 2);
    // 가시 2건(redacted/not_required) + 비가시 3건(pending/quarantine/deleted)
    await seedArtifact(pool, TENANT_A, RUN_A, { id: "72000000-0000-0000-0000-0000000000a1", stepId: STEP_ARTIFACT_ID, attempt: 2, type: "screenshot", mediaType: "image/png", filename: "step-ok.png", byteSize: 12345, redaction: "redacted", sha256: "SHA-SECRET-A1", objectRef: "obj://SECRET-A1", createdAt: "2026-06-15T00:00:01Z" });
    await seedArtifact(pool, TENANT_A, RUN_A, { id: "72000000-0000-0000-0000-0000000000a2", type: "video", mediaType: "video/webm", filename: "run.webm", byteSize: 67890, durationMs: 4200, redaction: "not_required", sha256: "SHA-SECRET-A2", objectRef: "obj://SECRET-A2", createdAt: "2026-06-15T00:00:02Z" });
    await seedArtifact(pool, TENANT_A, RUN_A, { id: "72000000-0000-0000-0000-0000000000a3", type: "vlm_input", redaction: "pending", sha256: "SHA-SECRET-A3", objectRef: "obj://SECRET-A3", createdAt: "2026-06-15T00:00:03Z" });
    await seedArtifact(pool, TENANT_A, RUN_A, { id: "72000000-0000-0000-0000-0000000000a4", type: "screenshot", redaction: "redacted", quarantine: true, sha256: "SHA-SECRET-A4", objectRef: "obj://SECRET-A4", createdAt: "2026-06-15T00:00:04Z" });
    await seedArtifact(pool, TENANT_A, RUN_A, { id: "72000000-0000-0000-0000-0000000000a5", type: "screenshot", redaction: "redacted", deleted: "2026-06-16T00:00:00Z", sha256: "SHA-SECRET-A5", objectRef: "obj://SECRET-A5", createdAt: "2026-06-15T00:00:05Z" });
    await seedGenerationPlannerArtifact(pool, TENANT_A, GEN_LINKED);
    // cross-tenant
    await seedScenarioRun(pool, TENANT_B, SCEN_B, SVER_B, RUN_B);
    await seedScenarioGeneration(pool, TENANT_B, GEN_B, RUN_B);
    await seedArtifact(pool, TENANT_B, RUN_B, { id: "72000000-0000-0000-0000-0000000000b1", type: "screenshot", redaction: "redacted", sha256: "SHA-SECRET-B1", objectRef: "obj://SECRET-B1", createdAt: "2026-06-15T00:00:01Z" });
    console.log("seeded: tenant A run(2 visible + 3 hidden artifacts) · tenant B run(1)");

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

      // 1) viewer(artifact.read) 목록 → 200, 가시 2건만, newest-first(a2→a1)
      const res = await get(`/v1/runs/${RUN_A}/artifacts`, viewer);
      check("viewer GET artifacts → 200", res.statusCode === 200, res.body);
      const items = res.json().items as Array<Record<string, unknown>>;
      check("가시 artifact 2건만(pending/quarantine/deleted 누락)", items.length === 2, JSON.stringify(items.map((i) => i.type)));
      check("newest-first(a2 video → a1 screenshot)", items[0]?.type === "video" && items[1]?.type === "screenshot", JSON.stringify(items.map((i) => i.type)));

      // 2) metadata 필드
      check("metadata 필드(artifact_id/step_id/attempt/type/redaction_status/retention_until/legal_hold/created_at)",
        items[0]?.artifact_id === "72000000-0000-0000-0000-0000000000a2" && items[0]?.redaction_status === "not_required" && items[0]?.legal_hold === false && typeof items[0]?.created_at === "string");
      check("run-level video provenance is null",
        items[0]?.step_id === null && items[0]?.attempt === null,
        JSON.stringify(items[0]));
      check("step screenshot exposes provenance metadata",
        items[1]?.step_id === STEP_ARTIFACT_ID && items[1]?.attempt === 2,
        JSON.stringify(items[1]));
      check("media metadata exposed for image/video results",
        items[0]?.media_type === "video/webm" && items[0]?.filename === "run.webm" && items[0]?.byte_size === 67890 && items[0]?.duration_ms === 4200,
        JSON.stringify(items[0]));

      // 3) **민감 미노출** — content/object_ref/sha256 마커 0건
      const body = res.body;
      for (const secret of ["SECRET-A1", "SECRET-A2", "SECRET-A3", "SECRET-A4", "SECRET-A5", "SHA-SECRET", "object_ref", "sha256", "content"]) {
        check(`민감 미노출: '${secret}' 응답에 없음`, !body.includes(secret), secret);
      }

      // 4) 커서 페이지(limit=1 → 1 + next_cursor → 다음 1)
      const p1 = await get(`/v1/runs/${RUN_A}/artifacts?limit=1`, viewer);
      const p1body = p1.json() as { items: unknown[]; next_cursor: string | null };
      const next = p1body.next_cursor;
      check("limit=1 → 1 item + next_cursor", p1body.items.length === 1 && typeof next === "string", p1.body);
      const p2 = await get(`/v1/runs/${RUN_A}/artifacts?limit=1&cursor=${encodeURIComponent(next ?? "")}`, viewer);
      const p2body = p2.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null };
      const p2items = p2body.items;
      check("page2 → a1 screenshot", p2items.length === 1 && p2items[0]?.type === "screenshot", JSON.stringify(p2items.map((i) => i.type)));
      check("page2가 마지막 visible artifact면 next_cursor=null", p2items.length === 1 && p2body.next_cursor === null, p2.body);

      // 4b) visible 전체 개수 limit → 더 줄 것이 없으므로 next_cursor=null
      const full = await get(`/v1/runs/${RUN_A}/artifacts?limit=${items.length}`, viewer);
      const fullBody = full.json() as { items: unknown[]; next_cursor: string | null };
      check("visible artifact 수와 같은 limit → next_cursor=null",
        full.statusCode === 200 && fullBody.items.length === items.length && fullBody.next_cursor === null,
        full.body);

      // 4c) 무효 cursor/limit은 조용한 빈 결과가 아니라 422 + IR_SCHEMA_INVALID(reason)로 거부
      const badCursor = await get(`/v1/runs/${RUN_A}/artifacts?cursor=not-a-json-cursor`, viewer);
      check("invalid cursor → 422 IR_SCHEMA_INVALID(invalid_cursor)",
        badCursor.statusCode === 422 && badCursor.json().code === "IR_SCHEMA_INVALID" && badCursor.json().details?.reason === "invalid_cursor",
        badCursor.body);
      const badLimit = await get(`/v1/runs/${RUN_A}/artifacts?limit=0`, viewer);
      check("invalid limit=0 → 422 IR_SCHEMA_INVALID(invalid_limit)",
        badLimit.statusCode === 422 && badLimit.json().code === "IR_SCHEMA_INVALID" && badLimit.json().details?.reason === "invalid_limit",
        badLimit.body);

      // 5) cross-tenant: A가 B run → 빈 목록(RLS)
      const cross = await get(`/v1/runs/${RUN_B}/artifacts`, viewer);
      check("cross-tenant run artifacts → 200 empty(RLS)", cross.statusCode === 200 && (cross.json().items as unknown[]).length === 0, cross.body);

      // 6) malformed run_id → 404
      const mal = await get(`/v1/runs/not-a-uuid/artifacts`, viewer);
      const genResults = await get(`/v1/scenario-generations/${GEN_LINKED}/result-artifacts`, viewer);
      check("linked generation result-artifacts -> 200", genResults.statusCode === 200, genResults.body);
      const genResultItems = genResults.json().items as Array<Record<string, unknown>>;
      check(
        "linked generation result-artifacts reuses visible run artifacts",
        genResultItems.length === 2 &&
          genResultItems[0]?.artifact_id === "72000000-0000-0000-0000-0000000000a2" &&
          genResultItems[1]?.artifact_id === "72000000-0000-0000-0000-0000000000a1",
        JSON.stringify(genResultItems),
      );
      check(
        "linked generation result-artifacts includes image/video metadata",
        genResultItems[0]?.media_type === "video/webm" &&
          genResultItems[0]?.filename === "run.webm" &&
          genResultItems[0]?.duration_ms === 4200 &&
          genResultItems[1]?.media_type === "image/png",
        JSON.stringify(genResultItems),
      );
      check(
        "linked generation result-artifacts excludes planner artifact scope",
        genResultItems.every((item) => item.type !== "scenario_generation_llm_output") &&
          !genResults.body.includes("SECRET-GEN") &&
          !genResults.body.includes("71600000-0000-0000-0000-0000000000a1"),
        genResults.body,
      );
      for (const secret of ["SECRET-A1", "SECRET-A2", "SHA-SECRET", "object_ref", "sha256", "content"]) {
        check(`generation result-artifacts metadata-only hides '${secret}'`, !genResults.body.includes(secret), secret);
      }

      const genResultPage1 = await get(`/v1/scenario-generations/${GEN_LINKED}/result-artifacts?limit=1`, viewer);
      const genResultPage1Body = genResultPage1.json() as { items: unknown[]; next_cursor: string | null };
      check(
        "generation result-artifacts limit=1 -> next_cursor",
        genResultPage1.statusCode === 200 && genResultPage1Body.items.length === 1 && typeof genResultPage1Body.next_cursor === "string",
        genResultPage1.body,
      );
      const genResultPage2 = await get(
        `/v1/scenario-generations/${GEN_LINKED}/result-artifacts?limit=1&cursor=${encodeURIComponent(genResultPage1Body.next_cursor ?? "")}`,
        viewer,
      );
      const genResultPage2Body = genResultPage2.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null };
      check(
        "generation result-artifacts cursor page2 -> remaining screenshot and null cursor",
        genResultPage2.statusCode === 200 &&
          genResultPage2Body.items.length === 1 &&
          genResultPage2Body.items[0]?.artifact_id === "72000000-0000-0000-0000-0000000000a1" &&
          genResultPage2Body.next_cursor === null,
        genResultPage2.body,
      );

      const unlinkedGeneration = await get(`/v1/scenario-generations/${GEN_UNLINKED}/result-artifacts`, viewer);
      check(
        "unlinked generation result-artifacts -> 200 empty",
        unlinkedGeneration.statusCode === 200 &&
          (unlinkedGeneration.json().items as unknown[]).length === 0 &&
          unlinkedGeneration.json().next_cursor === null,
        unlinkedGeneration.body,
      );
      const crossGeneration = await get(`/v1/scenario-generations/${GEN_B}/result-artifacts`, viewer);
      check(
        "cross-tenant generation result-artifacts -> 404 RESOURCE_NOT_FOUND",
        crossGeneration.statusCode === 404 && crossGeneration.json().code === "RESOURCE_NOT_FOUND",
        crossGeneration.body,
      );
      const badGenerationCursor = await get(`/v1/scenario-generations/${GEN_LINKED}/result-artifacts?cursor=not-a-json-cursor`, viewer);
      check(
        "generation result-artifacts invalid cursor -> 422 IR_SCHEMA_INVALID(invalid_cursor)",
        badGenerationCursor.statusCode === 422 &&
          badGenerationCursor.json().code === "IR_SCHEMA_INVALID" &&
          badGenerationCursor.json().details?.reason === "invalid_cursor",
        badGenerationCursor.body,
      );
      const badGenerationId = await get(`/v1/scenario-generations/not-a-uuid/result-artifacts`, viewer);
      check(
        "generation result-artifacts malformed generation_id -> 404 RESOURCE_NOT_FOUND",
        badGenerationId.statusCode === 404 && badGenerationId.json().code === "RESOURCE_NOT_FOUND",
        badGenerationId.body,
      );
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
  console.log("\nPASS: GET /v1/runs/{id}/artifacts integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
