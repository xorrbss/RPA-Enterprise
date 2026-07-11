/**
 * DG1 — DB 역할 분리(최소권한) 실 PG 검증.
 *   db/roles.sql 의 rpa_app 런타임 역할이: DML 동작 · DDL 거부 · RLS 적용(BYPASSRLS 없음)임을 증명한다.
 *   gate 가 제공하는 postgres(superuser, trust)로 셋업하고, rpa_app 로 연결해 검증한다.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/db-roles-least-privilege.int.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { tenantFlagFor } from "../src/runtime/pool-forbidden-flags";
import { PgGraphileRunEnqueuer } from "../src/runtime/run-queue";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = Number(process.env.PGPORT ?? "5432");
const DB = "rpa_dg1_roles";
const APP_PW = "dg1-app-test-pw";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO = "9c000000-0000-4000-8000-000000000001";
const RUN_A = "9c000000-0000-4000-8000-000000000002";
const CORR_A = "9c000000-0000-4000-8000-000000000003";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // 1) postgres(superuser, trust)로 깨끗한 DB 생성 + 마이그레이션 + roles.sql 적용.
  const admin = new pg.Client({ host: HOST, port: PORT, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const setup = new pg.Client({ host: HOST, port: PORT, user: "postgres", database: DB });
  await setup.connect();
  await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
  await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
  await setup.query(readFileSync(`${ROOT}db/roles.sql`, "utf8"));
  // 배포 runbook 의 LOGIN 주입 단계 모사(검증 연결용).
  await setup.query(`ALTER ROLE rpa_app LOGIN PASSWORD '${APP_PW}'`);
  // 역할 속성 검증.
  const attrs = await setup.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='rpa_app'`,
  );
  const a = attrs.rows[0];
  check(
    "rpa_app 속성: 비-superuser·비-bypassrls·비-createdb·비-createrole",
    a !== undefined && !a.rolsuper && !a.rolbypassrls && !a.rolcreatedb && !a.rolcreaterole,
    JSON.stringify(a),
  );
  await setup.end();

  // 1b) 오너 런북 1단계와 동일한 실 러너로 graphile 스키마 + 런타임 GRANT 를 적용한다(스키마는 위에서 SQL 로
  // 직접 세웠으므로 기존 DB 경로인 --baseline-existing). 이 명령이 부여하는 권한이 없으면 rpa_app 은 큐를 못 읽는다.
  const migrate = spawnSync(process.execPath, ["scripts/db-migrate.mjs", "--baseline-existing", "--graphile-worker"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: `postgresql://postgres@${HOST}:${PORT}/${DB}` },
  });
  check("db-migrate.mjs --graphile-worker 성공", migrate.status === 0, `exit=${migrate.status}`);

  // 실 인큐 경로로 tenant A job 1건(= run-queue.ts 가 붙이는 flags 를 그대로 생성).
  const enqueuePool = new pg.Pool({ host: HOST, port: PORT, user: "postgres", database: DB });
  const enqueueClient = await enqueuePool.connect();
  try {
    await enqueueClient.query("BEGIN");
    await enqueueClient.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
    await new PgGraphileRunEnqueuer().enqueueRunClaim(enqueueClient, {
      tenantId: TENANT_A,
      runId: RUN_A,
      correlationId: CORR_A,
    });
    await enqueueClient.query("COMMIT");
  } finally {
    enqueueClient.release();
    await enqueuePool.end();
  }

  // 2) rpa_app(런타임 역할)로 연결해 동작 검증.
  const app = new pg.Client({ host: HOST, port: PORT, user: "rpa_app", password: APP_PW, database: DB });
  await app.connect();

  // DML: tenant A 로 scenario INSERT + SELECT.
  await app.query("BEGIN");
  await app.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
  await app.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ('${SCENARIO}','${TENANT_A}','dg1')`);
  const selA = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM scenarios`);
  check("rpa_app DML: INSERT+SELECT 동작", selA.rows[0]?.n === 1, JSON.stringify(selA.rows[0]));
  await app.query("COMMIT");

  // RLS: tenant B 로 보면 0건(BYPASSRLS 없음 → 격리).
  await app.query("BEGIN");
  await app.query(`SET LOCAL app.tenant_id = '${TENANT_B}'`);
  const selB = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM scenarios`);
  check("rpa_app RLS: 타 테넌트엔 0건(격리 적용)", selB.rows[0]?.n === 0, JSON.stringify(selB.rows[0]));
  await app.query("COMMIT");

  // DDL 거부(스키마 USAGE 만, CREATE 미부여).
  let ddlDenied = false;
  let ddlDetail = "";
  try {
    await app.query(`CREATE TABLE dg1_should_not_exist (id int)`);
  } catch (err) {
    ddlDetail = String((err as { message?: string }).message ?? err);
    ddlDenied = /permission denied|must be owner/i.test(ddlDetail);
  }
  check("rpa_app DDL 거부: CREATE TABLE 차단", ddlDenied, ddlDetail);

  // 큐 표면: run-queue.ts 가 인큐한 job 을 rpa_app 이 실제로 셀 수 있어야 한다(api/ops-health.ts readQueueDepth).
  // graphile 의 payload 보유 테이블 `_private_jobs` 는 RLS 가 켜져 있어 rpa_app 에게 0 건이므로, 테넌트 스코프는
  // 공개 뷰 `graphile_worker.jobs` + `tenant:<uuid>` flag 로만 성립한다. 이 조합이 깨지면 production readiness
  // graphile_queue 게이트가 영구 blocked 가 된다(운영 전환 불가) — 실 역할로 여기서 못 박는다.
  await app.query("BEGIN");
  await app.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
  const queueA = await app.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE locked_at IS NULL AND flags ? $1`,
    [tenantFlagFor(TENANT_A)],
  );
  check("rpa_app 큐 조회: 자기 테넌트 대기 job 1건", queueA.rows[0]?.n === 1, JSON.stringify(queueA.rows[0]));
  const queueB = await app.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE locked_at IS NULL AND flags ? $1`,
    [tenantFlagFor(TENANT_B)],
  );
  check("rpa_app 큐 조회: 타 테넌트 job 은 0건(음성 대조)", queueB.rows[0]?.n === 0, JSON.stringify(queueB.rows[0]));
  await app.query("COMMIT");

  await app.end();

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: DG1 db role least-privilege verified (rpa_app DML ok · RLS applies · DDL denied · 큐 조회 가능)");
}

main().catch((err) => {
  console.error("FAIL: db-roles verification threw:", err);
  process.exit(1);
});
