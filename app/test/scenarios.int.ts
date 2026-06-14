/**
 * D4.4 통합 테스트 — 시나리오 저장/검증 + §10 컴파일 파이프라인(ajv→IREL→V1–V11)을 실 PostgreSQL로 검증.
 *
 * 실행: temp PG15 게이트 위에서 test:int 체인.
 * 검증(d4-prompt §5.4 게이트): 유효 IR 저장(201) OK + 무효 IR 거부(422) + validate dry-run(ValidationReport)
 *   + RBAC(create=operator+, read/validate=전 역할).  promote(승격)는 후속 증분.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { createPool, withTenantTx } from "../src/db/pool";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import type { SecretRef } from "../../ts/core-types";
import type {
  SignedCommandRegistry,
  SignedCommandRegistryEntry,
  SignedCommandRegistryPurpose,
} from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_scenarios_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const SECRET = new TextEncoder().encode("d44-int-test-secret-do-not-use-in-prod-0123456789");

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStaticReason(body: unknown, reason: string): boolean {
  if (!isRecord(body) || !isRecord(body.details) || !isRecord(body.details.report)) return false;
  const errors = body.details.report.errors;
  return Array.isArray(errors) && errors.some((error) => isRecord(error) && error.reason === reason);
}

interface ScenarioIrFixture {
  meta: { name: string; version: number };
  start: string;
  nodes: Record<string, Record<string, unknown>>;
}

// 유효 IR: meta+start+nodes(흐름키 1개). 무효(ajv): 흐름키 2개. 무효(graph): start가 없는 노드 참조(V2).
const validIr = (name: string): ScenarioIrFixture => ({
  meta: { name, version: 1 },
  start: "n1",
  nodes: {
    n1: {
      on: [
        { when: "flags.blocked", target: "n2", priority: 1 },
        { when: "flags.not_found", target: "n3", priority: 0 },
      ],
    },
    n2: { terminal: "success" },
    n3: { terminal: "success" },
  },
});
const warningIr = (name: string): ScenarioIrFixture => ({
  meta: { name, version: 1 },
  start: "n1",
  nodes: {
    n1: {
      on: [{ when: "flags.not_found", target: "@end_no_data", priority: 1 }],
    },
  },
});
const shellIr = (name: string, cmdRef: string): ScenarioIrFixture => ({
  meta: { name, version: 1 },
  start: "n1",
  nodes: {
    n1: { what: [{ action: "shell", cmd_ref: cmdRef }], terminal: "success" },
  },
});
const ajvInvalidIr = { meta: { name: "ajv-bad", version: 1 }, start: "n1", nodes: { n1: { terminal: "success", next: "n2" } } };
const graphInvalidIr = (name: string): ScenarioIrFixture => ({ meta: { name, version: 1 }, start: "missing", nodes: { n1: { terminal: "success" } } });

const REGISTRY_SOURCE = "secret://staging/signed-command-registry" as SecretRef;
const SIGNING_KEY_REF = "secret://staging/signed-command-registry/kid-2026-06" as SecretRef;
const SIGNED_EXPORT_COMMAND: SignedCommandRegistryEntry = {
  cmdRef: "signed.export_report",
  kid: "kid-2026-06",
  signature: "sig:test-signed-export-report",
  sideEffectKind: "read_only",
  verificationKeyRef: SIGNING_KEY_REF,
};

let registryMode: "available" | "unavailable" = "available";
let registryCommands: readonly SignedCommandRegistryEntry[] = [SIGNED_EXPORT_COMMAND];
const registryPurposes: SignedCommandRegistryPurpose[] = [];
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs(request) {
    registryPurposes.push(request.purpose);
    if (registryMode === "unavailable") {
      return { kind: "unavailable", reason: "test_registry_unavailable", sourceRef: REGISTRY_SOURCE };
    }
    return { kind: "available", snapshot: { sourceRef: REGISTRY_SOURCE, commands: registryCommands } };
  },
};

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vw", tenant_id: TENANT_A, roles: ["viewer"] });
      const admin = await mint({ sub: "ad", tenant_id: TENANT_A, roles: ["admin"] });

      // 1) operator 유효 IR 저장 → 201 + ETag=version.
      const created = await app.inject({
        method: "POST", url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: validIr("scenario-a"),
      });
      check("create valid IR → 201", created.statusCode === 201, created.body);
      const createdBody = created.json();
      check("create version=1", createdBody.version === 1, JSON.stringify(createdBody));
      check("create promotion_status=draft", createdBody.promotion_status === "draft", JSON.stringify(createdBody));
      check("create ETag=1", created.headers.etag === "1", String(created.headers.etag));
      const scenarioId = createdBody.scenario_id;
      check("create scenario_id uuid", typeof scenarioId === "string" && /^[0-9a-f-]{36}$/i.test(scenarioId), JSON.stringify(createdBody));
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM scenarios s
             JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
            WHERE s.id=$1::uuid`,
          [scenarioId],
        );
        check("created scenario join visible under tenant RLS", r.rows[0]?.count === "1", JSON.stringify(r.rows[0]));
      });

      // 2) GET 상세 → 200 + version + ETag. compiled_ast 캐시 확인(DB).
      const got = await app.inject({ method: "GET", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: `Bearer ${viewer}` } });
      check("get scenario (viewer read) → 200", got.statusCode === 200, got.body);
      check("get version=1 + ETag", got.json().version === 1 && got.headers.etag === "1", got.body);
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ compiled_ast: string | null }>(`SELECT compiled_ast FROM scenario_versions WHERE scenario_id=$1::uuid`, [scenarioId]);
        const compiled = typeof r.rows[0]?.compiled_ast === "string" ? JSON.parse(r.rows[0].compiled_ast) as unknown : null;
        const nodes = isRecord(compiled) && isRecord(compiled.nodes) ? compiled.nodes : {};
        const n1 = isRecord(nodes.n1) ? nodes.n1 : {};
        const on = Array.isArray(n1.on) ? n1.on : [];
        const first = isRecord(on[0]) ? on[0] : {};
        const when = isRecord(first.when) ? first.when : {};
        check("compiled_ast cached executable AST", compiled !== null && isRecord(compiled) && compiled.kind === "rpa.scenario.compiled_ast.v1", JSON.stringify(r.rows[0]));
        check("compiled_ast includes on[] expression AST", on.length === 2 && when.kind === "variable", JSON.stringify(compiled));
      });

      // 2b) promote → If-Match + Idempotency-Key + prod warning blocking path.
      const promoted = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/promote`,
        headers: { authorization: `Bearer ${admin}`, "if-match": "1", "idempotency-key": "scenario-promote-a" },
        payload: { target: "prod" },
      });
      check("promote valid → 200", promoted.statusCode === 200, promoted.body);
      check("promote status=prod + ETag", promoted.json().promotion_status === "prod" && promoted.headers.etag === "1", promoted.body);
      const promotedReplay = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/promote`,
        headers: { authorization: `Bearer ${admin}`, "if-match": "1", "idempotency-key": "scenario-promote-a" },
        payload: { target: "prod" },
      });
      check(
        "promote replay → 200 same body",
        promotedReplay.statusCode === 200 &&
          promotedReplay.json().scenario_id === promoted.json().scenario_id &&
          promotedReplay.json().version === promoted.json().version &&
          promotedReplay.json().promotion_status === promoted.json().promotion_status,
        promotedReplay.body,
      );
      const promoteConflict = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/promote`,
        headers: { authorization: `Bearer ${admin}`, "if-match": "999", "idempotency-key": "scenario-promote-conflict" },
        payload: { target: "prod" },
      });
      check("promote stale If-Match → 412", promoteConflict.statusCode === 412, promoteConflict.body);
      check("promote stale If-Match → SCENARIO_VERSION_CONFLICT", promoteConflict.json().code === "SCENARIO_VERSION_CONFLICT", promoteConflict.body);

      // 3) validate dry-run: 유효 IR → 200 {valid:true}, 그래프 무효 → 200 {valid:false, errors}.
      const valOk = await app.inject({ method: "POST", url: `/v1/scenarios/${scenarioId}/validate`, headers: { authorization: `Bearer ${viewer}` }, payload: validIr("ignored") });
      check("validate valid → 200 valid:true", valOk.statusCode === 200 && valOk.json().valid === true, valOk.body);
      const valGraph = await app.inject({ method: "POST", url: `/v1/scenarios/${scenarioId}/validate`, headers: { authorization: `Bearer ${operator}` }, payload: graphInvalidIr("ignored") });
      check("validate graph-invalid → 200 valid:false + errors", valGraph.statusCode === 200 && valGraph.json().valid === false && valGraph.json().report.errors.length > 0, valGraph.body);

      const shellCreate = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: shellIr("scenario-shell-ok", "signed.export_report"),
      });
      check("create registered shell cmd_ref → 201", shellCreate.statusCode === 201, shellCreate.body);
      const shellValidate = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/validate`,
        headers: { authorization: `Bearer ${viewer}` },
        payload: shellIr("ignored-shell", "signed.export_report"),
      });
      check("validate registered shell cmd_ref → 200 valid:true", shellValidate.statusCode === 200 && shellValidate.json().valid === true, shellValidate.body);
      const shellUnregistered = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: shellIr("scenario-shell-unregistered", "signed.unknown"),
      });
      check("create unregistered shell cmd_ref → 422", shellUnregistered.statusCode === 422, shellUnregistered.body);
      check(
        "unregistered shell reason=shell_cmd_unregistered",
        hasStaticReason(shellUnregistered.json(), "shell_cmd_unregistered"),
        shellUnregistered.body,
      );
      registryMode = "unavailable";
      const shellUnavailable = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: shellIr("scenario-shell-unavailable", "signed.export_report"),
      });
      registryMode = "available";
      check("create shell while registry unavailable → 422", shellUnavailable.statusCode === 422, shellUnavailable.body);
      check(
        "unavailable shell reason=shell_cmd_registry_unavailable",
        hasStaticReason(shellUnavailable.json(), "shell_cmd_registry_unavailable"),
        shellUnavailable.body,
      );
      check("registry used on save", registryPurposes.includes("scenario.save"), registryPurposes.join(","));
      check("registry used on validate", registryPurposes.includes("scenario.validate"), registryPurposes.join(","));
      check("registry used on promote", registryPurposes.includes("scenario.promote"), registryPurposes.join(","));

      // 4) 무효 IR 저장 거부(422): ajv 위반(흐름키 2개) + 그래프 위반(start 미존재).
      const ajvBad = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${operator}` }, payload: ajvInvalidIr });
      check("create ajv-invalid → 422", ajvBad.statusCode === 422, ajvBad.body);
      check("ajv-invalid → IR_SCHEMA_INVALID", ajvBad.json().code === "IR_SCHEMA_INVALID", ajvBad.body);
      const graphBad = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${operator}` }, payload: graphInvalidIr("scenario-graphbad") });
      check("create graph-invalid → 422", graphBad.statusCode === 422, graphBad.body);
      check("graph-invalid → IR_SCHEMA_INVALID", graphBad.json().code === "IR_SCHEMA_INVALID", graphBad.body);

      const warningDraft = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: warningIr("scenario-warning"),
      });
      check("create warning draft → 201", warningDraft.statusCode === 201, warningDraft.body);
      const warningPromote = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${warningDraft.json().scenario_id}/promote`,
        headers: { authorization: `Bearer ${admin}`, "if-match": "1", "idempotency-key": "scenario-promote-warning" },
        payload: { target: "prod" },
      });
      check("promote warning draft → 422", warningPromote.statusCode === 422, warningPromote.body);
      check("promote warning draft → IR_SCHEMA_INVALID", warningPromote.json().code === "IR_SCHEMA_INVALID", warningPromote.body);

      // 5) RBAC: viewer는 scenario.create 미허용 → 403(파이프라인 이전 인가 차단).
      const viewerCreate = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${viewer}` }, payload: validIr("viewer-blocked") });
      check("viewer create → 403", viewerCreate.statusCode === 403, viewerCreate.body);
      check("viewer create → AUTHZ_FORBIDDEN", viewerCreate.json().code === "AUTHZ_FORBIDDEN", viewerCreate.body);

      // 6) 미존재 scenario → 404 RESOURCE_NOT_FOUND.
      const absent = await app.inject({ method: "GET", url: "/v1/scenarios/10000000-0000-0000-0000-0000000000ff", headers: { authorization: `Bearer ${operator}` } });
      check("absent scenario → 404", absent.statusCode === 404, absent.body);
      check("absent → RESOURCE_NOT_FOUND", absent.json().code === "RESOURCE_NOT_FOUND", absent.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D4.4 scenario save/validate + compile pipeline integration green");
}

main().catch((err) => {
  console.error("FAIL: scenarios integration threw:", err);
  process.exit(1);
});
