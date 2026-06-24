/**
 * Integration test for Document IDP MVP.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/api-document-jobs.int.ts
 */
import { createHash } from "node:crypto";
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
const SCHEMA = "rpa_api_document_jobs_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCEN_A = "10000000-0000-4000-8000-0000000000a1";
const SVER_A = "20000000-0000-4000-8000-0000000000a1";
const RUN_A = "30000000-0000-4000-8000-0000000000a1";
const ART_A = "40000000-0000-4000-8000-0000000000a1";
const ART_PENDING = "40000000-0000-4000-8000-0000000000a2";
const ART_IMAGE = "40000000-0000-4000-8000-0000000000a3";
const SCEN_B = "10000000-0000-4000-8000-0000000000b1";
const SVER_B = "20000000-0000-4000-8000-0000000000b1";
const RUN_B = "30000000-0000-4000-8000-0000000000b1";
const ART_B = "40000000-0000-4000-8000-0000000000b1";
const SECRET = new TextEncoder().encode("api-document-jobs-int-secret-do-not-use-in-prod-0123456789");

type Pool = ReturnType<typeof createPool>;

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
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function mint(roles: string[], sub = "operator-a", tenant = TENANT_A): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedScenarioRun(pool: Pool, tenant: string, scen: string, sver: string, run: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'document-idp')`, [scen, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scen],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
       VALUES ($1,$2,$3,'suspended',$1,1,'2026-06-15T00:00:00Z','2026-06-15T00:00:00Z')`,
      [run, tenant, sver],
    );
  });
}

async function seedArtifact(
  pool: Pool,
  store: FsObjectStore,
  tenant: string,
  run: string,
  id: string,
  content: string,
  redaction = "redacted",
  mediaType = "text/plain; charset=utf-8",
): Promise<void> {
  const objectRef = await store.put(content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO artifacts
         (id, tenant_id, run_id, type, media_type, filename, byte_size, redaction_status, sha256, object_ref, retention_until, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'extract_result_json',$8,'invoice.txt',$4::bigint,$5,$6,$7,'2026-09-01T00:00:00Z','2026-06-15T00:00:01Z')`,
      [id, tenant, run, Buffer.byteLength(content, "utf8"), redaction, sha256, objectRef, mediaType],
    ),
  );
}

async function artifactReadAuditCount(pool: Pool): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const result = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='artifact.read' AND outcome='allow' AND reason='document_idp_extraction_source_read'`,
    );
    return result.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const dir = mkdtempSync(join(tmpdir(), "api-document-jobs-"));
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
    console.log("migrations applied (concurrency -> core)");

    await seedScenarioRun(pool, TENANT_A, SCEN_A, SVER_A, RUN_A);
    await seedArtifact(pool, store, TENANT_A, RUN_A, ART_A, "Invoice ID: INV-7\nTotal: 9900");
    await seedArtifact(pool, store, TENANT_A, RUN_A, ART_PENDING, "Invoice ID: INV-8", "pending");
    await seedArtifact(pool, store, TENANT_A, RUN_A, ART_IMAGE, "not-really-png", "redacted", "image/png");
    await seedScenarioRun(pool, TENANT_B, SCEN_B, SVER_B, RUN_B);
    await seedArtifact(pool, store, TENANT_B, RUN_B, ART_B, "Invoice ID: OTHER\nTotal: 1");

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
      const operator = await mint(["operator"]);
      const viewer = await mint(["viewer"], "viewer-a");
      const tenantB = await mint(["operator"], "operator-b", TENANT_B);
      const body = {
        source_artifact_id: ART_A,
        document_type: "invoice",
        field_schema: [
          { key: "invoice_id", label: "Invoice ID", required: true, aliases: ["송장 번호"], min_confidence: 0.8 },
          { key: "total", label: "Total", type: "number", required: true, aliases: ["금액"], min_confidence: 0.8 },
        ],
      };

      const create = await app.inject({
        method: "POST",
        url: "/v1/document-jobs",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-create-1" },
        payload: body,
      });
      check("operator create document job -> 201", create.statusCode === 201, create.body);
      const jobId = create.json().document_job_id as string;
      check("job links source run", create.json().source_run_id === RUN_A, create.body);

      const replay = await app.inject({
        method: "POST",
        url: "/v1/document-jobs",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-create-1" },
        payload: body,
      });
      check("create idempotency replay -> same job", replay.statusCode === 201 && replay.json().document_job_id === jobId, replay.body);

      const viewerDenied = await app.inject({
        method: "POST",
        url: "/v1/document-jobs",
        headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "doc-viewer-denied" },
        payload: body,
      });
      check("viewer cannot create document job", viewerDenied.statusCode === 403, viewerDenied.body);

      const hiddenArtifact = await app.inject({
        method: "POST",
        url: "/v1/document-jobs",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-hidden-artifact" },
        payload: { ...body, source_artifact_id: ART_PENDING },
      });
      check("pending artifact cannot seed document job", hiddenArtifact.statusCode === 404, hiddenArtifact.body);

      const unsupportedArtifact = await app.inject({
        method: "POST",
        url: "/v1/document-jobs",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-image-artifact" },
        payload: { ...body, source_artifact_id: ART_IMAGE },
      });
      check("image artifact is rejected until OCR module exists", unsupportedArtifact.statusCode === 422, unsupportedArtifact.body);

      const crossTenant = await app.inject({
        method: "POST",
        url: "/v1/document-jobs",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-cross-artifact" },
        payload: { ...body, source_artifact_id: ART_B },
      });
      check("cross-tenant artifact hidden", crossTenant.statusCode === 404, crossTenant.body);

      const extract = await app.inject({
        method: "POST",
        url: `/v1/document-jobs/${jobId}/extract`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-extract-1" },
        payload: {},
      });
      check("extract document job -> 200", extract.statusCode === 200, extract.body);
      check("label extraction requires validation", extract.json().status === "validation_required", extract.body);
      check("missing fields include low-confidence labels", Array.isArray(extract.json().missing_fields) && extract.json().missing_fields.includes("invoice_id") && extract.json().missing_fields.includes("total"), extract.body);
      check("extract records artifact read audit", (await artifactReadAuditCount(pool)) === 1);

      const validation = await app.inject({
        method: "POST",
        url: `/v1/document-jobs/${jobId}/validation-task`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-validation-1" },
        payload: {},
      });
      check("validation task created -> 201", validation.statusCode === 201, validation.body);
      const taskId = validation.json().human_task_id as string;
      check("validation task exposes business form", validation.body.includes("business_form_v1") && validation.body.includes("invoice_id"), validation.body);

      const validationReplay = await app.inject({
        method: "POST",
        url: `/v1/document-jobs/${jobId}/validation-task`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "doc-validation-1" },
        payload: {},
      });
      check("validation task idempotency replay -> same task", validationReplay.statusCode === 201 && validationReplay.json().human_task_id === taskId, validationReplay.body);

      const list = await app.inject({ method: "GET", url: "/v1/document-jobs", headers: { authorization: `Bearer ${viewer}` } });
      check("viewer can list document jobs", list.statusCode === 200 && list.body.includes(jobId), list.body);

      const bList = await app.inject({ method: "GET", url: "/v1/document-jobs", headers: { authorization: `Bearer ${tenantB}` } });
      check("tenant B cannot see tenant A jobs", bList.statusCode === 200 && !bList.body.includes(jobId), bList.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} document job API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: document job API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
