/**
 * Integration test for Browser Object Repository site elements.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-site-elements.int.ts
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
import type { SelectorProbeInput, SelectorProbeProvider } from "../src/api/server-shared";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_site_elements_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SITE_A = "70000000-0000-4000-8000-0000000000a1";
const SITE_B = "70000000-0000-4000-8000-0000000000b2";
const OPERATOR_SUB = "11111111-0000-4000-8000-000000000001";

const SECRET = new TextEncoder().encode("site-elements-int-secret-do-not-use-in-prod-0123456789");
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

async function seedSite(pool: Pool, tenantId: string, siteId: string, name: string): Promise<void> {
  await withTenantTx(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'green', true)`,
      [siteId, tenantId, name, `https://${name}.example.com`],
    );
  });
}

async function elementCount(pool: Pool, tenantId: string, siteId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM site_element_repository WHERE site_profile_id=$1::uuid`,
      [siteId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

async function idempotencyCount(pool: Pool, tenant: string, endpoint: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM control_plane_idempotency_keys
        WHERE tenant_id=$1::uuid AND endpoint=$2 AND idempotency_key=$3`,
      [tenant, endpoint, key],
    );
    return Number(result.rows[0]?.count ?? "0");
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
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }

    await seedSite(pool, TENANT_A, SITE_A, "portal-a");
    await seedSite(pool, TENANT_B, SITE_B, "portal-b");

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const buildTestServer = (selectorProbe?: SelectorProbeProvider) => buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
      selectorProbe,
    });
    const app = buildTestServer();
    await app.ready();
    try {
      const operator = await mint({ sub: OPERATOR_SUB, tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "viewer-a", tenant_id: TENANT_A, roles: ["viewer"] });
      const operatorB = await mint({ sub: "11111111-0000-4000-8000-0000000000b1", tenant_id: TENANT_B, roles: ["operator"] });

      const list = (token: string, siteId = SITE_A, qs = "") =>
        app.inject({ method: "GET", url: `/v1/sites/${siteId}/elements${qs}`, headers: { authorization: `Bearer ${token}` } });
      const post = (token: string, key?: string, body?: Record<string, unknown>, siteId = SITE_A) =>
        app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/elements`,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });
      const patch = (token: string, elementId: string, key: string, body?: Record<string, unknown>, siteId = SITE_A) =>
        app.inject({
          method: "PATCH",
          url: `/v1/sites/${siteId}/elements/${elementId}`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: body ?? {},
        });
      const probe = (token: string, elementId: string, key: string, body?: Record<string, unknown>, siteId = SITE_A) =>
        app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/elements/${elementId}/probe`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: body ?? {},
        });
      const del = (token: string, elementId: string, key: string, siteId = SITE_A) =>
        app.inject({
          method: "DELETE",
          url: `/v1/sites/${siteId}/elements/${elementId}`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        });

      const empty = await list(viewer);
      check("viewer list empty repository -> 200", empty.statusCode === 200 && JSON.parse(empty.body).items.length === 0, empty.body);

      const created = await post(operator, "element-create-1", {
        element_key: "SubmitButton",
        label: "Submit button",
        selector: "button[type=submit]",
        element_type: "button",
        sample_url: "https://portal-a.example.com/form",
        notes: "shared by approval submit flows",
      });
      const createdBody = JSON.parse(created.body) as { element_id: string; element_key: string; stability: string; selector: string };
      check("operator create element -> 201", created.statusCode === 201 && createdBody.element_key === "SubmitButton", created.body);
      check("create default stability stable", createdBody.stability === "stable", created.body);

      const replay = await post(operator, "element-create-1", {
        element_key: "SubmitButton",
        label: "Submit button",
        selector: "button[type=submit]",
        element_type: "button",
        sample_url: "https://portal-a.example.com/form",
        notes: "shared by approval submit flows",
      });
      check("create replay returns same element", replay.statusCode === 201 && JSON.parse(replay.body).element_id === createdBody.element_id, replay.body);
      check("create replay does not duplicate rows", (await elementCount(pool, TENANT_A, SITE_A)) === 1);

      const filtered = await list(viewer, SITE_A, "?stability=stable&search=submit");
      check("viewer search returns element", filtered.statusCode === 200 && JSON.parse(filtered.body).items[0]?.element_key === "SubmitButton", filtered.body);
      check("secret-like values are not present", !filtered.body.includes("password") && !filtered.body.includes("cookie") && !filtered.body.includes("token"), filtered.body);

      const duplicate = await post(operator, "element-create-duplicate", {
        element_key: "SubmitButton",
        label: "Duplicate",
        selector: "#dupe",
      });
      check("duplicate element_key -> 422", duplicate.statusCode === 422 && duplicate.body.includes("element_key_already_exists"), duplicate.body);

      const invalid = await post(operator, "element-create-invalid", { element_key: "1bad", label: "Bad", selector: "#bad" });
      check("invalid element_key rejected before idempotency reserve", invalid.statusCode === 422, invalid.body);
      check("invalid element_key did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createSiteElement", "element-create-invalid")) === 0);

      const missingIdem = await post(operator, undefined, { element_key: "SearchInput", label: "Search", selector: "input[name=q]" });
      check("missing Idempotency-Key -> 422", missingIdem.statusCode === 422, missingIdem.body);

      const viewerDenied = await post(viewer, "viewer-create-denied", { element_key: "ViewerButton", label: "Viewer", selector: "#v" });
      check("viewer create denied -> 403", viewerDenied.statusCode === 403, viewerDenied.body);
      check("viewer denied request did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createSiteElement", "viewer-create-denied")) === 0);

      const updated = await patch(operator, createdBody.element_id, "element-update-1", {
        selector: "button.submit-primary",
        stability: "review_needed",
      });
      const updatedBody = JSON.parse(updated.body) as { selector: string; stability: string; last_verified_at: string | null };
      check("operator update element -> 200", updated.statusCode === 200 && updatedBody.selector === "button.submit-primary", updated.body);
      check("update persists stability without forging verification time", updatedBody.stability === "review_needed" && updatedBody.last_verified_at === null, updated.body);

      const forgedVerificationTime = await patch(operator, createdBody.element_id, "element-update-forged-verification", {
        last_verified_at: "2026-06-23T00:00:00.000Z",
      });
      check(
        "manual last_verified_at update rejected before idempotency reserve",
        forgedVerificationTime.statusCode === 422 &&
          forgedVerificationTime.json().details?.reason === "probe_managed_field" &&
          (await idempotencyCount(pool, TENANT_A, "updateSiteElement", "element-update-forged-verification")) === 0,
        forgedVerificationTime.body,
      );

      const notRunProbe = await probe(operator, createdBody.element_id, "element-probe-not-run", {});
      const notRunProbeBody = JSON.parse(notRunProbe.body) as { probe_status: string; reason_code: string };
      check("probe without runtime provider is explicit not_run", notRunProbe.statusCode === 200 && notRunProbeBody.probe_status === "not_run" && notRunProbeBody.reason_code === "SELECTOR_PROBE_PROVIDER_UNAVAILABLE", notRunProbe.body);

      const probeCalls: SelectorProbeInput[] = [];
      const liveProbeApp = buildTestServer({
        async probe(input) {
          probeCalls.push(input);
          return { status: "matched", matchCount: 2 };
        },
      });
      await liveProbeApp.ready();
      try {
        const liveProbe = await liveProbeApp.inject({
          method: "POST",
          url: `/v1/sites/${SITE_A}/elements/${createdBody.element_id}/probe`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "element-probe-live" },
          payload: { sample_url: "https://portal-a.example.com/form" },
        });
        const liveProbeBody = JSON.parse(liveProbe.body) as { probe_status: string; match_count: number; element: { stability: string; last_verified_at: string | null }; };
        check("live probe matched -> stable with match count", liveProbe.statusCode === 200 && liveProbeBody.probe_status === "matched" && liveProbeBody.match_count === 2 && liveProbeBody.element.stability === "stable" && liveProbeBody.element.last_verified_at !== null, liveProbe.body);
        check("live probe received selector and sample url", probeCalls.length === 1 && probeCalls[0]?.selector === "button.submit-primary" && probeCalls[0]?.sampleUrl === "https://portal-a.example.com/form");

        const liveReplay = await liveProbeApp.inject({
          method: "POST",
          url: `/v1/sites/${SITE_A}/elements/${createdBody.element_id}/probe`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "element-probe-live" },
          payload: { sample_url: "https://portal-a.example.com/form" },
        });
        check("live probe replay does not call provider again", liveReplay.statusCode === 200 && probeCalls.length === 1, liveReplay.body);
      } finally {
        await liveProbeApp.close();
      }

      const crossList = await list(operatorB, SITE_A);
      check("cross-tenant list site -> 404", crossList.statusCode === 404, crossList.body);
      const crossCreate = await post(operatorB, "cross-create", { element_key: "CrossButton", label: "Cross", selector: "#x" }, SITE_A);
      check("cross-tenant create site -> 404", crossCreate.statusCode === 404, crossCreate.body);
      const crossPatch = await patch(operatorB, createdBody.element_id, "cross-patch", { selector: "#wrong-tenant" }, SITE_A);
      check("cross-tenant update element -> 404", crossPatch.statusCode === 404, crossPatch.body);
      const crossProbe = await probe(operatorB, createdBody.element_id, "cross-probe", { sample_url: "https://portal-a.example.com/form" }, SITE_A);
      check("cross-tenant probe element -> 404", crossProbe.statusCode === 404, crossProbe.body);
      const crossDelete = await del(operatorB, createdBody.element_id, "cross-delete", SITE_A);
      check("cross-tenant delete element -> 404", crossDelete.statusCode === 404, crossDelete.body);

      const deleted = await del(operator, createdBody.element_id, "element-delete-1");
      check("operator delete element -> 200", deleted.statusCode === 200 && JSON.parse(deleted.body).deleted === true, deleted.body);
      const deleteReplay = await del(operator, createdBody.element_id, "element-delete-1");
      check("delete replay returns same response", deleteReplay.statusCode === 200 && JSON.parse(deleteReplay.body).deleted === true, deleteReplay.body);
      const afterDelete = await list(viewer);
      check("list after delete empty", afterDelete.statusCode === 200 && JSON.parse(afterDelete.body).items.length === 0, afterDelete.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} site element API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: site element API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
