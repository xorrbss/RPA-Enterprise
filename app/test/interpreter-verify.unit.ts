/**
 * 단위 — P0b: node.verify 결정형 실행 + self-heal 재시도 라우팅 (인터프리터). 외부 의존 없음.
 *
 * 검증:
 *  - verify 전부 pass → 흐름 진행(success), 재시도 없음.
 *  - on_fail=self_heal + read-only + budget·max_self_heal 내: verify 실패 → 노드 재실행(execute 에 selfHealRetry 전파,
 *    executeAct 가 markSuspect+재해소) → 재시도서 pass 면 success(자가복구); max_self_heal 소진 시 loud fail_business.
 *  - ⚠쓰기 커밋(비-read_only sideEffect) 노드는 verify 실패해도 재실행 금지(double-commit 안전) → loud fail_business.
 *  - on_fail≠self_heal(예 abort_security) → 재시도 없이 loud fail_business.
 *  - node.verify 미지정 → executor.verify 미호출(기존 동작 보존). 실행: tsx test/interpreter-verify.unit.ts.
 */
import type { ExecutorPlugin, PageState, RunContext, StepResult, VerifyResult } from "../../ts/core-types";
import { runScenario, type CompiledScenario, type NodeVerify } from "../src/runtime/ir-interpreter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const cannedPageState: PageState = {
  url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
  dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
  auth: "anonymous",
  flags: {},
  matchedWhere: [],
};
const fakeResolver = { resolvePageState: async (): Promise<PageState> => cannedPageState };

function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "n", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: cannedPageState,
  };
}

function baseStep(): StepResult {
  return {
    stepId: "s", action: "act", status: "success",
    pageStateBefore: "ps_before", pageStateAfter: "ps_after",
    artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
  };
}

const PASS: VerifyResult = { status: "pass", confidence: 1, failedCriteria: [], evidenceRefs: [], recommendation: "continue" };
const FAIL: VerifyResult = { status: "fail_det", confidence: 1, failedCriteria: ["element_visible"], evidenceRefs: [], recommendation: "self_heal" };

function mockExec(opts: { verdicts: readonly VerifyResult[]; sideEffect?: StepResult["sideEffect"] }) {
  const calls = { execute: 0, verify: 0, retryExecutes: 0 };
  const exec: ExecutorPlugin = {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async (_stepId: string, _action: unknown, c: RunContext): Promise<StepResult> => {
      calls.execute += 1;
      if (c.selfHealRetry === true) calls.retryExecutes += 1;
      return opts.sideEffect ? { ...baseStep(), sideEffect: opts.sideEffect } : baseStep();
    },
    verify: async (): Promise<VerifyResult> => {
      const v = opts.verdicts[Math.min(calls.verify, opts.verdicts.length - 1)] ?? PASS;
      calls.verify += 1;
      return v;
    },
  };
  return { exec, calls };
}

function nv(onFail: string, maxSelfHeal: number): NodeVerify {
  return { criteria: [{ type: "element_visible", target: { selector: "#ok" } }], onFail, maxSelfHeal };
}

function scenario(verify?: NodeVerify): CompiledScenario {
  return {
    start: "a",
    nodes: {
      a: { what: [{ type: "act" }], flow: { kind: "next", target: "done" }, ...(verify ? { verify } : {}) },
      done: { what: [], flow: { kind: "terminal", terminal: "success" } },
    },
  };
}

async function main(): Promise<void> {
  // 1) verify pass → success, 재시도 없음
  {
    const { exec, calls } = mockExec({ verdicts: [PASS] });
    const o = await runScenario(scenario(nv("self_heal", 2)), ctx(), { executor: exec, resolver: fakeResolver });
    check("verify pass → success(재시도 없음)", o.terminal === "success" && calls.execute === 1 && calls.retryExecutes === 0, JSON.stringify({ t: o.terminal, ...calls }));
  }
  // 2) fail→self_heal 재실행→pass→success (read-only 자가복구)
  {
    const { exec, calls } = mockExec({ verdicts: [FAIL, PASS] });
    const o = await runScenario(scenario(nv("self_heal", 2)), ctx(), { executor: exec, resolver: fakeResolver });
    check("verify fail→self_heal 재실행(selfHealRetry 전파)→pass→success", o.terminal === "success" && calls.execute === 2 && calls.retryExecutes === 1 && calls.verify === 2, JSON.stringify({ t: o.terminal, ...calls }));
  }
  // 3) 계속 실패 + max_self_heal=1 → 소진 → loud fail_business
  {
    const { exec, calls } = mockExec({ verdicts: [FAIL] });
    const o = await runScenario(scenario(nv("self_heal", 1)), ctx(), { executor: exec, resolver: fakeResolver });
    check("verify 계속 실패→max_self_heal(1) 소진→fail_business", o.terminal === "fail_business" && calls.execute === 2 && calls.retryExecutes === 1, JSON.stringify({ t: o.terminal, ...calls }));
  }
  // 4) ⚠쓰기 커밋 노드 → 재실행 금지(double-commit 안전) → fail_business
  {
    const { exec, calls } = mockExec({ verdicts: [FAIL, PASS], sideEffect: { kind: "submit", committed: true } });
    const o = await runScenario(scenario(nv("self_heal", 2)), ctx(), { executor: exec, resolver: fakeResolver });
    check("쓰기 커밋 노드 verify 실패→재실행 금지→fail_business", o.terminal === "fail_business" && calls.execute === 1 && calls.retryExecutes === 0, JSON.stringify({ t: o.terminal, ...calls }));
  }
  // 5) on_fail≠self_heal → 재시도 없이 fail_business
  {
    const { exec, calls } = mockExec({ verdicts: [FAIL, PASS] });
    const o = await runScenario(scenario(nv("abort_security", 2)), ctx(), { executor: exec, resolver: fakeResolver });
    check("on_fail=abort_security verify 실패→재시도 없이 fail_business", o.terminal === "fail_business" && calls.execute === 1 && calls.retryExecutes === 0, JSON.stringify({ t: o.terminal, ...calls }));
  }
  // 6) node.verify 미지정 → verify 미호출(기존 동작 보존)
  {
    const { exec, calls } = mockExec({ verdicts: [FAIL] });
    const o = await runScenario(scenario(undefined), ctx(), { executor: exec, resolver: fakeResolver });
    check("no node.verify → verify 미호출, success", o.terminal === "success" && calls.verify === 0 && calls.execute === 1, JSON.stringify({ t: o.terminal, ...calls }));
  }

  if (failures > 0) {
    console.error(`\n${failures} FAIL`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS: P0b interpreter verify + self-heal 재시도 green");
  }
}

void main();
