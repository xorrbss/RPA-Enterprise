/**
 * runtime-worker suspend-drive 통합 (worker suspend-deps 배선). 실 PostgreSQL.
 *
 * handleRunClaim 이 executorFactory(주입형 executor) + suspensionPort + resumeTokenCodec 주입 시, executor 가 step
 * status='suspended' 를 반환하면 driveClaimedRun→driveSuspend 로 run 을 'suspended' 까지 구동하는지 검증한다(R4+포트
 * +resume-token 발행+R11). UtilityExecutor 는 'suspended' 를 반환하지 않으므로(success/pass/fail_det), worker-driven
 * suspend 를 트리거·검증하려면 executor 주입 seam(executorFactory)이 필수다 — 여기서 fake suspend executor 를 주입.
 * 실 challenge 감지(프로덕션 트리거)는 DOM/vision executor 후행(별개).
 *
 * 또한 suspend deps 미주입 시 driveSuspend throw 를 C3 system-failure 폴백이 failed_system 으로 종결(좀비 run 방지) — 회귀로 증명.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-suspend-drive.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin, PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { ResumeTokenCodec, ResumeTokenEnvelope, SessionRestoreResult, SessionRestorer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_suspend_drive_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000a1";
const SITE = "40000000-0000-0000-0000-000000000d01";
const IDENTITY = "40000000-0000-0000-0000-000000000d02";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000000d03";
// 회귀 run(deps 미주입)은 별도 site/identity — drive run 의 lease 와 충돌(SESSION_LOCKED) 방지.
const SITE2 = "40000000-0000-0000-0000-000000000d04";
const IDENTITY2 = "40000000-0000-0000-0000-000000000d05";
// resume 재-suspend run 전용 site/identity(lease 충돌 회피).
const SITE3 = "40000000-0000-0000-0000-000000000d06";
const IDENTITY3 = "40000000-0000-0000-0000-000000000d07";
// 토큰-발행-실패 run 전용 site/identity(lease 충돌 회피).
const SITE4 = "40000000-0000-0000-0000-000000000d08";
const IDENTITY4 = "40000000-0000-0000-0000-000000000d09";
const SCEN = "70000000-0000-0000-0000-000000000d01";
const SVER = "70000000-0000-0000-0000-000000000d02";
const RUN_SUSPEND = "71000000-0000-0000-0000-000000000d01";
const RUN_NODEPS = "71000000-0000-0000-0000-000000000d02";
const RUN_RESUSPEND = "71000000-0000-0000-0000-000000000d03";
const RUN_TOKENFAIL = "71000000-0000-0000-0000-000000000d04";
const CORRELATION = "20000000-0000-0000-0000-000000000d01";
const CORRELATION2 = "20000000-0000-0000-0000-000000000d02";
const CORRELATION3 = "20000000-0000-0000-0000-000000000d03";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

const planResolver: BrowserLeasePlanResolver = async (_client, input) => {
  if (input.runId === RUN_NODEPS) return { siteProfileId: SITE2, browserIdentityId: IDENTITY2, networkPolicyId: NETWORK_POLICY };
  if (input.runId === RUN_RESUSPEND) return { siteProfileId: SITE3, browserIdentityId: IDENTITY3, networkPolicyId: NETWORK_POLICY };
  if (input.runId === RUN_TOKENFAIL) return { siteProfileId: SITE4, browserIdentityId: IDENTITY4, networkPolicyId: NETWORK_POLICY };
  return { siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY };
};

// fake suspend executor(트리거 i): 첫 스텝에서 status='suspended' → 인터프리터 suspend outcome → driveSuspend.
// provider 를 쓰지 않으므로 executorFactory 는 인자 무시. UtilityExecutor 대역(실 challenge 감지는 DOM/vision 후행).
const suspendingExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    return {
      stepId,
      action: "navigate",
      status: "suspended",
      // ②③: status='suspended' 는 executor 가 감지한 challenge(captcha|mfa)를 운반해야 한다(인터프리터가 challengeKind 유도).
      challenge: { type: "captcha", detectedBy: "dom", confidence: 1 },
      pageStateBefore: "ref",
      pageStateAfter: "ps_suspend_after",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in suspend-drive int");
  },
};

// mock SecretStore: resume_token HMAC 서명키 {kid,key} 반환(실 Vault SecretStore 대역). 키 자료는 테스트 로컬.
const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-test", key: "worker-suspend-signing-key" }) as unknown as PlainSecret,
};
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);
// 토큰 발행 실패(SecretStore/KMS/network) 모사 — issue 가 throw. step1(R4/R5+human_task) commit 후 발행 실패로
// run 이 'suspending' 에 좌초하는지(C3 폴백 R12) 검증용.
const throwingResumeTokenCodec: ResumeTokenCodec = {
  async issue() {
    throw new Error("simulated resume-token issue failure (SecretStore/KMS/network)");
  },
  async verify() {
    throw new Error("throwingResumeTokenCodec.verify not used");
  },
};

// resume 재-suspend 케이스용: run_resume 가 R17→restore→R18 후 driveResumedRun 으로 resumeNodeId 재진입 → 같은 suspend
// executor 가 다시 suspend → driveSuspend(handleRunResume Phase C 리터럴의 suspend-deps 주입을 핀고정).
function token(runId: string, pageStateRef: string, resumeNodeId: string): ResumeTokenEnvelope {
  return {
    runId: runId as RunId,
    resumeNodeId,
    pageStateRef,
    issuedAt: "2026-06-16T00:00:00.000Z" as ResumeTokenEnvelope["issuedAt"],
    expiresAt: "2026-06-17T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"],
    kid: "kms://tenant-a/resume-token-key",
    hmac: "signed-envelope-hmac",
  };
}
const restorer: SessionRestorer = {
  async restoreSession(input): Promise<SessionRestoreResult> {
    return { kind: "restored", pageStateRef: input.expectedPageStateRef };
  },
};

// open(navigate) → done. suspend executor 가 open 에서 suspend → resumeNodeId=open.
const scenarioIr = {
  meta: { name: "suspend-worker-test", version: 1 },
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
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb),
                ($3,$2,'ok2','https://ok2.example/*','green',true,'{"flags":{}}'::jsonb),
                ($4,$2,'ok3','https://ok3.example/*','green',true,'{"flags":{}}'::jsonb),
                ($5,$2,'ok4','https://ok4.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT, SITE2, SITE3, SITE4],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1,$2,$3,'ok'), ($4,$2,$5,'ok2'), ($6,$2,$7,'ok3'), ($8,$2,$9,'ok4')`,
        [IDENTITY, TENANT, SITE, IDENTITY2, SITE2, IDENTITY3, SITE3, IDENTITY4, SITE4],
      );
      await c.query(
        `INSERT INTO network_policies (id, tenant_id, allowed_domains)
         VALUES ($1,$2,ARRAY['ok.example','ok2.example','ok3.example','ok4.example'])`,
        [NETWORK_POLICY, TENANT],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'suspend-drive')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      for (const rid of [RUN_SUSPEND, RUN_NODEPS]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
           VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
          [rid, TENANT, SVER, CORRELATION],
        );
      }
      // resume 재-suspend run: resume_requested + resume_token(resumeNodeId=open). CORRELATION2 로 이벤트 격리.
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, resume_token, params)
         VALUES ($1,$2,$3,'resume_requested',$4,$5::jsonb,'{"entry_url":"https://ok3.example/landing"}'::jsonb)`,
        [RUN_RESUSPEND, TENANT, SVER, CORRELATION2, JSON.stringify(token(RUN_RESUSPEND, "page-state://resuspend", "open"))],
      );
      // 토큰-발행-실패 run: queued. 구동 시 첫 스텝 suspend → R4/R5+포트 commit → 토큰 발행 throw → R12 폴백.
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
         VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok4.example/landing"}'::jsonb)`,
        [RUN_TOKENFAIL, TENANT, SVER, CORRELATION3],
      );
    });

    // 1) executorFactory(suspend) + suspensionPort + resumeTokenCodec 주입 → claim 후 driveClaimedRun→driveSuspend→suspended.
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
      sessionRestorer: restorer,
      executorFactory: () => suspendingExecutor,
      suspensionPort,
      resumeTokenCodec,
    });
    const driven = await driving.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_SUSPEND as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim+suspend → job completed(run=suspended)", driven.kind === "completed", JSON.stringify(driven));
    check("DB runs.status = suspended (worker-driven suspend)", (await runStatus(pool, RUN_SUSPEND)) === "suspended", String(await runStatus(pool, RUN_SUSPEND)));

    const sdb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ resume_token: { kid?: string; hmac?: string } | null; bookmark: { reason?: string } | null }>(
        `SELECT resume_token, bookmark FROM runs WHERE id=$1::uuid`,
        [RUN_SUSPEND],
      );
      return r.rows[0] ?? null;
    });
    check("runs.resume_token 발행(kid+hmac)", typeof sdb?.resume_token?.kid === "string" && typeof sdb?.resume_token?.hmac === "string", JSON.stringify(sdb?.resume_token));
    check("runs.bookmark 영속(reason=challenge)", sdb?.bookmark?.reason === "challenge", JSON.stringify(sdb?.bookmark));

    const sht = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ kind: string; state: string }>(`SELECT kind, state FROM human_tasks WHERE run_id=$1::uuid`, [RUN_SUSPEND]);
      return r.rows;
    });
    check("human_tasks 1건 kind=captcha state=open (포트)", sht.length === 1 && sht[0]?.kind === "captcha" && sht[0]?.state === "open", JSON.stringify(sht));

    const sevs = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid`, [CORRELATION]);
      return r.rows.map((x) => x.event_type);
    });
    check("outbox: human_task.created + run.suspended", sevs.includes("human_task.created") && sevs.includes("run.suspended"), sevs.join(","));

    // 발행·저장된 토큰이 verify 라운드트립(서명 유효) — codec 이 worker 경유로 주입돼 동작함을 증명.
    if (sdb?.resume_token) {
      const v = await resumeTokenCodec.verify(sdb.resume_token as unknown as Parameters<typeof resumeTokenCodec.verify>[0]);
      check("저장된 resume_token verify → valid(round-trip)", v.kind === "valid", v.kind);
    } else {
      check("저장된 resume_token verify → valid(round-trip)", false, "resume_token 부재");
    }
    check("세션 release(close) 호출됨", driveSession !== null && (driveSession as FakeCdpSession).closeCalls === 1, `closeCalls=${driveSession === null ? "no-session" : (driveSession as FakeCdpSession).closeCalls}`);

    // 3) resume 경로 재-suspend: run_resume → R17→restore→R18(run.resumed)→driveResumedRun(resumeNodeId) → suspend
    //    executor → driveSuspend → suspended. handleRunResume Phase C 리터럴의 suspend-deps 주입을 핀고정(claim 경로와 별개).
    const reSusp = await driving.handle({
      kind: "run_resume",
      tenantId: TENANT as TenantId,
      runId: RUN_RESUSPEND as RunId,
      correlationId: CORRELATION2 as CorrelationId,
    });
    check("run_resume+재suspend → job completed(run=suspended)", reSusp.kind === "completed", JSON.stringify(reSusp));
    check("DB runs.status = suspended (resume 경로 재-suspend)", (await runStatus(pool, RUN_RESUSPEND)) === "suspended", String(await runStatus(pool, RUN_RESUSPEND)));
    const reEvs = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid`, [CORRELATION2]);
      return r.rows.map((x) => x.event_type);
    });
    check(
      "resume 재-suspend outbox: run.resumed + human_task.created + run.suspended",
      reEvs.includes("run.resumed") && reEvs.includes("human_task.created") && reEvs.includes("run.suspended"),
      reEvs.join(","),
    );
    const reHt = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ state: string }>(`SELECT state FROM human_tasks WHERE run_id=$1::uuid`, [RUN_RESUSPEND]);
      return r.rows;
    });
    check("resume 재-suspend human_tasks 1건 state=open (포트)", reHt.length === 1 && reHt[0]?.state === "open", JSON.stringify(reHt));

    // 2) suspend deps 미주입(executorFactory 만, suspensionPort/codec 없음): driveSuspend 가 R2(running) 이후 throw 하지만
    //    C3 system-failure 폴백이 이를 failed_system 으로 종결한다 — run 이 running 에 영구 잔류(좀비)하지 않음(원 예외는 로그로 표면화).
    const noDeps = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
      allowTestBrowserSessionProvider: true,
      executorFactory: () => suspendingExecutor,
    });
    const err = await caught(
      noDeps.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_NODEPS as RunId, correlationId: CORRELATION as CorrelationId }),
    );
    check("suspend deps 미주입 → 폴백이 throw 흡수(job 정상 종료)", err === undefined, String(err));
    check(
      "suspend deps 미주입 → run failed_system 종결(running 잔류=좀비 아님)",
      (await runStatus(pool, RUN_NODEPS)) === "failed_system",
      String(await runStatus(pool, RUN_NODEPS)),
    );

    // 4) suspend deps 주입됐으나 resume-token 발행 실패(codec.issue throw): step1(R4/R5+human_task) commit 후
    //    토큰 발행이 throw → run 은 'suspending'. C3 폴백 terminalizeStuckRunAsSystemFailure 가 R12(suspending→
    //    failed_system)로 종결한다. 회귀: 종전엔 running/completing 만 처리해 run 이 'suspending' 에 영구 좌초했다.
    const tokenFail = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
      allowTestBrowserSessionProvider: true,
      executorFactory: () => suspendingExecutor,
      suspensionPort,
      resumeTokenCodec: throwingResumeTokenCodec,
    });
    const tfErr = await caught(
      tokenFail.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_TOKENFAIL as RunId, correlationId: CORRELATION3 as CorrelationId }),
    );
    check("token 발행 실패 → C3 폴백이 throw 흡수(job 정상 종료)", tfErr === undefined, String(tfErr));
    check(
      "token 발행 실패 → run failed_system 종결(suspending 좌초=좀비 아님, R12)",
      (await runStatus(pool, RUN_TOKENFAIL)) === "failed_system",
      String(await runStatus(pool, RUN_TOKENFAIL)),
    );
    const tfHt = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ state: string }>(`SELECT state FROM human_tasks WHERE run_id=$1::uuid`, [RUN_TOKENFAIL]);
      return r.rows;
    });
    check("token 발행 실패 → step1 human_task 가 R12 종결 시 cancel 됨(orphan open 아님, #1 보수)", tfHt.length === 1 && tfHt[0]?.state === "cancelled", JSON.stringify(tfHt));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker suspend-drive — queued→(claim)→driveClaimedRun→driveSuspend→suspended (worker suspend-deps 배선)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-suspend-drive int fatal:", e);
  process.exit(1);
});
