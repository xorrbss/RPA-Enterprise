/**
 * 단위 테스트 — 인터프리터 fallback_chain 실행 (RQ-002 fallback feature).
 *
 * 외부 의존 없음(fake executor + resolver, 순수). 실행: tsx test/interpreter-fallback.unit.ts.
 * 검증(ir-static-validation §4·ir-expression §2):
 *  - 티어 순서 실행(sub-traversal). advance_when(true)/기본(실패 terminal) → 다음 티어 전환.
 *  - advance_when=false → 해당 티어 채택(성공 시 정상; 실패+false면 그 실패 채택).
 *  - 마지막 티어 실패 → 마지막 티어 outcome 채택(빈결과 위장 금지, fail 표면화).
 *  - tier 투영: 티어 서브그래프 내 노드 출력에 tier 부착 → node.<id>.tier 분기 가능.
 *  - advance_when 스코프 = flags+params+node(loop/cursor 없음).
 */
import type { ExecutorPlugin, PageState, PageStateResolver, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import type { CompiledOnBranch } from "../src/runtime/flow-control";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function ast(expr: string): IRELNode {
  const p = parseIrelExpression(expr);
  if (!p.ok) throw new Error(`parse failed: ${expr}`);
  return p.ast;
}
function stepResult(status: StepStatus): StepResult {
  return {
    stepId: "s", action: "act", status, pageStateBefore: "ps", pageStateAfter: "ps",
    artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
  };
}
/** stepId(`<nodeId>.<k>`)의 nodeId 가 failNodes 면 failed_system, 그 외 success. */
function makeExecutor(failNodes: Set<string>): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async (stepId: string): Promise<StepResult> => stepResult(failNodes.has(stepId.split(".")[0]) ? "failed_system" : "success"),
    verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
  };
}
const basePageState: PageState = {
  url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
  dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
  auth: "anonymous", flags: {}, matchedWhere: [],
};
function resolver(flags: Record<string, boolean> = {}): PageStateResolver {
  return { resolvePageState: async (): Promise<PageState> => ({ ...basePageState, flags }) };
}
function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "n", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: basePageState,
  };
}

type Node = CompiledScenario["nodes"][string];
type Tier = { tier: string; entryNode: string; advanceWhen?: IRELNode };
const fb = (tiers: Tier[]): Node => ({ what: [], flow: { kind: "fallback", tiers } });
const actTerm = (terminal: string): Node => ({ what: [{ type: "act" }], flow: { kind: "terminal", terminal } });
const onNode = (branches: CompiledOnBranch<string>[]): Node => ({ what: [], flow: { kind: "on", branches } });

async function run(scenario: CompiledScenario, failNodes: Set<string>, params: Record<string, unknown> = {}, flags: Record<string, boolean> = {}): Promise<string> {
  const o = await runScenario(scenario, ctx(), { executor: makeExecutor(failNodes), resolver: resolver(flags), params });
  return o.terminal;
}

