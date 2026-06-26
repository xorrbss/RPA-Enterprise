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
const SCIM_SECRET = "scim-signed-request-secret" as PlainSecret;

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

const scimSecretStore: SecretStore = {
  async resolve(ref) {
    if (ref !== SCIM_SECRET_REF) throw new Error(`unexpected secret ref: ${ref}`);
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

async function seedProvider(pool: Pool, providerKey: string, status: "active" | "disabled" = "active"): Promise<void> {
  await withTenantTx(pool, TENANT, (client) =>
    client.query(
      `INSERT INTO scim_providers
         (id, tenant_id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
          signature_secret_ref, clock_skew_seconds, created_by)
       VALUES
         (gen_random_uuid(), $1::uuid, $2::text, $3::text, $4::text, 'scim-principal@1',
          'signed_request_v1', $5::text, 300, 'test-admin')`,
      [TENANT, providerKey, providerKey, status, SCIM_SECRET_REF],
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
    await seedGroupMapping(pool, "okta", "grp-rpa-viewers", "viewer");
    await seedGroupMapping(pool, "okta", "grp-rpa-operators", "operator");
    await seedGroupMapping(pool, "okta", "grp-rpa-operator-shadow", "operator");
    await seedGroupMapping(pool, "okta", "grp-rpa-disabled", "approver", "disabled");

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
      check("scim.sync audit rows appended", (await auditCount(pool)) === 2, String(await auditCount(pool)));

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
