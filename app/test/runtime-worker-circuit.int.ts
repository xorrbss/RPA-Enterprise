/**
 * worker 서킷(ops-defaults §3 worker.circuit) 통합 — R3b openCircuit=worker 결정(state-machine §1). 실 PostgreSQL.
 *
 * per-worker 연속 INIT 실패 누적(workers.consecutive_init_failures)이 임계(worker.circuit.consecutive_failures) 도달 시
 * circuit open(워커 격리: acquireBrowserLease lease 거부) → cooldown(circuit_until) 경과 후 claim 은 프로브로 허용(게이트
 * read-only) → 프로브 성공 N회(close 임계)면 half_open→closed, 프로브 실패면 open 재진입. R3b per-run 직결 안 함(과잉격리 회피).
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-circuit.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RuntimeWorkerJob } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import type { BrowserSessionProvider } from "../src/executor/browser-session-provider";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { UtilityExecutor } from "../src/executor/utility-executor";
import type { RuntimeJobEnqueuePort } from "../src/runtime/executor-ports";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_worker_circuit_int";
const TENANT = "00000000-0000-0000-0000-0000000000d1";
const WORKER = "9d000000-0000-0000-0000-0000000000d1";
const SITE_F = "4d000000-0000-0000-0000-0000000000f1"; // INIT 실패 run 용
const IDENT_F = "4d000000-0000-0000-0000-0000000000f2";
// 성공 프로브/리셋 run 용(각자 site — 구동 완료 후 lease active 잔류라 SESSION_LOCKED 회피).
const SITE_S = "4d000000-0000-0000-0000-0000000000a1";
const IDENT_S = "4d000000-0000-0000-0000-0000000000a2";
const SITE_S2 = "4d000000-0000-0000-0000-0000000000b1";
const IDENT_S2 = "4d000000-0000-0000-0000-0000000000b2";
const SITE_S3 = "4d000000-0000-0000-0000-0000000000c1";
const IDENT_S3 = "4d000000-0000-0000-0000-0000000000c2";
const NETWORK = "4d000000-0000-0000-0000-0000000000e3";
const SCEN = "7d000000-0000-0000-0000-0000000000e1";
const SVER = "7d000000-0000-0000-0000-0000000000e2";
const RUN_F1 = "7d000000-0000-0000-0000-000000000f01";
const RUN_F2 = "7d000000-0000-0000-0000-000000000f02";
const RUN_F3 = "7d000000-0000-0000-0000-000000000f03";
const RUN_S = "7d000000-0000-0000-0000-000000000501"; // half_open 프로브 성공 1
const RUN_S2 = "7d000000-0000-0000-0000-000000000502"; // half_open 프로브 성공 2 → close
const RUN_S3 = "7d000000-0000-0000-0000-000000000503"; // closed INIT 성공 → cif reset
const CORR = "20000000-0000-0000-0000-0000000000d1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const throwingProvider: BrowserSessionProvider = {
  binding: { kind: "test_fake" },
  async bind() {
    throw new Error("INIT bind failure (test)");
  },
};

const SUCCESS_SITE: Record<string, { site: string; ident: string }> = {
  [RUN_S]: { site: SITE_S, ident: IDENT_S },
  [RUN_S2]: { site: SITE_S2, ident: IDENT_S2 },
  [RUN_S3]: { site: SITE_S3, ident: IDENT_S3 },
};
const planResolver: BrowserLeasePlanResolver = async (_client, input) => {
  const s = SUCCESS_SITE[input.runId];
  return s !== undefined
    ? { siteProfileId: s.site, browserIdentityId: s.ident, networkPolicyId: NETWORK }
    : { siteProfileId: SITE_F, browserIdentityId: IDENT_F, networkPolicyId: NETWORK };
};

const scenarioIr = {
  meta: { name: "worker-circuit-test", version: 1 },
  start: "open",
  nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } },
};

const noopEnqueuer: RuntimeJobEnqueuePort = { async enqueueRuntimeJob() {} };

async function worker(pool: ReturnType<typeof createPool>): Promise<{ state: string; cif: number; hos: number; until_set: boolean }> {
  const r = await pool.query<{ circuit_state: string; consecutive_init_failures: number; half_open_successes: number; until_set: boolean }>(
    `SELECT circuit_state, consecutive_init_failures, half_open_successes, (circuit_until IS NOT NULL) AS until_set FROM workers WHERE id=$1::uuid`,
    [WORKER],
  );
  const row = r.rows[0];
  return { state: row?.circuit_state ?? "?", cif: row?.consecutive_init_failures ?? -1, hos: row?.half_open_successes ?? -1, until_set: row?.until_set ?? false };
}

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId])).rows[0]?.status ?? null);
}

function claimJob(runId: string): RuntimeWorkerJob {
  return { kind: "run_claim", tenantId: TENANT as RuntimeWorkerJob["tenantId"], runId: runId as RuntimeWorkerJob["runId"], correlationId: CORR as RuntimeWorkerJob["correlationId"] };
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
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`, [WORKER]);
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      for (const [site, ident, label] of [[SITE_F, IDENT_F, "f"], [SITE_S, IDENT_S, "s"], [SITE_S2, IDENT_S2, "s2"], [SITE_S3, IDENT_S3, "s3"]] as const) {
        await c.query(
          `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
           VALUES ($1,$2,$3,$4,'green',true,'{"flags":{}}'::jsonb)`,
          [site, TENANT, `site-${label}`, `https://${label}.example/*`],
        );
        await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,$4,1)`, [ident, TENANT, site, `id-${label}`]);
      }
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['f.example','s.example','s2.example','s3.example'])`, [NETWORK, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'wc')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      for (const [rid, url] of [[RUN_F1, "f"], [RUN_F2, "f"], [RUN_F3, "f"], [RUN_S, "s"], [RUN_S2, "s2"], [RUN_S3, "s3"]] as const) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
           VALUES ($1,$2,$3,'queued',$4,$5::jsonb)`,
          [rid, TENANT, SVER, CORR, JSON.stringify({ entry_url: `https://${url}.example/x` })],
        );
      }
    });

    // ===== 1) per-worker 누적 → 임계(2) 도달 시 circuit open =====
    // initFailThreshold(run-level)=5 로 둬서 run 은 R3a 재큐(종결 안 함), worker 누적이 회로를 연다.
    const workerA = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: throwingProvider,
      allowTestBrowserSessionProvider: true,
      runtimeJobEnqueuer: noopEnqueuer,
      initFailThreshold: 5,
      initBackoff: { baseMs: 1, factor: 2, maxMs: 5 },
      initBackoffJitter: () => 1,
      workerCircuitThreshold: 2,
      workerCircuitOpenMs: 150,
    });

    await workerA.handle(claimJob(RUN_F1));
    const w1 = await worker(pool);
    check("INIT 실패 1회 → worker 카운터=1, circuit closed(임계 미달)", w1.cif === 1 && w1.state === "closed", JSON.stringify(w1));

    await workerA.handle(claimJob(RUN_F2));
    const w2 = await worker(pool);
    check("INIT 실패 2회(임계 도달) → circuit OPEN + circuit_until 설정", w2.state === "open" && w2.cif === 2 && w2.until_set, JSON.stringify(w2));

    // ===== 2) open(cooldown 중) → 후속 claim 은 lease 거부(워커 격리, run 미claim) =====
    const f3a = await workerA.handle(claimJob(RUN_F3));
    check("circuit open 중 run_claim → 거부(failed)", f3a.kind === "failed", JSON.stringify(f3a));
    check("거부된 run 은 claim 안 됨(queued 유지)", (await runStatus(pool, RUN_F3)) === "queued", String(await runStatus(pool, RUN_F3)));
    const w3 = await worker(pool);
    check("거부는 INIT 도달 전 → 카운터 불변(2)·open 유지", w3.cif === 2 && w3.state === "open", JSON.stringify(w3));

    // ===== 3) cooldown 경과 → 프로브 허용(게이트 read-only). 프로브 실패(throwing) → open 유지+새 cooldown(시험 중 1회 실패도 재격리) =====
    await new Promise((r) => setTimeout(r, 220)); // cooldown 150ms 경과
    await workerA.handle(claimJob(RUN_F3)); // 게이트: open+경과 → 프로브 허용 → INIT 실패 → recordWorkerInitFailure: open 유지+새 cooldown
    const w4 = await worker(pool);
    check("cooldown 경과 → 프로브 실패 → open 유지+새 cooldown(cif/hos 0)", w4.state === "open" && w4.hos === 0 && w4.cif === 0 && w4.until_set, JSON.stringify(w4));

    // ===== 4) cooldown 경과 → half_open 프로브 성공 N회(close 임계 2) → closed =====
    const workerS = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider({ makeSession: (downloadDir) => new FakeCdpSession(downloadDir) }),
      allowTestBrowserSessionProvider: true,
      runtimeJobEnqueuer: noopEnqueuer,
      executorFactory: (provider) => new UtilityExecutor(provider),
      workerCircuitCloseThreshold: 2,
    });
    await new Promise((r) => setTimeout(r, 220)); // step3 재open 의 cooldown 경과
    const p1 = await workerS.handle(claimJob(RUN_S)); // open→half_open → 프로브 성공 → hos=1
    check("half_open 프로브1 성공 → 잡 완료", p1.kind === "completed", JSON.stringify(p1));
    const w5 = await worker(pool);
    check("half_open 프로브 성공 1회(<임계 2) → half_open 유지, hos=1", w5.state === "half_open" && w5.hos === 1, JSON.stringify(w5));

    const p2 = await workerS.handle(claimJob(RUN_S2)); // half_open → 프로브 성공 → hos=2 → closed
    check("half_open 프로브2 성공 → 잡 완료", p2.kind === "completed", JSON.stringify(p2));
    const w6 = await worker(pool);
    check("half_open 프로브 성공 2회(임계 도달) → closed + hos reset 0 + circuit_until 해제", w6.state === "closed" && w6.hos === 0 && !w6.until_set, JSON.stringify(w6));

    // ===== 5) closed 상태 INIT 성공 → consecutive_init_failures reset(0) (streak 종료) =====
    await pool.query(`UPDATE workers SET consecutive_init_failures=3 WHERE id=$1::uuid`, [WORKER]);
    const p3 = await workerS.handle(claimJob(RUN_S3));
    check("closed 성공 run → 잡 완료", p3.kind === "completed", JSON.stringify(p3));
    const w7 = await worker(pool);
    check("closed INIT 성공 → consecutive_init_failures reset(0)", w7.cif === 0 && w7.state === "closed", JSON.stringify(w7));

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: worker circuit integration green");
    process.exit(0);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
