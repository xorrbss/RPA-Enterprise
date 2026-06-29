/**
 * Integration test for hardened SCIM principal sync.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-scim.int.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import { PgPrincipalRoleAssignmentResolver } from "../src/api/role-assignments";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { scimSigningPayload } from "../src/api/scim";
import { createPool, withTenantTx } from "../src/db/pool";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { SecretStoreBoundary, SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_scim_int";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const JWT_SECRET = new TextEncoder().encode("scim-int-secret-do-not-use-in-prod-0123456789");
const SCIM_SECRET_REF = "secret://tenant-a/scim/okta/signing" as SecretRef;
const SCIM_SECRET_REF_V2 = "secret://tenant-a/scim/okta/signing-v2" as SecretRef;
const SCIM_SECRET = "scim-signed-request-secret" as PlainSecret;

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

const scimSecretStore: SecretStore = {
  async resolve(ref) {
    if (ref !== SCIM_SECRET_REF && ref !== SCIM_SECRET_REF_V2) throw new Error(`unexpected secret ref: ${ref}`);
    return SCIM_SECRET;
  },
};

const scimBoundaryCalls: Array<{ ref: string; purpose: string; connectorId: string | undefined; identity: unknown }> = [];
const scimSignatureSecretBoundary: SecretStoreBoundary = {
  store: scimSecretStore,
  async authorize(request) {
    return { kind: "allow", ref: request.ref };
  },
  async resolveAuthorized(request) {
    scimBoundaryCalls.push({
      ref: String(request.ref),
      purpose: request.purpose,
      connectorId: request.connectorId,
      identity: request.principal.claims.runtime_identity,
    });
    return scimSecretStore.resolve(request.ref);
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
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(JWT_SECRET);
}

function signedScimHeaders(payload: Record<string, unknown>, timestamp = String(Math.floor(Date.now() / 1000))): Record<string, string> {
  const providerKey = String(payload.idp_provider);
  const schemaVersion = String(payload.schema_version);
  const signature = createHmac("sha256", SCIM_SECRET)
    .update(scimSigningPayload(timestamp, providerKey, schemaVersion, payload))
    .digest("hex");
  return {
    "x-rpa-scim-timestamp": timestamp,
    "x-rpa-scim-signature": `sha256=${signature}`,
  };
}

type Pool = ReturnType<typeof createPool>;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function seedProvider(
  pool: Pool,
  providerKey: string,
  status: "active" | "disabled" = "active",
  secretRotationPolicy = "periodic_90d",
  createdAt = new Date().toISOString(),
  lastSecretRotatedAt: string | null = null,
): Promise<void> {
  await withTenantTx(pool, TENANT, (client) =>
    client.query(
      `INSERT INTO scim_providers
         (id, tenant_id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
          signature_secret_ref, secret_rotation_policy, clock_skew_seconds,
          last_secret_rotated_at, created_by, created_at)
       VALUES
         (gen_random_uuid(), $1::uuid, $2::text, $3::text, $4::text, 'scim-principal@1',
          'signed_request_v1', $5::text, $6::text, 300, $7::timestamptz, 'test-admin', $8::timestamptz)`,
      [TENANT, providerKey, providerKey, status, SCIM_SECRET_REF, secretRotationPolicy, lastSecretRotatedAt, createdAt],
    ),
  );
}

async function seedGroupMapping(
  pool: Pool,
  providerKey: string,
  externalGroup: string,
  role: string,
  status: "active" | "disabled" = "active",
): Promise<void> {
  await withTenantTx(pool, TENANT, (client) =>
    client.query(
      `INSERT INTO scim_group_role_mappings
         (id, tenant_id, provider_key, external_group, role, status, created_by)
       VALUES
         (gen_random_uuid(), $1::uuid, $2::text, $3::text, $4::text, $5::text, 'test-admin')`,
      [TENANT, providerKey, externalGroup, role, status],
    ),
  );
}

async function principal(pool: Pool, sub: string): Promise<{ source: string; external_id: string | null; idp_provider: string | null } | null> {
  return withTenantTx(pool, TENANT, async (client) => {
    const r = await client.query<{ source: string; external_id: string | null; idp_provider: string | null }>(
      `SELECT source, external_id, idp_provider FROM principals WHERE sub=$1::text`,
      [sub],
    );
    return r.rows[0] ?? null;
  });
}

async function roleStatus(pool: Pool, sub: string, role: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (client) => {
    const r = await client.query<{ status: string }>(
      `SELECT status
         FROM principal_role_assignments
        WHERE principal_sub=$1::text AND role=$2::text AND source='scim'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [sub, role],
    );
    return r.rows[0]?.status ?? null;
  });
}

async function roleExternalIds(pool: Pool, sub: string): Promise<string[]> {
  return withTenantTx(pool, TENANT, async (client) => {
    const r = await client.query<{ external_id: string }>(
      `SELECT external_id
         FROM principal_role_assignments
        WHERE principal_sub=$1::text AND source='scim'
        ORDER BY external_id`,
      [sub],
    );
    return r.rows.map((row) => row.external_id);
  });
}

async function auditCount(pool: Pool): Promise<number> {
  return withTenantTx(pool, TENANT, async (client) => {
    const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action='scim.sync'`);
    return r.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seedProvider(pool, "okta");
    await seedProvider(pool, "disabled-idp", "disabled");
    await seedProvider(pool, "decom-idp");
    await seedProvider(pool, "manual-idp", "active", "manual", isoDaysFromNow(-365));
    await seedProvider(pool, "due-soon-idp", "active", "periodic_30d", isoDaysFromNow(-25));
    await seedProvider(pool, "overdue-idp", "active", "periodic_30d", isoDaysFromNow(-31));
    await seedGroupMapping(pool, "okta", "grp-rpa-viewers", "viewer");
    await seedGroupMapping(pool, "okta", "grp-rpa-operators", "operator");
    await seedGroupMapping(pool, "okta", "grp-rpa-operator-shadow", "operator");
    await seedGroupMapping(pool, "okta", "grp-rpa-disabled", "approver", "disabled");
    await seedGroupMapping(pool, "decom-idp", "grp-rpa-decom-operators", "operator");

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(JWT_SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
      roleAssignments: new PgPrincipalRoleAssignmentResolver(pool),
      scimSignatureSecretBoundary,
    });
    await app.ready();
    try {
      const admin = await mint({ sub: "auth0|admin", tenant_id: TENANT, roles: ["admin"] });
      const operator = await mint({ sub: "auth0|operator", tenant_id: TENANT, roles: ["operator"] });
      const providerList = await app.inject({
        method: "GET",
        url: "/v1/scim/providers",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("admin lists SCIM providers -> 200", providerList.statusCode === 200 && providerList.json().items.length === 6, providerList.body);
      const providerItems = providerList.json().items as Array<{
        provider_key: string;
        secret_rotation_policy: string;
        rotation_status: string;
        rotation_due_at: string | null;
      }>;
      const providerByKey = new Map(providerItems.map((item) => [item.provider_key, item]));
      check(
        "SCIM provider rotation status current",
        providerByKey.get("okta")?.secret_rotation_policy === "periodic_90d" &&
          providerByKey.get("okta")?.rotation_status === "current" &&
          typeof providerByKey.get("okta")?.rotation_due_at === "string",
        providerList.body,
      );
      check(
        "SCIM provider rotation status manual",
        providerByKey.get("manual-idp")?.secret_rotation_policy === "manual" &&
          providerByKey.get("manual-idp")?.rotation_status === "manual" &&
          providerByKey.get("manual-idp")?.rotation_due_at === null,
        providerList.body,
      );
      check("SCIM provider rotation status due_soon", providerByKey.get("due-soon-idp")?.rotation_status === "due_soon", providerList.body);
      check("SCIM provider rotation status overdue", providerByKey.get("overdue-idp")?.rotation_status === "overdue", providerList.body);

      const invalidRotationPolicy = await app.inject({
        method: "POST",
        url: "/v1/scim/providers",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-provider-invalid-rotation-policy" },
        payload: {
          provider_key: "bad-rotation-idp",
          display_name: "Bad Rotation",
          signature_secret_ref: SCIM_SECRET_REF,
          secret_rotation_policy: "periodic_7d",
        },
      });
      check(
        "SCIM provider create rejects invalid rotation policy -> 422",
        invalidRotationPolicy.statusCode === 422 && invalidRotationPolicy.json().details?.reason === "invalid_secret_rotation_policy",
        invalidRotationPolicy.body,
      );

      const createProvider = await app.inject({
        method: "POST",
        url: "/v1/scim/providers",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-provider-create" },
        payload: {
          provider_key: "entra",
          display_name: "Microsoft Entra",
          signature_secret_ref: SCIM_SECRET_REF,
          secret_rotation_policy: "periodic_60d",
          clock_skew_seconds: 120,
        },
      });
      check("admin creates SCIM provider -> 201", createProvider.statusCode === 201 && createProvider.json().provider_key === "entra", createProvider.body);
      check("provider response exposes SecretRef not secret value", createProvider.body.includes(SCIM_SECRET_REF) && !createProvider.body.includes(SCIM_SECRET));
      check("provider creation starts without rotation evidence", createProvider.json().last_secret_rotated_at === null, createProvider.body);
      check(
        "provider creation exposes rotation policy evidence",
        createProvider.json().secret_rotation_policy === "periodic_60d" &&
          createProvider.json().rotation_status === "current" &&
          typeof createProvider.json().rotation_due_at === "string",
        createProvider.body,
      );

      const operatorProviderCreate = await app.inject({
        method: "POST",
        url: "/v1/scim/providers",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "scim-provider-operator" },
        payload: {
          provider_key: "operator-idp",
          display_name: "Operator IdP",
          signature_secret_ref: SCIM_SECRET_REF,
        },
      });
      check("non-admin cannot manage SCIM providers -> 403", operatorProviderCreate.statusCode === 403, operatorProviderCreate.body);

      const rotateProviderSecret = await app.inject({
        method: "PATCH",
        url: "/v1/scim/providers/entra",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-provider-rotate" },
        payload: {
          signature_secret_ref: SCIM_SECRET_REF_V2,
          secret_rotation_policy: "manual",
          clock_skew_seconds: 240,
        },
      });
      check(
        "admin rotates SCIM provider SecretRef with evidence -> 200",
        rotateProviderSecret.statusCode === 200 &&
          rotateProviderSecret.json().signature_secret_ref === SCIM_SECRET_REF_V2 &&
          rotateProviderSecret.json().secret_rotation_policy === "manual" &&
          rotateProviderSecret.json().rotation_status === "manual" &&
          rotateProviderSecret.json().rotation_due_at === null &&
          typeof rotateProviderSecret.json().last_secret_rotated_at === "string" &&
          rotateProviderSecret.json().last_secret_rotated_by === "auth0|admin",
        rotateProviderSecret.body,
      );
      check("rotated provider still exposes SecretRef only", rotateProviderSecret.body.includes(SCIM_SECRET_REF_V2) && !rotateProviderSecret.body.includes(SCIM_SECRET));

      const disableProvider = await app.inject({
        method: "PATCH",
        url: "/v1/scim/providers/entra",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-provider-disable" },
        payload: { status: "disabled" },
      });
      check("admin disables SCIM provider -> 200", disableProvider.statusCode === 200 && disableProvider.json().status === "disabled", disableProvider.body);

      const createMapping = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/entra/group-role-mappings",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-mapping-create" },
        payload: { external_group: "entra-rpa-operators", role: "operator", description: "Ops group" },
      });
      check("admin creates SCIM group mapping -> 201", createMapping.statusCode === 201 && createMapping.json().role === "operator", createMapping.body);

      const mappingList = await app.inject({
        method: "GET",
        url: "/v1/scim/providers/entra/group-role-mappings",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("admin lists SCIM group mappings -> 200", mappingList.statusCode === 200 && mappingList.json().items.length === 1, mappingList.body);

      const disableMapping = await app.inject({
        method: "PATCH",
        url: `/v1/scim/providers/entra/group-role-mappings/${createMapping.json().mapping_id}`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-mapping-disable" },
        payload: { status: "disabled" },
      });
      check("admin disables SCIM group mapping -> 200", disableMapping.statusCode === 200 && disableMapping.json().status === "disabled", disableMapping.body);

      const importMappings = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/entra/group-role-mappings/import",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-mapping-import-upsert" },
        payload: {
          mode: "upsert_only",
          mappings: [
            { external_group: "entra-rpa-operators", role: "reviewer", description: "Ops reviewers" },
            { external_group: "entra-rpa-viewers", role: "viewer", description: null },
          ],
        },
      });
      check(
        "admin imports SCIM group mappings in upsert mode -> 200",
        importMappings.statusCode === 200 &&
          importMappings.json().imported === 1 &&
          importMappings.json().updated === 1 &&
          importMappings.json().unchanged === 0 &&
          importMappings.json().disabled === 0 &&
          importMappings.json().items.length === 2,
        importMappings.body,
      );

      const reconcileMappings = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/entra/group-role-mappings/import",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-mapping-import-replace" },
        payload: {
          mode: "replace_active",
          mappings: [{ external_group: "entra-rpa-viewers", role: "viewer", description: null }],
        },
      });
      check(
        "admin reconciles SCIM group mappings in replace_active mode -> 200",
        reconcileMappings.statusCode === 200 &&
          reconcileMappings.json().imported === 0 &&
          reconcileMappings.json().updated === 0 &&
          reconcileMappings.json().unchanged === 1 &&
          reconcileMappings.json().disabled === 1,
        reconcileMappings.body,
      );

      const duplicateImport = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/entra/group-role-mappings/import",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-mapping-import-duplicate" },
        payload: {
          mode: "upsert_only",
          mappings: [
            { external_group: "dup-group", role: "viewer" },
            { external_group: "dup-group", role: "operator" },
          ],
        },
      });
      check(
        "SCIM group mapping import rejects duplicate external_group -> 422",
        duplicateImport.statusCode === 422 && duplicateImport.json().details?.reason === "duplicate_external_group",
        duplicateImport.body,
      );

      const basePayload = {
        schema_version: "scim-principal@1",
        idp_provider: "okta",
        external_id: "00u-alice",
        sub: "auth0|alice",
        display_name: "Alice",
        email: "alice@example.com",
        active: true,
        roles: ["viewer", "operator"],
      };
      const postScim = (payload: Record<string, unknown>, key: string, headers = signedScimHeaders(payload)) =>
        app.inject({
          method: "POST",
          url: "/v1/scim/principals",
          headers: { authorization: `Bearer ${admin}`, "idempotency-key": key, ...headers },
          payload,
        });

      const created = await postScim(basePayload, "scim-alice-create");
      check("signed registered provider sync -> 200", created.statusCode === 200 && created.json().sub === "auth0|alice", created.body);
      const alice = await principal(pool, "auth0|alice");
      check(
        "principal stored as SCIM-managed external identity",
        alice?.source === "scim" && alice.external_id === "00u-alice" && alice.idp_provider === "okta",
        JSON.stringify(alice),
      );
      check("two SCIM roles active", (await roleStatus(pool, "auth0|alice", "viewer")) === "active" && (await roleStatus(pool, "auth0|alice", "operator")) === "active");
      check(
        "SCIM role external ids are per role",
        JSON.stringify(await roleExternalIds(pool, "auth0|alice")) === JSON.stringify(["00u-alice:operator", "00u-alice:viewer"]),
      );
      check(
        "SCIM signature resolved through connector SecretStore boundary",
        scimBoundaryCalls.some((call) => call.ref === SCIM_SECRET_REF && call.purpose === "connector" && call.connectorId === "scim:okta" && call.identity === "api"),
        JSON.stringify(scimBoundaryCalls),
      );

      const narrowed = await postScim({ ...basePayload, roles: ["viewer"] }, "scim-alice-narrow");
      check("role set narrowing -> 200", narrowed.statusCode === 200, narrowed.body);
      check("removed SCIM role revoked", (await roleStatus(pool, "auth0|alice", "operator")) === "revoked");
      check("kept SCIM role remains active", (await roleStatus(pool, "auth0|alice", "viewer")) === "active");
      check("SCIM management + sync audit rows appended", (await auditCount(pool)) === 9, String(await auditCount(pool)));

      const groupPayload = {
        schema_version: "scim-principal@1",
        idp_provider: "okta",
        external_id: "00u-bob",
        sub: "auth0|bob",
        display_name: "Bob",
        email: "bob@example.com",
        active: true,
        external_groups: ["grp-rpa-viewers", "grp-rpa-operators", "grp-rpa-operator-shadow"],
      };
      const groupCreated = await postScim(groupPayload, "scim-bob-groups");
      check("external_groups mapping sync -> 200", groupCreated.statusCode === 200, groupCreated.body);
      check(
        "external_groups resolved through RPA-owned mapping ledger",
        JSON.stringify([...groupCreated.json().roles].sort()) === JSON.stringify(["operator", "viewer"]),
        groupCreated.body,
      );
      check("mapped SCIM roles active", (await roleStatus(pool, "auth0|bob", "viewer")) === "active" && (await roleStatus(pool, "auth0|bob", "operator")) === "active");
      check(
        "duplicate mapped roles are deduped before assignment",
        JSON.stringify(await roleExternalIds(pool, "auth0|bob")) === JSON.stringify(["00u-bob:operator", "00u-bob:viewer"]),
      );

      const decommissionPayload = {
        schema_version: "scim-principal@1",
        idp_provider: "decom-idp",
        external_id: "00u-decom",
        sub: "auth0|decom",
        display_name: "Decommission Target",
        email: "decom@example.com",
        active: true,
        external_groups: ["grp-rpa-decom-operators"],
      };
      const decommissionedPrincipal = await postScim(decommissionPayload, "scim-decom-create", signedScimHeaders(decommissionPayload));
      check("decommission target sync -> 200", decommissionedPrincipal.statusCode === 200, decommissionedPrincipal.body);
      check("decommission target role active before provider retirement", (await roleStatus(pool, "auth0|decom", "operator")) === "active");

      const decommissionProvider = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/decom-idp/decommission",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-provider-decommission" },
        payload: { reason: "Managed IdP retired" },
      });
      check(
        "admin decommissions SCIM provider with revoke evidence -> 200",
        decommissionProvider.statusCode === 200 &&
          decommissionProvider.json().provider.status === "disabled" &&
          decommissionProvider.json().provider.decommission_reason === "Managed IdP retired" &&
          decommissionProvider.json().provider.rotation_status === "decommissioned" &&
          decommissionProvider.json().provider.rotation_due_at === null &&
          typeof decommissionProvider.json().provider.decommissioned_at === "string" &&
          decommissionProvider.json().disabled_mappings === 1 &&
          decommissionProvider.json().revoked_assignments === 1,
        decommissionProvider.body,
      );
      check("provider decommission revokes active SCIM assignment", (await roleStatus(pool, "auth0|decom", "operator")) === "revoked");

      const decommissionedProviderMapping = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/decom-idp/group-role-mappings",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-decom-mapping-create" },
        payload: { external_group: "blocked-after-decom", role: "viewer" },
      });
      check(
        "decommissioned SCIM provider rejects new group mapping -> 422",
        decommissionedProviderMapping.statusCode === 422 && decommissionedProviderMapping.json().details?.reason === "scim_provider_decommissioned",
        decommissionedProviderMapping.body,
      );

      const decommissionedProviderImport = await app.inject({
        method: "POST",
        url: "/v1/scim/providers/decom-idp/group-role-mappings/import",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-decom-mapping-import" },
        payload: { mode: "upsert_only", mappings: [{ external_group: "blocked-import", role: "viewer" }] },
      });
      check(
        "decommissioned SCIM provider rejects group mapping import -> 422",
        decommissionedProviderImport.statusCode === 422 && decommissionedProviderImport.json().details?.reason === "scim_provider_decommissioned",
        decommissionedProviderImport.body,
      );

      const reenableDecommissionedProvider = await app.inject({
        method: "PATCH",
        url: "/v1/scim/providers/decom-idp",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "scim-provider-decommission-reactivate" },
        payload: { status: "active" },
      });
      check(
        "decommissioned SCIM provider cannot be reactivated by status patch -> 422",
        reenableDecommissionedProvider.statusCode === 422 && reenableDecommissionedProvider.json().details?.reason === "scim_provider_decommissioned",
        reenableDecommissionedProvider.body,
      );

      const disabledAfterDecommission = await postScim(
        { ...decommissionPayload, external_id: "00u-decom-after", sub: "auth0|decom-after" },
        "scim-decom-disabled",
        signedScimHeaders({ ...decommissionPayload, external_id: "00u-decom-after", sub: "auth0|decom-after" }),
      );
      check(
        "decommissioned provider inbound sync -> 403",
        disabledAfterDecommission.statusCode === 403 && disabledAfterDecommission.json().details?.reason === "scim_provider_disabled",
        disabledAfterDecommission.body,
      );

      const unmappedGroup = { ...groupPayload, external_id: "00u-unmapped", sub: "auth0|unmapped", external_groups: ["grp-rpa-missing"] };
      const unmappedGroupResponse = await postScim(unmappedGroup, "scim-unmapped-group", signedScimHeaders(unmappedGroup));
      check(
        "unmapped external group -> 422",
        unmappedGroupResponse.statusCode === 422 && unmappedGroupResponse.json().details?.reason === "scim_group_role_unmapped",
        unmappedGroupResponse.body,
      );
      check("unmapped external group did not upsert principal", (await principal(pool, "auth0|unmapped")) === null);

      const disabledGroup = { ...groupPayload, external_id: "00u-disabled-group", sub: "auth0|disabled-group", external_groups: ["grp-rpa-disabled"] };
      const disabledGroupResponse = await postScim(disabledGroup, "scim-disabled-group", signedScimHeaders(disabledGroup));
      check(
        "disabled external group mapping -> 422",
        disabledGroupResponse.statusCode === 422 && disabledGroupResponse.json().details?.reason === "scim_group_role_unmapped",
        disabledGroupResponse.body,
      );

      const mixedRoleSources = { ...basePayload, external_id: "00u-mixed", sub: "auth0|mixed", external_groups: ["grp-rpa-viewers"] };
      const mixedRoleSourcesResponse = await postScim(mixedRoleSources, "scim-mixed-role-sources", signedScimHeaders(mixedRoleSources));
      check(
        "roles and external_groups mixed -> 422",
        mixedRoleSourcesResponse.statusCode === 422 && mixedRoleSourcesResponse.json().details?.reason === "scim_role_source_conflict",
        mixedRoleSourcesResponse.body,
      );

      const badSignature = await postScim(
        { ...basePayload, external_id: "00u-bad", sub: "auth0|bad" },
        "scim-bad-signature",
        { "x-rpa-scim-timestamp": String(Math.floor(Date.now() / 1000)), "x-rpa-scim-signature": `sha256=${"0".repeat(64)}` },
      );
      check("bad signature -> 401", badSignature.statusCode === 401 && badSignature.json().code === "UNAUTHENTICATED", badSignature.body);
      check("bad signature did not upsert principal", (await principal(pool, "auth0|bad")) === null);

      const schemaV2 = { ...basePayload, schema_version: "scim-principal@2", external_id: "00u-v2", sub: "auth0|v2" };
      const unsupportedSchema = await postScim(schemaV2, "scim-schema-v2", signedScimHeaders(schemaV2));
      check("unsupported schema version -> 422", unsupportedSchema.statusCode === 422 && unsupportedSchema.json().details?.reason === "unsupported_scim_schema_version", unsupportedSchema.body);

      const unregistered = { ...basePayload, idp_provider: "entra-id", external_id: "00u-entra", sub: "auth0|entra" };
      const unregisteredProvider = await postScim(unregistered, "scim-unregistered", signedScimHeaders(unregistered));
      check("unregistered provider -> 403", unregisteredProvider.statusCode === 403 && unregisteredProvider.json().details?.reason === "scim_provider_not_registered", unregisteredProvider.body);

      const disabled = { ...basePayload, idp_provider: "disabled-idp", external_id: "00u-disabled", sub: "auth0|disabled" };
      const disabledProvider = await postScim(disabled, "scim-disabled", signedScimHeaders(disabled));
      check("disabled provider -> 403", disabledProvider.statusCode === 403 && disabledProvider.json().details?.reason === "scim_provider_disabled", disabledProvider.body);

      const externalMove = { ...basePayload, sub: "auth0|alice-renamed" };
      const externalConflict = await postScim(externalMove, "scim-external-conflict", signedScimHeaders(externalMove));
      check("external_id cannot move to another sub", externalConflict.statusCode === 422 && externalConflict.json().details?.reason === "scim_external_id_sub_conflict", externalConflict.body);

      const subRelink = { ...basePayload, external_id: "00u-alice-new" };
      const subConflict = await postScim(subRelink, "scim-sub-conflict", signedScimHeaders(subRelink));
      check("sub cannot be relinked to another external_id", subConflict.statusCode === 422 && subConflict.json().details?.reason === "scim_sub_external_id_conflict", subConflict.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) process.exit(1);
  console.log("\nPASS: hardened SCIM principal sync integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
