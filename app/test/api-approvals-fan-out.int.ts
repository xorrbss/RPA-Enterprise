/**
 * 통합 — POST /v1/approvals/fan-out (결재 fan-out — 수집 목록 → 행별 검토 run). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-approvals-fan-out.int.ts
 * 검증: approver fan-out→201 + 유효 행마다 검토 run 스폰(REVIEW sver) + approval_row_claims 행, 무효 행(비-URL doc_ref·
 *       approval_id 부재) 스킵, 멱등 replay(동일 키)→동일 응답·재스폰 없음, 다른 키·재-fanout→전부 already_fanned_out(스폰 0),
 *       스폰 run params(doc_ref/approval_id/폴백) 정합, RBAC 거부(viewer/operator→403), cross-tenant→404,
 *       artifact 부재→422, 멱등키 누락→422, artifactStore 미구성→500.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import type { ArtifactObjectReader } from "../src/api/server-shared";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { ObjectRef, SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_approvals_fanout_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const APPROVER_SUB = "11111111-0000-0000-0000-000000000001";
// tenant A: 수집 시나리오/run + REVIEW 시나리오(prod) + approval_inbox artifact.
const SCEN_A = "70000000-0000-0000-0000-0000000000a1";
const SVER_A = "70000000-0000-0000-0000-0000000000a2";
const SOURCE_RUN_A = "70000000-0000-0000-0000-0000000000a3";
const REVIEW_SCEN_A = "70000000-0000-0000-0000-0000000000a6";
const REVIEW_SVER_A = "70000000-0000-0000-0000-0000000000a7";
const ART_A = "70000000-0000-0000-0000-0000000000a8";
const OBJECT_REF_A = "file://fanout-int/approval-inbox-rows-a" as ObjectRef;
// tenant A: 두 번째 수집 run — artifact 없음(부재 테스트).
const SOURCE_RUN_NOART = "70000000-0000-0000-0000-0000000000a9";
// tenant A: 상호배제(③) 테스트용 수집 run + artifact(내용은 OBJECT_REF_A 재사용 = DOC_A/DOC_B).
const SOURCE_RUN_MX = "70000000-0000-0000-0000-0000000000aa";
const ART_MX = "70000000-0000-0000-0000-0000000000ab";
// tenant B: cross-tenant 격리.
const SCEN_B = "70000000-0000-0000-0000-0000000000b1";
const SVER_B = "70000000-0000-0000-0000-0000000000b2";
const SOURCE_RUN_B = "70000000-0000-0000-0000-0000000000b3";

const DOC_A = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/984261";
const DOC_B = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/984262";

// 4행: 2 유효(DOC_A 완전·DOC_B drafted_at 없음), 2 무효(비-URL doc_ref, approval_id 부재) → 스폰 2 / 스킵 2.
const ROWS_CONTENT_A = JSON.stringify({
  rows: [
    { doc_ref: DOC_A, approval_id: "IB-지출-20260630-0001", title: "지출결의 A", drafter: "김기안", doc_type: "결재", drafted_at: "2026-06-30", status: "대기" },
    { doc_ref: DOC_B, approval_id: "IB-합의-20260630-0002", title: "합의 B", drafter: "이합의", doc_type: "합의", status: "대기" },
    { doc_ref: "not-a-url", approval_id: "IB-X-3", title: "무효 URL", drafter: "박무효", doc_type: "결재", status: "대기" },
    { doc_ref: "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/984264", title: "approval_id 없음", drafter: "최무번", doc_type: "결재", status: "대기" },
  ],
});

const TARGET_IR = `{"target":{"site_profile_id":"00000000-0000-4000-8000-0000000000a1","browser_identity_id":"00000000-0000-4000-8000-0000000000a2","network_policy_id":"00000000-0000-4000-8000-0000000000a3"}}`;

const SECRET = new TextEncoder().encode("approvals-fanout-int-secret-do-not-use-in-prod-0123456789");
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
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 수집')`, [SCEN_A, TENANT_A]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod',$4::jsonb)`, [SVER_A, TENANT_A, SCEN_A, TARGET_IR]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status) VALUES ($1,$2,$3,$4,'completed')`, [SOURCE_RUN_A, TENANT_A, SVER_A, SOURCE_RUN_A]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status) VALUES ($1,$2,$3,$4,'completed')`, [SOURCE_RUN_NOART, TENANT_A, SVER_A, SOURCE_RUN_NOART]);
    // REVIEW 시나리오(prod) — fan-out 이 스폰하는 검토 run.
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 검토·승인')`, [REVIEW_SCEN_A, TENANT_A]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod',$4::jsonb)`, [REVIEW_SVER_A, TENANT_A, REVIEW_SCEN_A, TARGET_IR]);
    // SOURCE_RUN_A 의 결재 목록 artifact(approval_inbox). object_ref 는 가짜 리더가 ROWS_CONTENT_A 로 해소.
    await c.query(
      // retention_until 필수(CHECK legal_hold OR retention_until NOT NULL) — 먼 미래 고정(시간 무관).
      `INSERT INTO artifacts (id, tenant_id, run_id, type, media_type, object_ref, redaction_status, retention_until)
       VALUES ($1,$2,$3,'approval_inbox','application/json; charset=utf-8',$4,'redacted','2099-12-31T00:00:00Z')`,
      [ART_A, TENANT_A, SOURCE_RUN_A, OBJECT_REF_A],
    );
    // 상호배제(③) 테스트용 run + artifact(내용 OBJECT_REF_A 재사용 = DOC_A/DOC_B). DOC_A 는 아래에서 'decide' claim 선점.
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status) VALUES ($1,$2,$3,$4,'completed')`, [SOURCE_RUN_MX, TENANT_A, SVER_A, SOURCE_RUN_MX]);
    await c.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, type, media_type, object_ref, redaction_status, retention_until)
       VALUES ($1,$2,$3,'approval_inbox','application/json; charset=utf-8',$4,'redacted','2099-12-31T00:00:00Z')`,
      [ART_MX, TENANT_A, SOURCE_RUN_MX, OBJECT_REF_A],
    );
  });
  await withTenantTx(pool, TENANT_B, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 수집')`, [SCEN_B, TENANT_B]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod',$4::jsonb)`, [SVER_B, TENANT_B, SCEN_B, TARGET_IR]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status) VALUES ($1,$2,$3,$4,'completed')`, [SOURCE_RUN_B, TENANT_B, SVER_B, SOURCE_RUN_B]);
  });
}

/** tenant A 의 (claim 행 수, REVIEW sver 로 스폰된 run 수). */
async function counts(pool: Pool): Promise<{ claims: number; spawned: number }> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const cl = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_row_claims`);
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM runs WHERE scenario_version_id=$1::uuid`, [REVIEW_SVER_A]);
    return { claims: Number(cl.rows[0]!.n), spawned: Number(r.rows[0]!.n) };
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
    // 가짜 artifact reader — OBJECT_REF_A → ROWS_CONTENT_A, 그 외 null.
    const artifactStore: ArtifactObjectReader = {
      async get(ref) {
        return ref === OBJECT_REF_A ? ROWS_CONTENT_A : null;
      },
      async getBytes() {
        return null;
      },
    };
    const baseDeps = {
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    };
    // artifactStore 주입 시 buildServer 는 artifact read 라우트를 등록하며 securityAudit(§10 audit boundary)를 요구.
    const app = buildServer({ ...baseDeps, artifactStore, securityAudit: new PgDurableSecurityAuditDecisionWriter(pool) });
    await app.ready();
    try {
      const approver = await mint({ sub: APPROVER_SUB, tenant_id: TENANT_A, roles: ["approver"] });
      const viewer = await mint({ sub: "v1", tenant_id: TENANT_A, roles: ["viewer"] });
      const operator = await mint({ sub: "o1", tenant_id: TENANT_A, roles: ["operator"] });

      const post = (token: string, key: string | undefined, body: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: "/v1/approvals/fan-out",
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body,
        });

      // 1) approver fan-out → 201, 유효 2 스폰 / 무효 2 스킵.
      const ok = await post(approver, "k-1", { source_run_id: SOURCE_RUN_A });
      check("approver fan-out → 201", ok.statusCode === 201, ok.body);
      const b = ok.json();
      check("spawned_count=2 (DOC_A/DOC_B)", b.spawned_count === 2, ok.body);
      check("skipped_count=2 (비-URL·approval_id 부재)", b.skipped_count === 2, ok.body);
      check("skip 사유: invalid_doc_ref + missing_approval_id",
        Array.isArray(b.skipped) && b.skipped.some((s: { reason: string }) => s.reason === "invalid_doc_ref") && b.skipped.some((s: { reason: string }) => s.reason === "missing_approval_id"),
        JSON.stringify(b.skipped));
      const c1 = await counts(pool);
      check("DB: claim 2행 + REVIEW run 2 스폰", c1.claims === 2 && c1.spawned === 2, JSON.stringify(c1));
      check("enqueueRunClaim 2회", spawnCount === 2, `spawnCount=${spawnCount}`);

      // 1b) 스폰 run params 정합(doc_ref canonical·approval_id·폴백·drafted_at 조건부).
      const spawnedA = (b.spawned as { doc_ref: string; run_id: string }[]).find((s) => s.doc_ref === DOC_A);
      check("응답 spawned 에 DOC_A run_id", spawnedA !== undefined && typeof spawnedA.run_id === "string", JSON.stringify(b.spawned));
      if (spawnedA !== undefined) {
        const paramsRow = await withTenantTx(pool, TENANT_A, (c) =>
          c.query<{ params: Record<string, unknown> }>(`SELECT params FROM runs WHERE id=$1::uuid`, [spawnedA.run_id]),
        );
        const p = paramsRow.rows[0]?.params ?? {};
        check("DOC_A run params: doc_ref/approval_id/drafter/doc_type/title/drafted_at",
          p.doc_ref === DOC_A && p.approval_id === "IB-지출-20260630-0001" && p.drafter === "김기안" && p.doc_type === "결재" && p.title === "지출결의 A" && p.drafted_at === "2026-06-30",
          JSON.stringify(p));
        const prio = await withTenantTx(pool, TENANT_A, (c) =>
          c.query<{ priority: string }>(`SELECT priority FROM runs WHERE id=$1::uuid`, [spawnedA.run_id]),
        );
        check("DOC_A run priority=high", prio.rows[0]?.priority === "high", JSON.stringify(prio.rows));
      }
      // DOC_B 는 drafted_at 없음 → params 에 drafted_at 미포함.
      const spawnedB = (b.spawned as { doc_ref: string; run_id: string }[]).find((s) => s.doc_ref === DOC_B);
      if (spawnedB !== undefined) {
        const pB = (await withTenantTx(pool, TENANT_A, (c) =>
          c.query<{ params: Record<string, unknown> }>(`SELECT params FROM runs WHERE id=$1::uuid`, [spawnedB.run_id]),
        )).rows[0]?.params ?? {};
        check("DOC_B run params: drafted_at 미포함(수집에 없음)", pB.drafted_at === undefined && pB.doc_ref === DOC_B, JSON.stringify(pB));
      }

      // 2) 멱등 replay(동일 키) → 201 동일 결과, 재스폰 없음.
      const replay = await post(approver, "k-1", { source_run_id: SOURCE_RUN_A });
      check("replay(동일 키) → 201 spawned_count=2 동일", replay.statusCode === 201 && replay.json().spawned_count === 2, replay.body);
      const c2 = await counts(pool);
      check("replay: claim/스폰 증가 없음(2/2)", c2.claims === 2 && c2.spawned === 2, JSON.stringify(c2));
      check("replay: enqueueRunClaim 추가 없음", spawnCount === 2, `spawnCount=${spawnCount}`);

      // 3) 다른 키 · 재-fanout → 유효 행 전부 already_fanned_out(스폰 0).
      const again = await post(approver, "k-2", { source_run_id: SOURCE_RUN_A });
      check("재-fanout(다른 키) → 201 spawned_count=0", again.statusCode === 201 && again.json().spawned_count === 0, again.body);
      check("재-fanout: skipped 에 already_fanned_out",
        (again.json().skipped as { reason: string }[]).some((s) => s.reason === "already_fanned_out"), again.body);
      const c3 = await counts(pool);
      check("재-fanout: claim/스폰 그대로(2/2)", c3.claims === 2 && c3.spawned === 2, JSON.stringify(c3));

      // 3b) enable_auto=true → auto_enabled=true + 수집 시나리오 auto_fan_out 켜짐(②: 이후 완료 run 은 sweeper 가 자동 fan-out).
      //     행은 이미 claim 되어 spawned 0 이지만 플래그는 켜진다(멱등 + 자동 활성 분리).
      const before = await withTenantTx(pool, TENANT_A, (c) => c.query<{ f: boolean }>(`SELECT auto_fan_out AS f FROM scenarios WHERE id=$1::uuid`, [SCEN_A]));
      check("enable_auto 전: scenarios.auto_fan_out=false", before.rows[0]?.f === false, JSON.stringify(before.rows));
      const auto = await post(approver, "k-auto", { source_run_id: SOURCE_RUN_A, enable_auto: true });
      check("enable_auto=true → 201 auto_enabled=true", auto.statusCode === 201 && auto.json().auto_enabled === true, auto.body);
      const after = await withTenantTx(pool, TENANT_A, (c) => c.query<{ f: boolean }>(`SELECT auto_fan_out AS f FROM scenarios WHERE id=$1::uuid`, [SCEN_A]));
      check("enable_auto 후: scenarios.auto_fan_out=true", after.rows[0]?.f === true, JSON.stringify(after.rows));
      const badAuto = await post(approver, "k-ba", { source_run_id: SOURCE_RUN_A, enable_auto: "yes" });
      check("enable_auto 비-boolean → 422", badAuto.statusCode === 422, badAuto.body);

      // 4) RBAC: viewer/operator → 403.
      const vDeny = await post(viewer, "k-v", { source_run_id: SOURCE_RUN_A });
      check("viewer fan-out → 403 AUTHZ_FORBIDDEN", vDeny.statusCode === 403 && vDeny.json().code === "AUTHZ_FORBIDDEN", vDeny.body);
      const oDeny = await post(operator, "k-o", { source_run_id: SOURCE_RUN_A });
      check("operator fan-out → 403", oDeny.statusCode === 403, oDeny.body);

      // 5) cross-tenant source_run → 404(RLS 존재 비노출).
      const cross = await post(approver, "k-x", { source_run_id: SOURCE_RUN_B });
      check("cross-tenant source_run → 404 RESOURCE_NOT_FOUND", cross.statusCode === 404 && cross.json().code === "RESOURCE_NOT_FOUND", cross.body);

      // 6) artifact 부재 run → 422(approval_artifact_not_found), 스폰 없음.
      const noArt = await post(approver, "k-na", { source_run_id: SOURCE_RUN_NOART });
      check("artifact 부재 → 422 IR_SCHEMA_INVALID", noArt.statusCode === 422 && noArt.json().code === "IR_SCHEMA_INVALID", noArt.body);

      // 7) malformed / 멱등키 누락 → 422.
      const badBody = await post(approver, "k-bb", { source_run_id: "not-a-uuid" });
      check("invalid source_run_id → 422", badBody.statusCode === 422, badBody.body);
      const extraField = await post(approver, "k-ef", { source_run_id: SOURCE_RUN_A, extra: 1 });
      check("unexpected field → 422", extraField.statusCode === 422, extraField.body);
      const noKey = await post(approver, undefined, { source_run_id: SOURCE_RUN_A });
      check("missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      // 최종 불변(SOURCE_RUN_A): claim 2 / REVIEW run 2 (거부·중복·404·부재 스폰 0). MX 는 아래에서 처리(여기선 claim 0).
      const cFinal = await counts(pool);
      check("최종: claim 2 / REVIEW run 2", cFinal.claims === 2 && cFinal.spawned === 2, JSON.stringify(cFinal));

      // 7b) 처리모드 상호배제(③): 이미 'decide'(목록 건별 결재)로 claim 된 행은 fan-out 이 스킵('already_decided'),
      //     나머지 유효행만 스폰 → 한 행은 한 경로로만(이중 승인 방지).
      await withTenantTx(pool, TENANT_A, (c) =>
        c.query(
          `INSERT INTO approval_row_claims (id, tenant_id, source_run_id, doc_ref, mode, spawned_run_id)
           VALUES ('70000000-0000-0000-0000-0000000000ec'::uuid, $1::uuid, $2::uuid, $3, 'decide', NULL)`,
          [TENANT_A, SOURCE_RUN_MX, DOC_A],
        ),
      );
      const mx = await post(approver, "k-mx", { source_run_id: SOURCE_RUN_MX });
      check(
        "상호배제: 'decide' claim 된 DOC_A 는 fan-out 스킵('already_decided')",
        mx.statusCode === 201 && (mx.json().skipped as { doc_ref: string; reason: string }[]).some((s) => s.doc_ref === DOC_A && s.reason === "already_decided"),
        mx.body,
      );
      check("상호배제: 나머지 유효행(DOC_B)만 스폰(spawned_count=1)", mx.json().spawned_count === 1, mx.body);
    } finally {
      await app.close();
    }

    // 8) artifactStore 미구성 서버 → fan-out 500(fail-closed, 조용한 빈 결과 금지).
    const appNoStore = buildServer({ ...baseDeps });
    await appNoStore.ready();
    try {
      const approver = await mint({ sub: APPROVER_SUB, tenant_id: TENANT_A, roles: ["approver"] });
      const res = await appNoStore.inject({
        method: "POST",
        url: "/v1/approvals/fan-out",
        headers: { authorization: `Bearer ${approver}`, "idempotency-key": "k-nostore" },
        payload: { source_run_id: SOURCE_RUN_A },
      });
      check("artifactStore 미구성 → 500 CONTROL_PLANE_INTERNAL_ERROR", res.statusCode === 500 && res.json().code === "CONTROL_PLANE_INTERNAL_ERROR", res.body);
    } finally {
      await appNoStore.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: POST /v1/approvals/fan-out integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
