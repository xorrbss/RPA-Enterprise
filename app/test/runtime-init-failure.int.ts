/**
 * INIT R3a/R3b 통합 (state-machine.md §1 INIT 규칙). 실 PostgreSQL.
 *
 * claimed→running 셋업(Phase B: 세션 bind)이 실패하면 좀비 claimed 잔류 대신 init_failed 로 R3a/R3b 분기되는지 검증:
 *   - 연속 실패 < 임계 → R3a: queued 재큐(consecutive_init_failures+1·attempts+1·백오프 재인큐) + 브라우저 lease 해제.
 *   - 임계 이상 → R3b: failed_system + 연결 workitem system 정산(W5 abandoned+dead_letter) + run.failed_system. openCircuit 보류.
 *   - R2(INIT 성공) 시 consecutive_init_failures reset. queued 에서 init_failed 는 IllegalTransition(음성).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-init-failure.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RuntimeWorkerJob } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import type { BrowserSessionProvider } from "../src/executor/browser-session-provider";
import { applyRunTransition } from "../src/runtime/run-transition";
import { handleClaimedInitFailure } from "../src/runtime/run-init-failure";
import type { RuntimeJobEnqueuePort } from "../src/runtime/executor-ports";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_init_failure_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1";
const WORKER = "9c000000-0000-0000-0000-0000000000c1";
const SITE_A = "4c000000-0000-0000-0000-0000000000a1";
const IDENT_A = "4c000000-0000-0000-0000-0000000000a2";
const SITE_B = "4c000000-0000-0000-0000-0000000000b1";
const IDENT_B = "4c000000-0000-0000-0000-0000000000b2";
const NETWORK = "4c000000-0000-0000-0000-0000000000f3";
const SCEN = "7c000000-0000-0000-0000-0000000000e1";
const SVER = "7c000000-0000-0000-0000-0000000000e2";
const RUN_CYCLE = "7c000000-0000-0000-0000-000000000c01"; // R3a→R3b 사이클(no workitem)
const RUN_WI = "7c000000-0000-0000-0000-000000000c02"; // R3b + workitem 정산
const RUN_RESET = "7c000000-0000-0000-0000-000000000c03"; // R2 reset(직접 전이)
const RUN_ILLEGAL = "7c000000-0000-0000-0000-000000000c04"; // queued+init_failed=IllegalTransition
const RUN_NEG = "7c000000-0000-0000-0000-000000000c05"; // 비-claimed 핸들러 가드
const RUN_NOENQ = "7c000000-0000-0000-0000-000000000c06"; // 적대리뷰 B2: enqueuer 미주입 → R3b 강등
const WORKITEM = "7c000000-0000-0000-0000-000000000c11";
const CORR = "20000000-0000-0000-0000-0000000000c1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// bind 가 throw 하는 test_fake provider → INIT(Phase B) 실패 유발.
const throwingProvider: BrowserSessionProvider = {
  binding: { kind: "test_fake" },
  async bind() {
    throw new Error("INIT bind failure (test)");
  },
};

const planResolver: BrowserLeasePlanResolver = async (_client, input) =>
  input.runId === RUN_WI
    ? { siteProfileId: SITE_B, browserIdentityId: IDENT_B, networkPolicyId: NETWORK }
    : { siteProfileId: SITE_A, browserIdentityId: IDENT_A, networkPolicyId: NETWORK };

const scenarioIr = {
  meta: { name: "init-fail-test", version: 1 },
  start: "open",
  nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } },
};

async function runRow(pool: ReturnType<typeof createPool>, runId: string): Promise<{ status: string; attempts: number; cif: number } | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string; attempts: number; consecutive_init_failures: number }>(
      `SELECT status, attempts, consecutive_init_failures FROM runs WHERE id=$1::uuid`,
      [runId],
    );
    const row = r.rows[0];
    return row === undefined ? null : { status: row.status, attempts: row.attempts, cif: row.consecutive_init_failures };
  });
}

// run 당 browser_lease 행 수 — abort claimAbortBrowserLeaseForRun(run_id별 LIMIT 2→multiple) 불변식 검증용(적대리뷰 B1).
async function leaseCountForRun(pool: ReturnType<typeof createPool>, runId: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM browser_leases WHERE run_id=$1::uuid`, [runId]);
    return r.rows[0]?.n ?? 0;
  });
}

async function leaseStates(pool: ReturnType<typeof createPool>, siteProfileId: string): Promise<readonly string[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ state: string }>(
      `SELECT state FROM browser_leases WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid ORDER BY expires_at`,
      [TENANT, siteProfileId],
    );
    return r.rows.map((row) => row.state);
  });
}

async function runEventTypes(pool: ReturnType<typeof createPool>, runId: string): Promise<readonly string[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ event_type: string }>(
      `SELECT event_type FROM events_outbox WHERE run_id=$1::uuid ORDER BY event_type`,
      [runId],
    );
    return r.rows.map((row) => row.event_type);
  });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
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
      for (const [site, ident, label] of [
        [SITE_A, IDENT_A, "a"],
        [SITE_B, IDENT_B, "b"],
      ] as const) {
        await c.query(
          `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
           VALUES ($1,$2,$3,$4,'green',true,'{"flags":{}}'::jsonb)`,
          [site, TENANT, `site-${label}`, `https://${label}.example/*`],
        );
        await c.query(
          `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,$4,1)`,
          [ident, TENANT, site, `id-${label}`],
        );
      }
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['a.example','b.example'])`, [NETWORK, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'init-fail')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      for (const rid of [RUN_CYCLE, RUN_ILLEGAL, RUN_NEG, RUN_NOENQ]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
           VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://a.example/x"}'::jsonb)`,
          [rid, TENANT, SVER, CORR],
        );
      }
      // RESET 검증용: 이미 claimed + consecutive_init_failures=2(R3a 2회 후 가정).
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, worker_id, status, correlation_id, consecutive_init_failures, attempts, params)
         VALUES ($1,$2,$3,$4,'claimed',$5,2,2,'{"entry_url":"https://a.example/x"}'::jsonb)`,
        [RUN_RESET, TENANT, SVER, WORKER, CORR],
      );
      // R3b + workitem 정산: workitem processing attempts=2(max 3) → system 정산 시 W5 abandoned + dead_letter(run_id).
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
         VALUES ($1,$2,'init-fail','wi-1','processing',2)`,
        [WORKITEM, TENANT],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id, params)
         VALUES ($1,$2,$3,$4,'queued',$5,'{"entry_url":"https://b.example/x"}'::jsonb)`,
        [RUN_WI, TENANT, SVER, WORKITEM, CORR],
      );
    });

    // ===== 1) R3a (threshold=2): 1차 init 실패 → queued 재큐 + counter/attempts+1 + 백오프 재인큐 + lease 해제 =====
    const enqA: { job: RuntimeWorkerJob; delayMs?: number }[] = [];
    const fakeEnqueuer: RuntimeJobEnqueuePort = {
      async enqueueRuntimeJob(_client, job, delayMs) {
        enqA.push({ job, delayMs });
      },
    };
    const workerA = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: throwingProvider,
      allowTestBrowserSessionProvider: true,
      runtimeJobEnqueuer: fakeEnqueuer,
      initFailThreshold: 2,
      initBackoff: { baseMs: 10, factor: 2, maxMs: 50 },
      initBackoffJitter: () => 1, // 결정적
    });

    const r1 = await workerA.handle({ kind: "run_claim", tenantId: TENANT as RuntimeWorkerJob["tenantId"], runId: RUN_CYCLE as RuntimeWorkerJob["runId"], correlationId: CORR as RuntimeWorkerJob["correlationId"] });
    check("R3a: run_claim 잡 완료(claim 성공·init 실패 처리)", r1.kind === "completed", JSON.stringify(r1));
    const cyc1 = await runRow(pool, RUN_CYCLE);
    check("R3a: status=queued(재큐)", cyc1?.status === "queued", JSON.stringify(cyc1));
    check("R3a: consecutive_init_failures=1", cyc1?.cif === 1, JSON.stringify(cyc1));
    check("R3a: attempts=1(requeue)", cyc1?.attempts === 1, JSON.stringify(cyc1));
    check("R3a: run_claim 재인큐 1회 + 백오프 delay(base 10·factor^0=10ms)", enqA.length === 1 && enqA[0]?.job.kind === "run_claim" && enqA[0]?.delayMs === 10, JSON.stringify(enqA));
    // 적대리뷰 B1: init 실패 lease 는 drain('draining' 누적)이 아니라 행 삭제 → run 당 lease 0(재-claim 신규 1행만 → abort 'multiple' wedge 예방).
    check("R3a: init 실패 lease 행 삭제(run당 lease 0 — abort-wedge/누수 예방)", (await leaseCountForRun(pool, RUN_CYCLE)) === 0, JSON.stringify(await leaseStates(pool, SITE_A)));

    // ===== 2) R3b (2차 init 실패, 임계 도달): failed_system + run.failed_system, 추가 재인큐 없음 =====
    const enqBefore = enqA.length;
    const r2 = await workerA.handle({ kind: "run_claim", tenantId: TENANT as RuntimeWorkerJob["tenantId"], runId: RUN_CYCLE as RuntimeWorkerJob["runId"], correlationId: CORR as RuntimeWorkerJob["correlationId"] });
    check("R3b: run_claim 잡 완료", r2.kind === "completed", JSON.stringify(r2));
    const cyc2 = await runRow(pool, RUN_CYCLE);
    check("R3b: status=failed_system(종결)", cyc2?.status === "failed_system", JSON.stringify(cyc2));
    check("R3b: run.failed_system 이벤트 발행", (await runEventTypes(pool, RUN_CYCLE)).includes("run.failed_system"), JSON.stringify(await runEventTypes(pool, RUN_CYCLE)));
    check("R3b: 추가 재인큐 없음(더 이상 재큐 안 함)", enqA.length === enqBefore, JSON.stringify(enqA));
    // 적대리뷰 B1 불변식: R3a→재-claim→R3b 사이클 후에도 run당 lease ≤1(누적 0). abort 의 'multiple' wedge 원천 차단.
    check("B1: 사이클 후 run당 browser_lease ≤1(abort-wedge 예방)", (await leaseCountForRun(pool, RUN_CYCLE)) <= 1, String(await leaseCountForRun(pool, RUN_CYCLE)));

    // ===== 3) R3b + workitem 정산(threshold=1, 즉시 R3b): failed_system + workitem abandoned + dead_letter(run_id) =====
    const workerB = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: throwingProvider,
      allowTestBrowserSessionProvider: true,
      runtimeJobEnqueuer: fakeEnqueuer,
      initFailThreshold: 1, // 1차 실패에서 바로 R3b
      initBackoff: { baseMs: 10, factor: 2, maxMs: 50 },
      initBackoffJitter: () => 1,
    });
    const r3 = await workerB.handle({ kind: "run_claim", tenantId: TENANT as RuntimeWorkerJob["tenantId"], runId: RUN_WI as RuntimeWorkerJob["runId"], correlationId: CORR as RuntimeWorkerJob["correlationId"] });
    check("R3b(wi): run_claim 잡 완료", r3.kind === "completed", JSON.stringify(r3));
    const wiRun = await runRow(pool, RUN_WI);
    check("R3b(wi): run status=failed_system", wiRun?.status === "failed_system", JSON.stringify(wiRun));
    const wiStatus = await withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM workitems WHERE id=$1::uuid`, [WORKITEM])).rows[0]?.status ?? null);
    check("R3b(wi): 연결 workitem system 정산 → abandoned(attempts=2, max 3 소진)", wiStatus === "abandoned", String(wiStatus));
    const dlq = await withTenantTx(pool, TENANT, async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM dead_letter WHERE workitem_id=$1::uuid AND run_id=$2::uuid`, [WORKITEM, RUN_WI])).rows[0]?.n ?? 0);
    check("R3b(wi): dead_letter 생성(W5, run_id 포함 — evaluateDeadLetter 충족)", dlq === 1, String(dlq));

    // ===== 4) R2 reset: claimed(cif=2) + run.started(initOk) → running + consecutive_init_failures=0 =====
    await withTenantTx(pool, TENANT, async (c) => {
      const t = await applyRunTransition(c, {
        tenantId: TENANT, runId: RUN_RESET, fromStatus: "claimed",
        event: { type: "run.started" }, guard: { initOk: true }, correlationId: CORR,
      });
      check("R2: 전이 적용(claimed→running)", t.applied && t.next === "running", JSON.stringify(t));
    });
    const reset = await runRow(pool, RUN_RESET);
    check("R2: consecutive_init_failures reset=0(INIT 성공)", reset?.cif === 0, JSON.stringify(reset));

    // ===== 5) 음성: queued 에서 init_failed = IllegalTransition(claimed 한정 — 발명/조용한 false 금지) =====
    const illegal = await withTenantTx(pool, TENANT, (c) =>
      caught(
        applyRunTransition(c, {
          tenantId: TENANT, runId: RUN_ILLEGAL, fromStatus: "queued",
          event: { type: "init_failed" }, guard: { initFailBelowThreshold: true }, correlationId: CORR,
        }),
      ),
    );
    check("음성: applyRunTransition(queued, init_failed) → throw(IllegalTransition)", illegal instanceof Error, String(illegal));
    const illegalRow = await runRow(pool, RUN_ILLEGAL);
    check("음성: queued run 상태 불변", illegalRow?.status === "queued" && illegalRow?.cif === 0, JSON.stringify(illegalRow));

    // ===== 6) 핸들러 가드: 비-claimed(queued) 면 init_failed 미적용(null) + 전이 없음 =====
    const neg = await handleClaimedInitFailure(
      { pool, initFailThreshold: 2 },
      {
        tenantId: TENANT, runId: RUN_NEG, correlationId: CORR,
        drainLease: async () => {},
        canRequeue: true,
        reenqueueRunClaim: async () => {},
      },
    );
    check("가드: 비-claimed run → null(미적용)", neg === null, String(neg));
    const negRow = await runRow(pool, RUN_NEG);
    check("가드: queued run 상태/카운터 불변", negRow?.status === "queued" && negRow?.cif === 0, JSON.stringify(negRow));

    // ===== 7) 적대리뷰 B2: 재큐 enqueuer 미주입(canRequeue=false) → 임계 미만이어도 R3b 강등(좀비 claimed 금지) =====
    const workerNoEnq = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: throwingProvider,
      allowTestBrowserSessionProvider: true,
      // runtimeJobEnqueuer 미주입 → canRequeue=false
      initFailThreshold: 3, // 임계 미만(1<3)이지만 재큐 불가라 R3b 강등돼야 함
      initBackoffJitter: () => 1,
    });
    const r7 = await workerNoEnq.handle({ kind: "run_claim", tenantId: TENANT as RuntimeWorkerJob["tenantId"], runId: RUN_NOENQ as RuntimeWorkerJob["runId"], correlationId: CORR as RuntimeWorkerJob["correlationId"] });
    check("B2: enqueuer 미주입 init 실패 → 잡 완료(throw/롤백 없음)", r7.kind === "completed", JSON.stringify(r7));
    const noenq = await runRow(pool, RUN_NOENQ);
    check("B2: 임계 미만이어도 R3b 강등 → failed_system(좀비 claimed 금지)", noenq?.status === "failed_system", JSON.stringify(noenq));
    check("B2: init 실패 lease 행 삭제(누수 0)", (await leaseCountForRun(pool, RUN_NOENQ)) === 0, String(await leaseCountForRun(pool, RUN_NOENQ)));

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: INIT R3a/R3b integration green");
    process.exit(0);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
