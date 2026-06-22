/**
 * 통합 — keyset 커서 마이크로초 정밀도(감사 PAG-01). 실 PostgreSQL.
 *
 * created_at 컬럼은 timestamptz(마이크로초)인데 pg 가 JS Date(밀리초)로 파싱해 커서가 밀리초로 절단되면, 동일-밀리초
 * 경계 행이 DESC keyset 페이지네이션에서 조용히 누락된다. 수정: SELECT 가 created_at::text(전정밀도)를 cursor_at 로
 * 반환하고 paginate/encodeCursor 가 그 문자열을 그대로 커서에 싣는다. 본 테스트는 runs 목록 쿼리(DESC)를 재현해
 * 동일-밀리초·상이-마이크로초 행이 limit=1 연속 페이지에서 누락 없이 모두 반환됨을 검증(+ negative control: 밀리초
 * 절단 시 누락 재현).
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/list-cursor-precision.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { decodeCursor, encodeCursor, paginate } from "../src/api/list-query";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_cursor_precision_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000c1";
const SVER = "70000000-0000-0000-0000-0000000000c2";
const R1 = "71000000-0000-0000-0000-000000000001"; // .500002 (newest)
const R2 = "71000000-0000-0000-0000-000000000002"; // .500001 (same ms .500, 경계 누락 후보)
const R3 = "71000000-0000-0000-0000-000000000003"; // .400000 (earlier ms)

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

type Pool = ReturnType<typeof createPool>;
interface Row { id: string; cursor_at: string }

// runs 목록(DESC) 쿼리 재현: created_at::text AS cursor_at + keyset (created_at,id) < (cursor::timestamptz, id).
async function queryPage(pool: Pool, cursor: { createdAt: string; id: string } | null, limit: number): Promise<Row[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<Row>(
      `SELECT id, created_at::text AS cursor_at
         FROM runs
        WHERE tenant_id = $1::uuid
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [TENANT, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    return r.rows;
  });
}

// limit=1 로 전 페이지를 순회해 id 를 수집한다. truncateMs=true 면 커서 created_at 을 밀리초로 절단(수정 전 동작 모사).
async function walkAll(pool: Pool, truncateMs: boolean): Promise<string[]> {
  const ids: string[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const rows = await queryPage(pool, cursor, 1);
    const page = paginate<Row, string>(rows, 1, (row) => ({ createdAt: row.cursor_at, id: row.id }), (row) => row.id);
    ids.push(...page.items);
    if (page.next_cursor === null) break;
    const decoded = decodeCursor(page.next_cursor)!;
    cursor = truncateMs
      ? { createdAt: new Date(decoded.createdAt).toISOString(), id: decoded.id } // 밀리초 절단(pre-fix)
      : decoded;
  }
  return ids;
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
    } finally { setup.release(); }

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'cur')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod','{}'::jsonb,'{}')`, [SVER, TENANT, SCEN]);
      // R1/R2 동일 밀리초(.500), 상이 마이크로초; R3 더 이른 밀리초(.400).
      const ins = `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at) VALUES ($1,$2,$3,'queued',$4,$5::timestamptz)`;
      await c.query(ins, [R1, TENANT, SVER, "20000000-0000-0000-0000-000000000001", "2026-01-01 00:00:00.500002+00"]);
      await c.query(ins, [R2, TENANT, SVER, "20000000-0000-0000-0000-000000000002", "2026-01-01 00:00:00.500001+00"]);
      await c.query(ins, [R3, TENANT, SVER, "20000000-0000-0000-0000-000000000003", "2026-01-01 00:00:00.400000+00"]);
    });

    // 수정(전정밀도 커서): limit=1 순회가 3개 모두 누락 없이 반환.
    const full = await walkAll(pool, false);
    check("전정밀도 커서: 동일-밀리초 행 누락 없이 3개 모두 반환", full.length === 3 && new Set(full).size === 3 && full.includes(R2), JSON.stringify(full));

    // negative control(밀리초 절단=pre-fix): 동일-밀리초 경계 행(R2)이 누락.
    const truncated = await walkAll(pool, true);
    check("밀리초 절단(pre-fix): 동일-밀리초 경계 행 누락 재현(R2 빠짐)", !truncated.includes(R2), JSON.stringify(truncated));
  } finally { await pool.end(); }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: list keyset 커서 마이크로초 정밀도(PAG-01)");
  process.exit(0);
}
main().catch((e) => { console.error("list-cursor-precision int fatal:", e); process.exit(1); });
