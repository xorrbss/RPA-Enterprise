/**
 * run-step-driver 인터프리터 예외 loud-log 회귀 (하드닝 #4). 실 PostgreSQL.
 *
 * driveScenario 는 runScenario(인터프리터) 예외를 systemFailureOutcome 으로 흡수한다(run→failed_system). 종전엔
 * `catch { ... }`(빈 바인딩)이라 예외를 **조용히 묻어** 분류·코드·메시지가 유실됐다 — 파일 헤더의 '조용한 false/unknown
 * 금지'(system=loud 채널) 규율 위반. 수정: catch 가 예외를 console.error 로 표면화(InterpreterError 면 code 포함).
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-interpreter-loud-log.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin } from "../../ts/core-types";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_loudlog_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000d1";
const SITE = "40000000-0000-0000-0000-000000001001";
const IDENTITY = "40000000-0000-0000-0000-000000001002";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000001003";
const SCEN = "70000000-0000-0000-0000-000000001001";
const SVER = "70000000-0000-0000-0000-000000001002";
const RUN_BOOM = "71000000-0000-0000-0000-000000001001";
const CORRELATION = "20000000-0000-0000-0000-000000001001";
const EXPECTED_CODE = "EXECUTOR_STATUS_UNSUPPORTED";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
// executor 가 미지원 status('uncertain')를 반환 → 인터프리터가 InterpreterError("EXECUTOR_STATUS_UNSUPPORTED") throw →
// runScenario 밖으로 전파 → driveScenario 의 runScenario catch(흡수). 종전엔 이 catch 가 조용했다(예외 code/메시지 유실).
const unsupportedExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    return {
      stepId,
      action: "navigate",
      status: "uncertain",
      pageStateBefore: "ref",
      pageStateAfter: "ps",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in loud-log int");
  },
};

const scenarioIr = {
  meta: { name: "loudlog-test", version: 1 },
  start: "open",
  nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } },
};

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
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
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`, [WORKER]);
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'loudlog')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
         VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
        [RUN_BOOM, TENANT, SVER, CORRELATION],
      );
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
      allowTestBrowserSessionProvider: true,
      executorFactory: () => unsupportedExecutor,
    });

    // console.error 캡처(인터프리터 흡수 로그 검증).
    const captured: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      await worker.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_BOOM as RunId, correlationId: CORRELATION as CorrelationId });
    } finally {
      console.error = orig;
    }

    check("인터프리터 예외 흡수 → run failed_system", (await runStatus(pool, RUN_BOOM)) === "failed_system", String(await runStatus(pool, RUN_BOOM)));
    const loud = captured.find((l) => l.includes("인터프리터 예외를 failed_system 으로 흡수"));
    check("인터프리터 예외가 loud-log 로 표면화됨 (#4, 조용한 흡수 아님)", loud !== undefined, captured.join(" | ").slice(0, 200));
    check("loud-log 에 InterpreterError code 포함(분류·디버깅 신호 보존, #4 핵심)", loud !== undefined && loud.includes(EXPECTED_CODE), String(loud));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run-step-driver 인터프리터 예외 loud-log — 조용한 흡수 제거(#4)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-interpreter-loud-log int fatal:", e);
  process.exit(1);
});
