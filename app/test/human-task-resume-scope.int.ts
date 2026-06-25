/**
 * C3 consumer 통합 — loadResolvedHumanTaskNodeOutputs (해소된 @human_task → IREL node.<id>.decision/correction). 실 PostgreSQL.
 *
 * 검증: resolved + node_id 보유 행만 투영(decision/correction). node_id NULL(challenge)·result NULL·malformed(decision
 * 비-string)·비-resolved(open) 행은 미투영(스킵). 같은 node_id 다중 cycle 은 최신 resolved 가 권위(later overwrites).
 * 다른 run 행은 격리(run_id 필터). 신뢰 경계: human_tasks.result 를 RLS 뒤에서 re-SELECT(reserved-handlers.md).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/human-task-resume-scope.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { loadResolvedHumanTaskNodeOutputs } from "../src/runtime/human-task-resume-scope";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_human_task_resume_scope_int";
const TENANT = "00000000-0000-0000-0000-0000000000b1";
const SCEN = "70000000-0000-0000-0000-0000000000b1";
const SVER = "70000000-0000-0000-0000-0000000000b2";
const RUN = "71000000-0000-0000-0000-0000000000b1";
const OTHER_RUN = "71000000-0000-0000-0000-0000000000b2";
const CORR = "20000000-0000-0000-0000-0000000000b1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let seq = 0;
function htId(): string {
  seq += 1;
  return `72000000-0000-0000-0000-${String(seq).padStart(12, "0")}`;
}

interface SeedRow {
  runId: string;
  nodeId: string | null;
  kind: string;
  state: string;
  result: unknown;
  resolvedAt?: string;
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

    const rows: SeedRow[] = [
      // 투영 대상: resolved + node_id + result(decision[/corrections]).
      { runId: RUN, nodeId: "approve_node", kind: "approval", state: "resolved", result: { decision: "approve", corrections: { amount: 100 } } },
      { runId: RUN, nodeId: "correct_node", kind: "validation", state: "resolved", result: { decision: "correct", corrections: { memo: "fixme" } } },
      { runId: RUN, nodeId: "decision_only", kind: "approval", state: "resolved", result: { decision: "reject" } },
      // 스킵: node_id NULL(challenge)·result NULL·malformed(decision 부재)·enum 밖 decision·비-resolved.
      { runId: RUN, nodeId: null, kind: "captcha", state: "resolved", result: { decision: "approve" } },
      { runId: RUN, nodeId: "no_result", kind: "approval", state: "resolved", result: null },
      { runId: RUN, nodeId: "malformed", kind: "approval", state: "resolved", result: { reason: "no decision field" } },
      { runId: RUN, nodeId: "bad_enum", kind: "approval", state: "resolved", result: { decision: "bogus" } },
      { runId: RUN, nodeId: "open_node", kind: "approval", state: "open", result: { decision: "approve" } },
      // 다중 cycle 최신 권위: 같은 node_id, resolved_at 이른 것(correct) → 늦은 것(retry)으로 덮어씀.
      { runId: RUN, nodeId: "loop_node", kind: "validation", state: "resolved", result: { decision: "retry" }, resolvedAt: "2026-06-25T02:00:00Z" },
      { runId: RUN, nodeId: "loop_node", kind: "validation", state: "resolved", result: { decision: "correct" }, resolvedAt: "2026-06-25T01:00:00Z" },
      // 최신 해소가 malformed(decision 부재)면 이전 사이클 유효값으로 폴백 금지(latest-wins) — 미투영(부재) 되어야.
      { runId: RUN, nodeId: "stale_guard", kind: "validation", state: "resolved", result: { decision: "approve" }, resolvedAt: "2026-06-25T01:00:00Z" },
      { runId: RUN, nodeId: "stale_guard", kind: "validation", state: "resolved", result: { reason: "no decision" }, resolvedAt: "2026-06-25T02:00:00Z" },
      // 다른 run 격리.
      { runId: OTHER_RUN, nodeId: "approve_node", kind: "approval", state: "resolved", result: { decision: "reject" } },
    ];

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'resume-scope')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SVER, TENANT, SCEN],
      );
      for (const rid of [RUN, OTHER_RUN]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id) VALUES ($1,$2,$3,'suspended',$4)`,
          [rid, TENANT, SVER, CORR],
        );
      }
      for (const row of rows) {
        await c.query(
          `INSERT INTO human_tasks (id, tenant_id, run_id, node_id, kind, state, result, resolved_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8::timestamptz)`,
          [htId(), TENANT, row.runId, row.nodeId, row.kind, row.state, row.result === null ? null : JSON.stringify(row.result), row.resolvedAt ?? null],
        );
      }
    });

    const outputs = await loadResolvedHumanTaskNodeOutputs(pool, TENANT, RUN);

    check("approve_node 투영 decision=approve", outputs.approve_node?.decision === "approve", JSON.stringify(outputs.approve_node));
    check("approve_node correction.amount=100", outputs.approve_node?.correction?.amount === 100, JSON.stringify(outputs.approve_node));
    check("correct_node decision=correct + correction.memo", outputs.correct_node?.decision === "correct" && outputs.correct_node.correction?.memo === "fixme", JSON.stringify(outputs.correct_node));
    check("decision_only decision=reject + correction 부재", outputs.decision_only?.decision === "reject" && outputs.decision_only.correction === undefined, JSON.stringify(outputs.decision_only));

    check("node_id NULL(challenge) 미투영", !("null" in outputs) && Object.values(outputs).every((o) => o !== undefined), "challenge 행은 SQL 필터로 제외");
    check("result NULL 미투영", outputs.no_result === undefined, JSON.stringify(outputs.no_result));
    check("malformed(decision 부재) 미투영", outputs.malformed === undefined, JSON.stringify(outputs.malformed));
    check("enum 밖 decision('bogus') 미투영(방어심층 재검증)", outputs.bad_enum === undefined, JSON.stringify(outputs.bad_enum));
    check("open(비-resolved) 미투영", outputs.open_node === undefined, JSON.stringify(outputs.open_node));

    check("loop_node 다중 cycle 최신 권위 = retry(resolved_at 정렬 기준, 배열 순서 무관)", outputs.loop_node?.decision === "retry", JSON.stringify(outputs.loop_node));
    check("stale_guard 최신 malformed → 이전 유효(approve) 폴백 금지(미투영)", outputs.stale_guard === undefined, JSON.stringify(outputs.stale_guard));

    check("다른 run 격리(approve_node 는 RUN 의 approve, OTHER_RUN 의 reject 아님)", outputs.approve_node?.decision === "approve", JSON.stringify(outputs.approve_node));
    const keyCount = Object.keys(outputs).length;
    check("투영 키 = {approve_node, correct_node, decision_only, loop_node} 4개(stale_guard 제외)", keyCount === 4, `keys=${Object.keys(outputs).join(",")}`);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: human-task resume scope — 해소 @human_task → node.<id>.decision/correction 투영(스킵/최신권위/run격리) (C3)");
  process.exit(0);
}

main().catch((e) => {
  console.error("human-task-resume-scope int fatal:", e);
  process.exit(1);
});
