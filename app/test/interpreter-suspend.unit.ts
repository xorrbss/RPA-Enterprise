/**
 * 단위 — 인터프리터 suspend outcome (트리거 i: executor status='suspended' / 트리거 ii: @human_task IR 노드). 외부 의존 없음.
 *
 * 검증: 트리거 i status='suspended' → terminal "suspend" + ChallengeSuspendContext(kind=challenge·challengeKind=captcha·
 * resumeNodeId=같은 노드·pageStateRef=res.pageStateAfter). 트리거 ii @human_task → HumanTaskSuspendContext(kind=human_task·
 * humanTaskKind=input.kind(미지정 exception)·assigneeRole·onTimeout(미지정 fail)·resumeNodeId=return_node). assignee_role
 * 부재/kind 오류 → IR_SCHEMA_INVALID, @challenge → RESERVED_HANDLER_UNSUPPORTED. failed_business → terminal(suspend 아님).
 * 기타 미지원 status(skipped) → EXECUTOR_STATUS_UNSUPPORTED(조용한 false/unknown 금지). 실행: tsx test/interpreter-suspend.unit.ts.
 */
import type { ChallengeSummary, ClassifiedException, ExecutorPlugin, PageState, RedactedString, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function challenge(type: ChallengeSummary["type"]): ChallengeSummary {
  return { type, detectedBy: "dom", confidence: 1 };
}

function stepResult(status: StepStatus, exception?: ClassifiedException, ch?: ChallengeSummary): StepResult {
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
    ...(ch !== undefined ? { challenge: ch } : {}),
  };
}

