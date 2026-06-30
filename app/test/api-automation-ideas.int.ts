/**
 * Integration test for /v1/automation-ideas and ROI estimates.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-automation-ideas.int.ts
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
const SCHEMA = "rpa_automation_ideas_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "51000000-0000-4000-8000-0000000000a1";
const SVER_A = "51000000-0000-4000-8000-0000000000a2";
const SCENARIO_B = "51000000-0000-4000-8000-0000000000b1";
const SVER_B = "51000000-0000-4000-8000-0000000000b2";
const TRIGGER_A = "52000000-0000-4000-8000-0000000000a1";
const TRIGGER_B = "52000000-0000-4000-8000-0000000000b1";
const SECRET = new TextEncoder().encode("automation-ideas-int-secret-do-not-use-in-prod-0123456789");
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
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedScenarioAndTrigger(
  pool: Pool,
  tenant: string,
  scenarioId: string,
  scenarioVersionId: string,
  triggerId: string,
): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'coe-int')`, [scenarioId, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
      [
        scenarioVersionId,
        tenant,
        scenarioId,
        JSON.stringify({
          nodes: [],
          target: {
            site_profile_id: "00000000-0000-4000-8000-0000000000f1",
            browser_identity_id: "00000000-0000-4000-8000-0000000000f2",
            network_policy_id: "00000000-0000-4000-8000-0000000000f3",
          },
        }),
      ],
    );
    await c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params, created_by)
       VALUES ($1,$2,$3,'enabled','0 9 * * 1-5','Asia/Seoul','{}'::jsonb,'seed-op')`,
      [triggerId, tenant, scenarioVersionId],
    );
  });
}

async function ideaCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM automation_ideas`);
    return r.rows[0]?.n ?? 0;
  });
}

async function processImportCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM process_mining_imports`);
    return r.rows[0]?.n ?? 0;
  });
}

async function roiCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM roi_estimates`);
    return r.rows[0]?.n ?? 0;
  });
}

async function roiActualCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM roi_actual_evidence`);
    return r.rows[0]?.n ?? 0;
  });
}

async function adoptionEvidenceCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM automation_adoption_evidence`);
    return r.rows[0]?.n ?? 0;
  });
}

async function idempotencyCount(pool: Pool, tenant: string, endpoint: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM control_plane_idempotency_keys
        WHERE endpoint=$1 AND idempotency_key=$2`,
      [endpoint, key],
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
    console.log("migrations applied (concurrency -> core)");

    await seedScenarioAndTrigger(pool, TENANT_A, SCENARIO_A, SVER_A, TRIGGER_A);
    await seedScenarioAndTrigger(pool, TENANT_B, SCENARIO_B, SVER_B, TRIGGER_B);
    console.log("seeded scenarios and run triggers across tenants");

    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort() {},
      async enqueueSinkDeliver() {},
    };
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
      const operator = await mint({ sub: "operator-a", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "viewer-a", tenant_id: TENANT_A, roles: ["viewer"] });
      const approver = await mint({ sub: "approver-a", tenant_id: TENANT_A, roles: ["approver"] });
      const operatorB = await mint({ sub: "operator-b", tenant_id: TENANT_B, roles: ["operator"] });

      const createIdea = (token: string, key?: string, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/automation-ideas",
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: payload as object | undefined,
        });
      const createProcessImport = (token: string, key?: string, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/process-mining/imports",
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: payload as object | undefined,
        });
      const command = (method: "POST" | "PATCH", url: string, token: string, key: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: payload as object | undefined,
        });

      const processImport = await createProcessImport(operator, "process-import-create-1", {
        source_type: "process_mining",
        source_system: "celonis-export",
        source_owner_ref: "group:process-owner",
        schema_version: "2026-06",
        import_evidence_ref: "artifact:pm-import-1",
        lineage_ref: "lineage:pm-import-1",
        row_count: 120,
        candidate_count: 4,
        schema_mapping: { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" },
        import_summary: "Aggregated process mining export from customer-owned monitoring.",
      });
      check("operator create process mining import -> 201", processImport.statusCode === 201, processImport.body);
      const processImportId = String(processImport.json().import_id);
      check("process import authority metadata round-trip", processImport.json().source_system === "celonis-export" && processImport.json().row_count === 120, processImport.body);

      const processImportList = await app.inject({
        method: "GET",
        url: "/v1/process-mining/imports?source_type=process_mining&limit=5",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list process imports -> 200", processImportList.statusCode === 200 && processImportList.json().items?.length === 1, processImportList.body);

      const rawEndpointImport = await createProcessImport(operator, "process-import-raw-url-denied", {
        source_type: "process_mining",
        source_system: "https://mining.example.com/export",
        source_owner_ref: "group:process-owner",
        schema_version: "2026-06",
        import_evidence_ref: "artifact:pm-import-raw",
        lineage_ref: "lineage:pm-import-raw",
        row_count: 1,
        candidate_count: 0,
        schema_mapping: { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" },
        import_summary: "Raw endpoint should be rejected.",
      });
      check("process import raw endpoint rejected before idempotency -> 422", rawEndpointImport.statusCode === 422 && rawEndpointImport.json().code === "IR_SCHEMA_INVALID", rawEndpointImport.body);
      check("raw endpoint import did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createProcessMiningImport", "process-import-raw-url-denied")) === 0);

      const viewerImportDenied = await createProcessImport(viewer, "viewer-process-import-denied", {
        source_type: "process_mining",
        source_system: "celonis-export",
        source_owner_ref: "group:process-owner",
        schema_version: "2026-06",
        import_evidence_ref: "artifact:pm-import-viewer",
        lineage_ref: "lineage:pm-import-viewer",
        row_count: 1,
        candidate_count: 0,
        schema_mapping: { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" },
        import_summary: "Viewer must not create imports.",
      });
      check("viewer create process import denied -> 403", viewerImportDenied.statusCode === 403 && viewerImportDenied.json().code === "AUTHZ_FORBIDDEN", viewerImportDenied.body);
      check("viewer import denied did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createProcessMiningImport", "viewer-process-import-denied")) === 0);

      const created = await createIdea(operator, "idea-create-1", {
        title: "Vendor portal payment check",
        description: "Check browser portal payment status and route exceptions to finance ops.",
        business_owner: "finance-ops",
        department: "Finance",
        priority: "high",
        score: 82,
      });
      check("operator create idea -> 201", created.statusCode === 201, created.body);
      const createdBody = created.json();
      const ideaId = String(createdBody.idea_id);
      check("idea defaults intake/manual and records owner", createdBody.stage === "intake" && createdBody.source === "manual" && createdBody.created_by === "operator-a", created.body);
      check("idea score/priority round-trip", createdBody.score === 82 && createdBody.priority === "high", created.body);

      const replay = await createIdea(operator, "idea-create-1", {
        title: "Vendor portal payment check",
        description: "Check browser portal payment status and route exceptions to finance ops.",
        business_owner: "finance-ops",
        department: "Finance",
        priority: "high",
        score: 82,
      });
      check("create replay returns same idea", replay.statusCode === 201 && replay.json().idea_id === ideaId, replay.body);
      check("create replay does not duplicate rows", (await ideaCount(pool, TENANT_A)) === 1);
      check("process import row exists only once", (await processImportCount(pool, TENANT_A)) === 1);

      const processIdea = await createIdea(operator, "idea-create-process-1", {
        title: "Vendor portal mining candidate",
        description: "Candidate from aggregated process mining lineage.",
        business_owner: "finance-ops",
        department: "Finance",
        source: "process_mining",
        priority: "high",
        score: 88,
        source_import_id: processImportId,
        source_item_ref: "candidate:vendor-status",
        source_lineage: { source_system: "celonis-export", lineage_ref: "lineage:pm-import-1" },
      });
      check("process mining idea requires and stores import lineage -> 201", processIdea.statusCode === 201, processIdea.body);
      check("process idea lineage round-trip", processIdea.json().source_import_id === processImportId && processIdea.json().source_item_ref === "candidate:vendor-status", processIdea.body);

      const processIdeaMissingLineage = await createIdea(operator, "idea-create-process-missing-lineage", {
        title: "Missing lineage",
        description: "Mining source must not be accepted without import lineage.",
        business_owner: "finance-ops",
        department: "Finance",
        source: "process_mining",
      });
      check("process mining idea without lineage rejected -> 422", processIdeaMissingLineage.statusCode === 422 && processIdeaMissingLineage.json().code === "IR_SCHEMA_INVALID", processIdeaMissingLineage.body);
      check("missing lineage idea did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createAutomationIdea", "idea-create-process-missing-lineage")) === 0);

      const noKey = await createIdea(operator, undefined, {
        title: "No key",
        description: "Missing idempotency key",
        business_owner: "finance-ops",
        department: "Finance",
      });
      check("missing Idempotency-Key -> 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      const viewerDenied = await createIdea(viewer, "viewer-idea-denied", {
        title: "Viewer denied",
        description: "Viewer must not create ideas",
        business_owner: "finance-ops",
        department: "Finance",
      });
      check("viewer create denied -> 403", viewerDenied.statusCode === 403 && viewerDenied.json().code === "AUTHZ_FORBIDDEN", viewerDenied.body);
      check("viewer denied request did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createAutomationIdea", "viewer-idea-denied")) === 0);

      const listed = await app.inject({
        method: "GET",
        url: "/v1/automation-ideas?stage=intake&owner=finance-ops&department=Finance&limit=5",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list ideas -> 200", listed.statusCode === 200, listed.body);
      const listedIdeas = listed.json().items ?? [];
      check(
        "list returns tenant A ideas only",
        listedIdeas.length === 2
          && listedIdeas.some((item: { idea_id?: string }) => item.idea_id === ideaId)
          && listedIdeas.some((item: { source?: string; source_import_id?: string }) => item.source === "process_mining" && item.source_import_id === processImportId),
        listed.body,
      );

      const tenantBGet = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}`,
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("tenant B cannot read tenant A idea -> 404", tenantBGet.statusCode === 404 && tenantBGet.json().code === "RESOURCE_NOT_FOUND", tenantBGet.body);

      const updated = await command("PATCH", `/v1/automation-ideas/${ideaId}`, operator, "idea-update-1", {
        priority: "critical",
        score: 91,
        scenario_id: SCENARIO_A,
        run_trigger_id: TRIGGER_A,
      });
      check("operator update idea links scenario/trigger -> 200", updated.statusCode === 200, updated.body);
      const updatedBody = updated.json();
      check("updated idea link fields round-trip", updatedBody.scenario_id === SCENARIO_A && updatedBody.run_trigger_id === TRIGGER_A && updatedBody.score === 91, updated.body);

      const badLink = await command("PATCH", `/v1/automation-ideas/${ideaId}`, operator, "idea-update-bad-link", {
        run_trigger_id: TRIGGER_B,
      });
      check("cross-tenant run trigger link rejected -> 404", badLink.statusCode === 404 && badLink.json().code === "RESOURCE_NOT_FOUND", badLink.body);

      const transitioned = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, operator, "idea-transition-1", {
        stage: "assess",
      });
      check("transition intake -> assess -> 200", transitioned.statusCode === 200 && transitioned.json().stage === "assess", transitioned.body);

      const operatorApproveDenied = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, operator, "idea-transition-approve-denied", {
        stage: "approved",
      });
      check("operator approve transition denied -> 403", operatorApproveDenied.statusCode === 403 && operatorApproveDenied.json().code === "AUTHZ_FORBIDDEN", operatorApproveDenied.body);
      check("operator denied approve does not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "transitionAutomationIdea", "idea-transition-approve-denied")) === 0);

      const illegalTransition = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, operator, "idea-transition-bad", {
        stage: "operate",
      });
      check("illegal transition assess -> operate -> 422", illegalTransition.statusCode === 422 && illegalTransition.json().code === "IR_SCHEMA_INVALID", illegalTransition.body);

      const approved = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, approver, "idea-transition-approve-1", {
        stage: "approved",
      });
      check("approver transition assess -> approved -> 200", approved.statusCode === 200 && approved.json().stage === "approved", approved.body);

      const adoptionEvidencePayload = {
        evidence_type: "pilot_charter_signoff",
        status: "valid",
        evidence_at: "2026-06-28T00:00:00.000Z",
        expires_at: "2026-12-31T00:00:00.000Z",
        summary: "Pilot charter approved for finance portal exception routing.",
        evidence_ref: "ticket:PILOT-CHARTER-1",
        metadata: {
          business_owner_ref: "group:finance-ops",
          platform_owner_ref: "group:rpa-platform",
          success_criteria_ref: "criteria:pilot-1",
        },
      };
      const adoptionEvidence = await command(
        "POST",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        operator,
        "adoption-evidence-1",
        adoptionEvidencePayload,
      );
      check("operator record adoption evidence -> 201", adoptionEvidence.statusCode === 201, adoptionEvidence.body);
      check(
        "adoption evidence stores pilot charter metadata",
        adoptionEvidence.json().evidence_type === "pilot_charter_signoff" &&
          adoptionEvidence.json().status === "valid" &&
          adoptionEvidence.json().evidence_ref === "ticket:PILOT-CHARTER-1",
        adoptionEvidence.body,
      );

      const adoptionEvidenceReplay = await command(
        "POST",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        operator,
        "adoption-evidence-1",
        adoptionEvidencePayload,
      );
      check(
        "adoption evidence replay returns same evidence",
        adoptionEvidenceReplay.statusCode === 201 && adoptionEvidenceReplay.json().evidence_id === adoptionEvidence.json().evidence_id,
        adoptionEvidenceReplay.body,
      );
      check("adoption evidence replay does not duplicate rows", (await adoptionEvidenceCount(pool, TENANT_A)) === 1);

      const adoptionEvidenceList = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/adoption-evidence?evidence_type=pilot_charter_signoff&status=valid`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check(
        "viewer list adoption evidence -> 200",
        adoptionEvidenceList.statusCode === 200 && adoptionEvidenceList.json().items?.[0]?.evidence_id === adoptionEvidence.json().evidence_id,
        adoptionEvidenceList.body,
      );

      const tenantBAdoptionEvidenceList = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("tenant B cannot list tenant A adoption evidence -> 404", tenantBAdoptionEvidenceList.statusCode === 404, tenantBAdoptionEvidenceList.body);

      const adoptionEvidenceMissingRef = await command(
        "POST",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        operator,
        "adoption-evidence-missing-ref",
        {
          evidence_type: "raci_signoff",
          status: "valid",
          evidence_at: "2026-06-28T00:00:00.000Z",
          expires_at: "2026-12-31T00:00:00.000Z",
          summary: "RACI valid evidence must carry an opaque evidence ref.",
        },
      );
      check(
        "valid adoption evidence requires evidence ref",
        adoptionEvidenceMissingRef.statusCode === 422 && adoptionEvidenceMissingRef.json().details?.reason === "valid_adoption_evidence_ref_required",
        adoptionEvidenceMissingRef.body,
      );
      check(
        "invalid adoption evidence did not reserve idempotency",
        (await idempotencyCount(pool, TENANT_A, "recordAutomationAdoptionEvidence", "adoption-evidence-missing-ref")) === 0,
      );

      const adoptionEvidenceSecretDenied = await command(
        "POST",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        operator,
        "adoption-evidence-secret-denied",
        {
          evidence_type: "training_completion",
          status: "valid",
          evidence_at: "2026-06-28T00:00:00.000Z",
          expires_at: "2026-12-31T00:00:00.000Z",
          summary: "Training completion reconciled.",
          evidence_ref: "ticket:TRAINING-1",
          metadata: { training_roster: "raw user roster must not be stored" },
        },
      );
      check(
        "adoption evidence forbids raw roster metadata",
        adoptionEvidenceSecretDenied.statusCode === 422 && adoptionEvidenceSecretDenied.json().details?.reason === "metadata_secret_or_endpoint_key_forbidden",
        adoptionEvidenceSecretDenied.body,
      );

      const adoptionEvidenceUrlDenied = await command(
        "POST",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        operator,
        "adoption-evidence-url-denied",
        {
          ...adoptionEvidencePayload,
          evidence_ref: "https://example.invalid/pilot-secret",
        },
      );
      check(
        "adoption evidence forbids raw endpoint refs",
        adoptionEvidenceUrlDenied.statusCode === 422 && adoptionEvidenceUrlDenied.json().details?.reason === "raw_endpoint_url_forbidden",
        adoptionEvidenceUrlDenied.body,
      );

      const viewerAdoptionEvidenceDenied = await command(
        "POST",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        viewer,
        "viewer-adoption-evidence-denied",
        adoptionEvidencePayload,
      );
      check("viewer record adoption evidence denied -> 403", viewerAdoptionEvidenceDenied.statusCode === 403 && viewerAdoptionEvidenceDenied.json().code === "AUTHZ_FORBIDDEN", viewerAdoptionEvidenceDenied.body);
      check(
        "viewer denied adoption evidence did not reserve idempotency",
        (await idempotencyCount(pool, TENANT_A, "recordAutomationAdoptionEvidence", "viewer-adoption-evidence-denied")) === 0,
      );

      const roi = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-upsert-1", {
        frequency_per_month: 120,
        minutes_per_case: 8,
        exception_rate: 0.1,
        hourly_cost: 40000,
        implementation_effort: 3200000,
        confidence: "medium",
      });
      check("operator upsert ROI -> 200", roi.statusCode === 200, roi.body);
      const roiBody = roi.json();
      check(
        "ROI monthly hours/value/payback calculated",
        roiBody.monthly_hours_saved === 14.4 &&
          roiBody.estimated_monthly_value === 576000 &&
          roiBody.monthly_value === 576000 &&
          roiBody.viability === "viable" &&
          Math.abs(roiBody.payback_months - 5.56) < 0.001,
        roi.body,
      );

      const roiReplay = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-upsert-1", {
        frequency_per_month: 120,
        minutes_per_case: 8,
        exception_rate: 0.1,
        hourly_cost: 40000,
        implementation_effort: 3200000,
        confidence: "medium",
      });
      check("ROI replay returns same estimate", roiReplay.statusCode === 200 && roiReplay.json().roi_estimate_id === roiBody.roi_estimate_id, roiReplay.body);
      check("ROI replay does not duplicate rows", (await roiCount(pool, TENANT_A)) === 1);

      const roiNotViable = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-not-viable-1", {
        frequency_per_month: 10,
        minutes_per_case: 6,
        exception_rate: 0,
        hourly_cost: 10000,
        implementation_effort: 1200000,
        platform_monthly_cost: 200000,
        avoided_license_cost: 0,
        confidence: "low",
      });
      check("ROI net negative is not viable without payback", roiNotViable.statusCode === 200, roiNotViable.body);
      const roiNotViableBody = roiNotViable.json();
      check(
        "ROI monthly_value <= 0 returns null payback and not_viable",
        roiNotViableBody.estimated_monthly_value === 10000 &&
          roiNotViableBody.monthly_value === -190000 &&
          roiNotViableBody.payback_months === null &&
          roiNotViableBody.viability === "not_viable",
        roiNotViable.body,
      );

      const roiOverflow = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-overflow-denied", {
        frequency_per_month: 1_000_000,
        minutes_per_case: 600_000,
        exception_rate: 0,
        hourly_cost: 1,
        implementation_effort: 1,
        confidence: "medium",
      });
      check(
        "ROI calculated overflow rejected before DB write -> 422",
        roiOverflow.statusCode === 422 &&
          roiOverflow.json().details?.reason === "roi_metric_out_of_range" &&
          roiOverflow.json().details?.metric === "monthly_hours_saved",
        roiOverflow.body,
      );
      check("ROI overflow did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "upsertRoiEstimate", "roi-overflow-denied")) === 0);

      const roiGet = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/roi-estimate`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer get ROI -> 200", roiGet.statusCode === 200 && roiGet.json().automation_idea_id === ideaId, roiGet.body);

      const roiActual = await command("POST", `/v1/automation-ideas/${ideaId}/roi-actuals`, operator, "roi-actual-1", {
        period_start: "2026-06-01",
        period_end: "2026-06-28",
        actual_transaction_count: 420,
        actual_failure_rate: 0.07,
        human_intervention_minutes: 180,
        reprocessing_minutes: 45,
        evidence_ref: "ticket:ROI-ACTUAL-1",
        summary: "Pilot actuals reconciled from run, review, and reprocessing evidence.",
        metadata: { measurement_method: "pilot_reconciliation" },
      });
      check("operator record ROI actual evidence -> 201", roiActual.statusCode === 201, roiActual.body);
      check(
        "ROI actual evidence separates actual pilot metrics",
        roiActual.json().actual_transaction_count === 420 &&
          roiActual.json().actual_failure_rate === 0.07 &&
          roiActual.json().human_intervention_minutes === 180 &&
          roiActual.json().reprocessing_minutes === 45,
        roiActual.body,
      );
      const roiActualReplay = await command("POST", `/v1/automation-ideas/${ideaId}/roi-actuals`, operator, "roi-actual-1", {
        period_start: "2026-06-01",
        period_end: "2026-06-28",
        actual_transaction_count: 420,
        actual_failure_rate: 0.07,
        human_intervention_minutes: 180,
        reprocessing_minutes: 45,
        evidence_ref: "ticket:ROI-ACTUAL-1",
        summary: "Pilot actuals reconciled from run, review, and reprocessing evidence.",
        metadata: { measurement_method: "pilot_reconciliation" },
      });
      check("ROI actual replay returns same evidence", roiActualReplay.statusCode === 201 && roiActualReplay.json().roi_actual_id === roiActual.json().roi_actual_id, roiActualReplay.body);
      check("ROI actual replay does not duplicate rows", (await roiActualCount(pool, TENANT_A)) === 1);

      const roiActualList = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/roi-actuals`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list ROI actual evidence -> 200", roiActualList.statusCode === 200 && roiActualList.json().items?.length === 1, roiActualList.body);

      const tenantBRoiActualList = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/roi-actuals`,
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("tenant B cannot list tenant A ROI actual evidence -> 404", tenantBRoiActualList.statusCode === 404, tenantBRoiActualList.body);

      const roiActualSecretDenied = await command("POST", `/v1/automation-ideas/${ideaId}/roi-actuals`, operator, "roi-actual-secret-denied", {
        period_start: "2026-06-01",
        period_end: "2026-06-28",
        actual_transaction_count: 1,
        actual_failure_rate: 0,
        human_intervention_minutes: 0,
        reprocessing_minutes: 0,
        evidence_ref: "ticket:ROI-ACTUAL-SECRET",
        summary: "See https://hooks.example.invalid/secret",
      });
      check("ROI actual secret-like summary rejected -> 422", roiActualSecretDenied.statusCode === 422 && roiActualSecretDenied.json().code === "IR_SCHEMA_INVALID", roiActualSecretDenied.body);
      check("ROI actual invalid evidence did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "recordRoiActualEvidence", "roi-actual-secret-denied")) === 0);

      const viewerRoiActualDenied = await command("POST", `/v1/automation-ideas/${ideaId}/roi-actuals`, viewer, "viewer-roi-actual-denied", {
        period_start: "2026-06-01",
        period_end: "2026-06-28",
        actual_transaction_count: 1,
        actual_failure_rate: 0,
        human_intervention_minutes: 0,
        reprocessing_minutes: 0,
        evidence_ref: "ticket:ROI-ACTUAL-VIEWER",
        summary: "Viewer must not record actuals.",
      });
      check("viewer record ROI actual denied -> 403", viewerRoiActualDenied.statusCode === 403 && viewerRoiActualDenied.json().code === "AUTHZ_FORBIDDEN", viewerRoiActualDenied.body);
      check("viewer denied ROI actual did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "recordRoiActualEvidence", "viewer-roi-actual-denied")) === 0);

      const viewerRoiDenied = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, viewer, "viewer-roi-denied", {
        frequency_per_month: 1,
        minutes_per_case: 1,
        exception_rate: 0,
        hourly_cost: 1,
        implementation_effort: 1,
      });
      check("viewer upsert ROI denied -> 403", viewerRoiDenied.statusCode === 403 && viewerRoiDenied.json().code === "AUTHZ_FORBIDDEN", viewerRoiDenied.body);
      check("viewer denied ROI request did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "upsertRoiEstimate", "viewer-roi-denied")) === 0);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`api-automation-ideas.int: ${failures} failed`);
    process.exit(1);
  }
  console.log("api-automation-ideas.int: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
