/**
 * 단위 — 인터프리터 @end_no_data terminal 처리 (IREL/정적검증 감사).
 *
 * @end_no_data 는 노드가 아니라 데이터-없음 terminal(success_empty)이다(ir.schema endNoDataTarget·reserved-handlers·
 * ir-static V1/V7). next/on[].target 으로 도달 시 인터프리터가 노드 조회 전에 가로채 success_empty 로 종료해야 한다 —
 * 안 그러면 unknown node → IR_SCHEMA_INVALID throw → failed_system 으로 오분류(수집 0건을 시스템 실패로 위장).
 *
 * 실행: tsx app/test/interpreter-end-no-data.unit.ts
 */
import type { ExecutorPlugin, PageState, PageStateResolver, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import { runScenario, type CompiledScenario, type ScenarioOutcome } from "../src/runtime/ir-interpreter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function ast(expr: string): IRELNode {
  const p = parseIrelExpression(expr);
  if (!p.ok) throw new Error(`parse failed: ${expr}`);
  return p.ast;
}
function stepResult(status: StepStatus): StepResult {
  return { stepId: "s", action: "act", status, pageStateBefore: "ps", pageStateAfter: "ps", artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: "t", endedAt: "t", durationMs: 0 } };
}
const fakeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  execute: async () => stepResult("success"),
  verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
};
const basePageState: PageState = {
  url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
  dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
  auth: "anonymous", flags: {}, matchedWhere: [],
};
const resolver: PageStateResolver = { resolvePageState: async (): Promise<PageState> => basePageState };
function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "n", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: basePageState,
  };
}
async function run(scenario: CompiledScenario): Promise<ScenarioOutcome> {
  return runScenario(scenario, ctx(), { executor: fakeExecutor, resolver, params: {} });
}

async function main(): Promise<void> {
  // 1) next: "@end_no_data" → success_empty terminal(failed_system 아님).
  const o1 = await run({ start: "N", nodes: { N: { what: [{ type: "act" }], flow: { kind: "next", target: "@end_no_data" } } } });
  check("next:@end_no_data → success_empty", o1.terminal === "success_empty", o1.terminal);

  // 2) on[].target: "@end_no_data"(매칭 분기) → success_empty.
  const o2 = await run({
    start: "N",
    nodes: { N: { what: [], flow: { kind: "on", branches: [{ when: ast("true"), target: "@end_no_data", priority: 1 }] } } },
  });
  check("on[]:@end_no_data → success_empty", o2.terminal === "success_empty", o2.terminal);

  // 3) negative control: 실제 미존재 노드 target 은 여전히 IR_SCHEMA_INVALID throw(인터셉터가 @end_no_data 만 한정).
  let err: unknown;
  try {
    await run({ start: "N", nodes: { N: { what: [], flow: { kind: "next", target: "missing_node" } } } });
  } catch (e) { err = e; }
  check("unknown 노드 target 은 여전히 loud throw(IR_SCHEMA_INVALID)", err instanceof Error && (err as { code?: string }).code === "IR_SCHEMA_INVALID", err instanceof Error ? (err as { code?: string }).code : String(err));
}

main().then(() => {
  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: interpreter @end_no_data → success_empty (IREL/정적검증 감사)");
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
