/**
 * 단위 — P0b 슬라이스1: node.verify 결정형 실행 + fail-loud 라우팅 (인터프리터). 외부 의존 없음.
 *
 * 검증: verify 전부 pass → 흐름 진행(terminal success); 첫 criterion fail_det → loud "fail_business"(조용한 통과 금지);
 * node.verify 미지정 → executor.verify 미호출(기존 동작 보존); criteria 다수면 첫 실패에서 중단(나머지 미평가).
 * self-heal(markSuspect+재시도)은 후속 슬라이스라 본 슬라이스는 재시도 없이 loud fail 만 검증. 실행: tsx test/interpreter-verify.unit.ts.
 */
import type { ExecutorPlugin, PageState, RunContext, StepResult, VerifyResult } from "../../ts/core-types";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";

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

function stepResult(): StepResult {
  return {
    stepId: "s", action: "act", status: "success",
    pageStateBefore: "ps_before", pageStateAfter: "ps_after",
    artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
  };
}

const PASS: VerifyResult = { status: "pass", confidence: 1, failedCriteria: [], evidenceRefs: [], recommendation: "continue" };
const FAIL: VerifyResult = { status: "fail_det", confidence: 1, failedCriteria: ["element_visible"], evidenceRefs: [], recommendation: "retry_same" };

function executorWithVerify(verdicts: readonly VerifyResult[]) {
  const calls = { verify: 0, execute: 0 };
  const exec: ExecutorPlugin = {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async () => { calls.execute += 1; return stepResult(); },
    verify: async (): Promise<VerifyResult> => {
      const v = verdicts[Math.min(calls.verify, verdicts.length - 1)] ?? PASS;
      calls.verify += 1;
      return v;
    },
  };
  return { exec, calls };
}

function scenario(verify?: { criteria: readonly unknown[] }): CompiledScenario {
  return {
    start: "a",
    nodes: {
      a: { what: [{ type: "act" }], flow: { kind: "next", target: "done" }, ...(verify ? { verify } : {}) },
      done: { what: [], flow: { kind: "terminal", terminal: "success" } },
    },
  };
}

const oneCriterion = { criteria: [{ type: "element_visible", target: { selector: "#ok" } }] };
const twoCriteria = { criteria: [{ type: "element_visible", target: { selector: "#a" } }, { type: "min_rows", selector: "#b", n: 1 }] };

async function main(): Promise<void> {
  // 1) verify pass → 흐름 진행(success), verify 1회 호출
  {
    const { exec, calls } = executorWithVerify([PASS]);
    const o = await runScenario(scenario(oneCriterion), ctx(), { executor: exec, resolver: fakeResolver });
    check("verify pass → terminal success", o.terminal === "success" && calls.verify === 1, JSON.stringify({ t: o.terminal, v: calls.verify }));
  }
  // 2) verify fail_det → loud fail_business (재시도 없음)
  {
    const { exec, calls } = executorWithVerify([FAIL]);
    const o = await runScenario(scenario(oneCriterion), ctx(), { executor: exec, resolver: fakeResolver });
    check("verify fail_det → loud fail_business", o.terminal === "fail_business" && calls.verify === 1, JSON.stringify({ t: o.terminal, v: calls.verify }));
  }
  // 3) node.verify 미지정 → executor.verify 미호출(기존 동작 보존)
  {
    const { exec, calls } = executorWithVerify([FAIL]);
    const o = await runScenario(scenario(undefined), ctx(), { executor: exec, resolver: fakeResolver });
    check("no node.verify → verify 미호출, success", o.terminal === "success" && calls.verify === 0, JSON.stringify({ t: o.terminal, v: calls.verify }));
  }
  // 4) criteria 다수 — 첫 실패에서 중단(둘째 미평가)
  {
    const { exec, calls } = executorWithVerify([FAIL, PASS]);
    const o = await runScenario(scenario(twoCriteria), ctx(), { executor: exec, resolver: fakeResolver });
    check("multi-criteria 첫 실패에서 중단", o.terminal === "fail_business" && calls.verify === 1, JSON.stringify({ t: o.terminal, v: calls.verify }));
  }

  if (failures > 0) {
    console.error(`\n${failures} FAIL`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS: P0b 슬라이스1 interpreter verify(결정형 실행 + fail-loud) green");
  }
}

void main();
