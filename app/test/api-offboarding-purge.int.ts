/**
 * Integration test for the tenant offboarding purge ledger + maker-checker
 * (/v1/offboarding/purge-requests — 설계 rpa-offboarding-data-export-deletion-design O2).
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-offboarding-purge.int.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { buildServer } from "../src/api/server";
import { processDueRunTriggers } from "../src/worker/run-trigger-scheduler";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { DurableSecurityAuditDecisionWriter, SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_offboarding_purge_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const TENANT_FAILCLOSED = "00000000-0000-4000-8000-0000000000c3";

const SECRET = new TextEncoder().encode("offboarding-purge-int-secret-do-not-use-in-prod");
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

function mint(roles: string[], sub: string, tenant = TENANT_A): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function auditCount(pool: Pool, tenant: string, action: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = $1`,
      [action],
    );
    return result.rows[0]?.n ?? -1;
  });
}

async function ledgerCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_offboarding_requests`);
    return result.rows[0]?.n ?? -1;
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
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }

    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort() {},
      async enqueueSinkDeliver() {},
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
      securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
      offboardingPurgeGraceDays: 7,
    });
    await app.ready();
    try {
      const maker = await mint(["admin"], "admin-a1");
      const checker = await mint(["admin"], "admin-a2");
      const operator = await mint(["operator"], "operator-a");
      const viewer = await mint(["viewer"], "viewer-a");
      const adminB = await mint(["admin"], "admin-b", TENANT_B);

      const post = (url: string, token: string, body: unknown, key = randomUUID()) =>
        app.inject({
          method: "POST",
          url,
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": key,
            // body 없는 명령(cancel)에 json content-type 을 붙이면 빈 바디가 malformed_request 422 로 거부된다.
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
        });

      // RBAC 게이트: purge 액션은 admin 전용, 목록(tenant_data.export)도 admin 전용.
      const operatorCreate = await post("/v1/offboarding/purge-requests", operator, { reason: "leave" });
      check("operator purge request denied -> 403", operatorCreate.statusCode === 403 && operatorCreate.json().code === "AUTHZ_FORBIDDEN", operatorCreate.body);
      const viewerList = await app.inject({ method: "GET", url: "/v1/offboarding/purge-requests", headers: { authorization: `Bearer ${viewer}` } });
      check("viewer purge list denied -> 403", viewerList.statusCode === 403, viewerList.body);

      // 형상 선검사: Idempotency-Key 누락 / reason 누락 → 422.
      const noKey = await app.inject({
        method: "POST",
        url: "/v1/offboarding/purge-requests",
        headers: { authorization: `Bearer ${maker}`, "content-type": "application/json" },
        payload: JSON.stringify({ reason: "x" }),
      });
      check("missing Idempotency-Key -> 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);
      const noReason = await post("/v1/offboarding/purge-requests", maker, { reason: "  " });
      check("missing reason -> 422", noReason.statusCode === 422, noReason.body);

      // maker 요청 생성 → pending 원장 + 같은 tx fail-closed 감사.
      const requestAuditBefore = await auditCount(pool, TENANT_A, "tenant_data.purge.request");
      const createKey = randomUUID();
      const created = await post("/v1/offboarding/purge-requests", maker, { reason: "계약 종료 오프보딩" }, createKey);
      const createdBody = created.json() as Record<string, unknown>;
      check(
        "admin create purge request -> 201 pending",
        created.statusCode === 201 && createdBody.status === "pending" && createdBody.requested_by === "admin-a1"
          && typeof createdBody.request_id === "string" && createdBody.purge_after === null,
        created.body,
      );
      check("create 는 tenant_data.purge.request audit +1", (await auditCount(pool, TENANT_A, "tenant_data.purge.request")) === requestAuditBefore + 1);
      const requestId = String(createdBody.request_id);

      // 활성 요청 UNIQUE — 두 번째 요청은 409(TENANT_OFFBOARDING).
      const dup = await post("/v1/offboarding/purge-requests", checker, { reason: "duplicate" });
      check("duplicate active request -> 409 TENANT_OFFBOARDING", dup.statusCode === 409 && dup.json().code === "TENANT_OFFBOARDING", dup.body);

      // Idempotency replay: 같은 키+같은 바디 → 최초 응답 재생(재실행 없음).
      const replay = await post("/v1/offboarding/purge-requests", maker, { reason: "계약 종료 오프보딩" }, createKey);
      check(
        "idempotency replay returns first response",
        replay.statusCode === 201 && (replay.json() as Record<string, unknown>).request_id === requestId,
        replay.body,
      );

      // SoD: 요청자 본인 결정 금지.
      const selfDecide = await post(`/v1/offboarding/purge-requests/${requestId}/decide`, maker, { decision: "approved" });
      check(
        "self approval -> 403 self_approval_forbidden",
        selfDecide.statusCode === 403 && selfDecide.json().code === "AUTHZ_FORBIDDEN",
        selfDecide.body,
      );

      const badDecision = await post(`/v1/offboarding/purge-requests/${requestId}/decide`, checker, { decision: "maybe" });
      check("invalid decision -> 422", badDecision.statusCode === 422, badDecision.body);

      // checker 승인 → approved + purge_after = decided_at + 7d(정확 일치: 같은 UPDATE 의 now()).
      const approveAuditBefore = await auditCount(pool, TENANT_A, "tenant_data.purge.approve");
      const approved = await post(`/v1/offboarding/purge-requests/${requestId}/decide`, checker, { decision: "approved", reason: "반출 확인" });
      const approvedBody = approved.json() as Record<string, unknown>;
      const graceMs = Date.parse(String(approvedBody.purge_after)) - Date.parse(String(approvedBody.decided_at));
      check(
        "checker approve -> 200 approved + purge_after=+7d",
        approved.statusCode === 200 && approvedBody.status === "approved" && approvedBody.decided_by === "admin-a2"
          && graceMs === 7 * 24 * 60 * 60 * 1000,
        `${approved.body} graceMs=${graceMs}`,
      );
      check("decide 는 tenant_data.purge.approve audit +1", (await auditCount(pool, TENANT_A, "tenant_data.purge.approve")) === approveAuditBefore + 1);

      // 이미 결정된 요청 재결정 → 404(WHERE status='pending').
      const decideAgain = await post(`/v1/offboarding/purge-requests/${requestId}/decide`, checker, { decision: "rejected" });
      check("decide non-pending -> 404", decideAgain.statusCode === 404, decideAgain.body);

      // 유예 중 취소(요청자 본인도 가능 — 복구 방향은 SoD 불요, D3).
      const cancelled = await post(`/v1/offboarding/purge-requests/${requestId}/cancel`, maker, undefined);
      check(
        "cancel approved -> 200 cancelled",
        cancelled.statusCode === 200 && (cancelled.json() as Record<string, unknown>).status === "cancelled",
        cancelled.body,
      );

      // 취소 후 재요청 가능(UNIQUE 는 활성 상태만) → 반려 흐름 검증.
      const second = await post("/v1/offboarding/purge-requests", maker, { reason: "재요청" });
      const secondId = String((second.json() as Record<string, unknown>).request_id);
      check("re-request after cancel -> 201", second.statusCode === 201, second.body);
      const rejected = await post(`/v1/offboarding/purge-requests/${secondId}/decide`, checker, { decision: "rejected", reason: "반출 미완료" });
      const rejectedBody = rejected.json() as Record<string, unknown>;
      check(
        "checker reject -> 200 rejected + decision_reason + no purge_after",
        rejected.statusCode === 200 && rejectedBody.status === "rejected" && rejectedBody.decision_reason === "반출 미완료" && rejectedBody.purge_after === null,
        rejected.body,
      );

      // 종결(rejected) 행 취소 → 409 not_cancellable / 미존재 id → 404.
      const cancelRejected = await post(`/v1/offboarding/purge-requests/${secondId}/cancel`, checker, undefined);
      check("cancel rejected row -> 409 TENANT_OFFBOARDING", cancelRejected.statusCode === 409 && cancelRejected.json().code === "TENANT_OFFBOARDING", cancelRejected.body);
      const cancelUnknown = await post(`/v1/offboarding/purge-requests/${randomUUID()}/cancel`, checker, undefined);
      check("cancel unknown id -> 404", cancelUnknown.statusCode === 404, cancelUnknown.body);

      // 목록: 최신순 + grace_days 노출.
      const list = await app.inject({ method: "GET", url: "/v1/offboarding/purge-requests", headers: { authorization: `Bearer ${maker}` } });
      const listBody = list.json() as { items: Record<string, unknown>[]; grace_days: number };
      check(
        "list -> 200 (2 rows DESC, grace_days=7)",
        list.statusCode === 200 && listBody.items.length === 2 && listBody.items[0]?.request_id === secondId
          && listBody.items[1]?.request_id === requestId && listBody.grace_days === 7,
        list.body,
      );

      // 테넌트 격리: B admin 은 A 원장을 볼 수도, 결정할 수도 없다(RLS → 404).
      const listB = await app.inject({ method: "GET", url: "/v1/offboarding/purge-requests", headers: { authorization: `Bearer ${adminB}` } });
      check("tenant B list -> empty", listB.statusCode === 200 && (listB.json() as { items: unknown[] }).items.length === 0, listB.body);
      const crossDecide = await post(`/v1/offboarding/purge-requests/${secondId}/decide`, adminB, { decision: "approved" });
      check("tenant B decide on A request -> 404", crossDecide.statusCode === 404, crossDecide.body);

      // ===== O3: 오프보딩 잠금 — approved/purging 이면 쓰기 명령 409, 읽기·반출·복구 명령은 허용 =====
      const third = await post("/v1/offboarding/purge-requests", maker, { reason: "잠금 검증" });
      const thirdId = String((third.json() as Record<string, unknown>).request_id);
      check("lock: 3rd request -> 201 pending", third.statusCode === 201, third.body);

      const capsPending = await app.inject({ method: "GET", url: "/v1/capabilities", headers: { authorization: `Bearer ${maker}` } });
      const capsPendingBody = capsPending.json() as { offboarding: Record<string, unknown> };
      check(
        "capabilities: pending 원장 노출(active, 잠금 전)",
        capsPending.statusCode === 200 && capsPendingBody.offboarding.active === true && capsPendingBody.offboarding.status === "pending"
          && capsPendingBody.offboarding.request_id === thirdId,
        capsPending.body,
      );
      // pending 은 아직 잠금 전 — 쓰기 명령이 잠금(409)이 아니라 핸들러 형상검사(422)까지 도달한다.
      const writeWhilePending = await post("/v1/scenarios", maker, {});
      check("lock: pending 은 쓰기 미차단(422 도달)", writeWhilePending.statusCode === 422, writeWhilePending.body);

      const approveThird = await post(`/v1/offboarding/purge-requests/${thirdId}/decide`, checker, { decision: "approved" });
      check("lock: 3rd approved", approveThird.statusCode === 200, approveThird.body);

      const capsApproved = await app.inject({ method: "GET", url: "/v1/capabilities", headers: { authorization: `Bearer ${maker}` } });
      const capsApprovedBody = capsApproved.json() as { offboarding: Record<string, unknown> };
      check(
        "capabilities: approved + purge_after 노출(전역 배너 데이터)",
        capsApproved.statusCode === 200 && capsApprovedBody.offboarding.status === "approved"
          && typeof capsApprovedBody.offboarding.purge_after === "string",
        capsApproved.body,
      );

      const writeLocked = await post("/v1/scenarios", maker, {});
      check(
        "lock: approved 테넌트 scenario 쓰기 -> 409 tenant_offboarding_locked",
        writeLocked.statusCode === 409 && writeLocked.json().code === "TENANT_OFFBOARDING"
          && (writeLocked.json() as { details?: { reason?: string } }).details?.reason === "tenant_offboarding_locked",
        writeLocked.body,
      );
      const runCreateLocked = await post("/v1/runs", maker, {});
      check("lock: run 생성 -> 409", runCreateLocked.statusCode === 409 && runCreateLocked.json().code === "TENANT_OFFBOARDING", runCreateLocked.body);

      const readWhileLocked = await app.inject({ method: "GET", url: "/v1/runs", headers: { authorization: `Bearer ${maker}` } });
      check("lock: 읽기는 허용(GET /v1/runs 200)", readWhileLocked.statusCode === 200, readWhileLocked.body.slice(0, 200));
      const exportWhileLocked = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs",
        headers: { authorization: `Bearer ${maker}` },
      });
      check("lock: 원문 반출은 허용(유예 창의 목적)", exportWhileLocked.statusCode === 200, exportWhileLocked.body.slice(0, 200));

      // 복구 방향 명령은 예외: run.abort 는 잠금을 통과해 핸들러(404 — 미존재 run)까지 도달해야 한다.
      const abortProbe = await post(`/v1/runs/${randomUUID()}/abort`, maker, undefined);
      check("lock: run.abort 는 잠금 예외(409 아님)", abortProbe.statusCode !== 409, `status=${abortProbe.statusCode} ${abortProbe.body}`);
      // purge 명령 자체도 예외 — 잠금이 아니라 활성 UNIQUE 가 거부(reason 구분 증명).
      const purgeWhileLocked = await post("/v1/offboarding/purge-requests", checker, { reason: "locked-dup" });
      check(
        "lock: purge 요청은 잠금 예외(활성 UNIQUE 409 로 도달)",
        purgeWhileLocked.statusCode === 409
          && (purgeWhileLocked.json() as { details?: { reason?: string } }).details?.reason === "purge_request_active",
        purgeWhileLocked.body,
      );

      const cancelThird = await post(`/v1/offboarding/purge-requests/${thirdId}/cancel`, checker, undefined);
      check("lock: 취소는 잠금 중에도 허용(복구 창)", cancelThird.statusCode === 200, cancelThird.body);
      const writeUnlocked = await post("/v1/scenarios", maker, {});
      check("lock: 취소 후 쓰기 재개(422 도달)", writeUnlocked.statusCode === 422, writeUnlocked.body);
      const capsAfterCancel = await app.inject({ method: "GET", url: "/v1/capabilities", headers: { authorization: `Bearer ${maker}` } });
      check(
        "capabilities: 취소 후 active=false",
        (capsAfterCancel.json() as { offboarding: Record<string, unknown> }).offboarding.active === false,
        capsAfterCancel.body,
      );

      // ===== O3: run-trigger 스케줄러 발화 제외(테넌트 B) =====
      const SCEN_B = "20000000-0000-4000-8000-0000000000b1";
      const SVER_B = "21000000-0000-4000-8000-0000000000b1";
      const TRIGGER_B = "22000000-0000-4000-8000-0000000000b1";
      await withTenantTx(pool, TENANT_B, async (client) => {
        await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'offboarding-lock-b')`, [SCEN_B, TENANT_B]);
        await client.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
           VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
          [SVER_B, TENANT_B, SCEN_B, JSON.stringify({
            nodes: [],
            target: {
              site_profile_id: "00000000-0000-4000-8000-0000000000f1",
              browser_identity_id: "00000000-0000-4000-8000-0000000000f2",
              network_policy_id: "00000000-0000-4000-8000-0000000000f3",
            },
          })],
        );
        await client.query(
          `INSERT INTO run_triggers
             (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
              catchup_policy, max_concurrent_runs, next_fire_at, created_by)
           VALUES ($1,$2,$3,'enabled','0 8 * * *','Asia/Seoul','{}'::jsonb,'skip_missed',1,'2026-06-23T08:00:00Z','seed')`,
          [TRIGGER_B, TENANT_B, SVER_B],
        );
      });
      const adminB2 = await mint(["admin"], "admin-b2", TENANT_B);
      const reqB = await post("/v1/offboarding/purge-requests", adminB, { reason: "B 잠금" });
      const reqBId = String((reqB.json() as Record<string, unknown>).request_id);
      const approveB = await post(`/v1/offboarding/purge-requests/${reqBId}/decide`, adminB2, { decision: "approved" });
      check("scheduler: B 승인", reqB.statusCode === 201 && approveB.statusCode === 200, `${reqB.body} ${approveB.body}`);

      let seq = 0;
      const schedulerOptions = {
        tenantIds: [TENANT_B],
        enqueuer: noopEnqueuer,
        now: () => new Date("2026-06-23T09:00:00Z"),
        correlationId: () => `66000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
      };
      const lockedStats = await processDueRunTriggers(pool, schedulerOptions);
      check("scheduler: 오프보딩 테넌트는 발화 제외(claimed 0)", lockedStats.triggersClaimed === 0, JSON.stringify(lockedStats));

      const cancelB = await post(`/v1/offboarding/purge-requests/${reqBId}/cancel`, adminB, undefined);
      check("scheduler: B 취소", cancelB.statusCode === 200, cancelB.body);
      const unlockedStats = await processDueRunTriggers(pool, schedulerOptions);
      check(
        "scheduler: 취소 후 발화 재개(claimed 1)",
        unlockedStats.triggersClaimed === 1 && unlockedStats.fireLedgersCreated === 1,
        JSON.stringify(unlockedStats),
      );

      // 감사 fail-closed = 전이 롤백: audit append 가 죽으면 요청 생성 자체가 롤백된다(설계 §4-4).
      const throwingAudit: DurableSecurityAuditDecisionWriter = {
        async recordDecision() {
          throw new Error("audit store down");
        },
      };
      const failClosedApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer: noopEnqueuer,
        signedCommandRegistry,
        securityAudit: throwingAudit,
        offboardingPurgeGraceDays: 7,
      });
      await failClosedApp.ready();
      try {
        const adminC = await mint(["admin"], "admin-c", TENANT_FAILCLOSED);
        const failed = await failClosedApp.inject({
          method: "POST",
          url: "/v1/offboarding/purge-requests",
          headers: { authorization: `Bearer ${adminC}`, "idempotency-key": randomUUID(), "content-type": "application/json" },
          payload: JSON.stringify({ reason: "audit down" }),
        });
        check("audit append 실패 -> 요청 실패(fail-closed)", failed.statusCode >= 500, failed.body);
        check("audit 실패 시 원장 행 롤백(0행)", (await ledgerCount(pool, TENANT_FAILCLOSED)) === 0);
      } finally {
        await failClosedApp.close();
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
  console.log("\nPASS: offboarding purge ledger API integration green");
}

main().catch((err) => {
  console.error("FAIL: offboarding purge int threw:", err);
  process.exit(1);
});
