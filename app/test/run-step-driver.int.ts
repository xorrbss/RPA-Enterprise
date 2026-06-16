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

import type { ExecutorPlugin, PageState, PageStateResolver, PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { driveClaimedRun, type ClaimedRun } from "../src/runtime/run-step-driver";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_driver_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000d1";
const SVER = "70000000-0000-0000-0000-0000000000d2";
const RUN = "71000000-0000-0000-0000-0000000000d1";
const RUN_FAIL_BIZ = "71000000-0000-0000-0000-0000000000d3";
const RUN_FAIL_SYS = "71000000-0000-0000-0000-0000000000d4";
const RUN_SUSPEND = "71000000-0000-0000-0000-0000000000d5";
const RUN_HUMAN_TASK = "71000000-0000-0000-0000-0000000000d6";
const SCEN2 = "70000000-0000-0000-0000-0000000000e1"; // @human_task(R5) 시나리오(별도 IR)
const SVER2 = "70000000-0000-0000-0000-0000000000e2";
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

// 실패 terminal 구동 검증용: 첫 스텝(navigate)에서 지정 StepStatus 반환 → 인터프리터가 fail_business/fail_system terminal 로 매핑.
function failingExecutor(status: "failed_business" | "failed_system"): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    async execute(stepId) {
      const now = new Date().toISOString();
      return {
        stepId,
        action: "navigate",
        status,
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
}

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

// suspend 구동 검증용(트리거 i): 첫 스텝에서 status='suspended' → 인터프리터 suspend outcome → driver R4+포트+R11.
const suspendingExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = new Date().toISOString();
    return {
      stepId,
      action: "navigate",
      status: "suspended",
      pageStateBefore: "ref",
      pageStateAfter: "ps_suspend_after",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in driver int");
  },
};
// mock SecretStore: resume_token HMAC 서명키 {kid,key} 반환(실 Vault SecretStore 대역). 키 자료는 테스트 로컬.
const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-test", key: "int-resume-signing-key" }) as unknown as PlainSecret,
};
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);

