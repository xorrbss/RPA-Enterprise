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
const SCHEMA = "rpa_scenario_releases_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SECRET = new TextEncoder().encode("scenario-releases-int-secret-do-not-use-in-prod-0123456789");

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

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
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
