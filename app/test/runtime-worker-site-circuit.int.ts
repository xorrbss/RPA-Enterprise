/**
 * 사이트 서킷(ops-defaults §3 site.circuit) 통합 — block_rate 엔진 + 전이 + 이벤트 + worker 배선. 실 PostgreSQL.
 *
 * worker 서킷(per-worker 카운터)과 달리 rolling window block_rate(blocks/total) 트리거다. 두 층을 검증한다:
 *   A) recordSiteCircuitOutcome 직접 호출(표본 시퀀스 정밀 제어) — min_samples 미달→미발동, 임계 도달→open+이벤트,
 *      cooldown 경과 프로브 성공→closed+이벤트, 프로브 차단→재open(이벤트 미발행), 진행 중 cooldown 표본 무전이, 임계 미달.
 *   B) worker 배선 — challenge 자동감지 drive→blocked=true 표본, 정상 완료 drive→blocked=false 표본, circuit open 시
 *      acquireBrowserLease 가 SITE_CIRCUIT_OPEN deferred(run queued 유지).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-site-circuit.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin, PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { UtilityExecutor } from "../src/executor/utility-executor";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { recordSiteCircuitOutcome, type SiteCircuitConfig } from "../src/runtime/site-circuit";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_site_circuit_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1";
const WORKER = "9c000000-0000-0000-0000-0000000000c1";
// Part A 사이트(직접 record): rate 엔진.
const SITE_A = "40000000-0000-0000-0000-000000000c01";
const SITE_B = "40000000-0000-0000-0000-000000000c02";
// Part B 사이트(worker 배선): SITE_W=challenge suspend, SITE_W2=정상완료+게이트.
const SITE_W = "40000000-0000-0000-0000-000000000c03";
const IDENT_W = "40000000-0000-0000-0000-000000000c04";
const SITE_W2 = "40000000-0000-0000-0000-000000000c05";
const IDENT_W2 = "40000000-0000-0000-0000-000000000c06";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000000c07";
const SCEN = "70000000-0000-0000-0000-000000000c01";
const SVER = "70000000-0000-0000-0000-000000000c02";
const RUN_SUSPEND = "71000000-0000-0000-0000-000000000c01";
const RUN_SUCCESS = "71000000-0000-0000-0000-000000000c02";
const RUN_GATE = "71000000-0000-0000-0000-000000000c03";
const CORR_SUSPEND = "20000000-0000-0000-0000-000000000c01";
const CORR_SUCCESS = "20000000-0000-0000-0000-000000000c02";
const CORR_GATE = "20000000-0000-0000-0000-000000000c03";

// 테스트 픽스처(ops-defaults §3 site.circuit 테스트 열): block_rate 50% · window 60s · min_samples 4 · open 60s.
const CFG: SiteCircuitConfig = { blockRateThreshold: 0.5, windowMs: 60_000, minSamples: 4, openMs: 60_000 };

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof createPool>;

async function circuit(pool: Pool, siteId: string): Promise<{ state: string; future: boolean; nullUntil: boolean }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ circuit_state: string; future: boolean | null; null_until: boolean }>(
      `SELECT circuit_state, (circuit_until > now()) AS future, (circuit_until IS NULL) AS null_until
         FROM site_profiles WHERE id=$1::uuid`,
      [siteId],
    );
    const row = r.rows[0];
    return { state: row?.circuit_state ?? "?", future: row?.future === true, nullUntil: row?.null_until === true };
  });
}

async function sampleCount(pool: Pool, siteId: string): Promise<{ total: number; blocked: number }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ total: string; blocked: string }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE blocked)::int AS blocked
         FROM site_block_samples WHERE site_profile_id=$1::uuid`,
      [siteId],
    );
    return { total: Number(r.rows[0]?.total ?? 0), blocked: Number(r.rows[0]?.blocked ?? 0) };
  });
}

async function eventCount(pool: Pool, siteId: string, type: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE event_type=$1 AND idempotency_key LIKE $2`,
      [type, `${type === "site.circuit_opened" ? "site-circuit-opened" : "site-circuit-closed"}:${siteId}:%`],
    );
    return Number(r.rows[0]?.n ?? 0);
  });
}

async function forceCooldownElapsed(pool: Pool, siteId: string): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(`UPDATE site_profiles SET circuit_until = now() - interval '5 seconds' WHERE id=$1::uuid`, [siteId]);
  });
}

async function rec(pool: Pool, siteId: string, correlationId: string, blocked: boolean): Promise<void> {
  await recordSiteCircuitOutcome(pool, CFG, { tenantId: TENANT, siteProfileId: siteId, correlationId, blocked });
}

const suspendingExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-20T00:00:00.000Z";
    return {
      stepId,
      action: "navigate",
      status: "suspended",
      challenge: { type: "captcha", detectedBy: "dom", confidence: 1 },
      pageStateBefore: "ref",
      pageStateAfter: "ps_suspend_after",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in site-circuit int");
  },
};

const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-test", key: "site-circuit-signing-key" }) as unknown as PlainSecret,
};
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);

const planResolver: BrowserLeasePlanResolver = async (_client, input) => {
  if (input.runId === RUN_SUSPEND) return { siteProfileId: SITE_W, browserIdentityId: IDENT_W, networkPolicyId: NETWORK_POLICY };
  return { siteProfileId: SITE_W2, browserIdentityId: IDENT_W2, networkPolicyId: NETWORK_POLICY };
};

const scenarioIr = {
  meta: { name: "site-circuit-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

async function runStatus(pool: Pool, runId: string): Promise<string | null> {
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
         VALUES ($1,$2,'a','https://a.example/*','green',true,NULL),
                ($3,$2,'b','https://b.example/*','green',true,NULL),
                ($4,$2,'w','https://w.example/*','green',true,'{"flags":{}}'::jsonb),
                ($5,$2,'w2','https://w2.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE_A, TENANT, SITE_B, SITE_W, SITE_W2],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'w'), ($4,$2,$5,'w2')`,
        [IDENT_W, TENANT, SITE_W, IDENT_W2, SITE_W2],
      );
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['w.example','w2.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'site-circuit')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
         VALUES ($1,$2,$6,'queued',$3,'{"entry_url":"https://w.example/landing"}'::jsonb),
                ($4,$2,$6,'queued',$5,'{"entry_url":"https://w2.example/landing"}'::jsonb)`,
        [RUN_SUSPEND, TENANT, CORR_SUSPEND, RUN_SUCCESS, CORR_SUCCESS, SVER],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
         VALUES ($1,$2,$4,'queued',$3,'{"entry_url":"https://w2.example/landing"}'::jsonb)`,
        [RUN_GATE, TENANT, CORR_GATE, SVER],
      );
    });

    // ===== Part A: rate 엔진 직접 검증 (SITE_A / SITE_B) =====
    // 1) min_samples 미달: blocked 3회(<4) → 미발동.
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa01", true);
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa02", true);
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa03", true);
    check("A1 blocked 3회(<min_samples 4) → closed 유지(미발동)", (await circuit(pool, SITE_A)).state === "closed");

    // 2) 임계 도달: blocked 1회 더(total 4, rate 1.0≥0.5) → open + cooldown + site.circuit_opened.
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa04", true);
    const c2 = await circuit(pool, SITE_A);
    check("A2 blocked 4회(rate 1.0≥임계, total≥min) → open + cooldown 설정", c2.state === "open" && c2.future);
    check("A2 site.circuit_opened 1건 발행", (await eventCount(pool, SITE_A, "site.circuit_opened")) === 1);

    // 3) 진행 중 cooldown: ok 표본은 프로브 아님(circuit_until 미래) → 무전이(닫지 않음).
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa05", false);
    check("A3 cooldown 진행 중 ok 표본 → open 유지(닫지 않음)", (await circuit(pool, SITE_A)).state === "open");
    check("A3 site.circuit_closed 미발행(0)", (await eventCount(pool, SITE_A, "site.circuit_closed")) === 0);

    // 4) lazy auto-close 프로브 성공: cooldown 경과 강제 → ok 표본 → open→closed + site.circuit_closed.
    await forceCooldownElapsed(pool, SITE_A);
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa06", false);
    const c4 = await circuit(pool, SITE_A);
    check("A4 cooldown 경과 + ok 프로브 → closed + circuit_until NULL", c4.state === "closed" && c4.nullUntil);
    check("A4 site.circuit_closed 1건 발행", (await eventCount(pool, SITE_A, "site.circuit_closed")) === 1);

    // 5) close 후 rate 재초과: blocked 1회(window 누적 blocks 5/total 7=0.71≥0.5) → closed→open + opened 2번째.
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa07", true);
    check("A5 close 후 blocked → rate 재초과 → open 재진입", (await circuit(pool, SITE_A)).state === "open");
    check("A5 site.circuit_opened 누적 2건", (await eventCount(pool, SITE_A, "site.circuit_opened")) === 2);

    // 6) 프로브 차단 재open: cooldown 경과 강제 → blocked 프로브 → 재open(stays open, 새 cooldown), opened 미발행(여전히 2).
    await forceCooldownElapsed(pool, SITE_A);
    await rec(pool, SITE_A, "20000000-0000-0000-0000-00000000aa08", true);
    const c6 = await circuit(pool, SITE_A);
    check("A6 cooldown 경과 + blocked 프로브 → open 유지 + 새 cooldown", c6.state === "open" && c6.future);
    check("A6 재open 은 site.circuit_opened 미발행(여전히 2)", (await eventCount(pool, SITE_A, "site.circuit_opened")) === 2);

    // 7) 임계 미달(다른 사이트): blocked 2 + ok 6(total 8≥min, rate 0.25<0.5) → 미발동.
    for (let i = 0; i < 2; i += 1) await rec(pool, SITE_B, `20000000-0000-0000-0000-0000000bb0${i}`, true);
    for (let i = 0; i < 6; i += 1) await rec(pool, SITE_B, `20000000-0000-0000-0000-0000000bb1${i}`, false);
    check("A7 rate 0.25<임계(total≥min) → closed 유지", (await circuit(pool, SITE_B)).state === "closed");
    check("A7 site.circuit_opened 미발행(0)", (await eventCount(pool, SITE_B, "site.circuit_opened")) === 0);

    // ===== Part B: worker 배선 =====
    let driveSession: FakeCdpSession | null = null;
    const sessionProvider = new TestFakeBrowserSessionProvider({
      makeSession: (downloadDir) => {
        driveSession = new FakeCdpSession(downloadDir);
        return driveSession;
      },
    });
    // B1) challenge 자동감지 drive → blocked=true 표본 1행(SITE_W).
    const wSuspend = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: sessionProvider,
      allowTestBrowserSessionProvider: true,
      executorFactory: () => suspendingExecutor,
      suspensionPort,
      resumeTokenCodec,
      siteCircuit: CFG,
    });
    const susp = await wSuspend.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_SUSPEND as RunId, correlationId: CORR_SUSPEND as CorrelationId });
    check("B1 suspend drive → job completed(run=suspended)", susp.kind === "completed" && (await runStatus(pool, RUN_SUSPEND)) === "suspended", JSON.stringify(susp));
    const wSamp = await sampleCount(pool, SITE_W);
    check("B1 challenge 자동감지 → site_block_samples blocked=true 1행", wSamp.total === 1 && wSamp.blocked === 1, JSON.stringify(wSamp));

    // B2) 정상 완료 drive → blocked=false 표본 1행(SITE_W2).
    const wSuccess = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
      allowTestBrowserSessionProvider: true,
      executorFactory: (provider) => new UtilityExecutor(provider),
      siteCircuit: CFG,
    });
    const ok = await wSuccess.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_SUCCESS as RunId, correlationId: CORR_SUCCESS as CorrelationId });
    check("B2 정상 drive → job completed(run=completed)", ok.kind === "completed" && (await runStatus(pool, RUN_SUCCESS)) === "completed", JSON.stringify(ok));
    const w2Samp = await sampleCount(pool, SITE_W2);
    check("B2 정상 완료 → site_block_samples blocked=false 1행", w2Samp.total === 1 && w2Samp.blocked === 0, JSON.stringify(w2Samp));

    // B3) 게이트: SITE_W2 circuit open(cooldown 미래) → 새 queued run claim 이 SITE_CIRCUIT_OPEN deferred + run queued 유지.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`UPDATE site_profiles SET circuit_state='open', circuit_until = now() + interval '60 seconds' WHERE id=$1::uuid`, [SITE_W2]);
    });
    const gated = await wSuccess.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_GATE as RunId, correlationId: CORR_GATE as CorrelationId });
    check(
      "B3 circuit open → acquireBrowserLease SITE_CIRCUIT_OPEN deferred",
      gated.kind === "deferred" && gated.code === "SITE_CIRCUIT_OPEN" && gated.retryAfterMs > 0,
      JSON.stringify(gated),
    );
    check("B3 거부된 run 은 claim 안 됨(queued 유지)", (await runStatus(pool, RUN_GATE)) === "queued", String(await runStatus(pool, RUN_GATE)));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: site circuit integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-site-circuit int fatal:", e);
  process.exit(1);
});
