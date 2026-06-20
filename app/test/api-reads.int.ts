/**
 * D6.5 통합 테스트 — 운영 콘솔 조회 read 엔드포인트(api-surface §1·§3):
 *   listRuns · listHumanTasks · getHumanTask. 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-reads.int.ts
 *
 * 검증: 커서 페이지네이션(created_at,id DESC keyset)·닫힌 enum 필터(무효→422)·RLS 격리·read RBAC·404.
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
const SCHEMA = "rpa_reads_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCEN_A = "70000000-0000-0000-0000-0000000000a3";
const SVER_A = "70000000-0000-0000-0000-0000000000a4";
const SVER_A2 = "70000000-0000-0000-0000-0000000000a5";
const SCEN_B = "70000000-0000-0000-0000-0000000000b3";
const SVER_B = "70000000-0000-0000-0000-0000000000b4";
const ASSIGNEE = "70000000-0000-0000-0000-0000000000c1";
const ABSENT = "70000000-0000-0000-0000-0000000000ff";
const NETWORK_A = "7a200000-0000-0000-0000-000000000001";

const SECRET = new TextEncoder().encode("d65-reads-int-secret-do-not-use-in-prod-0123456789");
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

async function seedScenario(pool: Pool, tenant: string, scen: string, svers: string[]): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'reads')`, [scen, tenant]);
    for (const sv of svers) {
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,$4,'draft','{"nodes":[]}'::jsonb)`,
        [sv, tenant, scen, svers.indexOf(sv) + 1],
      );
    }
  });
}

// created_at을 명시해 정렬/커서를 결정적으로 만든다.
async function seedRun(
  pool: Pool,
  tenant: string,
  sver: string,
  id: string,
  status: string,
  createdAt: string,
  failureReason: { code: string; message: string } | null = null,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at, failure_reason)
       VALUES ($1,$2,$3,$4,$1,1,'2026-06-15T00:00:00Z',$5::timestamptz,$6::jsonb)`,
      [id, tenant, sver, status, createdAt, failureReason === null ? null : JSON.stringify(failureReason)],
    ),
  );
}

async function seedHumanTask(
  pool: Pool, tenant: string, run: string, id: string, state: string, kind: string,
  assignee: string | null, createdAt: string,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, assignee, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::text,'2026-07-01T00:00:00Z',$7::timestamptz)`,
      [id, tenant, run, kind, state, assignee, createdAt],
    ),
  );
}

async function seedWorkitem(pool: Pool, tenant: string, id: string, ref: string, status: string, createdAt: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, created_at)
       VALUES ($1,$2,'reads',$3,$4,2,$5::timestamptz)`,
      [id, tenant, ref, status, createdAt],
    ),
  );
}

async function seedDeadLetter(
  pool: Pool, tenant: string, id: string, workitemId: string, createdAt: string, replayed: boolean,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable, created_at, replayed_at)
       VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',true,$4::timestamptz,$5)`,
      [id, tenant, workitemId, createdAt, replayed ? new Date("2026-06-16T00:00:00Z") : null],
    ),
  );
}

// sink DLQ(데이터평면): raw_item → normalized_record → sink_deliveries(status). FK 체인이 필요해 3단 시드.
async function seedSinkDelivery(
  pool: Pool, tenant: string, sinkDeliveryId: string, naturalKey: string, status: string, attemptedAt: string,
): Promise<void> {
  const rawId = `7c00${sinkDeliveryId.slice(4)}`;
  const normId = `7d00${sinkDeliveryId.slice(4)}`;
  const sinkConfig = "50000000-0000-0000-0000-000000000001";
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(
      `INSERT INTO raw_items (id, tenant_id, connector_id, target_id, collection_attempt_id, raw_hash, raw_payload)
       VALUES ($1,$2,'reviews','20000000-0000-0000-0000-0000000000e1','40000000-0000-0000-0000-0000000000aa',$3,'{}'::jsonb)`,
      [rawId, tenant, `hash-${naturalKey}`],
    );
    await c.query(
      `INSERT INTO normalized_records (id, tenant_id, raw_item_id, schema_ref, natural_key, record, dedup_action)
       VALUES ($1,$2,$3,'schemas/review@1',$4,'{}'::jsonb,'insert')`,
      [normId, tenant, rawId, naturalKey],
    );
    await c.query(
      `INSERT INTO sink_deliveries (id, tenant_id, normalized_record_id, sink_config_id, attempt_no, sink_idempotency_key, status, attempted_at)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7::timestamptz)`,
      [sinkDeliveryId, tenant, normId, sinkConfig, `${tenant}:${sinkConfig}:schemas/review@1:${naturalKey}`, status, attemptedAt],
    );
  });
}

async function seedGatewayPolicy(pool: Pool, tenant: string, id: string, model: string, isDefault = false): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO gateway_policies (id, tenant_id, model, version, capabilities, budget, fallback_config, is_default)
       VALUES ($1,$2,$3,1,'{"jsonMode":true,"vision":false}'::jsonb,'{"maxInputTokens":1000}'::jsonb,'{"model":"fallback"}'::jsonb,$4)`,
      [id, tenant, model, isDefault],
    ),
  );
}

async function seedSite(
  pool: Pool, tenant: string, id: string, name: string, risk: string, approved: boolean, circuit: string, createdAt: string,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, circuit_state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
      [id, tenant, name, `https://${name}.example/*`, risk, approved, circuit, createdAt],
    ),
  );
}

async function seedBrowserSession(pool: Pool, tenant: string, siteId: string, identityId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES ($1,$2,$3,'default')`,
      [identityId, tenant, siteId],
    );
    await c.query(
      `INSERT INTO browser_sessions (
         tenant_id, site_profile_id, browser_identity_id, identity_key, ciphertext, enc_kid, expires_at
       ) VALUES ($1,$2,$3,'',decode('00','hex'),'kid-test','2026-07-01T00:00:00Z')`,
      [tenant, siteId, identityId],
    );
  });
}

async function seedNetworkPolicy(pool: Pool, tenant: string, id: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO network_policies (id, tenant_id, allowed_domains)
       VALUES ($1,$2,ARRAY['green-site.example'])`,
      [id, tenant],
    ),
  );
}

const ts = (i: number) => `2026-06-15T10:0${i}:00Z`;

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

    await seedScenario(pool, TENANT_A, SCEN_A, [SVER_A, SVER_A2]);
    await seedScenario(pool, TENANT_B, SCEN_B, [SVER_B]);

    // tenant A: 5 runs (created_at 오름차 0..4), 상태/버전 혼합.
    const A_RUNS = [
      ["71000000-0000-0000-0000-000000000001", "running", SVER_A, ts(0)],
      ["71000000-0000-0000-0000-000000000002", "running", SVER_A, ts(1)],
      ["71000000-0000-0000-0000-000000000003", "completed", SVER_A2, ts(2)],
      ["71000000-0000-0000-0000-000000000004", "suspended", SVER_A, ts(3)],
      ["71000000-0000-0000-0000-000000000005", "failed_system", SVER_A2, ts(4)],
    ] as const;
    for (const [id, st, sv, t] of A_RUNS) {
      await seedRun(
        pool,
        TENANT_A,
        sv,
        id,
        st,
        t,
        st === "failed_system" ? { code: "RUN_LOOP_FAILED", message: "site profile not found" } : null,
      );
    }
    await seedRun(pool, TENANT_B, SVER_B, "72000000-0000-0000-0000-000000000001", "running", ts(2));

    // human tasks: tenant A 3건 + tenant B 1건.
    const HT_A1 = "73000000-0000-0000-0000-000000000001";
    const HT_A2 = "73000000-0000-0000-0000-000000000002";
    const HT_A3 = "73000000-0000-0000-0000-000000000003";
    const HT_B = "74000000-0000-0000-0000-000000000001";
    await seedHumanTask(pool, TENANT_A, A_RUNS[3][0], HT_A1, "open", "exception", null, ts(0));
    await seedHumanTask(pool, TENANT_A, A_RUNS[3][0], HT_A2, "assigned", "approval", ASSIGNEE, ts(1));
    await seedHumanTask(pool, TENANT_A, A_RUNS[3][0], HT_A3, "open", "approval", null, ts(2));
    await seedHumanTask(pool, TENANT_B, "72000000-0000-0000-0000-000000000001", HT_B, "open", "exception", null, ts(0));

    // workitems: tenant A 4건(new/processing/abandoned + run 연계), tenant B 1건.
    const WI1 = "75000000-0000-0000-0000-000000000001";
    const WI2 = "75000000-0000-0000-0000-000000000002";
    const WI3 = "75000000-0000-0000-0000-000000000003";
    const WI_LINKED = "75000000-0000-0000-0000-000000000004";
    const WI_B = "76000000-0000-0000-0000-000000000001";
    await seedWorkitem(pool, TENANT_A, WI1, "wi-1", "new", ts(0));
    await seedWorkitem(pool, TENANT_A, WI2, "wi-2", "processing", ts(1));
    await seedWorkitem(pool, TENANT_A, WI3, "wi-3", "abandoned", ts(2));
    await seedWorkitem(pool, TENANT_A, WI_LINKED, "wi-linked", "processing", ts(3));
    await seedWorkitem(pool, TENANT_B, WI_B, "wi-b", "abandoned", ts(0));
    // run ↔ workitem 연계(WI_LINKED) — 새 run을 더하지 않고 기존 run(A_RUNS[2])에 workitem_id 연결(listRuns 픽스처 보존).
    const RUN_LINKED = A_RUNS[2][0];
    await withTenantTx(pool, TENANT_A, (c) =>
      c.query(`UPDATE runs SET workitem_id=$2::uuid WHERE tenant_id=$1::uuid AND id=$3::uuid`, [TENANT_A, WI_LINKED, RUN_LINKED]),
    );

    // dead_letter: tenant A 2 미복원 + 1 복원(목록 제외), tenant B 1.
    const DL1 = "77000000-0000-0000-0000-000000000001";
    const DL2 = "77000000-0000-0000-0000-000000000002";
    const DL_REPLAYED = "77000000-0000-0000-0000-000000000003";
    const DL_B = "78000000-0000-0000-0000-000000000001";
    await seedDeadLetter(pool, TENANT_A, DL1, WI3, ts(0), false);
    await seedDeadLetter(pool, TENANT_A, DL2, WI1, ts(1), false);
    await seedDeadLetter(pool, TENANT_A, DL_REPLAYED, WI2, ts(2), true);
    await seedDeadLetter(pool, TENANT_B, DL_B, WI_B, ts(0), false);

    // sink DLQ(데이터평면): tenant A 2 dead_letter + 1 delivered(목록 제외), tenant B 1 dead_letter.
    const SINK_DL1 = "7e000000-0000-0000-0000-000000000001";
    const SINK_DL2 = "7e000000-0000-0000-0000-000000000002";
    const SINK_DELIVERED = "7e000000-0000-0000-0000-000000000003";
    const SINK_DL_B = "7f000000-0000-0000-0000-0000000000b1";
    await seedSinkDelivery(pool, TENANT_A, SINK_DL1, "snk-a1", "dead_letter", ts(0));
    await seedSinkDelivery(pool, TENANT_A, SINK_DL2, "snk-a2", "dead_letter", ts(1));
    await seedSinkDelivery(pool, TENANT_A, SINK_DELIVERED, "snk-a3", "delivered", ts(2));
    await seedSinkDelivery(pool, TENANT_B, SINK_DL_B, "snk-b1", "dead_letter", ts(0));

    // gateway_policies: tenant A 2 모델(기본 1), tenant B 1 모델(단일).
    await seedGatewayPolicy(pool, TENANT_A, "79000000-0000-0000-0000-000000000001", "gpt-4o-mini", true);
    await seedGatewayPolicy(pool, TENANT_A, "79000000-0000-0000-0000-000000000002", "claude-haiku");
    await seedGatewayPolicy(pool, TENANT_B, "79000000-0000-0000-0000-0000000000b1", "gpt-4o-mini", true);

    // site_profiles: tenant A 3건(risk 혼합/승인 혼합/circuit 혼합), tenant B 1건.
    const SITE_RED = "7a000000-0000-0000-0000-000000000001";
    const SITE_GREEN = "7a000000-0000-0000-0000-000000000002";
    const SITE_AMBER = "7a000000-0000-0000-0000-000000000003";
    const SITE_B = "7b000000-0000-0000-0000-000000000001";
    await seedSite(pool, TENANT_A, SITE_RED, "red-site", "red", true, "open", ts(0));
    await seedSite(pool, TENANT_A, SITE_GREEN, "green-site", "green", false, "closed", ts(1));
    await seedSite(pool, TENANT_A, SITE_AMBER, "amber-site", "amber", false, "half_open", ts(2));
    await seedSite(pool, TENANT_B, SITE_B, "b-site", "red", false, "closed", ts(0));
    await seedNetworkPolicy(pool, TENANT_A, NETWORK_A);
    await seedBrowserSession(pool, TENANT_A, SITE_GREEN, "7a100000-0000-0000-0000-000000000002");
    console.log("seeded runs + human tasks + workitems + dead letters + gateway + sites");

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
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
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });
      const viewerB = await mint({ sub: "vb", tenant_id: TENANT_B, roles: ["viewer"] });
      const noRole = await mint({ sub: "nr", tenant_id: TENANT_A, roles: [] });

      const get = (url: string, token = viewer) =>
        app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

      // ===== listRuns =====
      // 1) 전체: 5건, created_at DESC(최신=run5..run1), current_node=null, as_of/failure_reason round-trip.
      const all = await get("/v1/runs");
      check("listRuns → 200", all.statusCode === 200, all.body);
      const allBody = all.json();
      check("listRuns returns 5 items", allBody.items?.length === 5, JSON.stringify(allBody.items?.length));
      check("listRuns next_cursor null (single page)", allBody.next_cursor === null, JSON.stringify(allBody.next_cursor));
      check(
        "listRuns DESC by created_at",
        allBody.items[0].run_id === A_RUNS[4][0] && allBody.items[4].run_id === A_RUNS[0][0],
        JSON.stringify(allBody.items.map((r: { run_id: string }) => r.run_id)),
      );
      check("listRuns item shape (run_id/status/current_node null/as_of/updated_at/failure_reason)",
        allBody.items[0].status === "failed_system" && allBody.items[0].current_node === null &&
        allBody.items[0].as_of === "2026-06-15T00:00:00.000Z" &&
        typeof allBody.items[0].updated_at === "string" &&
        allBody.items[0].failure_reason?.code === "RUN_LOOP_FAILED" &&
        allBody.items[0].failure_reason?.message === "site profile not found", JSON.stringify(allBody.items[0]));

      // 2) 커서 페이지네이션: limit=2 → 2건 + next_cursor, 이어서 소진.
      const p1 = await get("/v1/runs?limit=2");
      const p1b = p1.json();
      check("page1 limit=2 → 2 items + cursor", p1b.items.length === 2 && typeof p1b.next_cursor === "string", JSON.stringify(p1b));
      check("page1 newest first", p1b.items[0].run_id === A_RUNS[4][0] && p1b.items[1].run_id === A_RUNS[3][0], "");
      const p2 = await get(`/v1/runs?limit=2&cursor=${encodeURIComponent(p1b.next_cursor)}`);
      const p2b = p2.json();
      check("page2 → next 2 items", p2b.items.length === 2 && p2b.items[0].run_id === A_RUNS[2][0], JSON.stringify(p2b.items.map((r: {run_id:string}) => r.run_id)));
      const p3 = await get(`/v1/runs?limit=2&cursor=${encodeURIComponent(p2b.next_cursor)}`);
      const p3b = p3.json();
      check("page3 → last 1 item, cursor null", p3b.items.length === 1 && p3b.next_cursor === null && p3b.items[0].run_id === A_RUNS[0][0], JSON.stringify(p3b));

      // 3) status 필터.
      const running = await get("/v1/runs?status=running");
      check("filter status=running → 2", running.json().items.length === 2, JSON.stringify(running.json().items.length));
      const suspended = await get("/v1/runs?status=suspended");
      check("filter status=suspended → 1", suspended.json().items.length === 1, "");

      // 4) scenario_version_id 필터.
      const bySver = await get(`/v1/runs?scenario_version_id=${SVER_A2}`);
      check("filter scenario_version_id → 2", bySver.json().items.length === 2, JSON.stringify(bySver.json().items.length));

      // 5) 무효 필터/페이지 파라미터 → 422.
      const badStatus = await get("/v1/runs?status=bogus");
      check("invalid status → 422", badStatus.statusCode === 422 && badStatus.json().code === "IR_SCHEMA_INVALID", badStatus.body);
      const badLimit = await get("/v1/runs?limit=0");
      check("limit=0 → 422", badLimit.statusCode === 422, badLimit.body);
      const badLimit2 = await get("/v1/runs?limit=abc");
      check("limit=abc → 422", badLimit2.statusCode === 422, badLimit2.body);
      const badCursor = await get("/v1/runs?cursor=not-base64-json");
      check("invalid cursor → 422", badCursor.statusCode === 422 && badCursor.json().details?.reason === "invalid_cursor", badCursor.body);
      const badSver = await get("/v1/runs?scenario_version_id=not-uuid");
      check("invalid scenario_version_id → 422", badSver.statusCode === 422, badSver.body);

      // 6) RLS: tenant B viewer는 자기 1건만.
      const bRuns = await get("/v1/runs", viewerB);
      check("tenant B sees only own runs (1)", bRuns.json().items.length === 1, JSON.stringify(bRuns.json().items.length));

      // 7) RBAC: 역할 없음 → 403.
      const noRoleRuns = await get("/v1/runs", noRole);
      check("no-role listRuns → 403", noRoleRuns.statusCode === 403 && noRoleRuns.json().code === "AUTHZ_FORBIDDEN", noRoleRuns.body);

      // ===== listHumanTasks =====
      const allHt = await get("/v1/human-tasks");
      check("listHumanTasks → 200, 3 items", allHt.statusCode === 200 && allHt.json().items.length === 3, allHt.body);
      check("HumanTask shape (human_task_id/timeout/run_id)",
        allHt.json().items[0].human_task_id === HT_A3 && allHt.json().items[0].timeout === "2026-07-01T00:00:00.000Z" &&
        allHt.json().items[0].run_id === A_RUNS[3][0], JSON.stringify(allHt.json().items[0]));
      const byState = await get("/v1/human-tasks?status=open");
      check("filter state=open → 2", byState.json().items.length === 2, JSON.stringify(byState.json().items.length));
      const byKind = await get("/v1/human-tasks?kind=approval");
      check("filter kind=approval → 2", byKind.json().items.length === 2, "");
      const byAssignee = await get(`/v1/human-tasks?assignee=${ASSIGNEE}`);
      check("filter assignee → 1", byAssignee.json().items.length === 1 && byAssignee.json().items[0].human_task_id === HT_A2, "");
      // assignee=PrincipalId(자유형 string)이므로 비-UUID sub 필터도 422가 아니라 200(매칭 0). uuid 강제 폐지 회귀.
      const byOidcAssignee = await get("/v1/human-tasks?assignee=auth0%7Cabc123");
      check("filter non-uuid assignee → 200 (0 matches, not 422)", byOidcAssignee.statusCode === 200 && byOidcAssignee.json().items.length === 0, byOidcAssignee.body);
      const emptyAssignee = await get("/v1/human-tasks?assignee=");
      check("filter empty assignee → 422", emptyAssignee.statusCode === 422 && emptyAssignee.json().details?.reason === "invalid_assignee", emptyAssignee.body);
      const byRun = await get(`/v1/human-tasks?run_id=${A_RUNS[3][0]}`);
      check("filter run_id → 3 linked tasks", byRun.json().items.length === 3 && byRun.json().items.every((h: { run_id: string }) => h.run_id === A_RUNS[3][0]), JSON.stringify(byRun.json().items));
      const badRun = await get("/v1/human-tasks?run_id=not-uuid");
      check("invalid run_id → 422", badRun.statusCode === 422 && badRun.json().details?.reason === "invalid_run_id", badRun.body);
      const htPage = await get("/v1/human-tasks?limit=2");
      check("HT page limit=2 → 2 + cursor", htPage.json().items.length === 2 && typeof htPage.json().next_cursor === "string", "");
      const badKind = await get("/v1/human-tasks?kind=bogus");
      check("invalid kind → 422", badKind.statusCode === 422 && badKind.json().details?.reason === "invalid_kind", badKind.body);
      const htB = await get("/v1/human-tasks", viewerB);
      check("tenant B HT isolation (1)", htB.json().items.length === 1, "");

      // ===== getHumanTask =====
      const detail = await get(`/v1/human-tasks/${HT_A2}`);
      check("getHumanTask → 200", detail.statusCode === 200, detail.body);
      check("getHumanTask detail fields",
        detail.json().human_task_id === HT_A2 && detail.json().state === "assigned" &&
        detail.json().kind === "approval" && detail.json().assignee === ASSIGNEE, JSON.stringify(detail.json()));
      check("getHumanTask omits inline payload", !("payload" in detail.json()), JSON.stringify(detail.json()));
      const absent = await get(`/v1/human-tasks/${ABSENT}`);
      check("absent human task → 404", absent.statusCode === 404 && absent.json().code === "RESOURCE_NOT_FOUND", absent.body);
      const crossHt = await get(`/v1/human-tasks/${HT_A2}`, viewerB);
      check("cross-tenant human task → 404 (RLS)", crossHt.statusCode === 404, crossHt.body);
      const badId = await get("/v1/human-tasks/not-a-uuid");
      check("malformed human_task id → 404", badId.statusCode === 404, badId.body);

      // ===== listWorkitems =====
      const allWi = await get("/v1/workitems");
      check("listWorkitems → 200, 4 items", allWi.statusCode === 200 && allWi.json().items.length === 4, allWi.body);
      check("Workitem shape (workitem_id/target_id null/unique_reference)",
        allWi.json().items[0].workitem_id === WI_LINKED && allWi.json().items[0].target_id === null &&
        allWi.json().items[0].unique_reference === "wi-linked", JSON.stringify(allWi.json().items[0]));
      const wiAbandoned = await get("/v1/workitems?status=abandoned");
      check("filter workitem status=abandoned → 1", wiAbandoned.json().items.length === 1 && wiAbandoned.json().items[0].workitem_id === WI3, "");
      const wiTarget = await get("/v1/workitems?target_id=anything");
      check("target_id filter → 422 unsupported", wiTarget.statusCode === 422 && wiTarget.json().details?.reason === "target_id_filter_unsupported", wiTarget.body);
      const wiBadStatus = await get("/v1/workitems?status=bogus");
      check("invalid workitem status → 422", wiBadStatus.statusCode === 422, wiBadStatus.body);
      const wiPage = await get("/v1/workitems?limit=2");
      check("workitem page limit=2 → 2 + cursor", wiPage.json().items.length === 2 && typeof wiPage.json().next_cursor === "string", "");
      const wiB = await get("/v1/workitems", viewerB);
      check("tenant B workitem isolation (1)", wiB.json().items.length === 1, "");

      // ===== getWorkitem (run_id 연계) =====
      const wiDetail = await get(`/v1/workitems/${WI_LINKED}`);
      check("getWorkitem → 200 + run_id linkage", wiDetail.statusCode === 200 && wiDetail.json().run_id === RUN_LINKED, wiDetail.body);
      const wiUnlinked = await get(`/v1/workitems/${WI1}`);
      check("getWorkitem unlinked → run_id null", wiUnlinked.json().run_id === null, wiUnlinked.body);
      const wiAbsent = await get(`/v1/workitems/${ABSENT}`);
      check("absent workitem → 404", wiAbsent.statusCode === 404 && wiAbsent.json().code === "RESOURCE_NOT_FOUND", wiAbsent.body);
      const wiCross = await get(`/v1/workitems/${WI_B}`);
      check("cross-tenant workitem → 404 (RLS)", wiCross.statusCode === 404, wiCross.body);

      // ===== listDeadLetters (복원 제외) =====
      const dlq = await get("/v1/dlq");
      check("listDeadLetters → 200, 2 unreplayed", dlq.statusCode === 200 && dlq.json().items.length === 2, dlq.body);
      check("DeadLetter shape (kind=workitem/status=DEAD_LETTER/source_id)",
        dlq.json().items.every((d: { kind: string; status: string; source_id: string }) => d.kind === "workitem" && d.status === "DEAD_LETTER") &&
        dlq.json().items.some((d: { dead_letter_id: string; source_id: string }) => d.dead_letter_id === DL1 && d.source_id === WI3),
        JSON.stringify(dlq.json().items));
      // reason_code(error-catalog ErrorCode)·created_at 투영(workitem 한정). seedDeadLetter는 reason_code='WORKITEM_CHECKOUT_CONFLICT'.
      check("workitem DLQ projects reason_code + created_at(ISO)",
        dlq.json().items.every((d: { reason_code: string; created_at: string }) =>
          d.reason_code === "WORKITEM_CHECKOUT_CONFLICT" && typeof d.created_at === "string" && !Number.isNaN(Date.parse(d.created_at))),
        JSON.stringify(dlq.json().items));
      // sink DLQ(데이터평면): tenant A 2 dead_letter, delivered 1건 제외, kind=sink/status=DEAD_LETTER.
      const dlqSink = await get("/v1/dlq?kind=sink");
      check("dlq kind=sink → 2 dead_letter (delivered excluded)", dlqSink.statusCode === 200 && dlqSink.json().items.length === 2, dlqSink.body);
      check("sink DLQ shape (kind=sink/status=DEAD_LETTER/idempotency key)",
        dlqSink.json().items.every((d: { kind: string; status: string }) => d.kind === "sink" && d.status === "DEAD_LETTER") &&
        dlqSink.json().items.some((d: { dead_letter_id: string; source_id: string; sink_idempotency_key: string }) =>
          d.dead_letter_id === SINK_DL2 && typeof d.source_id === "string" && d.sink_idempotency_key.includes("snk-a2")),
        JSON.stringify(dlqSink.json().items));
      // 날조 금지: sink_deliveries엔 reason_code 컬럼이 없어 sink DLQ 항목은 reason_code 미제공(undefined).
      check("sink DLQ omits reason_code (의도된 부재)",
        dlqSink.json().items.every((d: { reason_code?: string }) => d.reason_code === undefined),
        JSON.stringify(dlqSink.json().items));
      const dlqSinkB = await get("/v1/dlq?kind=sink", viewerB);
      check("tenant B sink DLQ isolation (1)", dlqSinkB.json().items.length === 1, JSON.stringify(dlqSinkB.json().items));
      const dlqBadKind = await get("/v1/dlq?kind=bogus");
      check("dlq invalid kind → 422", dlqBadKind.statusCode === 422, dlqBadKind.body);
      const dlqB = await get("/v1/dlq", viewerB);
      check("tenant B dlq isolation (1)", dlqB.json().items.length === 1, "");

      // ===== listScenarios (최신 version) =====
      const scen = await get("/v1/scenarios");
      check("listScenarios → 200, 1 scenario (tenant A)", scen.statusCode === 200 && scen.json().items.length === 1, scen.body);
      check("Scenario latest version=2 + no ir field",
        scen.json().items[0].scenario_id === SCEN_A && scen.json().items[0].version === 2 &&
        scen.json().items[0].latest_version_id === SVER_A2 && scen.json().items[0].ir === undefined, JSON.stringify(scen.json().items[0]));
      const scenB = await get("/v1/scenarios", viewerB);
      check("tenant B scenario isolation (1, version=1)", scenB.json().items.length === 1 && scenB.json().items[0].version === 1, JSON.stringify(scenB.json().items));

      // ===== gateway policy list/read (default 해소) =====
      const gwList = await get("/v1/gateway/policies");
      check("gateway policies list → 200, 2 items + default first",
        gwList.statusCode === 200 && gwList.json().items.length === 2 &&
        gwList.json().items[0].model === "gpt-4o-mini" && gwList.json().items[0].version === 1 &&
        gwList.json().items[0].is_default === true,
        gwList.body);
      // tenant A는 2 모델이지만 기본 정책이 있어 model 미지정 단수 조회도 기본을 반환.
      const gwDefault = await get("/v1/gateway/policy");
      check("gateway no model + default policy → 200 default", gwDefault.statusCode === 200 && gwDefault.json().model === "gpt-4o-mini", gwDefault.body);
      const gwModel = await get("/v1/gateway/policy?model=gpt-4o-mini");
      check("gateway ?model= → 200", gwModel.statusCode === 200, gwModel.body);
      check("GatewayPolicy shape (model/capabilities/budget/fallback)",
        gwModel.json().model === "gpt-4o-mini" && gwModel.json().capabilities?.jsonMode === true &&
        gwModel.json().budget?.maxInputTokens === 1000 && gwModel.json().fallback?.model === "fallback" &&
        gwModel.json().is_default === true, JSON.stringify(gwModel.json()));
      const gwAbsent = await get("/v1/gateway/policy?model=nonexistent");
      check("gateway model absent → 404", gwAbsent.statusCode === 404 && gwAbsent.json().code === "RESOURCE_NOT_FOUND", gwAbsent.body);
      // tenant B는 1 모델 → model 미지정도 200(단일).
      const gwSingle = await get("/v1/gateway/policy", viewerB);
      check("gateway single policy no model → 200", gwSingle.statusCode === 200 && gwSingle.json().model === "gpt-4o-mini", gwSingle.body);

      // ===== listSites / getSite =====
      const sites = await get("/v1/sites");
      check("listSites → 200, 3 items", sites.statusCode === 200 && sites.json().items.length === 3, sites.body);
      check("Site shape (url_pattern/risk/approval_status/circuit_status/session meta)",
        sites.json().items.some((s: { site_profile_id: string; url_pattern: string; risk: string; approval_status: string; circuit_status: string; session_ready: boolean; session_expires_at: string | null; default_browser_identity_id: string | null; default_network_policy_id: string | null }) =>
          s.site_profile_id === SITE_GREEN && s.url_pattern === "https://green-site.example/*" &&
          s.risk === "green" && s.approval_status === "pending" && s.circuit_status === "closed" &&
          s.session_ready === true && s.session_expires_at === "2026-07-01T00:00:00.000Z" &&
          s.default_browser_identity_id === "7a100000-0000-0000-0000-000000000002" &&
          s.default_network_policy_id === NETWORK_A),
        JSON.stringify(sites.json().items));
      const sitesRed = await get("/v1/sites?risk=red");
      check("filter risk=red → 1", sitesRed.json().items.length === 1 && sitesRed.json().items[0].site_profile_id === SITE_RED, "");
      const sitesBadRisk = await get("/v1/sites?risk=bogus");
      check("invalid risk → 422", sitesBadRisk.statusCode === 422, sitesBadRisk.body);
      const siteDetail = await get(`/v1/sites/${SITE_GREEN}`);
      check("getSite → 200 (approval_status pending, circuit closed)",
        siteDetail.statusCode === 200 && siteDetail.json().approval_status === "pending" && siteDetail.json().circuit_status === "closed" &&
        siteDetail.json().default_browser_identity_id === "7a100000-0000-0000-0000-000000000002" &&
        siteDetail.json().default_network_policy_id === NETWORK_A, siteDetail.body);
      const siteAbsent = await get(`/v1/sites/${ABSENT}`);
      check("absent site → 404", siteAbsent.statusCode === 404 && siteAbsent.json().code === "RESOURCE_NOT_FOUND", siteAbsent.body);
      const siteCross = await get(`/v1/sites/${SITE_B}`);
      check("cross-tenant site → 404 (RLS)", siteCross.statusCode === 404, siteCross.body);
      const sitesB = await get("/v1/sites", viewerB);
      check("tenant B site isolation (1)", sitesB.json().items.length === 1, "");

      // RBAC: viewer는 gateway_policy.read·site.read 보유(신규 read 액션) → 위 호출들이 이미 200으로 검증됨.
      // no-role은 거부(read 액션 미보유).
      const noRoleSites = await get("/v1/sites", noRole);
      check("no-role listSites → 403 (gateway/site read gated)", noRoleSites.statusCode === 403 && noRoleSites.json().code === "AUTHZ_FORBIDDEN", noRoleSites.body);
      const noRoleGw = await get("/v1/gateway/policy?model=gpt-4o-mini", noRole);
      check("no-role gateway policy → 403", noRoleGw.statusCode === 403, noRoleGw.body);
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
  console.log("\nPASS: D6.5 read endpoints (listRuns/listHumanTasks/getHumanTask) integration green");
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
