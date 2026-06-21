/**
 * 단위 테스트 — 인터프리터가 §E `executor.execute` span 을 발행하는가(attr: node_id/action/executor + 공통 attr).
 *
 * 배경: 이 span 은 과거 (테스트 전용으로 휴면이던) PgExecutorStepOrchestrator 만 발행했고, 그 제거(README v2.29)로
 * production step 실행기 ir-interpreter 가 span 없이 executor.execute 를 호출하던 잠복 갭이 드러났다. 본 패치가
 * ir-interpreter 의 executor 호출을 withSpan(SPAN.executorExecute) 로 래핑해 §E 계약(impl-contracts-bundle: node_id/
 * action/executor)을 production 에서 충족함을 핀고정한다. 외부 의존 없음(InMemorySpanExporter + fake executor, 순수).
 *
 * 실행: tsx test/interpreter-span.unit.ts.
 */
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import type { ExecutorPlugin, PageState, RunContext, StepResult, VerifyResult } from "../../ts/core-types";
import { bootstrapTracing } from "../src/observability/bootstrap";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";

const spanExporter = new InMemorySpanExporter();
bootstrapTracing(spanExporter);

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

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "11111111-1111-1111-1111-1111111111aa",
    tenantId: "11111111-1111-1111-1111-111111111111",
    nodeId: "n",
    attempt: 0,
    siteProfileId: "s",
    browserIdentityId: "b",
    networkPolicyId: "np",
    leaseId: "l",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: cannedPageState,
    ...overrides,
  };
}

function stepResult(action: StepResult["action"], status: StepResult["status"]): StepResult {
  return {
    stepId: "s",
    action,
    status,
    pageStateBefore: "ps",
    pageStateAfter: "ps",
    artifacts: [],
    cache: { mode: "bypass" },
    timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
  };
}

const verify = async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult;

// 한 노드(go=navigate 실행)→done(terminal). go 실행이 executor.execute span 1건을 낸다.
const scenario: CompiledScenario = {
  start: "go",
  nodes: {
    go: { what: [{ type: "navigate" }], flow: { kind: "next", target: "done" } },
    done: { what: [], flow: { kind: "terminal", terminal: "success" } },
  },
};

function execSpan() {
  return spanExporter.getFinishedSpans().find((s) => s.name === "executor.execute");
}

async function main(): Promise<void> {
  // 1) utility executor, navigate 노드 → span node_id=go·action=navigate·executor=utility·status=success + 공통 attr.
  spanExporter.reset();
  const utilityExecutor: ExecutorPlugin = {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async () => stepResult("navigate", "success"),
    verify,
  };
  const out = await runScenario(scenario, ctx({ correlationId: "22222222-2222-2222-2222-2222222222cc" }), {
    executor: utilityExecutor,
    resolver: fakeResolver,
  });
  check("실행 완료(terminal success)", out.terminal === "success", out.terminal);
  const s1 = execSpan();
  check("executor.execute span 발행됨", s1 !== undefined);
  check("span attr node_id=go", s1?.attributes.node_id === "go", JSON.stringify(s1?.attributes));
  check("span attr action=navigate(StepResult.action 투영)", s1?.attributes.action === "navigate", JSON.stringify(s1?.attributes));
  check("span attr executor=utility(capability 라벨)", s1?.attributes.executor === "utility", JSON.stringify(s1?.attributes));
  check("span attr status=success", s1?.attributes.status === "success", JSON.stringify(s1?.attributes));
  check("span 공통 attr tenant_id/run_id", s1?.attributes.tenant_id === "11111111-1111-1111-1111-111111111111" && s1?.attributes.run_id === "11111111-1111-1111-1111-1111111111aa");
  check("span 공통 attr correlation_id=ctx.correlationId", s1?.attributes.correlation_id === "22222222-2222-2222-2222-2222222222cc", String(s1?.attributes.correlation_id));

  // 2) dom+vision executor → executor 라벨 "dom+vision"(활성 capability 결합).
  spanExporter.reset();
  const domVisionExecutor: ExecutorPlugin = {
    capabilities: () => ({ dom: true, vision: true, utility: false }),
    execute: async () => stepResult("act", "success"),
    verify,
  };
  await runScenario(scenario, ctx(), { executor: domVisionExecutor, resolver: fakeResolver });
  check("span executor=dom+vision(다중 capability)", execSpan()?.attributes.executor === "dom+vision", JSON.stringify(execSpan()?.attributes));

  // 3) correlationId 미주입 → span correlation_id = run_id 폴백(RunContext 문서화된 §E 폴백).
  spanExporter.reset();
  await runScenario(scenario, ctx(), { executor: domVisionExecutor, resolver: fakeResolver });
  check("correlation 미주입 → span correlation_id=run_id 폴백", execSpan()?.attributes.correlation_id === "11111111-1111-1111-1111-1111111111aa", String(execSpan()?.attributes.correlation_id));

  // 4) executor throw → span 은 error 로 기록되고 예외는 재던져진다(withSpan record+ERROR+rethrow, throw 전파 보존).
  spanExporter.reset();
  const throwingExecutor: ExecutorPlugin = {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async () => {
      throw new Error("boom");
    },
    verify,
  };
  let threw = false;
  try {
    await runScenario(scenario, ctx(), { executor: throwingExecutor, resolver: fakeResolver });
  } catch {
    threw = true;
  }
  check("executor throw → runScenario 재던짐(throw 전파 보존)", threw);
  const s4 = execSpan();
  check("throw 시에도 executor.execute span 종료·기록", s4 !== undefined);
  check("throw span status=ERROR(record+ERROR)", s4?.status.code === SpanStatusCode.ERROR, JSON.stringify(s4?.status));

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: interpreter executor.execute §E span green");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-span unit fatal:", e);
  process.exit(1);
});