function executorReturning(status: StepStatus, exception?: ClassifiedException, ch?: ChallengeSummary): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async () => stepResult(status, exception, ch),
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
  // 1) suspended(challenge=captcha) → suspend outcome + SuspendContext.challengeKind=captcha.
  {
    const exc: ClassifiedException = { class: "challenge", code: "CHALLENGE_UNRESOLVED", message: "captcha" as RedactedString };
    const o = await runScenario(scenario, ctx(), { executor: executorReturning("suspended", exc, challenge("captcha")), resolver: fakeResolver });
    check("terminal === 'suspend'", o.terminal === "suspend", o.terminal);
    check("suspend.resumeNodeId === 'challenge' (같은 노드 재진입)", o.suspend?.resumeNodeId === "challenge", o.suspend?.resumeNodeId);
    check("suspend.kind === 'challenge'", o.suspend?.kind === "challenge", o.suspend?.kind);
    check("suspend.challengeKind === 'captcha'", o.suspend?.kind === "challenge" && o.suspend.challengeKind === "captcha", JSON.stringify(o.suspend));
    check("suspend.stepId === 'challenge.0'", o.suspend?.stepId === "challenge.0", o.suspend?.stepId);
    check("suspend.attempt === 0", o.suspend?.attempt === 0, String(o.suspend?.attempt));
    check("suspend.pageStateRef === res.pageStateAfter('ps_after')", o.suspend?.pageStateRef === "ps_after", o.suspend?.pageStateRef);
    check("suspend.exception 전파(class=challenge)", o.suspend?.exception?.class === "challenge");
    check("visited 에 challenge 포함", o.visited.includes("challenge"));
  }

  // 2) suspended(challenge=mfa) → challengeKind=mfa(하드코딩 제거 검증 — captcha 로 오라벨링 안 됨).
  {
    const o = await runScenario(scenario, ctx(), { executor: executorReturning("suspended", undefined, challenge("mfa")), resolver: fakeResolver });
    check("suspend.challengeKind === 'mfa' (executor 신호 반영)", o.terminal === "suspend" && o.suspend?.kind === "challenge" && o.suspend.challengeKind === "mfa", JSON.stringify(o.suspend));
    check("exception 없는 suspend → suspend.exception undefined", o.suspend?.exception === undefined);
  }

  // 3) suspended 인데 challenge 부재 → 조용한 captcha 폴백 금지: EXECUTOR_STATUS_UNSUPPORTED throw.
  {
    let threw: unknown;
    try {
      await runScenario(scenario, ctx(), { executor: executorReturning("suspended"), resolver: fakeResolver });
    } catch (e) {
      threw = e;
    }
    check(
      "challenge 부재 suspend → EXECUTOR_STATUS_UNSUPPORTED throw",
      threw instanceof Error && (threw as { code?: string }).code === "EXECUTOR_STATUS_UNSUPPORTED",
      String(threw),
    );
  }

  // 4) suspended 인데 challenge.type 이 human-assist 아님(block_page) → throw(captcha|mfa 만 suspend).
  {
    let threw: unknown;
    try {
      await runScenario(scenario, ctx(), { executor: executorReturning("suspended", undefined, challenge("block_page")), resolver: fakeResolver });
    } catch (e) {
      threw = e;
    }
    check(
      "challenge.type='block_page' suspend → EXECUTOR_STATUS_UNSUPPORTED throw",
      threw instanceof Error && (threw as { code?: string }).code === "EXECUTOR_STATUS_UNSUPPORTED",
      String(threw),
    );
  }

  // 5) failed_business → terminal(suspend 아님).
  {
    const o = await runScenario(scenario, ctx(), { executor: executorReturning("failed_business"), resolver: fakeResolver });
    check("failed_business → terminal 'fail_business' (suspend 아님)", o.terminal === "fail_business" && o.suspend === undefined, o.terminal);
  }

  // 6) 기타 미지원 status(skipped) → EXECUTOR_STATUS_UNSUPPORTED throw(조용한 false 금지).
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

  // 6) @human_task(R5, 트리거 ii): reserved_handler next-target → suspend(human_task). what-less/what 양쪽 + 거부 경로.
  const htScenario = (input: Record<string, unknown>, what: unknown[] = []): CompiledScenario => ({
    start: "task",
    nodes: {
      task: { what, flow: { kind: "reserved_handler", handler: "@human_task", input, returnNode: "after" } },
      after: { what: [], flow: { kind: "terminal", terminal: "success" } },
    },
  });
  const htDeps = () => ({ executor: executorReturning("success"), resolver: fakeResolver });
  {
    const o = await runScenario(htScenario({ kind: "approval", assignee_role: "approver" }), ctx(), htDeps());
    check("@human_task → terminal 'suspend'", o.terminal === "suspend", o.terminal);
    check("@human_task suspend.kind === 'human_task'", o.suspend?.kind === "human_task", o.suspend?.kind);
    if (o.suspend?.kind === "human_task") {
      check("humanTaskKind === 'approval'", o.suspend.humanTaskKind === "approval", o.suspend.humanTaskKind);
      check("assigneeRole === 'approver'", o.suspend.assigneeRole === "approver", o.suspend.assigneeRole);
      check("onTimeout === 'fail'(기본)", o.suspend.onTimeout === "fail", o.suspend.onTimeout);
      check("resumeNodeId === 'after'(return_node 재개)", o.suspend.resumeNodeId === "after", o.suspend.resumeNodeId);
      check("stepId === 'task.@human_task'", o.suspend.stepId === "task.@human_task", o.suspend.stepId);
      check("pageStateRef === 'ps_h'(what-less → ctx.pageState ref)", o.suspend.pageStateRef === "ps_h", o.suspend.pageStateRef);
    }
    check("@human_task suspend → exception 부재(challenge 전용)", o.suspend?.exception === undefined);
    check("visited=task only(suspend 전 after 미도달)", o.visited.join(",") === "task", o.visited.join(","));
  }
  {
    // kind 미지정 → exception 기본(R5: 하드코딩 금지 + 미지정 exception).
    const o = await runScenario(htScenario({ assignee_role: "ops" }), ctx(), htDeps());
    check("@human_task kind 미지정 → 'exception' 기본", o.suspend?.kind === "human_task" && o.suspend.humanTaskKind === "exception", JSON.stringify(o.suspend));
  }
  {
    // on_timeout=escalate 투영(H4b).
    const o = await runScenario(htScenario({ kind: "validation", assignee_role: "reviewer", on_timeout: "escalate" }), ctx(), htDeps());
    check("@human_task on_timeout=escalate 투영", o.suspend?.kind === "human_task" && o.suspend.onTimeout === "escalate", JSON.stringify(o.suspend));
  }
  {
    // what 실행 노드 → pageStateRef = 마지막 StepResult.pageStateAfter(challenge 와 동일 출처).
    const o = await runScenario(htScenario({ kind: "approval", assignee_role: "approver" }, [{ type: "act" }]), ctx(), htDeps());
    check("@human_task what 실행 시 pageStateRef = res.pageStateAfter('ps_after')", o.suspend?.kind === "human_task" && o.suspend.pageStateRef === "ps_after", JSON.stringify(o.suspend));
  }
  {
    // assignee_role 부재 → IR_SCHEMA_INVALID(미할당 task 금지, 조용한 false 금지).
    let threw: unknown;
    try { await runScenario(htScenario({ kind: "approval" }), ctx(), htDeps()); } catch (e) { threw = e; }
    check("@human_task assignee_role 부재 → IR_SCHEMA_INVALID throw", threw instanceof Error && (threw as { code?: string }).code === "IR_SCHEMA_INVALID", String(threw));
  }
  {
    // kind 비정상 값 → IR_SCHEMA_INVALID(approval/validation/exception 외, 오라우팅 금지).
    let threw: unknown;
    try { await runScenario(htScenario({ kind: "weird", assignee_role: "ops" }), ctx(), htDeps()); } catch (e) { threw = e; }
    check("@human_task kind 'weird' → IR_SCHEMA_INVALID throw", threw instanceof Error && (threw as { code?: string }).code === "IR_SCHEMA_INVALID", String(threw));
  }
  {
    // @challenge reserved-handler 노드 → RESERVED_HANDLER_UNSUPPORTED(ResolutionPolicy 미구현, 조용한 false 금지).
    const challengeNode: CompiledScenario = {
      start: "c",
      nodes: {
        c: { what: [], flow: { kind: "reserved_handler", handler: "@challenge", input: {}, returnNode: "after" } },
        after: { what: [], flow: { kind: "terminal", terminal: "success" } },
      },
    };
    let threw: unknown;
    try { await runScenario(challengeNode, ctx(), htDeps()); } catch (e) { threw = e; }
    check("@challenge reserved-handler → RESERVED_HANDLER_UNSUPPORTED throw", threw instanceof Error && (threw as { code?: string }).code === "RESERVED_HANDLER_UNSUPPORTED", String(threw));
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 suspend outcome(challenge i + @human_task ii) + startNode 재진입 (A.1 suspend/resume)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-suspend unit fatal:", e);
  process.exit(1);
});
