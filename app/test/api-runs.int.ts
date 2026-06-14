/**
 * D4.1 통합 테스트 — 제어평면 Fastify 인증/RLS/에러 경계를 실 PostgreSQL에 대해 검증.
 *
 * 실행: temp PG15 게이트 위에서
 *   `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
 * 게이트가 PGHOST/PGPORT/PGUSER/PGDATABASE(비-BYPASSRLS rpa_smoke)를 주입한다.
 *
 * Fastify는 app.inject()(in-process)로 호출 — 네트워크 없이 미들웨어 경계 전체를 검증.
 *
 * 검증 대상(d4-prompt §5.1 게이트 + DoD RLS 격리):
 *  1) 미인증(토큰 없음/서명 무효) → 401 UNAUTHENTICATED(ApiError).
 *  2) 인증됐으나 tenant_id 클레임 부재 → 403 AUTHZ_FORBIDDEN.
 *  3) 인증+자기 tenant run 조회 → 200(status/worker_id/attempts/as_of).
 *  4) RLS 격리: tenant A 토큰으로 tenant B run 조회 → 404 RUN_NOT_FOUND(cross-tenant 차단).
 *  5) 존재하지 않는 run → 404 RUN_NOT_FOUND. correlation_id 에코(x-correlation-id).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { createPool, withTenantTx } from "../src/db/pool";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore, canonicalRequestHash } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueueInput, RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";
import type { CanonicalRequestHash, IdempotencyKey, TenantId } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_api_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCENARIO_A = "10000000-0000-0000-0000-0000000000a3";
const SVER_A = "10000000-0000-0000-0000-0000000000a4";
const RUN_A = "10000000-0000-0000-0000-0000000000a7";
const WORKITEM_A = "10000000-0000-0000-0000-0000000000a5";
const CORR_A = "20000000-0000-0000-0000-0000000000a1";
const SCENARIO_B = "10000000-0000-0000-0000-0000000000b3";
const SVER_B = "10000000-0000-0000-0000-0000000000b4";
const RUN_B = "10000000-0000-0000-0000-0000000000b7";
const CORR_B = "20000000-0000-0000-0000-0000000000b1";
const ABSENT_RUN = "10000000-0000-0000-0000-0000000000ff";

// HS256 공유 시크릿(테스트 전용, >=32바이트). 운영은 RS256/JWKS 검증기 주입.
const SECRET = new TextEncoder().encode("d41-int-test-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return {
      kind: "available",
      snapshot: {
        sourceRef: "secret://staging/signed-command-registry" as SecretRef,
        commands: [],
      },
    };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedTenantRun(
  pool: ReturnType<typeof createPool>,
  tenant: string,
  scenario: string,
  sver: string,
  run: string,
  correlation: string,
): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'d41')`, [scenario, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scenario],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of)
       VALUES ($1,$2,$3,'running',$4,2,'2026-06-14T00:00:00Z')`,
      [run, tenant, sver, correlation],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    // --- 마이그레이션 적용(concurrency → core), 전용 스키마(D2 검증 패턴). ---
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

    await seedTenantRun(pool, TENANT_A, SCENARIO_A, SVER_A, RUN_A, CORR_A);
    await seedTenantRun(pool, TENANT_B, SCENARIO_B, SVER_B, RUN_B, CORR_B);
    await withTenantTx(pool, TENANT_A, (c) =>
      c.query(`INSERT INTO workitems (id, tenant_id, connector_id, unique_reference) VALUES ($1,$2,'d43','wi-a')`, [WORKITEM_A, TENANT_A]),
    );
    console.log("seeded runs for tenant A and tenant B");

    // run create enqueue 스파이(graphile 미설치 테스트 환경 — enqueue 호출만 기록).
    const enqueued: RunEnqueueInput[] = [];
    const spyEnqueuer: RunEnqueuer = {
      async enqueueRunClaim(_client, input) {
        enqueued.push(input);
      },
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: spyEnqueuer,
      signedCommandRegistry,
    });
    // 테스트 전용: rbacAction 미선언(매칭) 라우트 → fail-closed 게이트(403) 검증용.
    app.get("/v1/_norbac_probe", async () => ({ ok: true }));
    await app.ready();
    try {
      const tokenA = await mint({ sub: "user-a", tenant_id: TENANT_A, roles: ["operator"] });
      const tokenNoTenant = await mint({ sub: "user-x", roles: ["operator"] });
      const tokenViewer = await mint({ sub: "user-v", tenant_id: TENANT_A, roles: ["viewer"] });
      const tokenNoRole = await mint({ sub: "user-z", tenant_id: TENANT_A, roles: [] });
      const tokenBadRole = await mint({ sub: "user-badrole", tenant_id: TENANT_A, roles: ["viewer", "bogus"] });
      const tokenNoSubject = await mint({ tenant_id: TENANT_A, roles: ["viewer"] });

      // 1) 미인증: Authorization 없음 → 401 UNAUTHENTICATED + correlation_id 에코.
      const noAuth = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { "x-correlation-id": "corr-noauth" },
      });
      check("no token → 401", noAuth.statusCode === 401, String(noAuth.statusCode));
      check("no token → UNAUTHENTICATED", noAuth.json().code === "UNAUTHENTICATED", noAuth.body);
      check("ApiError shape (code/message/correlation_id)",
        typeof noAuth.json().message === "string" && noAuth.json().correlation_id === "corr-noauth", noAuth.body);

      // 1b) 서명 무효 Bearer → 401 UNAUTHENTICATED.
      const badToken = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: "Bearer not.a.valid.jwt" },
      });
      check("invalid token → 401", badToken.statusCode === 401, String(badToken.statusCode));
      check("invalid token → UNAUTHENTICATED", badToken.json().code === "UNAUTHENTICATED", badToken.body);

      // 2) 인증됐으나 tenant_id 클레임 부재 → 403 AUTHZ_FORBIDDEN.
      const noTenant = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenNoTenant}` },
      });
      check("authenticated, no tenant claim → 403", noTenant.statusCode === 403, String(noTenant.statusCode));
      check("no tenant claim → AUTHZ_FORBIDDEN", noTenant.json().code === "AUTHZ_FORBIDDEN", noTenant.body);

      // 3) 인증 + 자기 tenant run 조회 → 200.
      const ownRun = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      check("own run → 200", ownRun.statusCode === 200, ownRun.body);
      const runBody = ownRun.json();
      check("own run body.run_id", runBody.run_id === RUN_A, JSON.stringify(runBody));
      check("own run body.status", runBody.status === "running", JSON.stringify(runBody));
      check("own run body.attempts", runBody.attempts === 2, JSON.stringify(runBody));
      check("own run body.worker_id null", runBody.worker_id === null, JSON.stringify(runBody));
      check("own run body.as_of round-trips", typeof runBody.as_of === "string" && new Date(runBody.as_of).toISOString() === "2026-06-14T00:00:00.000Z", JSON.stringify(runBody));

      // 3b) RBAC 허용: viewer 역할도 run.read 허용 → 200(auth-rbac §2).
      const viewerRead = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenViewer}` },
      });
      check("viewer run.read → 200 (RBAC allow)", viewerRead.statusCode === 200, viewerRead.body);

      // 3c) RBAC 거부: 역할 없는 토큰은 run.read 미허용 → 403 AUTHZ_FORBIDDEN(인증 통과 후 인가 단계 차단).
      const noRoleRead = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenNoRole}` },
      });
      check("no-role run.read → 403 (RBAC deny)", noRoleRead.statusCode === 403, noRoleRead.body);
      check("no-role → AUTHZ_FORBIDDEN", noRoleRead.json().code === "AUTHZ_FORBIDDEN", noRoleRead.body);
      const badRoleRead = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenBadRole}` },
      });
      check("unknown role claim → 403", badRoleRead.statusCode === 403, badRoleRead.body);
      check("unknown role claim → AUTHZ_FORBIDDEN", badRoleRead.json().code === "AUTHZ_FORBIDDEN", badRoleRead.body);
      const noSubjectRead = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenNoSubject}` },
      });
      check("missing subject claim → 403", noSubjectRead.statusCode === 403, noSubjectRead.body);
      check("missing subject claim → AUTHZ_FORBIDDEN", noSubjectRead.json().code === "AUTHZ_FORBIDDEN", noSubjectRead.body);

      // 3d) fail-closed: rbacAction 미선언(매칭) 라우트는 인증돼도 403(미설정 시 통과 금지).
      const noRbacRoute = await app.inject({
        method: "GET",
        url: "/v1/_norbac_probe",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      check("matched route w/o rbacAction → 403 (fail-closed)", noRbacRoute.statusCode === 403, noRbacRoute.body);
      check("fail-closed → AUTHZ_FORBIDDEN", noRbacRoute.json().code === "AUTHZ_FORBIDDEN", noRbacRoute.body);

      // 3e) 미매칭 라우트/미지원 메서드는 인증 이전에 404 RESOURCE_NOT_FOUND(403·401 아님; api-surface §2 각주1).
      const unmatchedAuthed = await app.inject({
        method: "GET",
        url: "/v1/nope",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      check("unmatched route (authed) → 404", unmatchedAuthed.statusCode === 404, unmatchedAuthed.body);
      check("unmatched → RESOURCE_NOT_FOUND", unmatchedAuthed.json().code === "RESOURCE_NOT_FOUND", unmatchedAuthed.body);
      const unmatchedNoAuth = await app.inject({ method: "GET", url: "/v1/nope" });
      check("unmatched route (no auth) → 404 (auth skipped on is404)", unmatchedNoAuth.statusCode === 404, unmatchedNoAuth.body);
      const optionsReq = await app.inject({
        method: "OPTIONS",
        url: `/v1/runs/${RUN_A}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      check("OPTIONS (no handler) → 404 not 403", optionsReq.statusCode === 404, optionsReq.body);

      // 4) RLS 격리: tenant A 토큰으로 tenant B run 조회 → 404(cross-tenant 차단).
      const crossTenant = await app.inject({
        method: "GET",
        url: `/v1/runs/${RUN_B}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      check("cross-tenant run → 404 (RLS isolation)", crossTenant.statusCode === 404, crossTenant.body);
      check("cross-tenant → RUN_NOT_FOUND", crossTenant.json().code === "RUN_NOT_FOUND", crossTenant.body);

      // 5) 존재하지 않는 run → 404 RUN_NOT_FOUND.
      const absent = await app.inject({
        method: "GET",
        url: `/v1/runs/${ABSENT_RUN}`,
        headers: { authorization: `Bearer ${tokenA}`, "x-correlation-id": "corr-absent" },
      });
      check("absent run → 404", absent.statusCode === 404, absent.body);
      check("absent → RUN_NOT_FOUND", absent.json().code === "RUN_NOT_FOUND", absent.body);
      check("absent correlation_id echo", absent.json().correlation_id === "corr-absent", absent.body);

      // 6) POST /v1/runs 멱등(release-decisions #7) + params.as_of(§0.6). tokenA=operator(run.create 허용).
      // 6a) Idempotency-Key 누락 → 422 IR_SCHEMA_INVALID(예약 이전 선검사).
      const missingKey = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { scenario_version_id: SVER_A },
      });
      check("POST /runs missing Idempotency-Key → 422", missingKey.statusCode === 422, missingKey.body);
      check("missing key → IR_SCHEMA_INVALID", missingKey.json().code === "IR_SCHEMA_INVALID", missingKey.body);

      // 6b) params 누락/unknown field → 422 IR_SCHEMA_INVALID(예약 이전 선검사, OpenAPI closed shape).
      const missingParams = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-missing-params" },
        payload: { scenario_version_id: SVER_A },
      });
      check("POST /runs missing params → 422", missingParams.statusCode === 422, missingParams.body);
      check("missing params → IR_SCHEMA_INVALID", missingParams.json().code === "IR_SCHEMA_INVALID", missingParams.body);
      const unknownField = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-tenant-in-body" },
        payload: { scenario_version_id: SVER_A, params: {}, tenant_id: TENANT_B },
      });
      check("POST /runs unknown tenant_id field → 422", unknownField.statusCode === 422, unknownField.body);
      check("unknown field → IR_SCHEMA_INVALID", unknownField.json().code === "IR_SCHEMA_INVALID", unknownField.body);

      // 6c) 최초 생성 → 201 queued + as_of 1회 고정 + enqueue 1회.
      const createBody = { scenario_version_id: SVER_A, params: { as_of: "2026-06-14T09:00:00Z" } };
      const created = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-1" },
        payload: createBody,
      });
      check("POST /runs → 201", created.statusCode === 201, created.body);
      const createdBody = created.json();
      check("created status=queued", createdBody.status === "queued", JSON.stringify(createdBody));
      check("created as_of fixed", createdBody.as_of === "2026-06-14T09:00:00Z", JSON.stringify(createdBody));
      check("enqueue called once", enqueued.length === 1, `enqueued=${enqueued.length}`);
      const firstRunId = createdBody.run_id;

      // 6d) 동일 키+본문 재요청 → 멱등 재생(같은 응답, 새 run/enqueue 없음).
      const replay = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-1" },
        payload: createBody,
      });
      check("replay → 201 same run_id", replay.statusCode === 201 && replay.json().run_id === firstRunId, replay.body);
      check("replay no new enqueue", enqueued.length === 1, `enqueued=${enqueued.length}`);

      // 6e) 동일 키 + 다른 본문 → 412 SCENARIO_VERSION_CONFLICT(request_hash mismatch, #7).
      const hashMismatch = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-1" },
        payload: { scenario_version_id: SVER_A, params: { as_of: "2026-06-14T10:00:00Z" } },
      });
      check("same key + diff body → 412", hashMismatch.statusCode === 412, hashMismatch.body);
      check("hash mismatch → SCENARIO_VERSION_CONFLICT", hashMismatch.json().code === "SCENARIO_VERSION_CONFLICT", hashMismatch.body);

      // 6f) runs 행은 정확히 1건 + run.created outbox 1건(재생/충돌이 중복 부작용 없음).
      await withTenantTx(pool, TENANT_A, async (c) => {
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE id = $1::uuid`, [firstRunId]);
        check("exactly 1 run row for idempotent create", n.rows[0]?.n === 1, `n=${n.rows[0]?.n}`);
        const ev = await c.query(`SELECT 1 FROM events_outbox WHERE run_id=$1::uuid AND event_type='run.created'`, [firstRunId]);
        check("run.created outbox emitted", ev.rowCount === 1, `rowCount=${ev.rowCount}`);
        const idem = await c.query<{ has_retention: boolean; retention_matches_expiry: boolean }>(
          `SELECT retention_until IS NOT NULL AS has_retention,
                  retention_until = expires_at AS retention_matches_expiry
             FROM control_plane_idempotency_keys
            WHERE endpoint='createRun' AND idempotency_key=$1`,
          ["run-create-1"],
        );
        check("idempotency response retention set", idem.rows[0]?.has_retention === true, JSON.stringify(idem.rows[0]));
        check(
          "idempotency response retention follows expires_at",
          idem.rows[0]?.retention_matches_expiry === true,
          JSON.stringify(idem.rows[0]),
        );
      });

      // 6g) in-flight 409(pipeline): 동일 키의 미완(processing) 예약이 있으면 재요청은 WORKITEM_CHECKOUT_CONFLICT(409).
      const inflightBody = { scenario_version_id: SVER_A, params: { as_of: "2026-06-14T11:00:00Z" } };
      const store = new PgControlPlaneIdempotencyStore(pool);
      const reserved = await store.reserve({
        tenantId: TENANT_A as TenantId,
        endpoint: "createRun",
        key: "run-create-inflight" as IdempotencyKey,
        requestHash: canonicalRequestHash("POST", "/v1/runs", inflightBody) as CanonicalRequestHash,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      check("pre-reserve → reserved", reserved.kind === "reserved", JSON.stringify(reserved));
      const inflight = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-inflight" },
        payload: inflightBody,
      });
      check("in-flight dup → 409", inflight.statusCode === 409, inflight.body);
      check("in-flight → WORKITEM_CHECKOUT_CONFLICT", inflight.json().code === "WORKITEM_CHECKOUT_CONFLICT", inflight.body);

      // 6h) RBAC: viewer는 run.create 미허용 → 403(멱등 예약 이전 차단; key 오염 금지).
      const viewerCreate = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenViewer}`, "idempotency-key": "run-create-viewer" },
        payload: { scenario_version_id: SVER_A, params: {} },
      });
      check("viewer run.create → 403", viewerCreate.statusCode === 403, viewerCreate.body);
      check("viewer create → AUTHZ_FORBIDDEN", viewerCreate.json().code === "AUTHZ_FORBIDDEN", viewerCreate.body);
      const viewerReplay = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenViewer}`, "idempotency-key": "run-create-viewer" },
        payload: { scenario_version_id: SVER_A, params: {} },
      });
      check("viewer run.create replay → 403", viewerReplay.statusCode === 403, viewerReplay.body);
      check("viewer replay no enqueue", enqueued.length === 1, `enqueued=${enqueued.length}`);
      await withTenantTx(pool, TENANT_A, async (c) => {
        const reservedByViewer = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM control_plane_idempotency_keys
            WHERE endpoint='createRun' AND idempotency_key=$1`,
          ["run-create-viewer"],
        );
        check(
          "viewer deny did not reserve idempotency key",
          reservedByViewer.rows[0]?.n === 0,
          `n=${reservedByViewer.rows[0]?.n}`,
        );
      });
      const operatorAfterViewerDeny = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-viewer" },
        payload: { scenario_version_id: SVER_A, params: {} },
      });
      check(
        "authorized create after viewer deny → 201",
        operatorAfterViewerDeny.statusCode === 201,
        operatorAfterViewerDeny.body,
      );
      check("viewer deny did not poison key", enqueued.length === 2, `enqueued=${enqueued.length}`);

      // 6i) 잘못된 as_of(비-ISO) → 422 IR_SCHEMA_INVALID(예약 이전, ::timestamptz cast 500 회피).
      const badAsOf = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-bad-asof" },
        payload: { scenario_version_id: SVER_A, params: { as_of: "not-a-date" } },
      });
      check("invalid as_of → 422", badAsOf.statusCode === 422, badAsOf.body);
      check("invalid as_of → IR_SCHEMA_INVALID", badAsOf.json().code === "IR_SCHEMA_INVALID", badAsOf.body);

      // 6j) workitem_id 연결: 존재하는 workitem → 201 + runs.workitem_id 연결(무성 드롭 아님).
      const linked = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-wi" },
        payload: { scenario_version_id: SVER_A, workitem_id: WORKITEM_A, params: { as_of: "2026-06-14T12:00:00Z" } },
      });
      check("POST /runs with workitem_id → 201", linked.statusCode === 201, linked.body);
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ workitem_id: string | null }>(`SELECT workitem_id FROM runs WHERE id=$1::uuid`, [linked.json().run_id]);
        check("run linked to workitem", r.rows[0]?.workitem_id === WORKITEM_A, JSON.stringify(r.rows[0]));
      });

      // 6k) 존재하지 않는 workitem_id → 422(FK 위반 500 아님).
      const badWi = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": "run-create-badwi" },
        payload: { scenario_version_id: SVER_A, workitem_id: "10000000-0000-0000-0000-0000000000ee", params: {} },
      });
      check("nonexistent workitem_id → 422", badWi.statusCode === 422, badWi.body);
      check("nonexistent workitem → IR_SCHEMA_INVALID", badWi.json().code === "IR_SCHEMA_INVALID", badWi.body);
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
  console.log("\nPASS: D4.3 control-plane API/idempotency integration green");
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
