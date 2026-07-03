import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { insertAuditVerificationRun } from "../src/runtime/audit-verification-runs";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import { buildServer } from "../src/api/server";
import type { AuthReadinessConfig } from "../src/api/server-shared";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_scenario_releases_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER_A = "85000000-0000-4000-8000-000000000101";
const WORKER_B = "85000000-0000-4000-8000-000000000102";
const SECRET = new TextEncoder().encode("scenario-releases-int-secret-do-not-use-in-prod-0123456789");
const SSO_READY: AuthReadinessConfig = {
  mode: "jwks",
  configurationSource: "deployment_config",
  jwksUrl: "https://idp.example.com/.well-known/jwks.json",
  issuer: "https://idp.example.com/",
  audience: "rpa-control-plane",
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

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

function validIr(name: string, version: number) {
  return {
    meta: { name, version },
    start: "n1",
    nodes: {
      n1: { on: [{ when: "flags.not_found", target: "done", priority: 1 }] },
      done: { terminal: "success" },
    },
  };
}

async function createSubmitApproveDeploy(
  app: ReturnType<typeof buildServer>,
  scenarioId: string,
  sourceVersion: number,
  target: "staging" | "prod",
  latestVersion: number,
  operator: string,
  admin: string,
  keyPrefix: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/v1/scenarios/${scenarioId}/releases`,
    headers: { authorization: `Bearer ${operator}`, "idempotency-key": `${keyPrefix}-create` },
    payload: { source_version: sourceVersion, target_environment: target, reason: `${keyPrefix} release` },
  });
  check(`${keyPrefix} create release`, created.statusCode === 201 && created.json().status === "draft", created.body);
  const releaseId = created.json().release_id as string;

  const submitted = await app.inject({
    method: "POST",
    url: `/v1/scenario-releases/${releaseId}/submit`,
    headers: { authorization: `Bearer ${operator}`, "idempotency-key": `${keyPrefix}-submit` },
    payload: {},
  });
  check(`${keyPrefix} submit release`, submitted.statusCode === 200 && submitted.json().status === "submitted", submitted.body);

  const approved = await app.inject({
    method: "POST",
    url: `/v1/scenario-releases/${releaseId}/approve`,
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": `${keyPrefix}-approve` },
    payload: { reason: "admin approval" },
  });
  check(`${keyPrefix} approve release`, approved.statusCode === 200 && approved.json().status === "approved", approved.body);

  const deployed = await app.inject({
    method: "POST",
    url: `/v1/scenario-releases/${releaseId}/deploy`,
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": `${keyPrefix}-deploy`, "if-match": String(latestVersion) },
    payload: {},
  });
  check(`${keyPrefix} deploy release`, deployed.statusCode === 200 && deployed.json().status === "deployed", deployed.body);
  check(`${keyPrefix} binding returned`, deployed.json().current_binding?.environment === target, deployed.body);
  return releaseId;
}

async function seedControlledProdReadiness(pool: ReturnType<typeof createPool>): Promise<void> {
  const direct = await pool.connect();
  try {
    await direct.query(`SET search_path = ${SCHEMA}, public`);
    await direct.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, status text NOT NULL)`);
    await direct.query(
      `INSERT INTO schema_migrations (version, status)
       VALUES ('0001','applied'), ('0002','applied')
       ON CONFLICT (version) DO UPDATE SET status=EXCLUDED.status`,
    );
    await direct.query(`CREATE SCHEMA IF NOT EXISTS graphile_worker`);
    await direct.query(`CREATE TABLE IF NOT EXISTS graphile_worker.jobs (id serial PRIMARY KEY, locked_at timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    await direct.query(
      `INSERT INTO workers (id, kind, status, heartbeat_at, circuit_state)
       VALUES ($1,'browser','active',now(),'closed'), ($2,'browser','active',now(),'closed')
       ON CONFLICT (id) DO UPDATE SET status='active', heartbeat_at=now(), circuit_state='closed'`,
      [WORKER_A, WORKER_B],
    );
    await direct.query(
      `INSERT INTO worker_pools (pool_key, description, max_concurrency, priority)
       VALUES ('prod-release-readiness', 'prod release readiness pool', 2, 'high')
       ON CONFLICT (pool_key) DO UPDATE SET description=EXCLUDED.description, max_concurrency=2, priority='high'`,
    );
    await direct.query(
      `INSERT INTO worker_pool_memberships (worker_id, pool_key, assigned_by)
       VALUES ($1, 'prod-release-readiness', 'admin-a'), ($2, 'prod-release-readiness', 'admin-a')
       ON CONFLICT (worker_id) DO UPDATE SET pool_key=EXCLUDED.pool_key, assigned_by=EXCLUDED.assigned_by`,
      [WORKER_A, WORKER_B],
    );
  } finally {
    direct.release();
  }

  await withTenantTx(pool, TENANT, async (client) => {
    await client.query(
      `INSERT INTO worker_pool_assignments (tenant_id, pool_key)
       VALUES ($1::uuid, 'prod-release-readiness')
       ON CONFLICT (tenant_id) DO UPDATE SET pool_key=EXCLUDED.pool_key`,
      [TENANT],
    );
    await insertAuditVerificationRun(client, {
      tenantId: TENANT,
      result: {
        tenantId: TENANT,
        valid: true,
        rowsChecked: 1,
        violations: [],
        checkedFromSequence: 1,
        checkedToSequence: 1,
      },
      startedAt: new Date(),
      completedAt: new Date(),
      correlationId: "85000000-0000-4000-8000-000000000301",
      triggeredBy: { subjectId: "ad", roles: ["admin"] },
      triggerKind: "manual_api",
      legalHold: false,
    });
    await client.query(
      `INSERT INTO production_readiness_evidence (
         id, tenant_id, evidence_type, status, evidence_at, expires_at,
         summary, evidence_ref, metadata, recorded_by, retention_until, legal_hold
       )
       VALUES
         (
           gen_random_uuid(), $1::uuid, 'external_alert_delivery', 'valid', now(), now() + interval '90 days',
           'External alert delivery drill receipt verified for prod release.',
           'ticket:OPS-900',
           '{"channel":"teams","provider_alias":"teams-primary","receipt_id":"receipt-prod-release","receipt_at":"2026-06-29T00:05:30.000Z","delivery_status":"delivered"}'::jsonb,
           'admin-a', now() + interval '365 days', false
         ),
         (
           gen_random_uuid(), $1::uuid, 'managed_backup_restore_drill', 'valid', now(), now() + interval '90 days',
           'Managed backup/PITR restore drill completed within target.',
           'drill:PITR-prod-release',
           '{"backup_policy_ref":"backup-policy:managed-pg-prod","restore_scope":"tenant-control-plane","restore_completed_at":"2026-06-29T00:30:00.000Z","rto_minutes":20,"rpo_minutes":5}'::jsonb,
           'admin-a', now() + interval '365 days', false
         ),
          (
            gen_random_uuid(), $1::uuid, 'slo_oncall_signoff', 'valid', now(), now() + interval '90 days',
            'SLO dashboard, severity policy, and on-call/RACI sign-off approved.',
            'ticket:SRE-900',
            '{"slo_dashboard":"grafana-folder-rpa","severity_model":"sev1-sev4","oncall_rota":"primary-secondary","raci_ref":"raci:SRE-RPA","support_hours":"24x7"}'::jsonb,
            'admin-a', now() + interval '365 days', false
          ),
          (
            gen_random_uuid(), $1::uuid, 'observability_telemetry_wiring', 'valid', now(), now() + interval '90 days',
            'OTLP/Prometheus telemetry wiring sampled with dashboard and alert route.',
            'ticket:OBS-900',
            '{"exporter":"prometheus","collector_ref":"otel-collector:rpa-prod","dashboard_ref":"grafana-folder-rpa","alert_route_ref":"alert-route:rpa-sev","sampled_at":"2026-06-29T00:10:00.000Z"}'::jsonb,
            'admin-a', now() + interval '365 days', false
          ),
          (
            gen_random_uuid(), $1::uuid, 'support_training_completion', 'valid', now(), now() + interval '90 days',
            'Support model and role training completion approved.',
            'ticket:TRAIN-900',
            '{"support_model_ref":"support-model:L1-L3","training_completion_ref":"training:completion-prod","trained_role_count":3,"trained_user_count":18,"coverage_percent":100,"completed_at":"2026-06-29T00:20:00.000Z"}'::jsonb,
            'admin-a', now() + interval '365 days', false
          )`,
      [TENANT],
    );
  });
}

async function recordSloReadinessEvidence(
  pool: ReturnType<typeof createPool>,
  status: "valid" | "failed",
  evidenceAt: string,
): Promise<void> {
  await withTenantTx(pool, TENANT, async (client) => {
    await client.query(
      `INSERT INTO production_readiness_evidence (
         id, tenant_id, evidence_type, status, evidence_at, expires_at,
         summary, evidence_ref, metadata, recorded_by, retention_until, legal_hold
       )
       VALUES (
         gen_random_uuid(), $1::uuid, 'slo_oncall_signoff', $2, $3::timestamptz,
         CASE WHEN $2 = 'valid' THEN $3::timestamptz + interval '90 days' ELSE NULL END,
         CASE WHEN $2 = 'valid'
           THEN 'SLO dashboard, severity policy, and on-call/RACI sign-off approved.'
           ELSE 'SLO/on-call coverage regressed before prod deploy.'
         END,
         CASE WHEN $2 = 'valid' THEN 'ticket:SRE-901' ELSE 'ticket:SRE-REGRESSED' END,
         CASE WHEN $2 = 'valid'
           THEN '{"slo_dashboard":"grafana-folder-rpa","severity_model":"sev1-sev4","oncall_rota":"primary-secondary","raci_ref":"raci:SRE-RPA","support_hours":"24x7"}'::jsonb
           ELSE '{"slo_dashboard":"grafana-folder-rpa","oncall_gap":"secondary_missing"}'::jsonb
         END,
         'admin-a', $3::timestamptz + interval '365 days', false
       )`,
      [TENANT, status, evidenceAt],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`DROP SCHEMA IF EXISTS graphile_worker CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
      enforceAlmMakerChecker: true,
      authReadiness: SSO_READY,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: "op", tenant_id: TENANT, roles: ["operator"] });
      const admin = await mint({ sub: "ad", tenant_id: TENANT, roles: ["admin"] });

      const created = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: validIr("release-scenario", 1),
      });
      check("create scenario v1", created.statusCode === 201, created.body);
      const scenarioId = created.json().scenario_id as string;

      const legacyPromote = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/promote`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "legacy-promote", "if-match": "1" },
        payload: { target: "prod" },
      });
      check("enterprise mode blocks legacy promote", legacyPromote.statusCode === 422 && legacyPromote.json().details?.reason === "legacy_promote_disabled_by_enterprise_alm", legacyPromote.body);

      const uncertified = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/releases`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "uncertified-create" },
        payload: { source_version: 1, target_environment: "prod", reason: "certification gate negative" },
      });
      check("uncertified prod release can be drafted", uncertified.statusCode === 201 && uncertified.json().status === "draft", uncertified.body);
      const uncertifiedReleaseId = uncertified.json().release_id as string;
      const operatorGovernanceDenied = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/1/governance-stage`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "governance-operator-denied" },
        payload: { stage: "pilot", reason: "pilot charter accepted", evidence_ref: "ticket:GOV-OP-DENIED" },
      });
      check("operator cannot set scenario governance stage", operatorGovernanceDenied.statusCode === 403, operatorGovernanceDenied.body);

      const governanceUrlDenied = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/1/governance-stage`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "governance-url-denied" },
        payload: {
          stage: "pilot",
          reason: "pilot charter accepted",
          evidence_ref: "https://example.invalid/governance",
        },
      });
      check(
        "governance evidence forbids raw URL refs",
        governanceUrlDenied.statusCode === 422 && governanceUrlDenied.json().details?.reason === "raw_endpoint_url_forbidden",
        governanceUrlDenied.body,
      );

      const pilotGovernance = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/1/governance-stage`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "governance-pilot-v1" },
        payload: {
          stage: "pilot",
          reason: "pilot charter and RACI accepted",
          evidence_ref: "ticket:GOV-PILOT-1",
          metadata: { pilot_charter_ref: "ticket:PILOT-1", raci_ref: "raci:finance-rpa" },
        },
      });
      check("admin sets pilot governance stage", pilotGovernance.statusCode === 200, pilotGovernance.body);
      check(
        "pilot governance is not prod certification",
        pilotGovernance.json().certification?.governance_stage === "pilot" &&
          pilotGovernance.json().certification?.status === "uncertified" &&
          pilotGovernance.json().certification?.valid_for_prod === false,
        pilotGovernance.body,
      );

      await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${uncertifiedReleaseId}/submit`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "uncertified-submit" },
        payload: {},
      });
      const uncertifiedApprove = await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${uncertifiedReleaseId}/approve`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "uncertified-approve" },
        payload: { reason: "should block" },
      });
      check(
        "prod approval blocked until source version is certified",
        uncertifiedApprove.statusCode === 422 && uncertifiedApprove.json().details?.reason === "certification_required_for_prod",
        uncertifiedApprove.body,
      );

      const certifiedV1 = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/1/certify`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "certify-v1" },
        payload: { reason: "pilot evidence accepted" },
      });
      check("certify v1 for prod release", certifiedV1.statusCode === 200 && certifiedV1.json().certification?.valid_for_prod === true, certifiedV1.body);

      const readinessBlocked = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/releases`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "readiness-blocked-create" },
        payload: { source_version: 1, target_environment: "prod", reason: "readiness gate negative" },
      });
      check("certified prod release can be drafted before readiness closes",
        readinessBlocked.statusCode === 201 && readinessBlocked.json().status === "draft",
        readinessBlocked.body);
      const readinessBlockedReleaseId = readinessBlocked.json().release_id as string;
      await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${readinessBlockedReleaseId}/submit`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "readiness-blocked-submit" },
        payload: {},
      });
      const readinessBlockedApprove = await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${readinessBlockedReleaseId}/approve`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-blocked-approve" },
        payload: { reason: "should block until controlled-prod readiness is ready" },
      });
      check(
        "prod approval blocked until controlled-prod readiness is ready",
        readinessBlockedApprove.statusCode === 422 &&
          readinessBlockedApprove.json().details?.reason === "controlled_prod_readiness_required" &&
          readinessBlockedApprove.json().details?.deferred_count >= 1,
        readinessBlockedApprove.body,
      );

      await seedControlledProdReadiness(pool);

      const missingAudienceApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        enforceAlmMakerChecker: true,
        authReadiness: {
          mode: "jwks",
          configurationSource: "deployment_config",
          jwksUrl: "https://idp.example.com/.well-known/jwks.json",
          issuer: "https://idp.example.com/",
        },
      });
      await missingAudienceApp.ready();
      try {
        const authBlocked = await missingAudienceApp.inject({
          method: "POST",
          url: `/v1/scenarios/${scenarioId}/releases`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "auth-readiness-blocked-create" },
          payload: { source_version: 1, target_environment: "prod", reason: "auth readiness negative" },
        });
        check("auth readiness negative prod release can be drafted",
          authBlocked.statusCode === 201 && authBlocked.json().status === "draft",
          authBlocked.body);
        const authBlockedReleaseId = authBlocked.json().release_id as string;
        await missingAudienceApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${authBlockedReleaseId}/submit`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "auth-readiness-blocked-submit" },
          payload: {},
        });
        const authBlockedApprove = await missingAudienceApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${authBlockedReleaseId}/approve`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "auth-readiness-blocked-approve" },
          payload: { reason: "should block until SSO audience is configured" },
        });
        check("prod approval blocked by auth SSO readiness",
          authBlockedApprove.statusCode === 422 &&
            authBlockedApprove.json().details?.reason === "controlled_prod_readiness_required" &&
            authBlockedApprove.json().details?.blocking_gate_ids?.includes("auth_sso_readiness"),
          authBlockedApprove.body);
      } finally {
        await missingAudienceApp.close();
      }

      const configuredModelReleaseApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        enforceAlmMakerChecker: true,
        authReadiness: SSO_READY,
        aiGovernanceConfiguredModels: ["codex-release-gate"],
      });
      await configuredModelReleaseApp.ready();
      try {
        const aiModelBlocked = await configuredModelReleaseApp.inject({
          method: "POST",
          url: `/v1/scenarios/${scenarioId}/releases`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-model-readiness-blocked-create" },
          payload: { source_version: 1, target_environment: "prod", reason: "configured model readiness negative" },
        });
        check("configured model readiness negative prod release can be drafted",
          aiModelBlocked.statusCode === 201 && aiModelBlocked.json().status === "draft",
          aiModelBlocked.body);
        const aiModelBlockedReleaseId = aiModelBlocked.json().release_id as string;
        await configuredModelReleaseApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiModelBlockedReleaseId}/submit`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-model-readiness-blocked-submit" },
          payload: {},
        });
        const aiModelBlockedApprove = await configuredModelReleaseApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiModelBlockedReleaseId}/approve`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-model-readiness-blocked-approve" },
          payload: { reason: "should block until AI model governance policy is configured" },
        });
        check("prod approval blocked by configured AI model readiness",
          aiModelBlockedApprove.statusCode === 422 &&
            aiModelBlockedApprove.json().details?.reason === "controlled_prod_readiness_required" &&
            aiModelBlockedApprove.json().details?.deferred_gate_ids?.includes("ai_governance_runtime"),
          aiModelBlockedApprove.body);

        const aiModelDeploy = await app.inject({
          method: "POST",
          url: `/v1/scenarios/${scenarioId}/releases`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-model-deploy-blocked-create" },
          payload: { source_version: 1, target_environment: "prod", reason: "configured model deploy gate negative" },
        });
        check("configured model deploy regression release can be drafted by ready app",
          aiModelDeploy.statusCode === 201 && aiModelDeploy.json().status === "draft",
          aiModelDeploy.body);
        const aiModelDeployReleaseId = aiModelDeploy.json().release_id as string;
        await app.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiModelDeployReleaseId}/submit`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-model-deploy-blocked-submit" },
          payload: {},
        });
        const aiModelDeployApprove = await app.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiModelDeployReleaseId}/approve`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-model-deploy-blocked-approve" },
          payload: { reason: "ready app approval" },
        });
        check("configured model deploy regression release can be approved by ready app",
          aiModelDeployApprove.statusCode === 200 && aiModelDeployApprove.json().status === "approved",
          aiModelDeployApprove.body);
        const aiModelDeployBlocked = await configuredModelReleaseApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiModelDeployReleaseId}/deploy`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-model-deploy-blocked-deploy", "if-match": "1" },
          payload: {},
        });
        check("prod deploy blocked by configured AI model readiness",
          aiModelDeployBlocked.statusCode === 422 &&
            aiModelDeployBlocked.json().details?.reason === "controlled_prod_readiness_required" &&
            aiModelDeployBlocked.json().details?.deferred_gate_ids?.includes("ai_governance_runtime"),
          aiModelDeployBlocked.body);
      } finally {
        await configuredModelReleaseApp.close();
      }

      const configuredPromptReleaseApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        enforceAlmMakerChecker: true,
        authReadiness: SSO_READY,
        aiGovernanceConfiguredPromptVersions: ["dom-executor@release-gate"],
      });
      await configuredPromptReleaseApp.ready();
      try {
        const aiPromptBlocked = await configuredPromptReleaseApp.inject({
          method: "POST",
          url: `/v1/scenarios/${scenarioId}/releases`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-prompt-readiness-blocked-create" },
          payload: { source_version: 1, target_environment: "prod", reason: "configured prompt readiness negative" },
        });
        check("configured prompt readiness negative prod release can be drafted",
          aiPromptBlocked.statusCode === 201 && aiPromptBlocked.json().status === "draft",
          aiPromptBlocked.body);
        const aiPromptBlockedReleaseId = aiPromptBlocked.json().release_id as string;
        await configuredPromptReleaseApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiPromptBlockedReleaseId}/submit`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-prompt-readiness-blocked-submit" },
          payload: {},
        });
        const aiPromptBlockedApprove = await configuredPromptReleaseApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiPromptBlockedReleaseId}/approve`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-prompt-readiness-blocked-approve" },
          payload: { reason: "should block until AI prompt governance policy is configured" },
        });
        check("prod approval blocked by configured AI prompt readiness",
          aiPromptBlockedApprove.statusCode === 422 &&
            aiPromptBlockedApprove.json().details?.reason === "controlled_prod_readiness_required" &&
            aiPromptBlockedApprove.json().details?.deferred_gate_ids?.includes("ai_governance_runtime"),
          aiPromptBlockedApprove.body);

        const aiPromptDeploy = await app.inject({
          method: "POST",
          url: `/v1/scenarios/${scenarioId}/releases`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-prompt-deploy-blocked-create" },
          payload: { source_version: 1, target_environment: "prod", reason: "configured prompt deploy gate negative" },
        });
        check("configured prompt deploy regression release can be drafted by ready app",
          aiPromptDeploy.statusCode === 201 && aiPromptDeploy.json().status === "draft",
          aiPromptDeploy.body);
        const aiPromptDeployReleaseId = aiPromptDeploy.json().release_id as string;
        await app.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiPromptDeployReleaseId}/submit`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ai-prompt-deploy-blocked-submit" },
          payload: {},
        });
        const aiPromptDeployApprove = await app.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiPromptDeployReleaseId}/approve`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-prompt-deploy-blocked-approve" },
          payload: { reason: "ready app approval" },
        });
        check("configured prompt deploy regression release can be approved by ready app",
          aiPromptDeployApprove.statusCode === 200 && aiPromptDeployApprove.json().status === "approved",
          aiPromptDeployApprove.body);
        const aiPromptDeployBlocked = await configuredPromptReleaseApp.inject({
          method: "POST",
          url: `/v1/scenario-releases/${aiPromptDeployReleaseId}/deploy`,
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-prompt-deploy-blocked-deploy", "if-match": "1" },
          payload: {},
        });
        check("prod deploy blocked by configured AI prompt readiness",
          aiPromptDeployBlocked.statusCode === 422 &&
            aiPromptDeployBlocked.json().details?.reason === "controlled_prod_readiness_required" &&
            aiPromptDeployBlocked.json().details?.deferred_gate_ids?.includes("ai_governance_runtime"),
          aiPromptDeployBlocked.body);
      } finally {
        await configuredPromptReleaseApp.close();
      }

      const deployBlocked = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/releases`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "deploy-blocked-create" },
        payload: { source_version: 1, target_environment: "prod", reason: "deploy readiness regression" },
      });
      check("ready prod release can be drafted for deploy regression test",
        deployBlocked.statusCode === 201 && deployBlocked.json().status === "draft",
        deployBlocked.body);
      const deployBlockedReleaseId = deployBlocked.json().release_id as string;
      await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${deployBlockedReleaseId}/submit`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "deploy-blocked-submit" },
        payload: {},
      });
      const deployBlockedApprove = await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${deployBlockedReleaseId}/approve`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "deploy-blocked-approve" },
        payload: { reason: "ready at approval time" },
      });
      check("prod approval succeeds while controlled-prod readiness is ready",
        deployBlockedApprove.statusCode === 200 && deployBlockedApprove.json().status === "approved",
        deployBlockedApprove.body);
      await recordSloReadinessEvidence(pool, "failed", new Date(Date.now() + 60_000).toISOString());
      const deployBlockedByReadiness = await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${deployBlockedReleaseId}/deploy`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "deploy-blocked-deploy", "if-match": "1" },
        payload: {},
      });
      check("prod deploy blocked if controlled-prod readiness regresses after approval",
        deployBlockedByReadiness.statusCode === 422 &&
          deployBlockedByReadiness.json().details?.reason === "controlled_prod_readiness_required" &&
          deployBlockedByReadiness.json().details?.blocking_gate_ids?.includes("slo_oncall_signoff"),
        deployBlockedByReadiness.body);
      await recordSloReadinessEvidence(pool, "valid", new Date(Date.now() + 120_000).toISOString());

      const releaseV1 = await createSubmitApproveDeploy(app, scenarioId, 1, "prod", 1, operator, admin, "v1");

      const prodAfterV1 = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ status: string; binding_count: number }>(
          `SELECT
             (SELECT promotion_status FROM scenario_versions WHERE scenario_id=$1::uuid AND version=1) AS status,
             (SELECT count(*)::int FROM scenario_environment_bindings WHERE scenario_id=$1::uuid AND environment='prod' AND deactivated_at IS NULL) AS binding_count`,
          [scenarioId],
        );
        return r.rows[0];
      });
      check("v1 deploy mirrors prod marker and binding", prodAfterV1?.status === "prod" && prodAfterV1.binding_count === 1, JSON.stringify(prodAfterV1));

      const updated = await app.inject({
        method: "PUT",
        url: `/v1/scenarios/${scenarioId}`,
        headers: { authorization: `Bearer ${operator}`, "if-match": "1" },
        payload: validIr("release-scenario", 2),
      });
      check("update scenario v2", updated.statusCode === 200 && updated.json().version === 2, updated.body);

      const certifiedV2 = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/2/certify`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "certify-v2" },
        payload: { reason: "pilot evidence accepted" },
      });
      check("certify v2 for prod release", certifiedV2.statusCode === 200 && certifiedV2.json().certification?.status === "certified", certifiedV2.body);

      const releaseV2 = await createSubmitApproveDeploy(app, scenarioId, 2, "prod", 2, operator, admin, "v2");

      const rollback = await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${releaseV2}/rollback`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "rollback-v2", "if-match": "2" },
        payload: {},
      });
      check("rollback deployed release → 201", rollback.statusCode === 201 && rollback.json().status === "deployed", rollback.body);
      check("rollback binding points to v1", rollback.json().current_binding?.version === 1, rollback.body);

      const rolledBack = await app.inject({
        method: "GET",
        url: `/v1/scenario-releases/${releaseV2}`,
        headers: { authorization: `Bearer ${admin}` },
      });
      check("original release marked rolled_back", rolledBack.statusCode === 200 && rolledBack.json().status === "rolled_back", rolledBack.body);

      const selfMade = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/releases`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "self-made-create" },
        payload: { source_version: 1, target_environment: "staging", reason: "maker checker negative" },
      });
      const selfReleaseId = selfMade.json().release_id as string;
      await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${selfReleaseId}/submit`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "self-made-submit" },
        payload: {},
      });
      const selfApprove = await app.inject({
        method: "POST",
        url: `/v1/scenario-releases/${selfReleaseId}/approve`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "self-made-approve" },
        payload: {},
      });
      check("maker-checker self approval denied", selfApprove.statusCode === 403 && selfApprove.json().code === "AUTHZ_FORBIDDEN", selfApprove.body);

      const auditCount = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'scenario_release.%'`,
        );
        return r.rows[0]?.n ?? 0;
      });
      check("release audit rows appended", auditCount >= 8, String(auditCount));
      check("release ids produced", typeof releaseV1 === "string" && typeof releaseV2 === "string");
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
