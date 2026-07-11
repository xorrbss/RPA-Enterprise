/**
 * DG1 — DB 역할 분리(최소권한) 실 PG 검증.
 *   db/roles.sql 의 rpa_app 런타임 역할이: DML 동작 · DDL 거부 · RLS 적용(BYPASSRLS 없음)임을 증명한다.
 *   또한 오너 런북 1단계의 실 러너(`db-migrate.mjs --graphile-worker`)를 실행해, 그 GRANT 로 rpa_app 이 큐를
 *   읽을 수 있음을 못 박는다 — 이 조합이 깨지면 production readiness graphile_queue 게이트가 영구 blocked 다.
 *   superuser(postgres)로 셋업하고 rpa_app 로 연결해 검증한다. CI 는 비밀번호 인증이라 PGADMIN_PASSWORD 를
 *   쓰고, 로컬 temp-PG(trust)에서는 undefined 로 무시된다(runtime-worker-claim.int.ts 와 동일 패턴).
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
const ADMIN_USER = process.env.PGADMIN_USER ?? "postgres";
const ADMIN_PASSWORD = process.env.PGADMIN_PASSWORD;
const DB = "rpa_dg1_roles";
const APP_PW = "dg1-app-test-pw";

function adminClient(database: string): pg.Client {
  return new pg.Client({ host: HOST, port: PORT, user: ADMIN_USER, password: ADMIN_PASSWORD, database });
}

/** db-migrate.mjs 는 DATABASE_URL 로 연결한다(graphile runMigrations 가 연결 문자열을 요구). */
function adminDatabaseUrl(database: string): string {
  const auth = ADMIN_PASSWORD === undefined || ADMIN_PASSWORD === ""
    ? encodeURIComponent(ADMIN_USER)
    : `${encodeURIComponent(ADMIN_USER)}:${encodeURIComponent(ADMIN_PASSWORD)}`;
  return `postgresql://${auth}@${HOST}:${PORT}/${encodeURIComponent(database)}`;
}

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
  // 1) superuser 로 깨끗한 DB 생성 + 마이그레이션 + roles.sql 적용.
  const admin = adminClient("postgres");
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const setup = adminClient(DB);
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
    env: { ...process.env, DATABASE_URL: adminDatabaseUrl(DB) },
  });
  check("db-migrate.mjs --graphile-worker 성공", migrate.status === 0, `exit=${migrate.status}`);

  // 실 인큐 경로를 **런타임 역할 rpa_app 으로** 실행한다(제어평면이 실제로 쓰는 접속). superuser 로 인큐하면
  // RLS 를 우회해 결함이 가려진다 — graphile 0.16 은 `_private_*` 에 RLS 를 켜고 정책을 만들지 않으므로,
  // db-migrate 가 rpa_app 정책을 부여하지 않으면 여기서 42501 로 실패해야 한다(= 실 배포에서 run 생성 불가).
  const enqueuePool = new pg.Pool({ host: HOST, port: PORT, user: "rpa_app", password: APP_PW, database: DB });
  const enqueueClient = await enqueuePool.connect();
  let enqueueError: string | undefined;
  try {
    await enqueueClient.query("BEGIN");
    await enqueueClient.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
    await new PgGraphileRunEnqueuer().enqueueRunClaim(enqueueClient, {
      tenantId: TENANT_A,
      runId: RUN_A,
      correlationId: CORR_A,
    });
    await enqueueClient.query("COMMIT");
  } catch (err) {
    enqueueError = String((err as { message?: string }).message ?? err);
    await enqueueClient.query("ROLLBACK").catch(() => undefined);
  } finally {
    enqueueClient.release();
    await enqueuePool.end();
  }
  check("rpa_app 인큐: graphile add_job 성공(제어평면 run 생성 경로)", enqueueError === undefined, enqueueError);

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

  // 워커의 dequeue(잠금) 경로 — graphile 러너가 rpa_app 접속으로 실행하는 UPDATE. RLS 정책이 없으면 여기서
  // 0행이 갱신되며 **조용히** 아무 job 도 못 집는다(에러도 나지 않는다).
  const locked = await app.query<{ id: string }>(
    `UPDATE graphile_worker._private_jobs
        SET locked_at = now(), locked_by = 'dg1-test-worker'
      WHERE locked_at IS NULL
      RETURNING id::text`,
  );
  check("rpa_app dequeue: job 잠금 가능(워커가 job 을 집을 수 있음)", locked.rowCount === 1, JSON.stringify(locked.rows));

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
