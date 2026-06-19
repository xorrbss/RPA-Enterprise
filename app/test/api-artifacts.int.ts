/**
 * 통합 테스트 — GET /v1/artifacts/{id} 산출물 조회 라우트(api-surface §5, release-decisions D8-A1).
 *   redaction → RBAC 2단 게이트. v1은 RLS(artifacts_visible_isolation)를 redaction 게이트로 사용:
 *   redacted/not_required·미삭제·비격리만 노출 → pending/failed/quarantined/deleted/cross-tenant는 404(존재 비노출).
 *   본문은 object store(redacted at rest)에서 read. S3 scheme router는 unit/main-config에서 검증하고 본 테스트는 FsObjectStore.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/api-artifacts.int.ts
 *
 * 검증: visible(redacted/not_required) → 200 + 본문 일치, pending/failed/quarantined/deleted → 404,
 *   cross-tenant → 404(RLS), absent/invalid uuid → 404, viewer도 artifact.read 보유(전 역할) → 200.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import type { ObjectRef, SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_api_artifacts_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const ABSENT = "60000000-0000-0000-0000-0000000000ff";
const GEN_A = "61000000-0000-0000-0000-0000000000a1";
const GEN_A_OTHER = "61000000-0000-0000-0000-0000000000a2";
const GEN_B = "61000000-0000-0000-0000-0000000000b1";
const SECRET = new TextEncoder().encode("api-artifacts-int-secret-do-not-use-in-prod-0123456789");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};
const noopEnqueuer: RunEnqueuer = {
  async enqueueRunClaim() {},
  async enqueueRunAbort() {},
  async enqueueSinkDeliver() {},
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

/** RQ-019: artifact.read audit boundary 행 수(tenant-scoped). security-contracts §10 — disclosure당 1행. */
async function artifactReadAuditCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='artifact.read' AND outcome='allow'`,
    );
    return r.rows[0]?.n ?? 0;
  });
}

/** object 기록(FsObjectStore.put) + artifacts 행 직접 INSERT(run 링크 불요 — run_id nullable). */
async function seedArtifact(
  pool: Pool,
  store: FsObjectStore,
  tenant: string,
  content: string,
  over: { redaction_status?: string; quarantine?: boolean; deleted?: boolean; mediaType?: string; filename?: string; byteSize?: number; durationMs?: number } = {},
): Promise<{ id: string; objectRef: ObjectRef; sha256: string }> {
  const objectRef = await store.put(content);
  const id = randomUUID();
  const sha256 = createHash("sha256").update(content).digest("hex");
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts (id, tenant_id, type, media_type, filename, byte_size, duration_ms,
                              redaction_status, sha256, object_ref, quarantine, deleted_at, retention_until)
       VALUES ($1::uuid, $2::uuid, 'evidence', $3, $4, $5::bigint, $6::int, $7, $8, $9, $10, $11, now() + interval '90 days')`,
      [
        id,
        tenant,
        over.mediaType ?? null,
        over.filename ?? null,
        over.byteSize ?? null,
        over.durationMs ?? null,
        over.redaction_status ?? "redacted",
        sha256,
        objectRef,
        over.quarantine ?? false,
        over.deleted ? new Date() : null,
      ],
    ),
  );
  return { id, objectRef, sha256 };
}

