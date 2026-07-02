/**
 * Integration test for S4b stored ops-alert notification routes (/v1/ops-alert-routes CRUD).
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-ops-alert-routes.int.ts
 *
 * 검증: RBAC(read=viewer+, manage=ops_alert.deliver admin-only) · 멱등 create/update/delete ·
 *      fail-closed 본문 검증(raw URL/secret 재료/비허용 source/severity) · soft-delete ·
 *      producer 활성 라우트 read(readActiveOpsAlertNotificationRoutes) 정합 · RLS 테넌트 격리.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { readActiveOpsAlertNotificationRoutes, type OpsAlertNotificationRoute } from "../src/api/ops-alert-notification-routes";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_ops_alert_routes_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";

const SECRET = new TextEncoder().encode("ops-alert-routes-int-secret-do-not-use-in-prod-0123");

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

function mint(roles: string[], tenant = TENANT_A, sub = "viewer-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

const VALID_CREATE_BODY = {
  source: "session_expiry",
  min_severity: "warning",
  provider_alias: "oncall-webhook",
  endpoint_secret_ref: "secret://tenant-a/notification/webhook/ops-primary",
  callback_signature_secret_ref: "secret://tenant-a/notification/webhook/callback-signing",
  route_policy_ref: "route:oncall",
  recipient_group_ref: "grp:oncall",
  allowed_hosts: ["Hooks.Example.com", "hooks.example.com"],
};

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim() {},
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
    async enqueueOpsNotificationSend() {},
  };
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer,
    signedCommandRegistry,
  });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid), ($2::uuid)`, [TENANT_A, TENANT_B]);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await app.ready();

    const viewer = await mint(["viewer"]);
    const operator = await mint(["operator"], TENANT_A, "operator-a");
    const admin = await mint(["admin"], TENANT_A, "admin-a");
    const adminB = await mint(["admin"], TENANT_B, "admin-b");
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");

    // --- read boundary ---
    const emptyList = await app.inject({ method: "GET", url: "/v1/ops-alert-routes", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer lists stored routes -> 200 empty", emptyList.statusCode === 200 && emptyList.json().items.length === 0 && emptyList.json().next_cursor === null, emptyList.body);
    const cursorRejected = await app.inject({ method: "GET", url: "/v1/ops-alert-routes?cursor=x", headers: { authorization: `Bearer ${viewer}` } });
    check("cursor query unsupported -> 422", cursorRejected.statusCode === 422 && cursorRejected.json().code === "IR_SCHEMA_INVALID", cursorRejected.body);

    // --- manage RBAC: ops_alert.deliver 는 admin 전용 ---
    const viewerCreate = await app.inject({
      method: "POST",
      url: "/v1/ops-alert-routes",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "route-create-viewer" },
      payload: VALID_CREATE_BODY,
    });
    check("viewer create denied -> 403", viewerCreate.statusCode === 403 && viewerCreate.json().code === "AUTHZ_FORBIDDEN", viewerCreate.body);
    const operatorCreate = await app.inject({
      method: "POST",
      url: "/v1/ops-alert-routes",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "route-create-operator" },
      payload: VALID_CREATE_BODY,
    });
    check("operator create denied -> 403 (deliver is admin-only)", operatorCreate.statusCode === 403 && operatorCreate.json().code === "AUTHZ_FORBIDDEN", operatorCreate.body);
    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/ops-alert-routes",
      headers: { authorization: `Bearer ${admin}` },
      payload: VALID_CREATE_BODY,
    });
    check("create without idempotency key -> 422", missingKey.statusCode === 422 && missingKey.json().code === "IR_SCHEMA_INVALID", missingKey.body);

    // --- fail-closed body validation ---
    const invalidCases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: "raw https endpoint ref rejected", body: { ...VALID_CREATE_BODY, endpoint_secret_ref: "https://hooks.example.com/x" } },
      { label: "secret material in policy ref rejected", body: { ...VALID_CREATE_BODY, route_policy_ref: "token=abcd1234" } },
      { label: "raw URL allowed_hosts rejected", body: { ...VALID_CREATE_BODY, allowed_hosts: ["https://hooks.example.com/x"] } },
      { label: "localhost allowed_hosts rejected", body: { ...VALID_CREATE_BODY, allowed_hosts: ["localhost"] } },
      { label: "ip allowed_hosts rejected", body: { ...VALID_CREATE_BODY, allowed_hosts: ["10.0.0.1"] } },
      { label: "non-auto-fire source rejected", body: { ...VALID_CREATE_BODY, source: "bot_pool" } },
      { label: "info min_severity rejected", body: { ...VALID_CREATE_BODY, min_severity: "info" } },
      { label: "unknown field rejected", body: { ...VALID_CREATE_BODY, endpoint_url: "https://hooks.example.com/x" } },
    ];
    for (const [index, invalid] of invalidCases.entries()) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/ops-alert-routes",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": `route-create-invalid-${index}` },
        payload: invalid.body,
      });
      check(invalid.label + " -> 422", res.statusCode === 422 && res.json().code === "IR_SCHEMA_INVALID", res.body);
    }

    // --- create + idempotent replay ---
    const created = await app.inject({
      method: "POST",
      url: "/v1/ops-alert-routes",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-create-1" },
      payload: VALID_CREATE_BODY,
    });
    const createdBody = created.json() as OpsAlertNotificationRoute;
    check(
      "admin creates stored route -> 201 with normalized fields",
      created.statusCode === 201 &&
        typeof createdBody.route_id === "string" &&
        createdBody.source === "session_expiry" &&
        createdBody.min_severity === "warning" &&
        createdBody.provider_alias === "oncall-webhook" &&
        createdBody.endpoint_secret_ref === VALID_CREATE_BODY.endpoint_secret_ref &&
        createdBody.callback_signature_secret_ref === VALID_CREATE_BODY.callback_signature_secret_ref &&
        createdBody.route_policy_ref === "route:oncall" &&
        createdBody.recipient_group_ref === "grp:oncall" &&
        JSON.stringify(createdBody.allowed_hosts) === JSON.stringify(["hooks.example.com"]) &&
        createdBody.enabled === true &&
        createdBody.created_by === "admin-a" &&
        createdBody.updated_by === "admin-a",
      created.body,
    );
    const replay = await app.inject({
      method: "POST",
      url: "/v1/ops-alert-routes",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-create-1" },
      payload: VALID_CREATE_BODY,
    });
    check("create idempotency replay returns same route", replay.statusCode === 201 && (replay.json() as OpsAlertNotificationRoute).route_id === createdBody.route_id, replay.body);

    const listAfterCreate = await app.inject({ method: "GET", url: "/v1/ops-alert-routes", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer sees created route in list", listAfterCreate.statusCode === 200 && listAfterCreate.json().items.length === 1 && listAfterCreate.json().items[0].route_id === createdBody.route_id, listAfterCreate.body);

    // --- producer active read path ---
    const activeRoutes = await withTenantTx(pool, TENANT_A, (client) => readActiveOpsAlertNotificationRoutes(client, TENANT_A));
    check(
      "producer active read returns route in fire shape",
      activeRoutes.length === 1 &&
        activeRoutes[0]?.source === "session_expiry" &&
        activeRoutes[0]?.minSeverity === "warning" &&
        activeRoutes[0]?.providerAlias === "oncall-webhook" &&
        activeRoutes[0]?.endpointSecretRef === VALID_CREATE_BODY.endpoint_secret_ref &&
        activeRoutes[0]?.callbackSignatureSecretRef === VALID_CREATE_BODY.callback_signature_secret_ref &&
        activeRoutes[0]?.recipientGroupRef === "grp:oncall",
      JSON.stringify(activeRoutes),
    );

    // --- update ---
    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-patch-empty" },
      payload: {},
    });
    check("empty patch -> 422", emptyPatch.statusCode === 422 && emptyPatch.json().code === "IR_SCHEMA_INVALID", emptyPatch.body);
    const operatorPatch = await app.inject({
      method: "PATCH",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "route-patch-operator" },
      payload: { enabled: false },
    });
    check("operator patch denied -> 403", operatorPatch.statusCode === 403 && operatorPatch.json().code === "AUTHZ_FORBIDDEN", operatorPatch.body);
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-patch-1" },
      payload: { min_severity: "critical", source: null, enabled: false, recipient_group_ref: null },
    });
    const patchedBody = patched.json() as OpsAlertNotificationRoute;
    check(
      "admin patch updates severity/source/enabled and clears recipient group",
      patched.statusCode === 200 &&
        patchedBody.route_id === createdBody.route_id &&
        patchedBody.min_severity === "critical" &&
        patchedBody.source === null &&
        patchedBody.enabled === false &&
        patchedBody.recipient_group_ref === null &&
        patchedBody.updated_by === "admin-a",
      patched.body,
    );
    const disabledActive = await withTenantTx(pool, TENANT_A, (client) => readActiveOpsAlertNotificationRoutes(client, TENANT_A));
    check("disabled route leaves producer active read", disabledActive.length === 0, JSON.stringify(disabledActive));
    const reEnabled = await app.inject({
      method: "PATCH",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-patch-2" },
      payload: { enabled: true },
    });
    check("re-enable patch -> 200 enabled", reEnabled.statusCode === 200 && (reEnabled.json() as OpsAlertNotificationRoute).enabled === true, reEnabled.body);
    const patchUnknownRoute = await app.inject({
      method: "PATCH",
      url: "/v1/ops-alert-routes/9a999999-0000-4000-8000-000000000001",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-patch-missing" },
      payload: { enabled: false },
    });
    check("patch unknown route -> 404", patchUnknownRoute.statusCode === 404 && patchUnknownRoute.json().code === "RESOURCE_NOT_FOUND", patchUnknownRoute.body);
    const patchBadId = await app.inject({
      method: "PATCH",
      url: "/v1/ops-alert-routes/not-a-uuid",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-patch-bad-id" },
      payload: { enabled: false },
    });
    check("patch non-uuid route id -> 404", patchBadId.statusCode === 404 && patchBadId.json().code === "RESOURCE_NOT_FOUND", patchBadId.body);

    // --- tenant isolation (RLS + tenant-scoped SQL) ---
    const tenantBList = await app.inject({ method: "GET", url: "/v1/ops-alert-routes", headers: { authorization: `Bearer ${viewerB}` } });
    check("tenant B sees no tenant A routes", tenantBList.statusCode === 200 && tenantBList.json().items.length === 0, tenantBList.body);
    const tenantBPatch = await app.inject({
      method: "PATCH",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${adminB}`, "idempotency-key": "route-patch-cross-tenant" },
      payload: { enabled: false },
    });
    check("tenant B admin cannot patch tenant A route -> 404", tenantBPatch.statusCode === 404 && tenantBPatch.json().code === "RESOURCE_NOT_FOUND", tenantBPatch.body);

    // --- delete (soft) ---
    const viewerDelete = await app.inject({
      method: "DELETE",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "route-delete-viewer" },
    });
    check("viewer delete denied -> 403", viewerDelete.statusCode === 403 && viewerDelete.json().code === "AUTHZ_FORBIDDEN", viewerDelete.body);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-delete-1" },
    });
    const deletedBody = deleted.json() as { deleted: boolean; route: OpsAlertNotificationRoute };
    check("admin delete -> 200 soft-deleted route", deleted.statusCode === 200 && deletedBody.deleted === true && deletedBody.route.route_id === createdBody.route_id && deletedBody.route.enabled === false, deleted.body);
    const deleteReplay = await app.inject({
      method: "DELETE",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-delete-1" },
    });
    check("delete idempotency replay returns same result", deleteReplay.statusCode === 200 && (deleteReplay.json() as { route: OpsAlertNotificationRoute }).route.route_id === createdBody.route_id, deleteReplay.body);
    const deleteAgain = await app.inject({
      method: "DELETE",
      url: `/v1/ops-alert-routes/${createdBody.route_id}`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "route-delete-2" },
    });
    check("second delete with new key -> 404 (already deleted)", deleteAgain.statusCode === 404 && deleteAgain.json().code === "RESOURCE_NOT_FOUND", deleteAgain.body);
    const listAfterDelete = await app.inject({ method: "GET", url: "/v1/ops-alert-routes", headers: { authorization: `Bearer ${viewer}` } });
    check("deleted route leaves the list", listAfterDelete.statusCode === 200 && listAfterDelete.json().items.length === 0, listAfterDelete.body);
    const deletedActive = await withTenantTx(pool, TENANT_A, (client) => readActiveOpsAlertNotificationRoutes(client, TENANT_A));
    check("deleted route leaves producer active read", deletedActive.length === 0, JSON.stringify(deletedActive));

    const noRole = await mint([]);
    const denied = await app.inject({ method: "GET", url: "/v1/ops-alert-routes", headers: { authorization: `Bearer ${noRole}` } });
    check("no-role route read denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} ops alert route API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: ops alert notification route API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
