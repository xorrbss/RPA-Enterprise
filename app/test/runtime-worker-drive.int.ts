/**
 * runtime-worker run-drive 통합 (A.1 step4). 실 PostgreSQL.
 *
 * handleRunClaim 이 browserSessionProvider 주입 시 queued run 을 claim 후 driveClaimedRun 으로 구동해 completed
 * 까지 가는지 검증한다. test_fake BrowserSessionProvider(무-Chrome)로 실 UtilityExecutor + SitePageStateResolver 를
 * 빌드 → navigate→terminal success 시나리오를 구동. provider 미주입 시 claimed 까지만(기존 동작 회귀). test_fake 는
 * allowTestBrowserSessionProvider opt-in 없이는 fail-closed throw.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-drive.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_drive_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9a000000-0000-0000-0000-0000000000a1";
const SITE = "40000000-0000-0000-0000-0000000000e1";
const IDENTITY = "40000000-0000-0000-0000-0000000000e2";
const NETWORK_POLICY = "40000000-0000-0000-0000-0000000000e3";
// 회귀 run(미구동)은 별도 site/identity — drive run 의 lease 와 충돌(SESSION_LOCKED) 방지.
// (drive 완료 시 세션은 release 되나 DB lease drain 은 Phase 1 범위 밖 → TTL/sweeper 회수. 동일 identity 면 즉시 재-claim 불가.)
const SITE2 = "40000000-0000-0000-0000-0000000000e4";
const IDENTITY2 = "40000000-0000-0000-0000-0000000000e5";
const SCEN = "70000000-0000-0000-0000-0000000000e1";
const SVER = "70000000-0000-0000-0000-0000000000e2";
const RUN_DRIVE = "71000000-0000-0000-0000-0000000000e1";
const RUN_NODRIVE = "71000000-0000-0000-0000-0000000000e2";
const CORRELATION = "20000000-0000-0000-0000-0000000000e1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async (_client, input) =>
  input.runId === RUN_NODRIVE
    ? { siteProfileId: SITE2, browserIdentityId: IDENTITY2, networkPolicyId: NETWORK_POLICY }
    : { siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY };

// navigate → next → terminal success. on[]/observe 없음 → pageState 해소 불요(FakeCdpSession no-op goto 로 충분).
const scenarioIr = {
  meta: { name: "drive-worker-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
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
      // workers 는 tenantless → raw 연결로 시드(search_path 는 pool options).
      await setup.query(
        `INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`,
        [WORKER],
      );
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles (ajv→IREL→V1–V11)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok2','https://ok2.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE2, TENANT],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1,$2,$3,'ok'), ($4,$2,$5,'ok2')`,
        [IDENTITY, TENANT, SITE, IDENTITY2, SITE2],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'drive')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      for (const rid of [RUN_DRIVE, RUN_NODRIVE]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
           VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
          [rid, TENANT, SVER, CORRELATION],
        );
      }
    });

    // 1) provider 주입 → claim 후 driveClaimedRun 으로 completed + 세션 release(close).
    let driveSession: FakeCdpSession | null = null;
    const sessionProvider = new TestFakeBrowserSessionProvider({
      makeSession: (downloadDir) => {
        driveSession = new FakeCdpSession(downloadDir);
        return driveSession;
      },
    });
    const driving = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: sessionProvider,
      allowTestBrowserSessionProvider: true,
    });
    const driven = await driving.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_DRIVE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim+drive → job completed", driven.kind === "completed", JSON.stringify(driven));
    check("DB runs.status = completed (driven to terminal)", (await runStatus(pool, RUN_DRIVE)) === "completed", String(await runStatus(pool, RUN_DRIVE)));
    check("세션 release(close) 호출됨", driveSession !== null && (driveSession as FakeCdpSession).closeCalls === 1, `closeCalls=${driveSession === null ? "no-session" : (driveSession as FakeCdpSession).closeCalls}`);

    // 2) provider 미주입 → claimed 까지만(회귀: 기존 동작 보존, 구동 안 함).
    const claimOnly = new PgRuntimeWorker(pool, { workerId: WORKER, browserLeasePlanResolver: planResolver });
    const claimed = await claimOnly.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_NODRIVE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim (provider 미주입) → job completed", claimed.kind === "completed", JSON.stringify(claimed));
    check("DB runs.status = claimed (미구동, 기존 동작)", (await runStatus(pool, RUN_NODRIVE)) === "claimed", String(await runStatus(pool, RUN_NODRIVE)));

    // 3) test_fake provider 를 opt-in 없이 주입 → fail-closed throw(gateBrowserSessionProvider, claim 전).
    const ungated = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
    });
    const gateErr = await caught(
      ungated.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_NODRIVE as RunId, correlationId: CORRELATION as CorrelationId }),
    );
    check("test_fake without allowTest opt-in → fail-closed throw", gateErr instanceof Error, String(gateErr));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker run-drive — queued→(claim)→driveClaimedRun→completed (A.1 step4)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-drive int fatal:", e);
  process.exit(1);
});
