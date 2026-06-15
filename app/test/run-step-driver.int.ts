/**
 * Run 실행 드라이버 통합 (D3 가동 1단계 — 증분2). 실 PostgreSQL.
 *
 * 인터프리터 ↔ DB 전이 배선을 격리 검증한다: claimed run + 시나리오(ir+compiled_ast) → driveClaimedRun →
 * run이 claimed→running→completing→completed 로 전이하는지(실 CAS + outbox). 브라우저는 증분1(ir-interpreter.int)
 * 에서 검증했으므로 여기선 결정형 fake 실행기/resolver로 DB 경로만 본다.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/run-step-driver.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExecutorPlugin, PageState, PageStateResolver } from "../../ts/core-types";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { driveClaimedRun, type ClaimedRun } from "../src/runtime/run-step-driver";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_driver_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000d1";
const SVER = "70000000-0000-0000-0000-0000000000d2";
const RUN = "71000000-0000-0000-0000-0000000000d1";
const WORKER = "9a000000-0000-0000-0000-0000000000a1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 결정형 fake 실행기: 모든 액션 success(브라우저 미사용). 본 시나리오는 navigate 1회만 호출.
const fakeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = new Date().toISOString();
    return {
      stepId,
      action: "navigate",
      status: "success",
      pageStateBefore: "ref",
      pageStateAfter: "ref",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in driver int");
  },
};

// fake resolver: reviews_visible=true → on[] 분기가 done(terminal)으로 라우팅.
const fakeResolver: PageStateResolver = {
  async resolvePageState(): Promise<PageState> {
    return {
      url: { raw: "x", canonical: "x", pattern: "x" },
      dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
      auth: "authenticated",
      flags: { not_found: false, reviews_visible: true },
      matchedWhere: [],
    };
  },
};

const scenarioIr = {
  meta: { name: "driver-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "https://example.com" }], next: "check" },
    check: {
      what: [{ action: "observe" }],
      on: [
        { when: "flags.not_found", target: "done", priority: 2 },
        { when: "flags.reviews_visible", target: "done", priority: 1 },
      ],
    },
    done: { terminal: "success" },
  },
};

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

    // 시나리오 컴파일(실 API 파이프라인) → ir + compiled_ast 캐시. 무효면 테스트 자체 실패.
    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles (ajv→IREL→V1–V11)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'driver')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      // R1을 우회해 claimed 상태로 직접 시드(드라이버는 R2부터). correlation_id=run_id.
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
         VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
        [RUN, TENANT, SVER, WORKER],
      );
    });

    const run: ClaimedRun = {
      runId: RUN,
      tenantId: TENANT,
      scenarioVersionId: SVER,
      correlationId: RUN,
      leaseId: "lease-1",
      siteProfileId: "site-1",
      browserIdentityId: "bid-1",
      networkPolicyId: "np-1",
    };
    const result = await driveClaimedRun(run, { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER });

    check("driver returns completed", result.state === "completed", result.state);
    check("interpreter visited open→check→done", result.outcome.visited.join(",") === "open,check,done", result.outcome.visited.join(","));
    check("terminal=success", result.outcome.terminal === "success", result.outcome.terminal);

    // DB 실제 상태 확인.
    const dbStatus = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; started_at: Date | null }>(
        `SELECT status, started_at FROM runs WHERE id=$1::uuid`,
        [RUN],
      );
      return r.rows[0] ?? null;
    });
    check("DB runs.status = completed", dbStatus?.status === "completed", JSON.stringify(dbStatus));
    check("R2 started_at 기록됨", dbStatus?.started_at !== null && dbStatus?.started_at !== undefined);

    // outbox 이벤트(전이별 emit) 확인.
    const events = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(
        `SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`,
        [RUN],
      );
      return r.rows.map((x) => x.event_type);
    });
    check("outbox에 run 전이 이벤트 emit됨", events.length >= 1, events.join(","));

    // 멱등 재구동: 이미 completed → claimed→running CAS 0 rows → 표면화(조용한 false 금지).
    let reDriveThrew = false;
    try {
      await driveClaimedRun(run, { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER });
    } catch {
      reDriveThrew = true;
    }
    check("이미 종료된 run 재구동 → CAS 충돌 표면화(throw)", reDriveThrew);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run 실행 드라이버 — claimed→running→completing→completed (인터프리터↔DB 전이, D3 가동 1단계 증분2)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-step-driver int fatal:", e);
  process.exit(1);
});
