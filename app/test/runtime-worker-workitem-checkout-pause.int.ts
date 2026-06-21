/**
 * runtime-worker W9/W11 workitem checkout pause/resume (하드닝 #7). 실 PostgreSQL.
 *
 * run 이 suspend 하면 연결 workitem 의 checkout timer 를 pause(W9, checkout_paused_at 설정)해야, suspend(human_task ≤30m)
 * 동안 checkout(10m)이 만료돼 W6/W7 sweeper 가 회수/abandon 하는 오발을 막는다. resume(→running) 시 timer resume(W11,
 * 잔여 TTL 부터). 종전엔 checkout_paused_at 을 어디서도 쓰지 않아 sweeper 의 paused 가드가 dead 였고 suspend 중 workitem 이
 * spurious 회수됐다.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-workitem-checkout-pause.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin, PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { ResumeTokenEnvelope, SessionRestoreResult, SessionRestorer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_wi_pause_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000e1";
const SITE = "40000000-0000-0000-0000-000000002001";
const IDENTITY = "40000000-0000-0000-0000-000000002002";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000002003";
const SCEN = "70000000-0000-0000-0000-000000002001";
const SVER = "70000000-0000-0000-0000-000000002002";
const RUN_WI = "71000000-0000-0000-0000-000000002001";
const WI = "72000000-0000-0000-0000-000000002001";
const CORRELATION = "20000000-0000-0000-0000-000000002001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
const suspendingExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    return { stepId, action: "navigate", status: "suspended", challenge: { type: "captcha", detectedBy: "dom", confidence: 1 }, pageStateBefore: "ref", pageStateAfter: "ps", artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: now, endedAt: now, durationMs: 0 } };
  },
  async verify() {
    throw new Error("verify not used");
  },
};
const fakeSecretStore: SecretStore = { resolve: async () => JSON.stringify({ kid: "kid-test", key: "wi-pause-key" }) as unknown as PlainSecret };
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);
const restorer: SessionRestorer = { async restoreSession(input): Promise<SessionRestoreResult> { return { kind: "restored", pageStateRef: input.expectedPageStateRef }; } };

const scenarioIr = {
  meta: { name: "wi-pause-test", version: 1 },
  start: "open",
  nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } },
};

async function workitem(pool: ReturnType<typeof createPool>): Promise<{ status: string; paused: Date | null; expires: Date | null }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string; checkout_paused_at: Date | null; checkout_expires_at: Date | null }>(
      `SELECT status, checkout_paused_at, checkout_expires_at FROM workitems WHERE id=$1::uuid`,
      [WI],
    );
    const row = r.rows[0];
    return { status: row?.status ?? "missing", paused: row?.checkout_paused_at ?? null, expires: row?.checkout_expires_at ?? null };
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
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'wi-pause')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      // 체크아웃된 workitem(processing) — checkout 만료는 미래(아직 안 만료), pause 안 됨.
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checked_out_by, checkout_expires_at)
         VALUES ($1,$2,'sw','wi-pause-ref','processing',0,$3::uuid, now() + interval '1 hour')`,
        [WI, TENANT, WORKER],
      );
      // run 은 이 workitem 에 연결.
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, workitem_id, params)
         VALUES ($1,$2,$3,'queued',$4,$5::uuid,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
        [RUN_WI, TENANT, SVER, CORRELATION, WI],
      );
    });

    const claimWorker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
      allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer,
      executorFactory: () => suspendingExecutor,
      suspensionPort,
      resumeTokenCodec,
    });

    // 1) claim → drive → suspend → W9(연결 workitem checkout timer pause).
    await claimWorker.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_WI as RunId, correlationId: CORRELATION as CorrelationId });
    let w = await workitem(pool);
    check("suspend → run suspended", await runStatus(pool) === "suspended", String(await runStatus(pool)));
    check("W9: 연결 workitem checkout_paused_at 설정됨(#7)", w.paused !== null, JSON.stringify(w));

    // 2) suspend 중 checkout 만료 모사 → sweeper 가 paused workitem 을 회수하지 않음.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`UPDATE workitems SET checkout_expires_at = now() - interval '1 hour' WHERE id=$1::uuid`, [WI]);
    });
    await claimWorker.handle({ kind: "workitem_checkout_sweeper", tenantId: TENANT as TenantId, correlationId: CORRELATION as CorrelationId });
    w = await workitem(pool);
    check("sweeper: paused workitem 회수 안 함(processing 유지, #7)", w.status === "processing", JSON.stringify(w));
    const beforeResume = w.expires; // resume 전 만료(W11 이 pause 구간만큼 연장하는지 비교 기준).

    // 3) resume(→running) → W11(checkout timer resume: paused 해제 + 만료 연장). sessionProvider 미주입 → R18 후 구동 안 함.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`UPDATE runs SET status='resume_requested', updated_at=now() WHERE id=$1::uuid AND status='suspended'`, [RUN_WI]);
    });
    const resumeWorker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      sessionRestorer: restorer,
    });
    await resumeWorker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_WI as RunId, correlationId: CORRELATION as CorrelationId });
    check("resume → run running(R18, 미구동)", await runStatus(pool) === "running", String(await runStatus(pool)));
    w = await workitem(pool);
    check("W11: 연결 workitem checkout_paused_at 해제됨(#7)", w.paused === null, JSON.stringify(w));
    check(
      "W11: checkout_expires_at 가 pause 구간만큼 연장됨(잔여 TTL 재개, #7)",
      w.expires !== null && beforeResume !== null && w.expires.getTime() > beforeResume.getTime(),
      `before=${String(beforeResume)} after=${String(w.expires)}`,
    );
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker W9/W11 workitem checkout pause/resume — suspend 중 회수 오발 방지(#7)");
  process.exit(0);
}

async function runStatus(pool: ReturnType<typeof createPool>): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_WI]);
    return r.rows[0]?.status ?? null;
  });
}

main().catch((e) => {
  console.error("runtime-worker-workitem-checkout-pause int fatal:", e);
  process.exit(1);
});
