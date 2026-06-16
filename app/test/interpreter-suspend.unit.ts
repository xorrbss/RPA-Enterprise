/**
 * 단위 — 인터프리터 suspend outcome (트리거 i: executor step status='suspended'). 외부 의존 없음.
 *
 * 검증: status='suspended' → terminal "suspend" + SuspendContext(resumeNodeId=같은 노드·challengeKind=captcha·
 * stepId·attempt·pageStateRef=res.pageStateAfter). failed_business → terminal(suspend 아님). 기타 미지원 status(skipped)
 * → EXECUTOR_STATUS_UNSUPPORTED throw(조용한 false/unknown 금지). 실행: tsx test/interpreter-suspend.unit.ts.
 */
import type { ClassifiedException, ExecutorPlugin, PageState, RedactedString, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function stepResult(status: StepStatus, exception?: ClassifiedException): StepResult {
  return {
    stepId: "s",
    action: "act",
    status,
    pageStateBefore: "ps_before",
    pageStateAfter: "ps_after",
    artifacts: [],
    cache: { mode: "bypass" },
    timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
    ...(exception !== undefined ? { exception } : {}),
  };
}

function executorReturning(status: StepStatus, exception?: ClassifiedException): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async () => stepResult(status, exception),
    verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
  };
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

// 단일 노드 시나리오: challenge 노드의 what 액션이 executor status 를 좌우(flow 는 도달 안 함 — what 실행 중 분기).
const scenario: CompiledScenario = {
  start: "challenge",
  nodes: { challenge: { what: [{ type: "act" }], flow: { kind: "terminal", terminal: "success" } } },
};

async function main(): Promise<void> {
  // 1) suspended → suspend outcome + SuspendContext.
  {
    const exc: ClassifiedException = { class: "challenge", code: "CHALLENGE_UNRESOLVED", message: "captcha" as RedactedString };
    const o = await runScenario(scenario, ctx(), { executor: executorReturning("suspended", exc), resolver: fakeResolver });
    check("terminal === 'suspend'", o.terminal === "suspend", o.terminal);
    check("suspend.resumeNodeId === 'challenge' (같은 노드 재진입)", o.suspend?.resumeNodeId === "challenge", o.suspend?.resumeNodeId);
    check("suspend.challengeKind === 'captcha'", o.suspend?.challengeKind === "captcha", o.suspend?.challengeKind);
    check("suspend.stepId === 'challenge.0'", o.suspend?.stepId === "challenge.0", o.suspend?.stepId);
    check("suspend.attempt === 0", o.suspend?.attempt === 0, String(o.suspend?.attempt));
    check("suspend.pageStateRef === res.pageStateAfter('ps_after')", o.suspend?.pageStateRef === "ps_after", o.suspend?.pageStateRef);
    check("suspend.exception 전파(class=challenge)", o.suspend?.exception?.class === "challenge");
    check("visited 에 challenge 포함", o.visited.includes("challenge"));
  }

  // 2) suspended without exception → exception 부재(optional).
  {
    const o = await runScenario(scenario, ctx(), { executor: executorReturning("suspended"), resolver: fakeResolver });
    check("exception 없는 suspend → suspend.exception undefined", o.terminal === "suspend" && o.suspend?.exception === undefined);
  }

  // 3) failed_business → terminal(suspend 아님).
  {
    const o = await runScenario(scenario, ctx(), { executor: executorReturning("failed_business"), resolver: fakeResolver });
    check("failed_business → terminal 'fail_business' (suspend 아님)", o.terminal === "fail_business" && o.suspend === undefined, o.terminal);
  }

  // 4) 기타 미지원 status(skipped) → EXECUTOR_STATUS_UNSUPPORTED throw(조용한 false 금지).
  {
    let threw: unknown;
    try {
      await runScenario(scenario, ctx(), { executor: executorReturning("skipped"), resolver: fakeResolver });
    } catch (e) {
      threw = e;
    }
    check(
      "skipped → EXECUTOR_STATUS_UNSUPPORTED throw",
      threw instanceof Error && (threw as { code?: string }).code === "EXECUTOR_STATUS_UNSUPPORTED",
      String(threw),
    );
  }

  // 5) startNode 재진입(resume): deps.startNode 지정 시 그 노드부터 순회(scenario.start 무시).
  {
    const twoNode: CompiledScenario = {
      start: "a",
      nodes: {
        a: { what: [], flow: { kind: "next", target: "b" } },
        b: { what: [], flow: { kind: "terminal", terminal: "success" } },
      },
    };
    const fromStart = await runScenario(twoNode, ctx(), { executor: executorReturning("success"), resolver: fakeResolver });
    check("startNode 미지정 → scenario.start(a)부터 (a,b)", fromStart.visited.join(",") === "a,b", fromStart.visited.join(","));
    const fromB = await runScenario(twoNode, ctx(), { executor: executorReturning("success"), resolver: fakeResolver, startNode: "b" });
    check("startNode='b' → b부터 재진입(a 스킵)", fromB.visited.join(",") === "b" && fromB.terminal === "success", fromB.visited.join(","));
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 suspend outcome + startNode 재진입 (A.1 suspend/resume)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-suspend unit fatal:", e);
  process.exit(1);
});
