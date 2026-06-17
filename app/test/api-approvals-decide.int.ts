/**
 * 통합 — POST /v1/approvals/decide (하이웍스 결재 인박스 Model A). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-approvals-decide.int.ts
 * 검증: approver 결재→201 + approval_decisions 행 + 정확히 1 run 스폰, RBAC 거부(viewer/operator→403),
 *       멱등 replay(동일 키)→동일 spawned_run_id·재스폰 없음, 다른 키·동일(run,doc)→APPROVAL_ALREADY_DECIDED(스폰 없음),
 *       reject⇒reason 필수(422), cross-tenant source_run→404(RLS), malformed/멱등키 누락→422.
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

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_approvals_decide_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const APPROVER_SUB = "11111111-0000-0000-0000-000000000001";
const SCEN_A = "70000000-0000-0000-0000-0000000000a1";
const SVER_A = "70000000-0000-0000-0000-0000000000a2";
const SOURCE_RUN_A = "70000000-0000-0000-0000-0000000000a3";
const DECIDE_SCEN_A = "70000000-0000-0000-0000-0000000000a4";
const DECIDE_SVER_A = "70000000-0000-0000-0000-0000000000a5";
const SCEN_B = "70000000-0000-0000-0000-0000000000b1";
const SVER_B = "70000000-0000-0000-0000-0000000000b2";
const SOURCE_RUN_B = "70000000-0000-0000-0000-0000000000b3";

const DOC_A = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/984261";
const DOC_B = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/984262";

const SECRET = new TextEncoder().encode("approvals-decide-int-secret-do-not-use-in-prod-0123456789");
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
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seed(pool: Pool): Promise<void> {
  // tenant A: 수집 시나리오 + 완료 run(source) + DECIDE 시나리오(prod).
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 수집')`, [SCEN_A, TENANT_A]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod','{}'::jsonb)`, [SVER_A, TENANT_A, SCEN_A]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status) VALUES ($1,$2,$3,$4,'completed')`, [SOURCE_RUN_A, TENANT_A, SVER_A, SOURCE_RUN_A]);
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 처리')`, [DECIDE_SCEN_A, TENANT_A]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod','{}'::jsonb)`, [DECIDE_SVER_A, TENANT_A, DECIDE_SCEN_A]);
  });
  // tenant B: 수집 + source run(cross-tenant 격리 테스트용).
  await withTenantTx(pool, TENANT_B, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 수집')`, [SCEN_B, TENANT_B]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod','{}'::jsonb)`, [SVER_B, TENANT_B, SCEN_B]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status) VALUES ($1,$2,$3,$4,'completed')`, [SOURCE_RUN_B, TENANT_B, SVER_B, SOURCE_RUN_B]);
  });
}

/** tenant A 의 (결정 행 수, DECIDE sver 로 스폰된 run 수). */
async function counts(pool: Pool): Promise<{ decisions: number; spawned: number }> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const d = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_decisions`);
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM runs WHERE scenario_version_id=$1::uuid`, [DECIDE_SVER_A]);
    return { decisions: Number(d.rows[0]!.n), spawned: Number(r.rows[0]!.n) };
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seed(pool);

    let spawnCount = 0;
    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {
        spawnCount += 1;
      },
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
    });
    await app.ready();
    try {
      const approver = await mint({ sub: APPROVER_SUB, tenant_id: TENANT_A, roles: ["approver"] });
      const viewer = await mint({ sub: "v1", tenant_id: TENANT_A, roles: ["viewer"] });
      const operator = await mint({ sub: "o1", tenant_id: TENANT_A, roles: ["operator"] });

      const post = (token: string, key?: string, body?: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/approvals/decide",
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });

      // 1) approver 승인 결재 → 201 + spawned_run_id + 결정 1행 + 정확히 1 run 스폰.
      const ok = await post(approver, "k-1", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_A, decision: "approve" });
      check("approver decide(approve) → 201", ok.statusCode === 201, ok.body);
      check("response spawned_run_id + decision=approve", typeof ok.json().spawned_run_id === "string" && ok.json().decision === "approve", ok.body);
      const c1 = await counts(pool);
      check("DB: 결정 1행 + DECIDE run 1개 스폰", c1.decisions === 1 && c1.spawned === 1, JSON.stringify(c1));
      check("enqueueRunClaim 1회(run_claim enqueue)", spawnCount === 1, `spawnCount=${spawnCount}`);
      const firstRun = ok.json().spawned_run_id as string;

      // 2) 멱등 replay(동일 키) → 201 동일 spawned_run_id, 재스폰 없음.
      const replay = await post(approver, "k-1", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_A, decision: "approve" });
      check("replay(동일 키) → 201 동일 spawned_run_id", replay.statusCode === 201 && replay.json().spawned_run_id === firstRun, replay.body);
      const c2 = await counts(pool);
      check("replay: 결정/스폰 증가 없음(1/1)", c2.decisions === 1 && c2.spawned === 1, JSON.stringify(c2));
      check("replay: enqueueRunClaim 추가 호출 없음", spawnCount === 1, `spawnCount=${spawnCount}`);

      // 3) 다른 키 · 동일(source_run, doc) → APPROVAL_ALREADY_DECIDED(409), 스폰 없음.
      const dup = await post(approver, "k-2", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_A, decision: "reject", reason: "재시도" });
      check("다른 키·동일(run,doc) → 409 APPROVAL_ALREADY_DECIDED", dup.statusCode === 409 && dup.json().code === "APPROVAL_ALREADY_DECIDED", dup.body);
      const c3 = await counts(pool);
      check("ALREADY_DECIDED: 결정/스폰 그대로(1/1)", c3.decisions === 1 && c3.spawned === 1, JSON.stringify(c3));

      // 4) RBAC: viewer/operator → 403 AUTHZ_FORBIDDEN(approval.decide 미보유).
      const vDeny = await post(viewer, "k-v", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_B, decision: "approve" });
      check("viewer decide → 403 AUTHZ_FORBIDDEN", vDeny.statusCode === 403 && vDeny.json().code === "AUTHZ_FORBIDDEN", vDeny.body);
      const oDeny = await post(operator, "k-o", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_B, decision: "approve" });
      check("operator decide → 403", oDeny.statusCode === 403, oDeny.body);

      // 5) reject ⇒ reason 필수: 누락 → 422(reason_required_for_reject), 스폰 없음.
      const noReason = await post(approver, "k-nr", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_B, decision: "reject" });
      check("reject without reason → 422", noReason.statusCode === 422 && noReason.json().code === "IR_SCHEMA_INVALID", noReason.body);

      // 6) reject WITH reason(다른 doc) → 201, 결정 2행, run 2개 스폰.
      const rej = await post(approver, "k-rej", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_B, decision: "reject", reason: "예산 초과" });
      check("approver decide(reject+reason) → 201", rej.statusCode === 201 && rej.json().decision === "reject", rej.body);
      const c6 = await counts(pool);
      check("DB: 결정 2행 + DECIDE run 2개 스폰", c6.decisions === 2 && c6.spawned === 2, JSON.stringify(c6));
      // 반려 사유 영속 확인.
      const reasonRow = await withTenantTx(pool, TENANT_A, (c) =>
        c.query<{ reason: string | null }>(`SELECT reason FROM approval_decisions WHERE doc_ref=$1`, [DOC_B]),
      );
      check("DB: 반려 사유 영속", reasonRow.rows[0]?.reason === "예산 초과", JSON.stringify(reasonRow.rows));

      // 7) cross-tenant source_run → 404(RLS, 존재 비노출), 스폰 없음.
      const cross = await post(approver, "k-x", { source_run_id: SOURCE_RUN_B, doc_ref: DOC_A, decision: "approve" });
      check("cross-tenant source_run → 404 RESOURCE_NOT_FOUND", cross.statusCode === 404 && cross.json().code === "RESOURCE_NOT_FOUND", cross.body);

      // 8) malformed body / 멱등키 누락 → 422(키 소모 이전).
      const badDec = await post(approver, "k-bd", { source_run_id: SOURCE_RUN_A, doc_ref: DOC_A, decision: "maybe" });
      check("invalid decision → 422", badDec.statusCode === 422, badDec.body);
      const badRef = await post(approver, "k-br", { source_run_id: SOURCE_RUN_A, doc_ref: "not-a-url", decision: "approve" });
      check("invalid doc_ref(비-URL) → 422", badRef.statusCode === 422, badRef.body);
      const noKey = await post(approver, undefined, { source_run_id: SOURCE_RUN_A, doc_ref: DOC_A, decision: "approve" });
      check("missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      // 최종 불변: 결정 2 / 스폰 2 (위 거부·중복은 스폰 0).
      const cFinal = await counts(pool);
      check("최종: 결정 2 / DECIDE run 2 (거부·중복 스폰 0)", cFinal.decisions === 2 && cFinal.spawned === 2, JSON.stringify(cFinal));
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
  console.log("\nPASS: POST /v1/approvals/decide integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