const scenarioIr = {
  meta: { name: "driver-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
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

// @human_task(R5, 트리거 ii) 시나리오: what-less task 노드 → next=@human_task → suspend. on_timeout=escalate(비기본값 → 포트 경유 실증).
const humanTaskIr = {
  meta: { name: "human-task-test", version: 1 },
  start: "task",
  nodes: {
    task: { what: [], next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver", on_timeout: "escalate" }, return_node: "after" } },
    after: { terminal: "success" },
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
    const compiledHt = compileScenario(humanTaskIr, {});
    check("@human_task scenario compiles (reservedHandlerCall next-target)", compiledHt.ok, compiledHt.ok ? "" : JSON.stringify(compiledHt.details));
    if (!compiledHt.ok) throw new Error("@human_task scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'driver')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      // @human_task(R5) 시나리오는 별도 scenario_version(SVER2, 별도 SCEN2).
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'human-task')`, [SCEN2, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER2, TENANT, SCEN2, JSON.stringify(compiledHt.ir), compiledHt.compiledAst],
      );
      // R1을 우회해 claimed 상태로 직접 시드(드라이버는 R2부터). correlation_id=run_id.
      for (const rid of [RUN, RUN_FAIL_BIZ, RUN_FAIL_SYS, RUN_SUSPEND]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
           VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
          [rid, TENANT, SVER, WORKER],
        );
      }
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
         VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
        [RUN_HUMAN_TASK, TENANT, SVER2, WORKER],
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
      params: { entry_url: "https://example.com" },
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

    // 실패 terminal 구동(2a): fail_business → failed_business(R9 단일 전이), fail_system → failed_system(R8 단일 전이).
    // applyRunTransition 이 run.failed_* emit + ended_at 설정 — 드라이버는 단일 전이만 적용(success 의 2-hop 과 비대칭).
    for (const f of [
      { rid: RUN_FAIL_BIZ, status: "failed_business" as const, terminal: "fail_business", state: "failed_business", event: "run.failed_business" },
      { rid: RUN_FAIL_SYS, status: "failed_system" as const, terminal: "fail_system", state: "failed_system", event: "run.failed_system" },
    ]) {
      const fres = await driveClaimedRun(
        {
          runId: f.rid,
          tenantId: TENANT,
          scenarioVersionId: SVER,
          correlationId: f.rid,
          leaseId: "lease-f",
          siteProfileId: "site-1",
          browserIdentityId: "bid-1",
          networkPolicyId: "np-1",
          params: { entry_url: "https://example.com" },
        },
        { pool, executor: failingExecutor(f.status), resolver: fakeResolver, workerId: WORKER },
      );
      check(`driver(${f.status}) → state=${f.state}`, fres.state === f.state, fres.state);
      check(`${f.status} → terminal=${f.terminal}`, fres.outcome.terminal === f.terminal, fres.outcome.terminal);
      const fdb = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ status: string; ended_at: Date | null }>(
          `SELECT status, ended_at FROM runs WHERE id=$1::uuid`,
          [f.rid],
        );
        return r.rows[0] ?? null;
      });
      check(`DB runs.status = ${f.state}`, fdb?.status === f.state, JSON.stringify(fdb));
      check(`${f.state} ended_at 기록(terminal)`, fdb?.ended_at !== null && fdb?.ended_at !== undefined);
      const fevents = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ event_type: string }>(
          `SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`,
          [f.rid],
        );
        return r.rows.map((x) => x.event_type);
      });
      check(`outbox에 ${f.event}`, fevents.includes(f.event), fevents.join(","));
    }

    // suspend 구동(step2+3): suspended → suspending(R4)+human_task 포트 → resume-token 발행+R11 → suspended.
    const susp = await driveClaimedRun(
      {
        runId: RUN_SUSPEND,
        tenantId: TENANT,
        scenarioVersionId: SVER,
        correlationId: RUN_SUSPEND,
        leaseId: "lease-s",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      { pool, executor: suspendingExecutor, resolver: fakeResolver, workerId: WORKER, suspensionPort, resumeTokenCodec },
    );
    check("driver(suspended) → state=suspended", susp.state === "suspended", susp.state);
    check(
      "outcome.terminal=suspend + suspend.resumeNodeId=open(같은 노드)",
      susp.outcome.terminal === "suspend" && susp.outcome.suspend?.resumeNodeId === "open",
      susp.outcome.suspend?.resumeNodeId,
    );
    const sdb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; resume_token: { kid?: string; hmac?: string } | null; bookmark: { reason?: string } | null }>(
        `SELECT status, resume_token, bookmark FROM runs WHERE id=$1::uuid`,
        [RUN_SUSPEND],
      );
      return r.rows[0] ?? null;
    });
    check("DB runs.status = suspended", sdb?.status === "suspended", String(sdb?.status));
    check("runs.resume_token 발행(kid+hmac)", typeof sdb?.resume_token?.kid === "string" && typeof sdb?.resume_token?.hmac === "string", JSON.stringify(sdb?.resume_token));
    check("runs.bookmark 영속(reason=challenge)", sdb?.bookmark?.reason === "challenge", JSON.stringify(sdb?.bookmark));
    const sht = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ kind: string; state: string }>(`SELECT kind, state FROM human_tasks WHERE run_id=$1::uuid`, [RUN_SUSPEND]);
      return r.rows;
    });
    check("human_tasks 1건 kind=captcha state=open", sht.length === 1 && sht[0]?.kind === "captcha" && sht[0]?.state === "open", JSON.stringify(sht));
    const sevs = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`, [RUN_SUSPEND]);
      return r.rows.map((x) => x.event_type);
    });
    check("outbox: human_task.created + run.suspended", sevs.includes("human_task.created") && sevs.includes("run.suspended"), sevs.join(","));
    // 발행·저장된 토큰이 verify 라운드트립(서명 유효) — DB 봉투 무결성 증명.
    if (sdb?.resume_token) {
      const v = await resumeTokenCodec.verify(sdb.resume_token as unknown as Parameters<typeof resumeTokenCodec.verify>[0]);
      check("저장된 resume_token verify → valid(round-trip)", v.kind === "valid", v.kind);
    } else {
      check("저장된 resume_token verify → valid(round-trip)", false, "resume_token 부재");
    }

    // 멱등 재구동: 이미 completed → claimed→running CAS 0 rows → 표면화(조용한 false 금지).
    let reDriveThrew = false;
    try {
      await driveClaimedRun(run, { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER });
    } catch {
      reDriveThrew = true;
    }
    check("이미 종료된 run 재구동 → CAS 충돌 표면화(throw)", reDriveThrew);

    // @human_task suspend 구동(트리거 ii, R5): what-less @human_task 노드 → R5(human_task_required)+포트→resume-token+R11→suspended.
    const htRun = await driveClaimedRun(
      {
        runId: RUN_HUMAN_TASK,
        tenantId: TENANT,
        scenarioVersionId: SVER2,
        correlationId: RUN_HUMAN_TASK,
        leaseId: "lease-ht",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: {},
      },
      { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER, suspensionPort, resumeTokenCodec },
    );
    check("driver(@human_task) → state=suspended", htRun.state === "suspended", htRun.state);
    check(
      "@human_task outcome: terminal=suspend·kind=human_task·resumeNodeId=after(return_node)",
      htRun.outcome.terminal === "suspend" && htRun.outcome.suspend?.kind === "human_task" && htRun.outcome.suspend.resumeNodeId === "after",
      JSON.stringify(htRun.outcome.suspend),
    );
    const htdb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; resume_token: { resumeNodeId?: string } | null; bookmark: { reason?: string } | null }>(
        `SELECT status, resume_token, bookmark FROM runs WHERE id=$1::uuid`,
        [RUN_HUMAN_TASK],
      );
      return r.rows[0] ?? null;
    });
    check("@human_task DB runs.status = suspended", htdb?.status === "suspended", String(htdb?.status));
    check("@human_task resume_token.resumeNodeId = after(return_node)", htdb?.resume_token?.resumeNodeId === "after", JSON.stringify(htdb?.resume_token));
    check("@human_task bookmark reason = human_task", htdb?.bookmark?.reason === "human_task", JSON.stringify(htdb?.bookmark));
    const htTask = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ kind: string; state: string; assignee_role: string | null; on_timeout: string }>(
        `SELECT kind, state, assignee_role, on_timeout FROM human_tasks WHERE run_id=$1::uuid`,
        [RUN_HUMAN_TASK],
      );
      return r.rows;
    });
    check(
      "@human_task human_tasks 1건 kind=approval·assignee_role=approver·on_timeout=escalate·state=open",
      htTask.length === 1 &&
        htTask[0]?.kind === "approval" &&
        htTask[0]?.assignee_role === "approver" &&
        htTask[0]?.on_timeout === "escalate" &&
        htTask[0]?.state === "open",
      JSON.stringify(htTask),
    );
    const htEvents = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`, [RUN_HUMAN_TASK]);
      return r.rows.map((x) => x.event_type);
    });
    check("@human_task outbox: human_task.created + run.suspended", htEvents.includes("human_task.created") && htEvents.includes("run.suspended"), htEvents.join(","));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run 실행 드라이버 — claimed→running→completing→completed + suspend(challenge R4 / @human_task R5) (인터프리터↔DB 전이, D3 가동 1단계)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-step-driver int fatal:", e);
  process.exit(1);
});