async function seedArtifactBytes(
  pool: Pool,
  store: FsObjectStore,
  tenant: string,
  content: Uint8Array,
  over: { redaction_status?: string; quarantine?: boolean; deleted?: boolean; mediaType?: string; filename?: string; byteSize?: number; durationMs?: number } = {},
): Promise<{ id: string; objectRef: ObjectRef; sha256: string }> {
  const objectRef = await store.putBytes(content);
  const id = randomUUID();
  const sha256 = createHash("sha256").update(content).digest("hex");
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts (id, tenant_id, type, media_type, filename, byte_size, duration_ms,
                              redaction_status, sha256, object_ref, quarantine, deleted_at, retention_until)
       VALUES ($1::uuid, $2::uuid, 'screenshot', $3, $4, $5::bigint, $6::int, $7, $8, $9, $10, $11, now() + interval '90 days')`,
      [
        id,
        tenant,
        over.mediaType ?? null,
        over.filename ?? null,
        over.byteSize ?? content.byteLength,
        over.durationMs ?? null,
        over.redaction_status ?? "redacted",
        sha256,
        objectRef,
        over.quarantine ?? false,
        over.deleted ? new Date() : null,
      ],
    ),
  );
  return { id, objectRef, sha256 };
}

async function seedScenarioGeneration(pool: Pool, tenant: string, generationId: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO scenario_generations
         (id, tenant_id, mode, status, prompt_hash, planner, draft_ir, evidence_policy, blockers, created_by)
       VALUES ($1::uuid, $2::uuid, 'save', 'saved', $3, 'llm_v1', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'test')`,
      [generationId, tenant, `hash-${generationId}`],
    ),
  );
}

