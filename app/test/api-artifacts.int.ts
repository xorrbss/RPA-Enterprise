/**
 * 통합 테스트 — GET /v1/artifacts/{id} 산출물 조회 라우트(api-surface §5, release-decisions D8-A1).
 *   redaction → RBAC 2단 게이트. v1은 RLS(artifacts_visible_isolation)를 redaction 게이트로 사용:
 *   redacted/not_required·미삭제·비격리만 노출 → pending/failed/quarantined/deleted/cross-tenant는 404(존재 비노출).
 *   본문은 object store(redacted at rest)에서 read. 실 분산 object-store 바인딩은 deploy-time(B3) — 본 테스트는 FsObjectStore.
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

/** object 기록(FsObjectStore.put) + artifacts 행 직접 INSERT(run 링크 불요 — run_id nullable). */
async function seedArtifact(
  pool: Pool,
  store: FsObjectStore,
  tenant: string,
  content: string,
  over: { redaction_status?: string; quarantine?: boolean; deleted?: boolean } = {},
): Promise<{ id: string; objectRef: ObjectRef; sha256: string }> {
  const objectRef = await store.put(content);
  const id = randomUUID();
  const sha256 = createHash("sha256").update(content).digest("hex");
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts (id, tenant_id, type, redaction_status, sha256, object_ref, quarantine, deleted_at, retention_until)
       VALUES ($1::uuid, $2::uuid, 'evidence', $3, $4, $5, $6, $7, now() + interval '90 days')`,
      [id, tenant, over.redaction_status ?? "redacted", sha256, objectRef, over.quarantine ?? false, over.deleted ? new Date() : null],
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

    const redacted = await seedArtifact(pool, store, TENANT_A, "redacted-body-A", { redaction_status: "redacted" });
    const notRequired = await seedArtifact(pool, store, TENANT_A, "nr-body-A", { redaction_status: "not_required" });
    const pending = await seedArtifact(pool, store, TENANT_A, "pending-body", { redaction_status: "pending" });
    const failed = await seedArtifact(pool, store, TENANT_A, "failed-body", { redaction_status: "failed" });
    const quarantined = await seedArtifact(pool, store, TENANT_A, "quarantined-body", { redaction_status: "redacted", quarantine: true });
    const deleted = await seedArtifact(pool, store, TENANT_A, "deleted-body", { redaction_status: "redacted", deleted: true });
    const tenantB = await seedArtifact(pool, store, TENANT_B, "redacted-body-B", { redaction_status: "redacted" });
    console.log("seeded artifacts (redacted/not_required/pending/failed/quarantined/deleted + tenant B)");

    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
      artifactStore: store,
    });
    await app.ready();
    try {
      const op = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });

      const get = (id: string, token = op) =>
        app.inject({ method: "GET", url: `/v1/artifacts/${id}`, headers: { authorization: `Bearer ${token}` } });

      // 1) visible(redacted) → 200 + 본문/필드.
      const r1 = await get(redacted.id);
      check("redacted → 200", r1.statusCode === 200, r1.body);
      check("body content = object 본문", r1.json().content === "redacted-body-A", r1.body);
      check("body fields(artifact_id·redaction_status·sha256)", r1.json().artifact_id === redacted.id && r1.json().redaction_status === "redacted" && r1.json().sha256 === redacted.sha256, r1.body);

      // 2) not_required → 200(가시).
      const r2 = await get(notRequired.id);
      check("not_required → 200 + 본문", r2.statusCode === 200 && r2.json().content === "nr-body-A", r2.body);

      // 3) viewer도 artifact.read(전 역할) → 200.
      const r3 = await get(redacted.id, viewer);
      check("viewer artifact.read → 200", r3.statusCode === 200 && r3.json().content === "redacted-body-A", r3.body);

      // 4) pending → 404(RLS 비가시; D8-A1 — 409 ARTIFACT_NOT_REDACTED 미노출, 존재 비노출).
      const r4 = await get(pending.id);
      check("pending → 404 RESOURCE_NOT_FOUND", r4.statusCode === 404 && r4.json().code === "RESOURCE_NOT_FOUND", r4.body);

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
