/**
 * C3 end-to-end — @human_task 해소 후 resume 가 사람 판정(decision)으로 분기하는 전 체인. 실 PostgreSQL.
 *
 * 증명: driveResumedRun → driveScenario 가 resume(startNode) 시 human_tasks.result 를 re-SELECT(loadResolvedHumanTaskNodeOutputs)
 * → interpreter nodeScope 시드 → return_node 의 on[] 이 node.<task>.decision 으로 분기. decision=approve → approved(success→completed),
 * decision=reject → catch-all rejected(fail_business→failed_business). 두 run 의 종착이 판정에 따라 갈리면 전 체인(producer node_id →
 * consumer result → IREL 분기)이 wired 임이 증명된다. (producer node_id 영속·consumer 투영 단위는 별도 테스트.)
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/run-step-driver-resume-decision.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExecutorPlugin, PageState, PageStateResolver, StepResult, VerifyResult } from "../../ts/core-types";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { driveResumedRun, type ClaimedRun } from "../src/runtime/run-step-driver";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_resume_decision_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1";
const WORKER = "9c000000-0000-0000-0000-0000000000c1";
const SCEN = "70000000-0000-0000-0000-0000000000c1";
const SVER = "70000000-0000-0000-0000-0000000000c2";
const RUN_APPROVE = "71000000-0000-0000-0000-0000000000c1";
const RUN_REJECT = "71000000-0000-0000-0000-0000000000c2";
const CORR_A = "20000000-0000-0000-0000-0000000000c1";
const CORR_R = "20000000-0000-0000-0000-0000000000c2";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// branch 노드는 what 이 없어 executor 미호출(decision 으로만 분기). 안전한 no-op 대역.
const fakeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  execute: async (): Promise<StepResult> => {
    throw new Error("executor must not be invoked for a what-less on[] branch node");
  },
  verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
};
const fakeResolver: PageStateResolver = {
  async resolvePageState(): Promise<PageState> {
    return {
      url: { raw: "x", canonical: "x", pattern: "x" },
      dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
      auth: "authenticated",
      flags: {},
      matchedWhere: [],
    };
  },
};

// task(@human_task, return_node=branch) → branch(on decision) → approved(success) / rejected(fail_business).
const decisionIr = {
  meta: { name: "resume-decision-test", version: 1 },
  start: "task",
  nodes: {
    task: {
      what: [],
      next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver" }, return_node: "branch" },
    },
    branch: {
      on: [
        { when: 'node.task.decision == "approve"', target: "approved", priority: 2 },
        { when: "true", target: "rejected", priority: 1 },
      ],
    },
    approved: { terminal: "success" },
    rejected: { terminal: "fail_business" },
  },
};

function resumedRun(runId: string, correlationId: string): ClaimedRun {
  return {
    runId,
    tenantId: TENANT,
    scenarioVersionId: SVER,
    correlationId,
    leaseId: `lease-${runId}`,
    siteProfileId: "site-c",
    browserIdentityId: "bid-c",
    networkPolicyId: "np-c",
    params: {},
  };
}

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

    const compiled = compileScenario(decisionIr, {});
    check("decision 시나리오 compiles (V9 @human_task 게이트 + V13 catch-all)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("decision scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'resume-decision')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      // 두 run 모두 worker 가 R18(resume_requested→running)을 적용한 직후 상태(running)로 시드 — driveResumedRun 은 그 노드부터 재진입.
      for (const [rid, corr] of [[RUN_APPROVE, CORR_A], [RUN_REJECT, CORR_R]] as const) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, started_at, params)
           VALUES ($1,$2,$3,'running',$4,1,$5::uuid,'2026-06-25T00:00:00Z','{}'::jsonb)`,
          [rid, TENANT, SVER, corr, WORKER],
        );
      }
      // 해소된 @human_task(producer 가 node_id='task' 영속한 상태를 모사) — result 가 판정.
      let seq = 0;
      for (const [rid, decision] of [[RUN_APPROVE, "approve"], [RUN_REJECT, "reject"]] as const) {
        seq += 1;
        await c.query(
          `INSERT INTO human_tasks (id, tenant_id, run_id, node_id, kind, state, result, resolved_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'task','approval','resolved',$4::jsonb, now())`,
          [`72000000-0000-0000-0000-${String(seq).padStart(12, "0")}`, TENANT, rid, JSON.stringify({ decision })],
        );
      }
    });

    const deps = { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER };

    // decision=approve → branch 가 approved(success) 로 → run completed.
    const approveResult = await driveResumedRun(resumedRun(RUN_APPROVE, CORR_A), deps, "branch");
    check("approve: visited branch→approved", approveResult.outcome.visited.join(",") === "branch,approved", approveResult.outcome.visited.join(","));
    check("approve: terminal=success", approveResult.outcome.terminal === "success", approveResult.outcome.terminal);
    check("approve: driver state=completed", approveResult.state === "completed", approveResult.state);
    check("approve: DB runs.status=completed", (await runStatus(pool, RUN_APPROVE)) === "completed", String(await runStatus(pool, RUN_APPROVE)));

    // decision=reject → branch catch-all 이 rejected(fail_business) 로 → run failed_business.
    const rejectResult = await driveResumedRun(resumedRun(RUN_REJECT, CORR_R), deps, "branch");
    check("reject: visited branch→rejected", rejectResult.outcome.visited.join(",") === "branch,rejected", rejectResult.outcome.visited.join(","));
    check("reject: terminal=fail_business", rejectResult.outcome.terminal === "fail_business", rejectResult.outcome.terminal);
    check("reject: driver state=failed_business", rejectResult.state === "failed_business", rejectResult.state);
    check("reject: DB runs.status=failed_business", (await runStatus(pool, RUN_REJECT)) === "failed_business", String(await runStatus(pool, RUN_REJECT)));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: resume decision e2e — @human_task 해소 result → re-SELECT 시드 → on[] decision 분기 (approve→completed / reject→failed_business) (C3)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-step-driver-resume-decision int fatal:", e);
  process.exit(1);
});
