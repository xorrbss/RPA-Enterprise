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
const SITE_A = "a0000000-0000-4000-8000-000000000001";
const IDENTITY_A = "a0000000-0000-4000-8000-000000000002";
const NETWORK_A = "a0000000-0000-4000-8000-000000000003";
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
  if (!isRecord(body)) return false;
  const report =
    isRecord(body.details) && isRecord(body.details.report)
      ? body.details.report
      : isRecord(body.report)
        ? body.report
        : undefined;
  if (!isRecord(report)) return false;
  const errors = report.errors;
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
const fileIr = (name: string): ScenarioIrFixture => ({
  meta: { name, version: 1 },
  start: "n1",
  nodes: {
    n1: { what: [{ action: "file" }], terminal: "success" },
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
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
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
      check("get returns ir body (편집 prefill용)", got.json().ir?.meta?.name === "scenario-a", got.body);
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
      const unpromoted = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/promote`,
        headers: { authorization: `Bearer ${admin}`, "if-match": "1", "idempotency-key": "scenario-unpromote-a" },
        payload: { target: "draft" },
      });
      check("unpromote latest prod → 200", unpromoted.statusCode === 200, unpromoted.body);
      check("unpromote status=draft + ETag", unpromoted.json().promotion_status === "draft" && unpromoted.headers.etag === "1", unpromoted.body);
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
      check("create registered shell cmd_ref rejected in browser product mode → 422", shellCreate.statusCode === 422, shellCreate.body);
      check(
        "registered shell reason=unsupported_browser_product_action",
        hasStaticReason(shellCreate.json(), "unsupported_browser_product_action"),
        shellCreate.body,
      );
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM scenarios
            WHERE tenant_id=$1::uuid AND name=$2`,
          [TENANT_A, "scenario-shell-ok"],
        );
        check("rejected shell create does not insert scenario", r.rows[0]?.count === "0", JSON.stringify(r.rows[0]));
      });
      const shellValidate = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/validate`,
        headers: { authorization: `Bearer ${viewer}` },
        payload: shellIr("ignored-shell", "signed.export_report"),
      });
      check("validate registered shell cmd_ref rejected in browser product mode", shellValidate.statusCode === 200 && shellValidate.json().valid === false, shellValidate.body);
      check(
        "validate shell reason=unsupported_browser_product_action",
        hasStaticReason(shellValidate.json(), "unsupported_browser_product_action"),
        shellValidate.body,
      );
      const fileCreate = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: fileIr("scenario-file-rejected"),
      });
      check("create file action rejected in browser product mode → 422", fileCreate.statusCode === 422, fileCreate.body);
      check(
        "file action reason=unsupported_browser_product_action",
        hasStaticReason(fileCreate.json(), "unsupported_browser_product_action"),
        fileCreate.body,
      );
      const shellUnregistered = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: shellIr("scenario-shell-unregistered", "signed.unknown"),
      });
      check("create unregistered shell cmd_ref → 422", shellUnregistered.statusCode === 422, shellUnregistered.body);
      check(
        "unregistered shell also reason=unsupported_browser_product_action",
        hasStaticReason(shellUnregistered.json(), "unsupported_browser_product_action"),
        shellUnregistered.body,
      );
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
        "unavailable shell also reason=unsupported_browser_product_action",
        hasStaticReason(shellUnavailable.json(), "unsupported_browser_product_action"),
        shellUnavailable.body,
      );
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

      // 7) PUT 편집 = 새 draft version(If-Match, meta.version=현재+1). scenarioId는 현재 version 1.
      const irV = (name: string, version: number) => ({ ...validIr(name), meta: { name, version } });
      const auth = (token: string) => `Bearer ${token}`;

      const edited = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator), "if-match": "1" }, payload: irV("scenario-a", 2) });
      check("edit PUT If-Match:1 → 200 v2 + ETag", edited.statusCode === 200 && edited.json().version === 2 && edited.headers.etag === "2", edited.body);
      check("edit promotion_status=draft", edited.json().promotion_status === "draft", edited.body);
      const editGot = await app.inject({ method: "GET", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(viewer) } });
      check("after edit GET version=2", editGot.json().version === 2, editGot.body);

      const editStale = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator), "if-match": "1" }, payload: irV("scenario-a", 3) });
      check("edit stale If-Match → 412 SCENARIO_VERSION_CONFLICT", editStale.statusCode === 412 && editStale.json().code === "SCENARIO_VERSION_CONFLICT", editStale.body);
      const editNoMatch = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator) }, payload: irV("scenario-a", 3) });
      check("edit missing If-Match → 412 missing_if_match", editNoMatch.statusCode === 412 && editNoMatch.json().details?.reason === "missing_if_match", editNoMatch.body);
      const editBadVer = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator), "if-match": "2" }, payload: irV("scenario-a", 9) });
      check("edit wrong meta.version → 422 version_must_increment", editBadVer.statusCode === 422 && editBadVer.json().details?.reason === "version_must_increment", editBadVer.body);
      const editRename = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator), "if-match": "2" }, payload: irV("renamed", 3) });
      check("edit rename → 422 scenario_name_immutable", editRename.statusCode === 422 && editRename.json().details?.reason === "scenario_name_immutable", editRename.body);
      const editInvalid = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator), "if-match": "2" }, payload: { meta: { name: "scenario-a", version: 3 }, start: "missing", nodes: { n1: { terminal: "success" } } } });
      check("edit invalid IR → 422 IR_SCHEMA_INVALID", editInvalid.statusCode === 422 && editInvalid.json().code === "IR_SCHEMA_INVALID", editInvalid.body);
      const editFile = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(operator), "if-match": "2" }, payload: { ...fileIr("scenario-a"), meta: { name: "scenario-a", version: 3 } } });
      check("edit file action rejected in browser product mode → 422", editFile.statusCode === 422 && hasStaticReason(editFile.json(), "unsupported_browser_product_action"), editFile.body);
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM scenario_versions
            WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid`,
          [TENANT_A, scenarioId],
        );
        check("rejected file edit does not insert version", r.rows[0]?.count === "2", JSON.stringify(r.rows[0]));
      });
      const editViewer = await app.inject({ method: "PUT", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(viewer), "if-match": "2" }, payload: irV("scenario-a", 3) });
      check("viewer edit → 403 AUTHZ_FORBIDDEN", editViewer.statusCode === 403 && editViewer.json().code === "AUTHZ_FORBIDDEN", editViewer.body);
      const editAbsent = await app.inject({ method: "PUT", url: "/v1/scenarios/10000000-0000-0000-0000-0000000000ff", headers: { authorization: auth(operator), "if-match": "1" }, payload: irV("ghost", 2) });
      check("edit absent scenario → 404 RESOURCE_NOT_FOUND", editAbsent.statusCode === 404 && editAbsent.json().code === "RESOURCE_NOT_FOUND", editAbsent.body);

      // 8) 버전 목록/롤백/보관: 과거 버전을 최신+1 draft로 복제하고, 보관 후 active 목록/상세/실행 생성 동선에서 제외.
      const versions = await app.inject({ method: "GET", url: `/v1/scenarios/${scenarioId}/versions`, headers: { authorization: auth(viewer) } });
      check("versions list → 200, v2 then v1", versions.statusCode === 200 && versions.json().items[0]?.version === 2 && versions.json().items[1]?.version === 1, versions.body);
      const versionOne = await app.inject({ method: "GET", url: `/v1/scenarios/${scenarioId}/versions/1`, headers: { authorization: auth(viewer) } });
      check("version detail v1 → ir body", versionOne.statusCode === 200 && versionOne.json().ir?.meta?.version === 1, versionOne.body);
      const rollback = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/1/rollback`,
        headers: { authorization: auth(operator), "if-match": "2", "idempotency-key": "scenario-rollback-a" },
        payload: {},
      });
      check("rollback v1 → v3 draft", rollback.statusCode === 200 && rollback.json().version === 3 && rollback.json().promotion_status === "draft", rollback.body);
      const rollbackReplay = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/versions/1/rollback`,
        headers: { authorization: auth(operator), "if-match": "2", "idempotency-key": "scenario-rollback-a" },
        payload: {},
      });
      check(
        "rollback replay → 200 same v3 without duplicate",
        rollbackReplay.statusCode === 200 &&
          rollbackReplay.json().version === 3 &&
          rollbackReplay.json().rolled_back_from === 1 &&
          rollbackReplay.headers.etag === "3",
        rollbackReplay.body,
      );
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ max_version: string; version_count: string }>(
          `SELECT max(version)::text AS max_version, count(*)::text AS version_count
             FROM scenario_versions
            WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid`,
          [TENANT_A, scenarioId],
        );
        check("rollback replay keeps max version at v3", r.rows[0]?.max_version === "3" && r.rows[0]?.version_count === "3", JSON.stringify(r.rows[0]));
      });
      const archive = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/archive`,
        headers: { authorization: auth(operator), "if-match": "3", "idempotency-key": "scenario-archive-a" },
        payload: {},
      });
      check("archive active scenario → 200", archive.statusCode === 200 && archive.json().archived === true, archive.body);
      const archiveReplay = await app.inject({
        method: "POST",
        url: `/v1/scenarios/${scenarioId}/archive`,
        headers: { authorization: auth(operator), "if-match": "3", "idempotency-key": "scenario-archive-a" },
        payload: {},
      });
      check(
        "archive replay → 200 same body",
        archiveReplay.statusCode === 200 &&
          archiveReplay.json().version === 3 &&
          archiveReplay.json().archived === true &&
          archiveReplay.headers.etag === "3",
        archiveReplay.body,
      );
      const archivedGet = await app.inject({ method: "GET", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: auth(viewer) } });
      check("archived scenario detail hidden → 404", archivedGet.statusCode === 404, archivedGet.body);
      const recreateName = await app.inject({
        method: "POST",
        url: "/v1/scenarios",
        headers: { authorization: auth(operator) },
        payload: validIr("scenario-a"),
      });
      check("archived scenario name can be reused → 201", recreateName.statusCode === 201, recreateName.body);

      // [run target 자동 추론] 쉬운 만들기/일반 저장 IR은 ir.target 미설정 → 저장 시 시작 URL로 사이트 자동 추론·주입
      //   (없으면 createRun 이 run_target_unresolved 로 거부). 명시 target 보존·추론 실패 시 미주입(후방호환) 검증.
      await withTenantTx(pool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
           VALUES ($1::uuid,$2::uuid,'auto-site','https://auto.example','green',true,'{"flags":{}}'::jsonb)`,
          [SITE_A, TENANT_A],
        );
        await c.query(
          `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1::uuid,$2::uuid,$3::uuid,'default')`,
          [IDENTITY_A, TENANT_A, SITE_A],
        );
        await c.query(
          `INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1::uuid,$2::uuid,ARRAY['auto.example'])`,
          [NETWORK_A, TENANT_A],
        );
      });
      const easyIrAt = (name: string, url: string, mode = "easy") => ({
        meta: { name, version: 1, studio_mode: mode },
        params_schema: { type: "object", properties: { entry_url: { type: "string", default: url } }, required: ["entry_url"] },
        start: "open",
        nodes: {
          open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "collect" },
          collect: { what: [{ action: "extract", instruction: "현재 페이지에서 데이터를 추출하라.", schema_ref: "data" }], next: "done" },
          done: { terminal: "success" },
        },
      });
      const targetOf = (scenarioId: string): Promise<unknown> =>
        withTenantTx(pool, TENANT_A, async (c) => {
          const r = await c.query<{ target: unknown }>(
            `SELECT sv.ir->'target' AS target FROM scenarios s JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id WHERE s.id=$1::uuid`,
            [scenarioId],
          );
          return r.rows[0]?.target ?? null;
        });
      const autoCreate = await app.inject({
        method: "POST", url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: easyIrAt("auto-target-easy", "https://auto.example/list"),
      });
      check("easy IR(타깃 없음) 저장 → 201", autoCreate.statusCode === 201, autoCreate.body);
      const autoTarget = await targetOf(autoCreate.json().scenario_id);
      check(
        "저장 IR에 target 자동 주입(site/browser/network)",
        isRecord(autoTarget) && autoTarget.site_profile_id === SITE_A && typeof autoTarget.browser_identity_id === "string" && typeof autoTarget.network_policy_id === "string",
        JSON.stringify(autoTarget),
      );
      const noSite = await app.inject({
        method: "POST", url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: easyIrAt("auto-target-nosite", "https://unregistered.example/x"),
      });
      check("미등록 URL 저장 → 201", noSite.statusCode === 201, noSite.body);
      check("미등록 URL은 target 미주입(후방호환)", (await targetOf(noSite.json().scenario_id)) === null, "expected null target");
      const explicit = await app.inject({
        method: "POST", url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: { ...easyIrAt("auto-target-explicit", "https://auto.example/keep", "ir"), target: { site_profile_id: SITE_A, browser_identity_id: IDENTITY_A, network_policy_id: NETWORK_A } },
      });
      check("명시 target IR 저장 → 201", explicit.statusCode === 201, explicit.body);
      const explicitTarget = await targetOf(explicit.json().scenario_id);
      check("명시 target 보존(추론이 덮어쓰지 않음)", isRecord(explicitTarget) && explicitTarget.network_policy_id === NETWORK_A, JSON.stringify(explicitTarget));

      // IFM-1(감사): version 충돌(412)은 멱등 키를 영구 잠그지 않는다 — stale If-Match→412(키 K 소비) 후, 같은 키 K +
      //   올바른 If-Match 재시도가 성공해야 한다(예약 회수). 수정 전엔 412 가 멱등 레코드에 영속돼 K 가 24h 동안 stale
      //   412 를 영구 replay(§0.3 'If-Match 재시도' 불가).
      {
        const c1 = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${operator}` }, payload: validIr("ifm1-release") });
        check("IFM-1: 시나리오 생성 → 201", c1.statusCode === 201, c1.body);
        const sid = c1.json().scenario_id as string;
        const key = "ifm1-rollback-key";
        const stale = await app.inject({ method: "POST", url: `/v1/scenarios/${sid}/versions/1/rollback`, headers: { authorization: `Bearer ${operator}`, "if-match": "999", "idempotency-key": key }, payload: {} });
        check("IFM-1: stale If-Match rollback → 412 SCENARIO_VERSION_CONFLICT(키 소비)", stale.statusCode === 412 && stale.json().code === "SCENARIO_VERSION_CONFLICT", stale.body);
        const retry = await app.inject({ method: "POST", url: `/v1/scenarios/${sid}/versions/1/rollback`, headers: { authorization: `Bearer ${operator}`, "if-match": "1", "idempotency-key": key }, payload: {} });
        check("IFM-1: 같은 키 + 올바른 If-Match 재시도 → 성공(412 영구잠금/replay 아님)", retry.statusCode !== 412 && retry.statusCode < 300, `status=${retry.statusCode} body=${retry.body}`);
      }
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
