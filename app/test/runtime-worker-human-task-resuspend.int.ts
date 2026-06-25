/**
 * @human_task 동일 노드 재suspend 멱등키 회귀 (적대감사 #2). 실 PostgreSQL.
 *
 * loop 본문의 @human_task 가 같은 노드에서 2회 suspend 될 때, suspend-side outbox 멱등키(R5 human_task_required·
 * human_task.created·R11 bookmark_saved)가 per-cycle 고유해야 한다. @human_task 는 reserved_handler flow 라
 * run_steps 행이 없어 resolveSuspendKeyAttempt 의 run_steps-attempt 방식이 fallback(=ctx.attempt=0)에 고정 →
 * 2회차 키가 글자 그대로 충돌(events_outbox UNIQUE 23505) → tx 롤백 → run 좌초했다. 수정: @human_task 는 그 노드
 * (node_id)의 기존 human_tasks 행 수로 키를 스코프(사이클당 1행 → per-cycle 고유).
 *
 * 드라이브 직접(driveClaimedRun/driveResumedRun) + fake resolver — 세션/워커 플러밍 우회(loop resolvePageState 포함).
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-human-task-resuspend.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExecutorPlugin, PageState, PageStateResolver, PlainSecret, SecretRef, SecretStore, StepResult, VerifyResult } from "../../ts/core-types";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { driveClaimedRun, driveResumedRun, type ClaimedRun } from "../src/runtime/run-step-driver";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_ht_resuspend_int";
const TENANT = "00000000-0000-0000-0000-0000000000c2";
const WORKER = "9c000000-0000-0000-0000-0000000000c2";
const SCEN = "70000000-0000-0000-0000-000000000f01";
const SVER = "70000000-0000-0000-0000-000000000f02";
const RUN = "71000000-0000-0000-0000-000000000f01";
const CORR = "20000000-0000-0000-0000-000000000f01";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const cannedPageState: PageState = {
  url: { raw: "https://ok.example/x", canonical: "https://ok.example/x", pattern: "https://ok.example/*" },
  dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
  auth: "authenticated",
  flags: {},
  matchedWhere: [],
};
const fakeResolver: PageStateResolver = { async resolvePageState(): Promise<PageState> { return cannedPageState; } };
const noopExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId): Promise<StepResult> {
    const now = "2026-06-16T00:00:00.000Z";
    return { stepId, action: "navigate", status: "success", pageStateBefore: "ref", pageStateAfter: "ref", artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: now, endedAt: now, durationMs: 0 } };
  },
  async verify(): Promise<VerifyResult> { return { passed: true, criteria: [] } as unknown as VerifyResult; },
};
const fakeSecretStore: SecretStore = { resolve: async () => JSON.stringify({ kid: "kid-test", key: "ht-resuspend-key" }) as unknown as PlainSecret };

// loop 본문=review(@human_task). until=loop.iteration>=2 라 review 가 매 drive 의 loop 진입(iter0)에서 suspend → 같은 노드 2회 suspend.
const scenarioIr = {
  meta: { name: "ht-resuspend-test", version: 1 },
  start: "loop",
  nodes: {
    loop: { loop: { body_target: "review", exit_target: "done", until: "loop.iteration >= 2", max_iterations: 3 } },
    review: { what: [], next: { handler: "@human_task", input: { kind: "validation", assignee_role: "reviewer" }, return_node: "loop" } },
    done: { terminal: "success" },
  },
};

function claimedRun(): ClaimedRun {
  return { runId: RUN, tenantId: TENANT, scenarioVersionId: SVER, correlationId: CORR, leaseId: `lease-${RUN}`, siteProfileId: "site-ht", browserIdentityId: "bid-ht", networkPolicyId: "np-ht", params: {} };
}

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
  });
}

async function counts(pool: ReturnType<typeof createPool>, runId: string): Promise<{ humanTasks: number; created: number; nodeIds: string[] }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const ht = await c.query<{ node_id: string | null }>(`SELECT node_id FROM human_tasks WHERE run_id=$1::uuid ORDER BY created_at`, [runId]);
    const created = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM events_outbox WHERE correlation_id=$1::uuid AND event_type='human_task.created'`, [CORR]);
    return { humanTasks: ht.rows.length, created: Number(created.rows[0]?.n ?? "0"), nodeIds: ht.rows.map((x) => x.node_id ?? "NULL") };
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const deps = {
    pool,
    executor: noopExecutor,
    resolver: fakeResolver,
    workerId: WORKER,
    suspensionPort: new PgChallengeSuspensionPort(),
    resumeTokenCodec: new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef),
  };
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
    check("loop+@human_task scenario compiles", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'ht-resuspend')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, params) VALUES ($1,$2,$3,'claimed',$4,1,$5::uuid,'{}'::jsonb)`, [RUN, TENANT, SVER, CORR, WORKER]);
    });

    // 사이클 1: claimed → R2 → loop iter0 → review @human_task suspend (keyAttempt=0, prior human_tasks=0).
    const c1 = await driveClaimedRun(claimedRun(), deps);
    check("cycle1 → driver suspended", c1.state === "suspended", JSON.stringify(c1.state));
    check("cycle1 → DB run suspended (@review #1)", (await runStatus(pool, RUN)) === "suspended", String(await runStatus(pool, RUN)));
    const after1 = await counts(pool, RUN);
    check("cycle1 human_tasks 1건 node_id=review", after1.humanTasks === 1 && after1.nodeIds[0] === "review", JSON.stringify(after1));

    // R13(resolve) + R18(→running) 모사 후 사이클 2: resume(return_node=loop) → loop iter0 → 같은 review 재suspend.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`UPDATE human_tasks SET state='resolved', result='{"decision":"correct"}'::jsonb, resolved_at=now() WHERE run_id=$1::uuid AND node_id='review'`, [RUN]);
      const r = await c.query(`UPDATE runs SET status='running' WHERE id=$1::uuid AND status='suspended'`, [RUN]);
      if (r.rowCount !== 1) throw new Error(`R18 mimic: affected ${r.rowCount ?? 0}`);
    });

    const c2 = await driveResumedRun(claimedRun(), deps, "loop");
    check("cycle2 → driver suspended (재-suspend)", c2.state === "suspended", `state=${c2.state} (수정 전엔 23505→failed_system)`);
    check("cycle2 → DB run suspended (@review #2) — 동일 노드 재suspend 멱등키 충돌 없음 (#2)", (await runStatus(pool, RUN)) === "suspended", String(await runStatus(pool, RUN)));
    const after2 = await counts(pool, RUN);
    check("cycle2 human_tasks 2건 (둘 다 node_id=review)", after2.humanTasks === 2 && after2.nodeIds.every((n) => n === "review"), JSON.stringify(after2));
    check("outbox human_task.created 2건 (per-cycle 고유키 — 충돌 시 1건이었을 것)", after2.created === 2, `created=${after2.created}`);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: @human_task 동일 노드 재suspend — per-cycle 멱등키(node_id 기존 human_tasks 행 수)로 23505 좌초 방지 (적대감사 #2)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-human-task-resuspend int fatal:", e);
  process.exit(1);
});
