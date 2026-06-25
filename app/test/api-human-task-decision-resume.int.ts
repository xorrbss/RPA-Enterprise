/**
 * 분기형 HITL 라이브 e2e (적대검증 후속 — resolve API→R13→resume→decision 분기 전 체인). 실 PostgreSQL.
 *
 * 기존 테스트가 비운 seam 을 닫는다: human-task **resolve REST API**(R13 suspended→resume_requested + resume 인큐 +
 * RBAC/전이)가 실제로 worker resume 을 거쳐 node.<review>.decision 분기까지 이어지는지를, **실 제어평면(buildServer)
 * HTTP + 실 drive(driveClaimedRun/driveResumedRun)**로 e2e 검증. (worker.handle 은 on[] 노드의 resolvePageState 가
 * fake 세션과 맞지 않아 drive 함수 직접 사용 — driveResumedRun 은 worker 가 내부 호출하는 바로 그 경로.)
 *
 * 흐름: claimed run → driveClaimedRun → review @human_task suspend → GET /v1/human-tasks(인박스) →
 *   assign→start→resolve(decision) [HTTP, R13] → driveResumedRun(decide) → decision 분기. approve→completed / reject→failed_business.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/api-human-task-decision-resume.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { driveClaimedRun, driveResumedRun, type ClaimedRun } from "../src/runtime/run-step-driver";
import type { ExecutorPlugin, PageState, PageStateResolver, PlainSecret, SecretRef, SecretStore, StepResult, VerifyResult } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_hitl_live_e2e_int";
const TENANT = "00000000-0000-0000-0000-0000000000d1";
const WORKER = "9c000000-0000-0000-0000-0000000000d1";
const SITE = "40000000-0000-0000-0000-000000000e21";
const IDENTITY = "40000000-0000-0000-0000-000000000e22";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000000e23";
const SCEN = "70000000-0000-0000-0000-000000000e21";
const SVER = "70000000-0000-0000-0000-000000000e22";
const RUN_APPROVE = "71000000-0000-0000-0000-000000000e21";
const RUN_REJECT = "71000000-0000-0000-0000-000000000e22";
const SECRET = new TextEncoder().encode("hitl-live-e2e-secret-do-not-use-in-prod-0123456789ab");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(SECRET);
}

const cannedPageState: PageState = {
  url: { raw: "https://ok.example/doc", canonical: "https://ok.example/doc", pattern: "https://ok.example/*" },
  dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
  auth: "authenticated",
  flags: {},
  matchedWhere: [],
};
const fakeResolver: PageStateResolver = { async resolvePageState(): Promise<PageState> { return cannedPageState; } };
const fakeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId): Promise<StepResult> {
    const now = "2026-06-16T00:00:00.000Z";
    return { stepId, action: "navigate", status: "success", pageStateBefore: "ref", pageStateAfter: "ref", artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: now, endedAt: now, durationMs: 0 } };
  },
  async verify(): Promise<VerifyResult> { return { passed: true, criteria: [] } as unknown as VerifyResult; },
};
const fakeSecretStore: SecretStore = { resolve: async () => JSON.stringify({ kid: "kid-test", key: "hitl-live-signing-key" }) as unknown as PlainSecret };

// buildApprovalIr(OperatorWizard C4b) 출력과 동형 — 승인 후 분기: navigate→@human_task(approval)→decide(decision)→success/fail_business.
const approvalIr = {
  meta: { name: "승인 후 분기", version: 1, studio_mode: "easy" },
  params_schema: { type: "object", properties: { entry_url: { type: "string", description: "승인 대상 페이지", default: "https://ok.example/doc" } }, required: ["entry_url"] },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "review" },
    review: { what: [], next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver" }, return_node: "decide" } },
    decide: { on: [{ when: 'node.review.decision == "approve"', target: "approved", priority: 2 }, { when: "true", target: "rejected", priority: 1 }] },
    approved: { terminal: "success" },
    rejected: { terminal: "fail_business" },
  },
};

function claimed(runId: string): ClaimedRun {
  return { runId, tenantId: TENANT, scenarioVersionId: SVER, correlationId: runId, leaseId: `lease-${runId}`, siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY, params: { entry_url: "https://ok.example/doc" } };
}
async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId])).rows[0]?.status ?? null);
}
async function reviewTaskId(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ id: string }>(`SELECT id::text AS id FROM human_tasks WHERE run_id=$1::uuid AND node_id='review'`, [runId])).rows[0]?.id ?? null);
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const deps = { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER, suspensionPort: new PgChallengeSuspensionPort(), resumeTokenCodec: new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef) };
  const resumeEnqueued: string[] = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim() {},
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
    async enqueueRunResume(_c, input) { resumeEnqueued.push(input.runId); },
  };
  const app = buildServer({ pool, auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)), rbac: new RoleMatrixRbacMiddleware(), idempotency: new PgControlPlaneIdempotencyStore(pool), enqueuer, signedCommandRegistry });
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
    await app.ready();

    const compiled = compileScenario(approvalIr, {});
    check("승인 분기 IR compiles (ajv→IREL→V1–V13)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("approval scenario did not compile");
    // createScenario({...ir, target}) 모사: 저장 IR 에 자동추론 target 주입(run-create 가 ir.target 으로 실행대상 해소).
    const irToStore = { ...(compiled.ir as unknown as Record<string, unknown>), target: { site_profile_id: SITE, browser_identity_id: IDENTITY, network_policy_id: NETWORK_POLICY } };

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors) VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'hitl-live')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(irToStore), compiled.compiledAst]);
      for (const rid of [RUN_APPROVE, RUN_REJECT]) {
        await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, params) VALUES ($1,$2,$3,'claimed',$4,1,$5::uuid,'{"entry_url":"https://ok.example/doc"}'::jsonb)`, [rid, TENANT, SVER, rid, WORKER]);
      }
    });

    const operator = await mint({ sub: "op", tenant_id: TENANT, roles: ["operator"] });
    const approver = await mint({ sub: "ap", tenant_id: TENANT, roles: ["approver", "operator"] });
    const post = (path: string, key: string, token: string, payload?: unknown) =>
      app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, payload: payload as object | undefined });

    for (const [rid, decision, expectStatus] of [[RUN_APPROVE, "approve", "completed"], [RUN_REJECT, "reject", "failed_business"]] as const) {
      const tag = decision;
      // 1) drive claim → review @human_task suspend.
      const c1 = await driveClaimedRun(claimed(rid), deps);
      check(`[${tag}] claim drive → suspended`, c1.state === "suspended", JSON.stringify(c1.state));
      check(`[${tag}] DB run suspended`, (await runStatus(pool, rid)) === "suspended", String(await runStatus(pool, rid)));
      const taskId = await reviewTaskId(pool, rid);
      check(`[${tag}] human_task 생성 (node_id=review)`, taskId !== null, String(taskId));
      if (taskId === null) continue;

      // 2) 인박스 조회(HTTP) — run 의 open task 가 운영자에게 보인다(GET /v1/human-tasks?run_id=).
      const inbox = await app.inject({ method: "GET", url: `/v1/human-tasks?run_id=${rid}`, headers: { authorization: `Bearer ${operator}` } });
      check(`[${tag}] GET /v1/human-tasks → 200`, inbox.statusCode === 200, inbox.body);
      check(`[${tag}] 인박스에 review task 노출`, JSON.stringify(inbox.json()).includes(taskId), `task ${taskId} not in inbox`);

      // 3) assign(operator) → start(operator) → resolve(approver, decision) [실 REST API, R13].
      const a = await post(`/v1/human-tasks/${taskId}/assign`, `assign-${tag}`, operator, { assignee: "ap" });
      check(`[${tag}] assign → 200`, a.statusCode === 200, a.body);
      const s = await post(`/v1/human-tasks/${taskId}/start`, `start-${tag}`, operator);
      check(`[${tag}] start → 200`, s.statusCode === 200, s.body);
      const r = await post(`/v1/human-tasks/${taskId}/resolve`, `resolve-${tag}`, approver, { result: { decision } });
      check(`[${tag}] resolve(${decision}) → 200`, r.statusCode === 200, r.body);
      check(`[${tag}] resolve → run resume_requested (R13)`, (await runStatus(pool, rid)) === "resume_requested", String(await runStatus(pool, rid)));
      check(`[${tag}] resolve → resume 인큐됨`, resumeEnqueued.includes(rid), resumeEnqueued.join(","));

      // 4) worker R18 모사(resume_requested→running) 후 resume drive → decision 분기.
      await withTenantTx(pool, TENANT, async (c) => {
        const u = await c.query(`UPDATE runs SET status='running' WHERE id=$1::uuid AND status='resume_requested'`, [rid]);
        if (u.rowCount !== 1) throw new Error(`R18 mimic affected ${u.rowCount ?? 0}`);
      });
      const c2 = await driveResumedRun(claimed(rid), deps, "decide");
      check(`[${tag}] resume drive → terminal ${decision === "approve" ? "success" : "fail_business"}`, c2.outcome.terminal === (decision === "approve" ? "success" : "fail_business"), c2.outcome.terminal);
      check(`[${tag}] 최종 DB run status = ${expectStatus} (사람 판정이 종착 결정)`, (await runStatus(pool, rid)) === expectStatus, String(await runStatus(pool, rid)));
    }
  } finally {
    await app.close();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: HITL 라이브 e2e — resolve REST API(R13)→resume→node.<review>.decision 분기 (approve→completed / reject→failed_business)");
  process.exit(0);
}

main().catch((e) => {
  console.error("api-human-task-decision-resume int fatal:", e);
  process.exit(1);
});