async function main(): Promise<void> {
  // 1) 단일 T0 success → T0 채택.
  const s1: CompiledScenario = { start: "F", nodes: { F: fb([{ tier: "T0", entryNode: "t0" }]), t0: actTerm("t0_done") } };
  check("단일 T0 success → adopt T0", (await run(s1, new Set())) === "t0_done");

  // 2) T0 실패(default advance) → T1 채택.
  const s2: CompiledScenario = { start: "F", nodes: { F: fb([{ tier: "T0", entryNode: "t0" }, { tier: "T1", entryNode: "t1" }]), t0: actTerm("t0_done"), t1: actTerm("t1_done") } };
  check("T0 실패 → default advance → T1 채택", (await run(s2, new Set(["t0"]))) === "t1_done");

  // 3) advance_when=true(T0 success여도 강제 전환) → T1 채택.
  const s3: CompiledScenario = {
    start: "F",
    nodes: { F: fb([{ tier: "T0", entryNode: "t0", advanceWhen: ast('node.t0.status == "success"') }, { tier: "T1", entryNode: "t1" }]), t0: actTerm("t0_done"), t1: actTerm("t1_done") },
  };
  check("advance_when=true(성공이어도 전환) → T1 채택", (await run(s3, new Set())) === "t1_done");

  // 4) advance_when=false → T0 채택(전환 안 함).
  const s4: CompiledScenario = {
    start: "F",
    nodes: { F: fb([{ tier: "T0", entryNode: "t0", advanceWhen: ast('node.t0.status == "failed_system"') }, { tier: "T1", entryNode: "t1" }]), t0: actTerm("t0_done"), t1: actTerm("t1_done") },
  };
  check("advance_when=false → T0 채택(전환 안 함)", (await run(s4, new Set())) === "t0_done");

  // 5) 모든 티어 실패 → 마지막 티어(T1) outcome 채택(fail 표면화, 빈결과 위장 금지).
  const s5: CompiledScenario = { start: "F", nodes: { F: fb([{ tier: "T0", entryNode: "t0" }, { tier: "T1", entryNode: "t1" }]), t0: actTerm("t0_done"), t1: actTerm("t1_done") } };
  check("모든 티어 실패 → 마지막 티어 채택(fail_system 표면화)", (await run(s5, new Set(["t0", "t1"]))) === "fail_system");

  // 6) tier 투영: 티어 서브그래프 내 노드가 node.<id>.tier 로 분기(관측).
  const s6: CompiledScenario = {
    start: "F",
    nodes: {
      F: fb([{ tier: "T0", entryNode: "t0" }]),
      t0: { what: [{ type: "act" }], flow: { kind: "next", target: "check" } },
      check: onNode([{ when: ast('node.t0.tier == "T0"'), target: "matched", priority: 1 }]),
      matched: actTerm("tier_matched"),
    },
  };
  check("tier 투영: node.t0.tier == 'T0' 분기 → matched", (await run(s6, new Set())) === "tier_matched");

  // 7) advance_when params 스코프: force=true → 전환(T1), force=false → T0.
  const s7: CompiledScenario = {
    start: "F",
    nodes: { F: fb([{ tier: "T0", entryNode: "t0", advanceWhen: ast("params.force == true") }, { tier: "T1", entryNode: "t1" }]), t0: actTerm("t0_done"), t1: actTerm("t1_done") },
  };
  check("advance_when params 스코프: force=true → T1", (await run(s7, new Set(), { force: true })) === "t1_done");
  check("advance_when params 스코프: force=false → T0", (await run(s7, new Set(), { force: false })) === "t0_done");

  // 8) 3티어 T0·T1 실패 → T2 success 채택.
  const s8: CompiledScenario = {
    start: "F",
    nodes: { F: fb([{ tier: "T0", entryNode: "t0" }, { tier: "T1", entryNode: "t1" }, { tier: "T2", entryNode: "t2" }]), t0: actTerm("a"), t1: actTerm("b"), t2: actTerm("t2_done") },
  };
  check("3티어 T0·T1 실패 → T2 채택", (await run(s8, new Set(["t0", "t1"]))) === "t2_done");

  // 9) break-it P2: advance_when 이 실패 티어 status 참조 — t0 실패 + advance_when="node.t0.status == failed_system" →
  //    실패 노드 status 도 투영되어 정상 advance(예전엔 IREL_RUNTIME_MISSING throw). 가장 흔한 fallback 패턴.
  const s9: CompiledScenario = {
    start: "F",
    nodes: { F: fb([{ tier: "T0", entryNode: "t0", advanceWhen: ast('node.t0.status == "failed_system"') }, { tier: "T1", entryNode: "t1" }]), t0: actTerm("t0_done"), t1: actTerm("t1_done") },
  };
  check("실패 티어 status 투영: advance_when node.t0.status==failed_system → T1(throw 아님)", (await run(s9, new Set(["t0"]))) === "t1_done");

  // 10) break-it P3: 마지막 티어 advance_when 은 평가 안 함(무의미·side-effect/spurious throw 방지) — 부재 노드 참조여도 채택.
  const s10: CompiledScenario = {
    start: "F",
    nodes: { F: fb([{ tier: "T0", entryNode: "t0" }, { tier: "T1", entryNode: "t1", advanceWhen: ast('node.absent.status == "success"') }]), t0: actTerm("a"), t1: actTerm("t1_done") },
  };
  check("마지막 티어 advance_when 미평가(부재참조여도 throw 아님) → 채택", (await run(s10, new Set(["t0"]))) === "t1_done");

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 fallback_chain — 티어 순서·advance_when·마지막티어 채택·tier 투영 (RQ-002)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-fallback unit fatal:", e);
  process.exit(1);
});
