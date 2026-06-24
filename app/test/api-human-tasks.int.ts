/**
 * D4.5 통합 테스트 — Human Task 상태명령(api-surface §3) assign(H1/H6)·start(H2)를 실 PostgreSQL에 검증.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-human-tasks.int.ts
 *
 * 검증: 전이 적용/상태별 거부(종결→410, out-of-order→422), 멱등 재생, 인가/RLS, 본문 선검사.
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
const SCHEMA = "rpa_htask_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCENARIO_A = "40000000-0000-0000-0000-0000000000a3";
const SVER_A = "40000000-0000-0000-0000-0000000000a4";
const RUN_A = "40000000-0000-0000-0000-0000000000a7";
const SCENARIO_B = "40000000-0000-0000-0000-0000000000b3";
const SVER_B = "40000000-0000-0000-0000-0000000000b4";
const RUN_B = "40000000-0000-0000-0000-0000000000b7";
const ASSIGNEE = "50000000-0000-0000-0000-000000000099";
const APPROVER_ASSIGNEE = "50000000-0000-0000-0000-000000000077";
const ABSENT = "40000000-0000-0000-0000-0000000000ff";

// 상태별 시드 human_task.
const HT_OPEN = "41000000-0000-0000-0000-000000000001";
const HT_OPEN2 = "41000000-0000-0000-0000-000000000002";
const HT_ASSIGNED = "41000000-0000-0000-0000-000000000003";
const HT_ASSIGNED2 = "41000000-0000-0000-0000-000000000004";
const HT_IN_PROGRESS = "41000000-0000-0000-0000-000000000005";
const HT_ESCALATED = "41000000-0000-0000-0000-000000000006";
const HT_RESOLVED = "41000000-0000-0000-0000-000000000007";
const HT_IDEM = "41000000-0000-0000-0000-000000000008";
const HT_VIEWER = "41000000-0000-0000-0000-000000000009";
const HT_OIDC = "41000000-0000-0000-0000-00000000000a"; // 비-UUID OIDC sub 배정 검증용(open).
const HT_B = "42000000-0000-0000-0000-000000000001";

// resolve/escalate 교차 전이용 전용 run + task(각 run 상태를 독립 검증).
const RUN_SUSP_RESOLVE = "40000000-0000-0000-0000-000000000010";
const RUN_RUNNING = "40000000-0000-0000-0000-000000000011";
const RUN_SUSP_APPROVAL = "40000000-0000-0000-0000-000000000012";
const RUN_SUSP_ESCALATE = "40000000-0000-0000-0000-000000000013";
const RUN_SUSP_SCOPE_OK = "40000000-0000-0000-0000-000000000014";
const RUN_SUSP_SCOPE_DENY = "40000000-0000-0000-0000-000000000015";
const RUN_SUSP_ROLE_SCOPE = "40000000-0000-0000-0000-000000000016";
const RUN_SUSP_FORM = "40000000-0000-0000-0000-000000000017";
const HT_RESOLVE_OK = "41000000-0000-0000-0000-000000000010";
const HT_RESOLVE_OK_CYCLE2 = "41000000-0000-0000-0000-000000000020"; // EPL-01: 같은 run 2번째 suspend 사이클 task
const HT_RESOLVE_NOCOUPLE = "41000000-0000-0000-0000-000000000011";
const HT_RESOLVE_ASSIGNED = "41000000-0000-0000-0000-000000000012";
const HT_APPROVAL = "41000000-0000-0000-0000-000000000013";
const HT_ESCALATE_OPEN = "41000000-0000-0000-0000-000000000014";
const HT_ESCALATED_AGAIN = "41000000-0000-0000-0000-000000000015";
const HT_RESOLVE_SCOPE_OK = "41000000-0000-0000-0000-000000000016";
const HT_RESOLVE_SCOPE_DENY = "41000000-0000-0000-0000-000000000017";
const HT_RESOLVE_ROLE_SCOPE = "41000000-0000-0000-0000-000000000018";
const HT_BUSINESS_FORM = "41000000-0000-0000-0000-000000000019";

const SECRET = new TextEncoder().encode("d45-htask-int-secret-do-not-use-in-prod-0123456789");
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

async function seedRun(pool: Pool, tenant: string, scenario: string, sver: string, run: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'d45ht')`, [scenario, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scenario],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, as_of)
       VALUES ($1,$2,$3,'suspended',$1,'2026-06-15T00:00:00Z')`,
      [run, tenant, sver],
    );
  });
}

async function seedExtraRun(pool: Pool, tenant: string, sver: string, run: string, status: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, as_of)
       VALUES ($1,$2,$3,$4,$1,'2026-06-15T00:00:00Z')`,
      [run, tenant, sver, status],
    ),
  );
}

async function seedTask(
  pool: Pool,
  tenant: string,
  run: string,
  id: string,
  state: string,
  kind = "exception",
  scope: { assignee?: string; assigneeRole?: string } = {},
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, assignee, assignee_role)
       VALUES ($1,$2,$3,$4,$5,$6::text,$7)`,
      [id, tenant, run, kind, state, scope.assignee ?? null, scope.assigneeRole ?? null],
    ),
  );
}

async function runStatus(pool: Pool, tenant: string, run: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [run]);
    return r.rows[0]?.status ?? null;
  });
}

async function outboxCount(pool: Pool, tenant: string, run: string, eventType: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE run_id=$1::uuid AND event_type=$2`,
      [run, eventType],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function taskRow(
  pool: Pool,
  tenant: string,
  id: string,
): Promise<{ state: string; assignee: string | null; result: Record<string, unknown> | null; resolved_by: string | null } | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ state: string; assignee: string | null; result: Record<string, unknown> | null; resolved_by: string | null }>(
      `SELECT state, assignee::text AS assignee, result, resolved_by FROM human_tasks WHERE id=$1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  });
}

async function idemRowCount(pool: Pool, tenant: string, endpoint: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM control_plane_idempotency_keys WHERE endpoint=$1 AND idempotency_key=$2`,
      [endpoint, key],
    );
    return r.rows[0]?.n ?? 0;
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
    console.log("migrations applied (concurrency → core)");

    await seedRun(pool, TENANT_A, SCENARIO_A, SVER_A, RUN_A);
    await seedRun(pool, TENANT_B, SCENARIO_B, SVER_B, RUN_B);
    const seeds: Array<[string, string]> = [
      [HT_OPEN, "open"],
      [HT_OPEN2, "open"],
      [HT_ASSIGNED, "assigned"],
      [HT_ASSIGNED2, "assigned"],
      [HT_IN_PROGRESS, "in_progress"],
      [HT_ESCALATED, "escalated"],
      [HT_RESOLVED, "resolved"],
      [HT_IDEM, "open"],
      [HT_VIEWER, "open"],
      [HT_OIDC, "open"],
    ];
    for (const [id, state] of seeds) await seedTask(pool, TENANT_A, RUN_A, id, state);
    await withTenantTx(pool, TENANT_A, (c) =>
      c.query(`UPDATE human_tasks SET assignee=$1::text, assignee_role='reviewer' WHERE id=$2::uuid`, [
        ASSIGNEE,
        HT_RESOLVED,
      ]),
    );
    await seedTask(pool, TENANT_B, RUN_B, HT_B, "open");

    // 교차 전이용 전용 run + task.
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_RESOLVE, "suspended");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_RUNNING, "running");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_APPROVAL, "suspended");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_ESCALATE, "suspended");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_SCOPE_OK, "suspended");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_SCOPE_DENY, "suspended");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_ROLE_SCOPE, "suspended");
    await seedExtraRun(pool, TENANT_A, SVER_A, RUN_SUSP_FORM, "suspended");
    await seedTask(pool, TENANT_A, RUN_SUSP_RESOLVE, HT_RESOLVE_OK, "in_progress", "exception", {
      assignee: ASSIGNEE,
      assigneeRole: "reviewer",
    });
    await seedTask(pool, TENANT_A, RUN_RUNNING, HT_RESOLVE_NOCOUPLE, "in_progress", "exception", {
      assignee: ASSIGNEE,
      assigneeRole: "reviewer",
    });
    await seedTask(pool, TENANT_A, RUN_A, HT_RESOLVE_ASSIGNED, "assigned", "exception", {
      assignee: ASSIGNEE,
      assigneeRole: "reviewer",
    });
    await seedTask(pool, TENANT_A, RUN_SUSP_APPROVAL, HT_APPROVAL, "in_progress", "approval", {
      assignee: APPROVER_ASSIGNEE,
      assigneeRole: "approver",
    });
    await seedTask(pool, TENANT_A, RUN_SUSP_ESCALATE, HT_ESCALATE_OPEN, "open");
    await seedTask(pool, TENANT_A, RUN_A, HT_ESCALATED_AGAIN, "escalated");
    await seedTask(pool, TENANT_A, RUN_SUSP_SCOPE_OK, HT_RESOLVE_SCOPE_OK, "in_progress", "exception", {
      assignee: ASSIGNEE,
      assigneeRole: "reviewer",
    });
    await seedTask(pool, TENANT_A, RUN_SUSP_SCOPE_DENY, HT_RESOLVE_SCOPE_DENY, "in_progress", "exception", {
      assignee: ASSIGNEE,
      assigneeRole: "reviewer",
    });
    await seedTask(pool, TENANT_A, RUN_SUSP_ROLE_SCOPE, HT_RESOLVE_ROLE_SCOPE, "in_progress", "exception", {
      assignee: APPROVER_ASSIGNEE,
      assigneeRole: "approver",
    });
    await seedTask(pool, TENANT_A, RUN_SUSP_FORM, HT_BUSINESS_FORM, "in_progress", "validation", {
      assignee: ASSIGNEE,
      assigneeRole: "reviewer",
    });
    await withTenantTx(pool, TENANT_A, (c) =>
      c.query(
        `UPDATE human_tasks
            SET result_schema=$3::jsonb,
                payload=$4::jsonb,
                artifact_refs=$5::jsonb
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [
          TENANT_A,
          HT_BUSINESS_FORM,
          JSON.stringify({
            version: "business_form_v1",
            fields: [
              { key: "invoice_id", label: "Invoice ID", type: "text", required: true },
              { key: "total", label: "Total", type: "number", required: true },
              { key: "approved", label: "Approved", type: "boolean" },
            ],
          }),
          JSON.stringify({ source: "invoice" }),
          JSON.stringify(["artifact.invoice.scan"]),
        ],
      ),
    );
    console.log("seeded human tasks across states");

    const resumeEnqueued: string[] = [];
    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort() {},
      async enqueueSinkDeliver() {},
      async enqueueRunResume(_client, input) {
        resumeEnqueued.push(input.runId);
      },
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
      const op = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });
      const reviewer = await mint({ sub: "rv", tenant_id: TENANT_A, roles: ["reviewer"] });
      const assignedReviewer = await mint({ sub: ASSIGNEE, tenant_id: TENANT_A, roles: ["reviewer"] });
      const approver = await mint({ sub: APPROVER_ASSIGNEE, tenant_id: TENANT_A, roles: ["approver"] });

      const post = (path: string, key: string, token = op, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: payload as object | undefined,
        });
      const assign = (id: string, key: string, token = op, payload: unknown = { assignee: ASSIGNEE }) =>
        post(`/v1/human-tasks/${id}/assign`, key, token, payload);
      const start = (id: string, key: string, token = op, payload?: unknown) =>
        post(`/v1/human-tasks/${id}/start`, key, token, payload);

      // ===== assign =====
      // 1) open + assign → 200 assigned + assignee set(H1).
      const a1 = await assign(HT_OPEN, "assign-open");
      check("assign open → 200 assigned", a1.statusCode === 200 && a1.json().state === "assigned", a1.body);
      const a1row = await taskRow(pool, TENANT_A, HT_OPEN);
      check("assign open → DB assigned + assignee", a1row?.state === "assigned" && a1row?.assignee === ASSIGNEE, JSON.stringify(a1row));

      // 2) escalated + assign → 200 assigned(H6 재배정).
      const a2 = await assign(HT_ESCALATED, "assign-escalated");
      check("assign escalated → 200 assigned (H6)", a2.statusCode === 200 && a2.json().state === "assigned", a2.body);
      const a2row = await taskRow(pool, TENANT_A, HT_ESCALATED);
      check("assign escalated → DB assigned + reassigned assignee", a2row?.state === "assigned" && a2row?.assignee === ASSIGNEE, JSON.stringify(a2row));

      // 3) in_progress + assign → 422 invalid_state_for_command(정의 안 됨).
      const a3 = await assign(HT_IN_PROGRESS, "assign-inprogress");
      check("assign in_progress → 422", a3.statusCode === 422, a3.body);
      check("assign in_progress → invalid_state_for_command", a3.json().details?.reason === "invalid_state_for_command", a3.body);

      // 4) resolved(종결) + assign → 410 HUMAN_TASK_EXPIRED.
      const a4 = await assign(HT_RESOLVED, "assign-resolved");
      check("assign resolved → 410", a4.statusCode === 410, a4.body);
      check("assign resolved → HUMAN_TASK_EXPIRED", a4.json().code === "HUMAN_TASK_EXPIRED", a4.body);

      // 5) 본문 선검사: assignee 누락/빈 값/비-string → 422(키 미소모). assignee=PrincipalId(JWT sub) 자유형 string이라
      //    uuid 형식은 강제하지 않으며(decided_by/created_by와 동형 text), 빈 값/비-string만 거부한다.
      const a5 = await assign(HT_OPEN2, "assign-noassignee", op, {});
      check("assign missing assignee → 422", a5.statusCode === 422, a5.body);
      check("assign missing assignee key unused", (await idemRowCount(pool, TENANT_A, "assignHumanTask", "assign-noassignee")) === 0);
      const a5b = await assign(HT_OPEN2, "assign-emptyassignee", op, { assignee: "" });
      check("assign empty assignee → 422", a5b.statusCode === 422 && a5b.json().details?.reason === "invalid_assignee", a5b.body);
      const a5c = await assign(HT_OPEN2, "assign-nonstringassignee", op, { assignee: 123 });
      check("assign non-string assignee → 422", a5c.statusCode === 422 && a5c.json().details?.reason === "invalid_assignee", a5c.body);
      // 5b) 비-UUID OIDC sub(PrincipalId) 배정 → 200 assigned + DB에 text 그대로 영속(uuid 강제 폐지).
      const a5d = await assign(HT_OIDC, "assign-oidcsub", op, { assignee: "auth0|abc123" });
      check("assign non-uuid OIDC sub → 200 assigned", a5d.statusCode === 200 && a5d.json().state === "assigned", a5d.body);
      const a5drow = await taskRow(pool, TENANT_A, HT_OIDC);
      check("assign non-uuid sub → DB assignee text 보존", a5drow?.state === "assigned" && a5drow?.assignee === "auth0|abc123", JSON.stringify(a5drow));

      // 6) 부재 → 404, cross-tenant → 404(RLS).
      const a6 = await assign(ABSENT, "assign-absent");
      check("assign absent → 404 RESOURCE_NOT_FOUND", a6.statusCode === 404 && a6.json().code === "RESOURCE_NOT_FOUND", a6.body);
      const a7 = await assign(HT_B, "assign-cross");
      check("assign cross-tenant → 404", a7.statusCode === 404 && a7.json().code === "RESOURCE_NOT_FOUND", a7.body);
      check("tenant B task untouched", (await taskRow(pool, TENANT_B, HT_B))?.state === "open");

      // 7) RBAC viewer → 403(키 미소모).
      const a8 = await assign(HT_VIEWER, "assign-viewer", viewer);
      check("assign viewer → 403 AUTHZ_FORBIDDEN", a8.statusCode === 403 && a8.json().code === "AUTHZ_FORBIDDEN", a8.body);
      check("viewer deny key unused", (await idemRowCount(pool, TENANT_A, "assignHumanTask", "assign-viewer")) === 0);
      check("viewer task unchanged", (await taskRow(pool, TENANT_A, HT_VIEWER))?.state === "open");

      // 8) 멱등 재생: 동일 키 재요청 → 최초 200 재생.
      const i1 = await assign(HT_IDEM, "assign-idem");
      check("assign idem first → 200 assigned", i1.statusCode === 200 && i1.json().state === "assigned", i1.body);
      const i2 = await assign(HT_IDEM, "assign-idem");
      check("assign idem replay → 200 assigned", i2.statusCode === 200 && i2.json().state === "assigned", i2.body);
      // 8b) 동일 키 다른 본문 → 412.
      const i3 = await assign(HT_IDEM, "assign-idem", op, { assignee: "50000000-0000-0000-0000-000000000088" });
      check("assign idem diff body → 412 SCENARIO_VERSION_CONFLICT", i3.statusCode === 412 && i3.json().code === "SCENARIO_VERSION_CONFLICT", i3.body);

      // 9) Idempotency-Key 누락 → 422.
      const noKey = await app.inject({ method: "POST", url: `/v1/human-tasks/${HT_OPEN2}/assign`, headers: { authorization: `Bearer ${op}` }, payload: { assignee: ASSIGNEE } });
      check("assign missing Idempotency-Key → 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      // ===== start =====
      // 10) assigned + start → 200 in_progress(H2).
      const s1 = await start(HT_ASSIGNED, "start-assigned");
      check("start assigned → 200 in_progress", s1.statusCode === 200 && s1.json().state === "in_progress", s1.body);
      check("start assigned → DB in_progress", (await taskRow(pool, TENANT_A, HT_ASSIGNED))?.state === "in_progress");

      // 11) open + start → 422 invalid_state_for_command(미배정).
      const s2 = await start(HT_OPEN2, "start-open");
      check("start open → 422 invalid_state_for_command", s2.statusCode === 422 && s2.json().details?.reason === "invalid_state_for_command", s2.body);

      // 12) resolved + start → 410.
      const s3 = await start(HT_RESOLVED, "start-resolved");
      check("start resolved → 410 HUMAN_TASK_EXPIRED", s3.statusCode === 410 && s3.json().code === "HUMAN_TASK_EXPIRED", s3.body);

      // 13) start 본문 거부(닫힌 shape).
      const s4 = await start(HT_ASSIGNED2, "start-body", op, { foo: 1 });
      check("start with body → 422 unexpected_body", s4.statusCode === 422 && s4.json().details?.reason === "unexpected_body", s4.body);

      // ===== resolve (H3 + Run R13) =====
      const resolve = (id: string, key: string, token = assignedReviewer, payload?: unknown) =>
        post(`/v1/human-tasks/${id}/resolve`, key, token, payload);

      // 14) in_progress(exception) + resolve → 200 resolved + run resume_requested + 이벤트 2종.
      const resolution = {
        decision: "correct",
        corrections: { invoice_no: "INV-2026-001" },
        confidence: 0.93,
        notes: "검증 큐에서 송장번호를 교정했습니다.",
      };
      const r1 = await resolve(HT_RESOLVE_OK, "resolve-ok", assignedReviewer, { result: resolution });
      check("resolve in_progress → 200 resolved", r1.statusCode === 200 && r1.json().state === "resolved", r1.body);
      const resolvedTask = await taskRow(pool, TENANT_A, HT_RESOLVE_OK);
      check("resolve → DB resolved", resolvedTask?.state === "resolved");
      check("resolve response includes review result",
        r1.json().result?.decision === "correct" && r1.json().result?.corrections?.invoice_no === "INV-2026-001" &&
        r1.json().result?.confidence === 0.93, r1.body);
      check("resolve → DB stores review result",
        resolvedTask?.result?.decision === "correct" &&
        (resolvedTask?.result?.corrections as { invoice_no?: unknown } | undefined)?.invoice_no === "INV-2026-001" &&
        resolvedTask?.result?.confidence === 0.93, JSON.stringify(resolvedTask));
      check("resolve → DB stores resolved_by", resolvedTask?.resolved_by === ASSIGNEE, JSON.stringify(resolvedTask));
      check("resolve → run resume_requested (R13)", (await runStatus(pool, TENANT_A, RUN_SUSP_RESOLVE)) === "resume_requested");
      check("resolve emits human_task.resolved", (await outboxCount(pool, TENANT_A, RUN_SUSP_RESOLVE, "human_task.resolved")) === 1);
      check("resolve emits run.resume_requested", (await outboxCount(pool, TENANT_A, RUN_SUSP_RESOLVE, "run.resume_requested")) === 1);
      check("resolve(R13) → run_resume 잡 인큐(같은 tx)", resumeEnqueued.includes(RUN_SUSP_RESOLVE), resumeEnqueued.join(","));

      // 14b) 다중 suspend/resume 사이클(이벤트 파이프라인 감사 EPL-01): 같은 run 을 다시 suspended 로 되돌리고 2번째
      //   human_task 를 resolve → R13 outbox 멱등키가 per-cycle(humanTaskId)이라 events_outbox UNIQUE 충돌 없이 성공해야.
      //   per-run 고정 키였다면 2회차 R13 이 ${runId}:run.resume_requested 재충돌→tx 롤백→500+run suspended 영구 stuck+이벤트 1건.
      await withTenantTx(pool, TENANT_A, (c) =>
        c.query(`UPDATE runs SET status='suspended' WHERE id=$1::uuid AND tenant_id=$2::uuid`, [RUN_SUSP_RESOLVE, TENANT_A]),
      );
      await seedTask(pool, TENANT_A, RUN_SUSP_RESOLVE, HT_RESOLVE_OK_CYCLE2, "in_progress", "exception", {
        assignee: ASSIGNEE,
        assigneeRole: "reviewer",
      });
      const r1b = await resolve(HT_RESOLVE_OK_CYCLE2, "resolve-ok-cycle2");
      check("2회차 resolve(R13) → 200(per-cycle 키, UNIQUE 충돌 없음)", r1b.statusCode === 200 && r1b.json().state === "resolved", r1b.body);
      check("2회차 resolve → run resume_requested(stuck 아님)", (await runStatus(pool, TENANT_A, RUN_SUSP_RESOLVE)) === "resume_requested");
      check("2회차 resolve → run.resume_requested 이벤트 2건(유실 없음)", (await outboxCount(pool, TENANT_A, RUN_SUSP_RESOLVE, "run.resume_requested")) === 2);

      const invalidResult = await resolve(HT_RESOLVE_NOCOUPLE, "resolve-invalid-result", assignedReviewer, { result: { decision: "maybe" } });
      check("resolve invalid result decision → 422", invalidResult.statusCode === 422 && invalidResult.json().details?.reason === "invalid_resolve_decision", invalidResult.body);
      check("resolve invalid result key unused", (await idemRowCount(pool, TENANT_A, "resolveHumanTask", "resolve-invalid-result")) === 0);

      const formMissing = await resolve(HT_BUSINESS_FORM, "resolve-form-missing", assignedReviewer, {
        result: { decision: "correct", corrections: { invoice_id: "INV-9" } },
      });
      check("business form required field missing → 422", formMissing.statusCode === 422 && formMissing.json().details?.reason === "business_form_required_field_missing", formMissing.body);
      check("business form missing key unused", (await idemRowCount(pool, TENANT_A, "resolveHumanTask", "resolve-form-missing")) === 0);

      const formTypeMismatch = await resolve(HT_BUSINESS_FORM, "resolve-form-type", assignedReviewer, {
        result: { decision: "correct", corrections: { invoice_id: "INV-9", total: "not-a-number" } },
      });
      check("business form number type mismatch → 422", formTypeMismatch.statusCode === 422 && formTypeMismatch.json().details?.reason === "business_form_value_type_mismatch", formTypeMismatch.body);
      check("business form type key unused", (await idemRowCount(pool, TENANT_A, "resolveHumanTask", "resolve-form-type")) === 0);

      const formOk = await resolve(HT_BUSINESS_FORM, "resolve-form-ok", assignedReviewer, {
        result: { decision: "correct", corrections: { invoice_id: "INV-9", total: 125000, approved: true } },
      });
      check("business form valid corrections → 200", formOk.statusCode === 200 && formOk.json().state === "resolved", formOk.body);
      const storedFormResult = (await taskRow(pool, TENANT_A, HT_BUSINESS_FORM))?.result;
      check(
        "business form valid corrections stored",
        (storedFormResult?.corrections as { total?: unknown } | undefined)?.total === 125000,
        formOk.body,
      );

      // 15) run이 suspended가 아니면(running) 교차 전이 건너뜀 — task는 resolved, run 불변.
      const r2 = await resolve(HT_RESOLVE_NOCOUPLE, "resolve-nocouple");
      check("resolve (run running) → 200 resolved", r2.statusCode === 200 && r2.json().state === "resolved", r2.body);
      check("resolve coupling skipped → run still running", (await runStatus(pool, TENANT_A, RUN_RUNNING)) === "running");
      check("resolve coupling skipped → no run.resume_requested", (await outboxCount(pool, TENANT_A, RUN_RUNNING, "run.resume_requested")) === 0);
      check("coupling 건너뜀(running) → run_resume 미인큐", !resumeEnqueued.includes(RUN_RUNNING));

      // 16) assigned + resolve → 422(H3는 in_progress에서만).
      const r3 = await resolve(HT_RESOLVE_ASSIGNED, "resolve-assigned");
      check("resolve assigned → 422 invalid_state_for_command", r3.statusCode === 422 && r3.json().details?.reason === "invalid_state_for_command", r3.body);

      // 17) resolved(종결) + resolve → 410.
      const r4 = await resolve(HT_RESOLVED, "resolve-resolved");
      check("resolve resolved → 410 HUMAN_TASK_EXPIRED", r4.statusCode === 410 && r4.json().code === "HUMAN_TASK_EXPIRED", r4.body);

      // 18) kind 의존 RBAC: approval task는 approver만. viewer/reviewer → 403, approver → 200(키 미소모 검증).
      const rApprovalViewer = await resolve(HT_APPROVAL, "resolve-approval-viewer", viewer);
      check("resolve approval by viewer → 403", rApprovalViewer.statusCode === 403 && rApprovalViewer.json().code === "AUTHZ_FORBIDDEN", rApprovalViewer.body);
      const rApprovalReviewer = await resolve(HT_APPROVAL, "resolve-approval-reviewer", reviewer);
      check("resolve approval by reviewer → 403 (no resolve.approval)", rApprovalReviewer.statusCode === 403, rApprovalReviewer.body);
      check("approval RBAC deny key unused", (await idemRowCount(pool, TENANT_A, "resolveHumanTask", "resolve-approval-reviewer")) === 0);
      const rApprovalApprover = await resolve(HT_APPROVAL, "resolve-approval-approver", approver);
      check("resolve approval by approver → 200 resolved", rApprovalApprover.statusCode === 200 && rApprovalApprover.json().state === "resolved", rApprovalApprover.body);
      check("resolve approval → run resume_requested", (await runStatus(pool, TENANT_A, RUN_SUSP_APPROVAL)) === "resume_requested");

      // 18b) assignee scope: matching role + matching assignee may resolve; role-only mismatch is denied before key reservation.
      const rScopedOk = await resolve(HT_RESOLVE_SCOPE_OK, "resolve-scope-ok", assignedReviewer);
      check("resolve scoped task by assignee → 200 resolved", rScopedOk.statusCode === 200 && rScopedOk.json().state === "resolved", rScopedOk.body);
      check("resolve scoped task → run resume_requested", (await runStatus(pool, TENANT_A, RUN_SUSP_SCOPE_OK)) === "resume_requested");
      const rScopedDeny = await resolve(HT_RESOLVE_SCOPE_DENY, "resolve-scope-deny", reviewer);
      check("resolve scoped task by other subject → 403", rScopedDeny.statusCode === 403 && rScopedDeny.json().code === "AUTHZ_FORBIDDEN", rScopedDeny.body);
      check("resolve scoped deny key unused", (await idemRowCount(pool, TENANT_A, "resolveHumanTask", "resolve-scope-deny")) === 0);
      check("resolve scoped deny leaves task in_progress", (await taskRow(pool, TENANT_A, HT_RESOLVE_SCOPE_DENY))?.state === "in_progress");
      const rRoleDeny = await resolve(HT_RESOLVE_ROLE_SCOPE, "resolve-role-scope-deny", reviewer);
      check("resolve assignee_role mismatch → 403", rRoleDeny.statusCode === 403 && rRoleDeny.json().code === "AUTHZ_FORBIDDEN", rRoleDeny.body);
      check("resolve assignee_role deny key unused", (await idemRowCount(pool, TENANT_A, "resolveHumanTask", "resolve-role-scope-deny")) === 0);
      const rRoleAllow = await resolve(HT_RESOLVE_ROLE_SCOPE, "resolve-role-scope-allow", approver);
      check("resolve assignee_role match by approver → 200 resolved", rRoleAllow.statusCode === 200 && rRoleAllow.json().state === "resolved", rRoleAllow.body);

      // ===== escalate (H5 + Run R15) =====
      const escalate = (id: string, key: string, token = reviewer, payload?: unknown) =>
        post(`/v1/human-tasks/${id}/escalate`, key, token, payload);

      // 19) open + escalate fails closed until reassignAssignee ownership is decided.
      const e1 = await escalate(HT_ESCALATE_OPEN, "escalate-open", reviewer, { reason: "need admin" });
      check("escalate open unresolved reassignAssignee → 500", e1.statusCode === 500, e1.body);
      check("escalate open unresolved → CONTROL_PLANE_INTERNAL_ERROR", e1.json().code === "CONTROL_PLANE_INTERNAL_ERROR", e1.body);
      check("escalate unresolved rolls back task", (await taskRow(pool, TENANT_A, HT_ESCALATE_OPEN))?.state === "open");
      check("escalate unresolved leaves run suspended", (await runStatus(pool, TENANT_A, RUN_SUSP_ESCALATE)) === "suspended");
      check("escalate unresolved emits no human_task.escalated", (await outboxCount(pool, TENANT_A, RUN_SUSP_ESCALATE, "human_task.escalated")) === 0);
      check("escalate unresolved stores deterministic failure", (await idemRowCount(pool, TENANT_A, "escalateHumanTask", "escalate-open")) === 1);
      const e1Replay = await escalate(HT_ESCALATE_OPEN, "escalate-open", reviewer, { reason: "need admin" });
      check("escalate unresolved same-key replay → 500", e1Replay.statusCode === 500 && e1Replay.json().code === "CONTROL_PLANE_INTERNAL_ERROR", e1Replay.body);
      check("escalate unresolved replay leaves task open", (await taskRow(pool, TENANT_A, HT_ESCALATE_OPEN))?.state === "open");

      // 20) escalated + escalate → 422(H5는 escalated에서 정의 안 됨).
      const e2 = await escalate(HT_ESCALATED_AGAIN, "escalate-again");
      check("escalate escalated → 422 invalid_state_for_command", e2.statusCode === 422 && e2.json().details?.reason === "invalid_state_for_command", e2.body);

      // 21) escalate RBAC: operator는 human_task.escalate 미보유 → 403.
      const e3 = await escalate(HT_OPEN2, "escalate-operator", op);
      check("escalate by operator → 403 (no human_task.escalate)", e3.statusCode === 403 && e3.json().code === "AUTHZ_FORBIDDEN", e3.body);
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
  console.log("\nPASS: D4.5 human task assign/start integration green");
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
