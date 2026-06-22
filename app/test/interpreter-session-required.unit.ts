/**
 * 단위 — login_required 페이지상태에서 그것을 처리하는 on[] 분기가 없으면, 모호한 IR_NO_BRANCH_MATCHED 대신
 * SessionRegistrationRequiredError(SESSION_REGISTRATION_REQUIRED)로 분류한다(세션 (재)등록 필요 표면화).
 * self-login 시나리오(login_required 분기 보유)는 분기가 매칭돼 분류되지 않는다(오탐 0). login_required 가 아니면
 * 기존 NoBranchMatchedError 를 유지(과분류 금지). 외부 의존 없음(fake executor+resolver). 실행: tsx test/interpreter-session-required.unit.ts.
 */
import type { ExecutorPlugin, PageState, PageStateResolver, RedactedString, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import type { CompiledOnBranch } from "../src/runtime/flow-control";
import { NoBranchMatchedError, SessionRegistrationRequiredError } from "../src/runtime/flow-control";
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
function makeExecutor(): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async (): Promise<StepResult> => stepResult("success"),
    verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
  };
}
const basePageState: PageState = {
  url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
  dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
  auth: "anonymous", flags: {}, matchedWhere: [],
};
function resolver(flags: Record<string, boolean>): PageStateResolver {
  return { resolvePageState: async (): Promise<PageState> => ({ ...basePageState, flags }) };
}
function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "gate", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: basePageState,
  };
}

type Node = CompiledScenario["nodes"][string];
const onNode = (branches: CompiledOnBranch<string>[]): Node => ({ what: [], flow: { kind: "on", branches } });
const actTerm = (terminal: string): Node => ({ what: [{ type: "act" }], flow: { kind: "terminal", terminal } });

async function run(scenario: CompiledScenario, flags: Record<string, boolean>): Promise<string> {
  const o = await runScenario(scenario, ctx(), { executor: makeExecutor(), resolver: resolver(flags), params: {} });
  return o.terminal;
}
async function runCatch(scenario: CompiledScenario, flags: Record<string, boolean>): Promise<unknown> {
  try {
    await run(scenario, flags);
    return null;
  } catch (e) {
    return e;
  }
}

async function main(): Promise<void> {
  // 처리 분기(reviews_visible)만 있고 login_required 분기는 없는 게이트(= 세션을 가정하는 시나리오).
  const sNoHandle: CompiledScenario = {
    start: "gate",
    nodes: { gate: onNode([{ when: ast("flags.reviews_visible"), target: "ok", priority: 1 }]), ok: actTerm("success") },
  };

  // 1) login_required=true + 처리 분기 없음 → SessionRegistrationRequiredError.
  const e1 = await runCatch(sNoHandle, { login_required: true, reviews_visible: false });
  check("login_required + 무분기 → SessionRegistrationRequiredError", e1 instanceof SessionRegistrationRequiredError, String(e1));
  check("코드 = SESSION_REGISTRATION_REQUIRED", e1 instanceof SessionRegistrationRequiredError && e1.code === "SESSION_REGISTRATION_REQUIRED");

  // 2) login_required 분기 보유(self-login) → 분기 매칭·정상 라우팅(분류 안 함, 오탐 0).
  const sHandle: CompiledScenario = {
    start: "gate",
    nodes: {
      gate: onNode([
        { when: ast("flags.login_required"), target: "login", priority: 2 },
        { when: ast("flags.reviews_visible"), target: "ok", priority: 1 },
      ]),
      login: actTerm("relogin"),
      ok: actTerm("success"),
    },
  };
  check("login_required 분기 보유 → 매칭·라우팅(오탐 0)", (await run(sHandle, { login_required: true, reviews_visible: false })) === "relogin");

  // 3) login_required=false + 무분기 → 기존 NoBranchMatchedError 유지(과분류 금지).
  const e3 = await runCatch(sNoHandle, { login_required: false, reviews_visible: false });
  check(
    "login_required 아님 + 무분기 → NoBranchMatchedError 유지",
    e3 instanceof NoBranchMatchedError && !(e3 instanceof SessionRegistrationRequiredError),
    String(e3),
  );

  // 4) in-band 실행기 step 실패(exception 보유) → throw 아니라 runScenario 가 outcome.failureReason 로 사유 코드 운반.
  //    (driver 가 이 사유를 runs.failure_reason 으로 기록 — navigate wedge 등 흔한 실패의 사유 표면화 경로.)
  const failExec: ExecutorPlugin = {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async (): Promise<StepResult> => ({ ...stepResult("failed_system"), exception: { code: "CDP_DISCONNECTED", class: "system", message: "disconnected" as RedactedString } }),
    verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
  };
  const sFail: CompiledScenario = { start: "go", nodes: { go: actTerm("never") } };
  const oFail = await runScenario(sFail, ctx(), { executor: failExec, resolver: resolver({}), params: {} });
  check("in-band 실행기 실패 → terminal fail_system", oFail.terminal === "fail_system", oFail.terminal);
  check("in-band 실패 → outcome.failureReason.code = step exception", oFail.failureReason?.code === "CDP_DISCONNECTED", JSON.stringify(oFail.failureReason));

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 login_required → SESSION_REGISTRATION_REQUIRED 분류 (오탐 0·과분류 0)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-session-required unit fatal:", e);
  process.exit(1);
});
