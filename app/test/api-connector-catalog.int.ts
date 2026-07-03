/**
 * Integration test for /v1/connectors and /v1/templates.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/api-connector-catalog.int.ts
 */
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import { buildServer } from "../src/api/server";
import { createPool } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "api_connector_catalog_int";
const SECRET = new TextEncoder().encode("connector-catalog-int-secret-do-not-use-in-prod-0123456789");

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

function mint(roles: string[], sub = "viewer-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: TENANT_A, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
  });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }

    await app.ready();
    const viewer = await mint(["viewer"]);
    const admin = await mint(["admin"], "admin-a");
    const noRole = await mint([]);

    const connectors = await app.inject({ method: "GET", url: "/v1/connectors?kind=browser", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list connectors -> 200", connectors.statusCode === 200, connectors.body);
    const connectorBody = JSON.parse(connectors.body) as { items: Array<{ connector_id: string; required_secret_refs: string[]; status: string }> };
    check("browser filter returns sap-web", connectorBody.items.some((item) => item.connector_id === "sap-web"), connectors.body);
    check("secret values are not exposed", !connectors.body.includes("token") && !connectors.body.includes("password") && !connectors.body.includes("cookie"), connectors.body);
    check("SecretRef namespace exposed as metadata only", connectorBody.items.some((item) => item.required_secret_refs.some((ref) => ref.startsWith("secret://"))), connectors.body);

    const fileConnectors = await app.inject({ method: "GET", url: "/v1/connectors?kind=file", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list file connectors -> 200", fileConnectors.statusCode === 200, fileConnectors.body);
    const fileConnectorBody = JSON.parse(fileConnectors.body) as {
      items: Array<{ connector_id: string; implementation_state: string; security_notes: string[]; required_secret_refs: string[] }>;
    };
    const idpConnector = fileConnectorBody.items.find((item) => item.connector_id === "document-idp");
    check("file connector catalog includes document-idp", idpConnector !== undefined, fileConnectors.body);
    check("document-idp records built-in deterministic engine decision", idpConnector?.implementation_state.includes("built_in_deterministic_text_v1") === true, fileConnectors.body);
    check("document-idp P1 does not require external OCR/vision secrets", idpConnector?.required_secret_refs.length === 0, fileConnectors.body);
    check("document-idp security notes keep document bytes tenant-local", idpConnector?.security_notes.some((note) => note.includes("테넌트 경계 안에 머뭅니다")) === true, fileConnectors.body);

    const notificationConnectors = await app.inject({ method: "GET", url: "/v1/connectors?kind=notification", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list notification connectors -> 200", notificationConnectors.statusCode === 200, notificationConnectors.body);
    const notificationConnectorBody = JSON.parse(notificationConnectors.body) as {
      items: Array<{ connector_id: string; status: string; supported_actions: string[]; required_secret_refs: string[]; implementation_state: string }>;
    };
    const opsWebhookConnector = notificationConnectorBody.items.find((item) => item.connector_id === "ops-webhook-sender");
    check(
      "ops webhook connector is implemented and SecretRef-backed",
      opsWebhookConnector !== undefined &&
        opsWebhookConnector.status === "available" &&
        opsWebhookConnector.required_secret_refs.every((ref) => ref.startsWith("secret://")) &&
        opsWebhookConnector.supported_actions.includes("notify") &&
        opsWebhookConnector.implementation_state.includes("/v1/ops-alerts"),
      notificationConnectors.body,
    );

    const templates = await app.inject({ method: "GET", url: "/v1/templates?connector_id=sap-web", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list templates -> 200", templates.statusCode === 200, templates.body);
    const templateBody = JSON.parse(templates.body) as { items: Array<{ template_id: string; connector_id: string }> };
    check("template connector filter returns sap-web templates", templateBody.items.length > 0 && templateBody.items.every((item) => item.connector_id === "sap-web"), templates.body);

    const idpTemplates = await app.inject({ method: "GET", url: "/v1/templates?connector_id=document-idp", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list document-idp templates -> 200", idpTemplates.statusCode === 200, idpTemplates.body);
    const idpTemplateBody = JSON.parse(idpTemplates.body) as { items: Array<{ template_id: string; produced_ir_pattern: string }> };
    check("document-idp template opens validation flow", idpTemplateBody.items.some((item) => item.template_id === "document-idp-validation" && item.produced_ir_pattern.includes("human_task(validation)")), idpTemplates.body);

    const httpTemplates = await app.inject({ method: "GET", url: "/v1/templates?connector_id=http-api", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list http-api templates -> 200", httpTemplates.statusCode === 200, httpTemplates.body);
    const httpTemplateBody = JSON.parse(httpTemplates.body) as { items: Array<{ template_id: string; produced_ir_pattern: string; success_criteria: string }> };
    check("http-api template advertises implemented http_status verify", httpTemplateBody.items.some((item) => item.template_id === "http-api-status-check" && item.produced_ir_pattern.includes("verify(http_status)") && item.success_criteria.includes("향후 커넥터 프로필 계약")), httpTemplates.body);

    const apiConnectors = await app.inject({ method: "GET", url: "/v1/connectors?kind=api", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list api connectors -> 200", apiConnectors.statusCode === 200, apiConnectors.body);
    const apiConnectorBody = JSON.parse(apiConnectors.body) as {
      items: Array<{
        connector_id: string;
        status: string;
        required_rbac_actions: string[];
        required_secret_refs: string[];
        manifest_permissions: { network: boolean; secret_refs: string[] };
        implementation_state: string;
      }>;
    };
    const managedIdp = apiConnectorBody.items.find((item) => item.connector_id === "managed-idp-scim");
    check(
      "managed IdP SCIM connector is metadata-only admin setup",
      managedIdp !== undefined &&
        managedIdp.status === "requires_admin" &&
        managedIdp.required_rbac_actions.includes("scim.sync") &&
        managedIdp.required_secret_refs.every((ref) => ref.startsWith("secret://")) &&
        managedIdp.manifest_permissions.network === false &&
        managedIdp.implementation_state.includes("/v1/scim/providers"),
      apiConnectors.body,
    );
    check("managed IdP connector does not expose signing material", !apiConnectors.body.includes("actual-signing-secret") && !apiConnectors.body.includes("client_secret"), apiConnectors.body);

    const idpScimTemplates = await app.inject({ method: "GET", url: "/v1/templates?connector_id=managed-idp-scim", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list managed IdP SCIM templates -> 200", idpScimTemplates.statusCode === 200, idpScimTemplates.body);
    const idpScimTemplateBody = JSON.parse(idpScimTemplates.body) as {
      items: Array<{ template_id: string; status: string; required_params: string[]; required_secret_refs: string[]; produced_ir_pattern: string; success_criteria: string }>;
    };
    check(
      "managed IdP SCIM templates cover registration, import, and decommission",
      ["managed-idp-scim-provider-registration", "managed-idp-scim-group-role-import", "managed-idp-scim-provider-decommission"].every((templateId) =>
        idpScimTemplateBody.items.some((item) => item.template_id === templateId && item.status === "requires_admin"),
      ),
      idpScimTemplates.body,
    );
    check(
      "managed IdP SCIM templates stay SecretRef-only",
      idpScimTemplateBody.items.some((item) =>
        item.template_id === "managed-idp-scim-provider-registration" &&
        item.required_params.includes("signature_secret_ref") &&
        item.required_secret_refs.every((ref) => ref.startsWith("secret://")) &&
        item.success_criteria.includes("signature_secret_ref"),
      ) &&
        idpScimTemplateBody.items.some((item) => item.template_id === "managed-idp-scim-group-role-import" && item.required_secret_refs.length === 0) &&
        !idpScimTemplates.body.includes("actual-signing-secret") &&
        !idpScimTemplates.body.includes("password"),
      idpScimTemplates.body,
    );

    const notificationTemplates = await app.inject({ method: "GET", url: "/v1/templates?connector_id=ops-webhook-sender", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list notification templates -> 200", notificationTemplates.statusCode === 200, notificationTemplates.body);
    const notificationTemplateBody = JSON.parse(notificationTemplates.body) as { items: Array<{ template_id: string; status: string; required_secret_refs: string[]; produced_ir_pattern: string; success_criteria: string }> };
    check(
      "notification template records receipt semantics instead of delivered synthesis",
      notificationTemplateBody.items.some((item) =>
        item.template_id === "ops-failure-alert" &&
        item.status === "available" &&
        item.required_secret_refs.every((ref) => ref.startsWith("secret://")) &&
        item.produced_ir_pattern.includes("/v1/ops-alerts") &&
        item.success_criteria.includes("제공자 접수/회신 증빙이 필요"),
      ),
      notificationTemplates.body,
    );

    const emptyProfiles = await app.inject({ method: "GET", url: "/v1/connector-profiles", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list connector profiles -> 200", emptyProfiles.statusCode === 200, emptyProfiles.body);
    check("connector profiles initially empty", (JSON.parse(emptyProfiles.body) as { items: unknown[] }).items.length === 0, emptyProfiles.body);

    const viewerCreateProfile = await app.inject({
      method: "POST",
      url: "/v1/connector-profiles",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "connector-profile-viewer-denied" },
      payload: {
        connector_id: "http-api",
        profile_name: "Finance API",
        secret_refs: ["secret://tenant-a/connector/http-api/bearer"],
        allowed_hosts: ["api.vendor.example"],
        owner_ref: "team:finance-platform",
      },
    });
    check("viewer cannot create connector profile -> 403", viewerCreateProfile.statusCode === 403, viewerCreateProfile.body);

    const createProfilePayload = {
      connector_id: "http-api",
      profile_name: "Finance API",
      environment: "staging",
      secret_refs: ["secret://tenant-a/connector/http-api/bearer"],
      allowed_hosts: ["api.vendor.example"],
      owner_ref: "team:finance-platform",
      support_owner_ref: "team:rpa-ops",
      metadata: { profile_ref: "ticket:CONN-1", rotation_owner: "team:finance-platform" },
    };
    const createdProfile = await app.inject({
      method: "POST",
      url: "/v1/connector-profiles",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "connector-profile-create-1" },
      payload: createProfilePayload,
    });
    check("admin create connector profile -> 201", createdProfile.statusCode === 201, createdProfile.body);
    const createdProfileBody = JSON.parse(createdProfile.body) as {
      profile_id: string;
      connector_id: string;
      status: string;
      secret_refs: string[];
      allowed_hosts: string[];
      latest_certification: unknown;
    };
    check("connector profile records draft http-api metadata", createdProfileBody.connector_id === "http-api" && createdProfileBody.status === "draft", createdProfile.body);
    check("connector profile stays SecretRef/host metadata only", createdProfileBody.secret_refs[0]?.startsWith("secret://") === true && createdProfileBody.allowed_hosts[0] === "api.vendor.example" && !createdProfile.body.includes("Bearer "), createdProfile.body);

    const replayProfile = await app.inject({
      method: "POST",
      url: "/v1/connector-profiles",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "connector-profile-create-1" },
      payload: createProfilePayload,
    });
    check("connector profile create idempotency replay -> 201", replayProfile.statusCode === 201, replayProfile.body);
    check("connector profile create idempotency returns same profile", JSON.parse(replayProfile.body).profile_id === createdProfileBody.profile_id, replayProfile.body);

    const rawEndpointProfile = await app.inject({
      method: "POST",
      url: "/v1/connector-profiles",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "connector-profile-create-raw-endpoint" },
      payload: {
        ...createProfilePayload,
        profile_name: "Unsafe API",
        metadata: { endpoint_url: "https://api.vendor.example/token" },
      },
    });
    check("connector profile rejects raw endpoint metadata -> 422", rawEndpointProfile.statusCode === 422, rawEndpointProfile.body);

    const candidateProfile = await app.inject({
      method: "POST",
      url: "/v1/connector-profiles",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "connector-profile-create-candidate" },
      payload: {
        connector_id: "sap-web",
        profile_name: "SAP Candidate",
        secret_refs: ["secret://tenant-a/connector/sap-web/session"],
        owner_ref: "team:sap-owner",
      },
    });
    check("candidate connector cannot be profiled as enabled -> 422", candidateProfile.statusCode === 422, candidateProfile.body);

    const missingEvidenceCertification = await app.inject({
      method: "POST",
      url: `/v1/connector-profiles/${createdProfileBody.profile_id}/certifications`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "connector-profile-cert-missing-evidence" },
      payload: { status: "certified", reason: "missing evidence should fail" },
    });
    check("connector certification requires evidence for certified -> 422", missingEvidenceCertification.statusCode === 422, missingEvidenceCertification.body);

    const certifiedProfile = await app.inject({
      method: "POST",
      url: `/v1/connector-profiles/${createdProfileBody.profile_id}/certifications`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "connector-profile-certify-1" },
      payload: {
        status: "certified",
        reason: "Security review, owner evidence, and contract tests accepted.",
        manifest_ref: "artifact://connector/http-api/manifest-v1",
        security_review_ref: "ticket:SEC-123",
        test_evidence_ref: "artifact://connector/http-api/test-report",
        owner_evidence_ref: "ticket:OWNER-456",
        receipt_semantics: {
          sent: "metadata_only",
          accepted: "provider_receipt_required",
          delivered: "provider_receipt_required",
          completed: "business_receipt_required",
        },
      },
    });
    check("admin certifies connector profile -> 201", certifiedProfile.statusCode === 201, certifiedProfile.body);
    const certifiedProfileBody = JSON.parse(certifiedProfile.body) as { status: string; receipt_semantics: { delivered: string } };
    check("connector certification records explicit receipt semantics", certifiedProfileBody.status === "certified" && certifiedProfileBody.receipt_semantics.delivered === "provider_receipt_required", certifiedProfile.body);

    const listedProfiles = await app.inject({ method: "GET", url: "/v1/connector-profiles?connector_id=http-api", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer lists certified connector profile -> 200", listedProfiles.statusCode === 200, listedProfiles.body);
    const listedProfileBody = JSON.parse(listedProfiles.body) as { items: Array<{ profile_id: string; status: string; latest_certification: { status: string } | null }> };
    check(
      "certified profile list includes latest certification metadata",
      listedProfileBody.items.some((item) => item.profile_id === createdProfileBody.profile_id && item.status === "certified" && item.latest_certification?.status === "certified"),
      listedProfiles.body,
    );

    const badKind = await app.inject({ method: "GET", url: "/v1/connectors?kind=desktop", headers: { authorization: `Bearer ${viewer}` } });
    check("invalid connector kind -> 422", badKind.statusCode === 422, badKind.body);

    const denied = await app.inject({ method: "GET", url: "/v1/connectors", headers: { authorization: `Bearer ${noRole}` } });
    check("no-role connector read denied -> 403", denied.statusCode === 403, denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} connector catalog API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: connector catalog API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
