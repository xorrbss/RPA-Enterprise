/**
 * Integration test for /v1/connectors and /v1/templates.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/api-connector-catalog.int.ts
 */
import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
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
  const pool = createPool();
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
  });
  try {
    await app.ready();
    const viewer = await mint(["viewer"]);
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
    check("document-idp security notes keep document bytes tenant-local", idpConnector?.security_notes.some((note) => note.includes("Document bytes stay inside")) === true, fileConnectors.body);

    const notificationConnectors = await app.inject({ method: "GET", url: "/v1/connectors?kind=notification", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list notification connectors -> 200", notificationConnectors.statusCode === 200, notificationConnectors.body);
    const notificationConnectorBody = JSON.parse(notificationConnectors.body) as {
      items: Array<{ connector_id: string; status: string; supported_actions: string[]; required_secret_refs: string[]; implementation_state: string }>;
    };
    const teamsConnector = notificationConnectorBody.items.find((item) => item.connector_id === "teams-webhook");
    check("external notification connector is future/blocked", teamsConnector !== undefined && teamsConnector.status === "blocked" && teamsConnector.implementation_state.includes("P2/future"), notificationConnectors.body);
    check("external notification connector does not advertise webhook dispatch secrets in P1", teamsConnector !== undefined && teamsConnector.required_secret_refs.length === 0 && teamsConnector.supported_actions.every((action) => action !== "webhook" && action !== "notify"), notificationConnectors.body);

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
    check("http-api template advertises implemented http_status verify", httpTemplateBody.items.some((item) => item.template_id === "http-api-status-check" && item.produced_ir_pattern.includes("verify(http_status)") && item.success_criteria.includes("future connector profile")), httpTemplates.body);

    const notificationTemplates = await app.inject({ method: "GET", url: "/v1/templates?connector_id=teams-webhook", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list notification templates -> 200", notificationTemplates.statusCode === 200, notificationTemplates.body);
    const notificationTemplateBody = JSON.parse(notificationTemplates.body) as { items: Array<{ template_id: string; status: string; required_secret_refs: string[]; produced_ir_pattern: string; success_criteria: string }> };
    check("notification template is console-alert only in P1", notificationTemplateBody.items.some((item) => item.template_id === "ops-failure-alert" && item.status === "blocked" && item.required_secret_refs.length === 0 && item.produced_ir_pattern.includes("/v1/ops-alerts") && item.success_criteria.includes("future notification contract")), notificationTemplates.body);

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