async function seedGenerationArtifact(
  pool: Pool,
  store: FsObjectStore,
  tenant: string,
  generationId: string,
  content: string,
  over: { redaction_status?: string; quarantine?: boolean; deleted?: boolean; createdAt?: string } = {},
): Promise<{ id: string; objectRef: ObjectRef; sha256: string }> {
  const objectRef = await store.put(content);
  const id = randomUUID();
  const sha256 = createHash("sha256").update(content).digest("hex");
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts
         (id, tenant_id, generation_id, type, media_type, byte_size, redaction_status, sha256, object_ref,
          quarantine, deleted_at, retention_until, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'scenario_generation_llm_output', 'text/plain; charset=utf-8',
               $4::bigint, $5, $6, $7, $8, $9, now() + interval '90 days', $10::timestamptz)`,
      [
        id,
        tenant,
        generationId,
        Buffer.byteLength(content, "utf8"),
        over.redaction_status ?? "redacted",
        sha256,
        objectRef,
        over.quarantine ?? false,
        over.deleted ? new Date() : null,
        over.createdAt ?? new Date().toISOString(),
      ],
    ),
  );
  return { id, objectRef, sha256 };
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const dir = mkdtempSync(join(tmpdir(), "api-artifacts-"));
  const store = new FsObjectStore(dir);
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

    const redacted = await seedArtifact(pool, store, TENANT_A, "redacted-body-A", {
      redaction_status: "redacted",
      mediaType: "image/png",
      filename: "evidence.png",
      byteSize: 321,
    });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const screenshot = await seedArtifactBytes(pool, store, TENANT_A, pngBytes, {
      redaction_status: "redacted",
      mediaType: "image/png",
      filename: "screen shot.png",
    });
    const notRequired = await seedArtifact(pool, store, TENANT_A, "nr-body-A", { redaction_status: "not_required" });
    const pending = await seedArtifact(pool, store, TENANT_A, "pending-body", { redaction_status: "pending" });
    const failed = await seedArtifact(pool, store, TENANT_A, "failed-body", { redaction_status: "failed" });
    const quarantined = await seedArtifact(pool, store, TENANT_A, "quarantined-body", { redaction_status: "redacted", quarantine: true });
    const deleted = await seedArtifact(pool, store, TENANT_A, "deleted-body", { redaction_status: "redacted", deleted: true });
    const tenantB = await seedArtifact(pool, store, TENANT_B, "redacted-body-B", { redaction_status: "redacted" });
    console.log("seeded artifacts (redacted/not_required/pending/failed/quarantined/deleted + tenant B)");
    await seedScenarioGeneration(pool, TENANT_A, GEN_A);
    await seedScenarioGeneration(pool, TENANT_A, GEN_A_OTHER);
    await seedScenarioGeneration(pool, TENANT_B, GEN_B);
    const genVisible = await seedGenerationArtifact(pool, store, TENANT_A, GEN_A, "redacted planner body", {
      redaction_status: "redacted",
      createdAt: "2026-06-15T00:00:02Z",
    });
    const genNotRequired = await seedGenerationArtifact(pool, store, TENANT_A, GEN_A, "not-required planner body", {
      redaction_status: "not_required",
      createdAt: "2026-06-15T00:00:01Z",
    });
    const genPending = await seedGenerationArtifact(pool, store, TENANT_A, GEN_A, "pending planner body", {
      redaction_status: "pending",
      createdAt: "2026-06-15T00:00:03Z",
    });
    const genWrong = await seedGenerationArtifact(pool, store, TENANT_A, GEN_A_OTHER, "wrong generation body", {
      redaction_status: "redacted",
      createdAt: "2026-06-15T00:00:04Z",
    });
    const genTenantB = await seedGenerationArtifact(pool, store, TENANT_B, GEN_B, "tenant b planner body", {
      redaction_status: "redacted",
      createdAt: "2026-06-15T00:00:05Z",
    });
    console.log("seeded generation artifacts (visible/pending/wrong generation/cross tenant)");

    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
      artifactStore: store,
      securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
    });
    await app.ready();
    try {
      const op = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });

      const get = (id: string, token = op) =>
        app.inject({ method: "GET", url: `/v1/artifacts/${id}`, headers: { authorization: `Bearer ${token}` } });
      const getBlob = (id: string, token = op) =>
        app.inject({ method: "GET", url: `/v1/artifacts/${id}/blob`, headers: { authorization: `Bearer ${token}` } });
      const listGenerationArtifacts = (generationId: string, token = op) =>
        app.inject({ method: "GET", url: `/v1/scenario-generations/${generationId}/artifacts`, headers: { authorization: `Bearer ${token}` } });
      const getGenerationArtifact = (generationId: string, artifactId: string, token = op) =>
        app.inject({
          method: "GET",
          url: `/v1/scenario-generations/${generationId}/artifacts/${artifactId}`,
          headers: { authorization: `Bearer ${token}` },
        });

      // 1) visible(redacted) → 200 + 본문/필드.
      const r1 = await get(redacted.id);
      check("redacted → 200", r1.statusCode === 200, r1.body);
      check("body content = object 본문", r1.json().content === "redacted-body-A", r1.body);
      check("body fields(artifact_id·redaction_status·sha256)", r1.json().artifact_id === redacted.id && r1.json().redaction_status === "redacted" && r1.json().sha256 === redacted.sha256, r1.body);
      check("body media metadata exposed", r1.json().media_type === "image/png" && r1.json().filename === "evidence.png" && r1.json().byte_size === 321, r1.body);

      // 2) not_required → 200(가시).
      const r2 = await get(notRequired.id);
      check("not_required → 200 + 본문", r2.statusCode === 200 && r2.json().content === "nr-body-A", r2.body);

      // 3) viewer도 artifact.read(전 역할) → 200.
      const r3 = await get(redacted.id, viewer);
      check("viewer artifact.read → 200", r3.statusCode === 200 && r3.json().content === "redacted-body-A", r3.body);

      // RQ-019: 성공 disclosure(r1·r2·r3 = 3건)는 security-contracts §10 audit boundary에 artifact.read/allow 행을 남긴다.
      check("성공 disclosure 3건 → audit_log artifact.read/allow 3행", (await artifactReadAuditCount(pool, TENANT_A)) === 3, "audit rows after 3 reads");

      // 4) pending → 404(RLS 비가시; D8-A1 — 409 ARTIFACT_NOT_REDACTED 미노출, 존재 비노출).
      const r4 = await get(pending.id);
      check("pending → 404 RESOURCE_NOT_FOUND", r4.statusCode === 404 && r4.json().code === "RESOURCE_NOT_FOUND", r4.body);
      // 404(비가시)는 본문 미노출 → audit 행 미추가(disclosure 없음).
      check("404은 audit 행 미추가(여전히 3)", (await artifactReadAuditCount(pool, TENANT_A)) === 3);

      // 5) failed → 404.
      const r5 = await get(failed.id);
      check("failed → 404", r5.statusCode === 404 && r5.json().code === "RESOURCE_NOT_FOUND", r5.body);

      // 6) quarantined → 404.
      const r6 = await get(quarantined.id);
      check("quarantined → 404", r6.statusCode === 404 && r6.json().code === "RESOURCE_NOT_FOUND", r6.body);

      // 7) deleted(soft) → 404.
      const r7 = await get(deleted.id);
      check("deleted → 404", r7.statusCode === 404 && r7.json().code === "RESOURCE_NOT_FOUND", r7.body);

      // 8) cross-tenant(B의 redacted를 A로 조회) → 404(RLS 은닉, 존재 비노출).
      const r8 = await get(tenantB.id);
      check("cross-tenant → 404", r8.statusCode === 404 && r8.json().code === "RESOURCE_NOT_FOUND", r8.body);

      // 9) 미존재 uuid → 404.
      const r9 = await get(ABSENT);
      check("absent → 404", r9.statusCode === 404 && r9.json().code === "RESOURCE_NOT_FOUND", r9.body);

      // 10) 무효 uuid → 404.
      const r10 = await get("not-a-uuid");
      check("invalid uuid → 404", r10.statusCode === 404 && r10.json().code === "RESOURCE_NOT_FOUND", r10.body);

      // 10b) RQ-022: 가시(redacted) artifact인데 object bytes 부재(스토리지 유실) → 미분류 500이 아니라 fail-closed 404.
      //   disclosure 자체가 불가하므로 §10 audit 행도 미추가(여전히 3).
      const objMissing = await seedArtifact(pool, store, TENANT_A, "will-be-deleted", { redaction_status: "redacted" });
      await store.delete(objMissing.objectRef); // object 파일만 삭제(artifacts row는 가시로 남김).
      const r10b = await get(objMissing.id);
      check("object bytes 부재 → 404 (500 아님)", r10b.statusCode === 404 && r10b.json().code === "RESOURCE_NOT_FOUND", r10b.body);
      check("object 부재 404은 audit 미추가(여전히 3)", (await artifactReadAuditCount(pool, TENANT_A)) === 3);

      // 11) RQ-019 fail-closed: artifactStore가 있는데 securityAudit 미주입 → 라우트 등록이 fail-closed throw
      //     (audit 없이 artifact 본문 노출 불가, security-contracts §10).
      const blob = await getBlob(screenshot.id);
      check("blob -> 200", blob.statusCode === 200, blob.body);
      check("blob content-type image/png", blob.headers["content-type"] === "image/png", String(blob.headers["content-type"]));
      check("blob content-disposition inline filename", String(blob.headers["content-disposition"]).includes('filename="screen shot.png"'), String(blob.headers["content-disposition"]));
      check("blob raw bytes preserved", Buffer.compare(Buffer.from(blob.rawPayload), Buffer.from(pngBytes)) === 0, blob.rawPayload.toString("hex"));
      check("blob disclosure adds audit row", (await artifactReadAuditCount(pool, TENANT_A)) === 4, "audit rows after blob read");

      const pendingBlob = await getBlob(pending.id);
      check("pending blob -> 404 RESOURCE_NOT_FOUND", pendingBlob.statusCode === 404 && pendingBlob.json().code === "RESOURCE_NOT_FOUND", pendingBlob.body);
      check("pending blob 404 does not add audit", (await artifactReadAuditCount(pool, TENANT_A)) === 4);

      const genList = await listGenerationArtifacts(GEN_A, viewer);
      check("generation artifacts list -> 200", genList.statusCode === 200, genList.body);
      const genItems = genList.json().items as Array<Record<string, unknown>>;
      check(
        "generation artifact list exposes only visible rows",
        genItems.length === 2 &&
          genItems[0]?.artifact_id === genVisible.id &&
          genItems[1]?.artifact_id === genNotRequired.id &&
          genItems.every((item) => item.type === "scenario_generation_llm_output" && item.step_id === null && item.attempt === null),
        JSON.stringify(genItems),
      );
      for (const secret of ["pending planner body", "redacted planner body", genVisible.sha256, "object_ref", "sha256", "content"]) {
        check(`generation artifact list hides '${secret}'`, !genList.body.includes(secret), secret);
      }
      check("generation artifact list does not add disclosure audit", (await artifactReadAuditCount(pool, TENANT_A)) === 4);

      const scopedBody = await getGenerationArtifact(GEN_A, genVisible.id, viewer);
      check("generation artifact scoped body -> 200", scopedBody.statusCode === 200, scopedBody.body);
      check(
        "generation artifact scoped body returns redacted content and generation id",
        scopedBody.json().generation_id === GEN_A &&
          scopedBody.json().artifact_id === genVisible.id &&
          scopedBody.json().content === "redacted planner body" &&
          scopedBody.json().sha256 === genVisible.sha256 &&
          !scopedBody.body.includes("object_ref"),
        scopedBody.body,
      );
      check("generation artifact scoped body adds audit row", (await artifactReadAuditCount(pool, TENANT_A)) === 5);

      const hiddenGenerationBody = await getGenerationArtifact(GEN_A, genPending.id, viewer);
      check("pending generation artifact scoped body -> 404", hiddenGenerationBody.statusCode === 404 && hiddenGenerationBody.json().code === "RESOURCE_NOT_FOUND", hiddenGenerationBody.body);
      const wrongGenerationBody = await getGenerationArtifact(GEN_A, genWrong.id, viewer);
      check("wrong-generation artifact scoped body -> 404", wrongGenerationBody.statusCode === 404 && wrongGenerationBody.json().code === "RESOURCE_NOT_FOUND", wrongGenerationBody.body);
      const crossGenerationList = await listGenerationArtifacts(GEN_B, viewer);
      check("cross-tenant generation artifact list -> 200 empty", crossGenerationList.statusCode === 200 && (crossGenerationList.json().items as unknown[]).length === 0, crossGenerationList.body);
      const crossGenerationBody = await getGenerationArtifact(GEN_B, genTenantB.id, viewer);
      check("cross-tenant generation artifact scoped body -> 404", crossGenerationBody.statusCode === 404 && crossGenerationBody.json().code === "RESOURCE_NOT_FOUND", crossGenerationBody.body);
      check("generation artifact 404 paths do not add audit", (await artifactReadAuditCount(pool, TENANT_A)) === 5);
      const invalidGenerationList = await listGenerationArtifacts("not-a-uuid", viewer);
      check("invalid generation artifact list id -> 404", invalidGenerationList.statusCode === 404 && invalidGenerationList.json().code === "RESOURCE_NOT_FOUND", invalidGenerationList.body);
      const invalidGenerationBody = await getGenerationArtifact(GEN_A, "not-a-uuid", viewer);
      check("invalid generation artifact body id -> 404", invalidGenerationBody.statusCode === 404 && invalidGenerationBody.json().code === "RESOURCE_NOT_FOUND", invalidGenerationBody.body);

      let buildThrew = false;
      try {
        buildServer({
          pool,
          auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
          rbac: new RoleMatrixRbacMiddleware(),
          idempotency: new PgControlPlaneIdempotencyStore(pool),
          enqueuer: noopEnqueuer,
          signedCommandRegistry,
          artifactStore: store,
        });
      } catch {
        buildThrew = true;
      }
      check("artifactStore without securityAudit → buildServer fail-closed throw", buildThrew);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: GET /v1/artifacts/{id} (D8-A1 RLS redaction-gate + object body) integration green");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
