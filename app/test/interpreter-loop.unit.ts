/**
 * 단위 테스트 — 인터프리터 loop 실행 (RQ-002 loop feature).
 *
 * 외부 의존 없음(fake executor + 구성형 resolver, 순수). 실행: tsx test/interpreter-loop.unit.ts.
 * 검증(ir.schema loop·ir-expression §2·ir-static-validation V4):
 *  - while-loop 의미: body 서브그래프를 loop 노드로 사이클백하며 반복, until=true 시 exit_target 탈출.
 *  - loop.page_count/loop.iteration 스코프 주입(0-base body-pass 카운트).
 *  - max_iterations 도달 → exit_target graceful 탈출(무한루프 가드).
 *  - flags.* 도 loop until 에서 참조 가능(on[]과 동일 경계).
 *  - cursor.* 미투영 참조 → IREL_RUNTIME_MISSING(loud, 수집 파이프라인 소관 — 조용한 false 금지).
 */
import type { ExecutorPlugin, PageState, PageStateResolver, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import { runScenario, type CompiledScenario, type ScenarioOutcome } from "../src/runtime/ir-interpreter";

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
/** loop 노드 도착마다 호출되는 resolver. flags 시퀀스를 순서대로 반환(마지막 값 고정). */
function resolver(flagsSeq: Record<string, boolean>[] = [{}]): PageStateResolver {
  let i = 0;
  return {
    resolvePageState: async (): Promise<PageState> => {
      const flags = flagsSeq[Math.min(i, flagsSeq.length - 1)];
      i += 1;
      return { ...basePageState, flags };
    },
  };
}
function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "n", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: basePageState,
  };
}

/** loop 노드 L(body=B, exit=done) + body B(act, next:L) + done(terminal). */
function loopScenario(until: string, maxIterations: number): CompiledScenario {
  return {
    start: "L",
    nodes: {
      L: { what: [], flow: { kind: "loop", until: ast(until), bodyTarget: "B", exitTarget: "done", maxIterations } },
      B: { what: [{ type: "act" }], flow: { kind: "next", target: "L" } },
      done: { what: [], flow: { kind: "terminal", terminal: "success" } },
    },
  };
}

async function runFull(scenario: CompiledScenario, params: Record<string, unknown>, flagsSeq?: Record<string, boolean>[]): Promise<ScenarioOutcome> {
  return runScenario(scenario, ctx(), { executor: fakeExecutor, resolver: resolver(flagsSeq), params });
}
async function runThrows(scenario: CompiledScenario, params: Record<string, unknown>, flagsSeq?: Record<string, boolean>[]): Promise<unknown> {
  try {
    await runScenario(scenario, ctx(), { executor: fakeExecutor, resolver: resolver(flagsSeq), params });
    return undefined;
  } catch (e) {
    return e;
  }
}
const bodyPasses = (o: ScenarioOutcome): number => o.visited.filter((n) => n === "B").length;

async function main(): Promise<void> {
  // 1) loop.page_count 종료 — params.max_pages=3 이면 body 3회 후 탈출.
  const o1 = await runFull(loopScenario("loop.page_count >= params.max_pages", 10), { max_pages: 3 });
  check("page_count 종료: body 3회 pass", bodyPasses(o1) === 3, `passes=${bodyPasses(o1)}`);
  check("page_count 종료: exit_target(done) → success", o1.terminal === "success", o1.terminal);

  // 2) loop.iteration 종료 — iteration>=1 이면 body 1회 후 탈출(iter0→body, iter1→exit).
  const o2 = await runFull(loopScenario("loop.iteration >= 1", 10), {});
  check("iteration>=1 종료: body 1회 pass", bodyPasses(o2) === 1, `passes=${bodyPasses(o2)}`);

  // 3) max_iterations 도달 graceful 탈출 — until 영영 false(>=9999), max=2 → body 2회 후 exit.
  const o3 = await runFull(loopScenario("loop.page_count >= 9999", 2), {});
  check("max_iterations=2 cap: body 2회 후 graceful exit", bodyPasses(o3) === 2 && o3.terminal === "success", `passes=${bodyPasses(o3)} term=${o3.terminal}`);

  // 4) flags.* 도 until 에서 참조 — no_next_page 가 3번째 도착에 true → body 2회 후 탈출.
  const o4 = await runFull(loopScenario("flags.no_next_page", 10), {}, [
    { no_next_page: false }, { no_next_page: false }, { no_next_page: true },
  ]);
  check("flags.no_next_page 종료: body 2회 후 탈출", bodyPasses(o4) === 2, `passes=${bodyPasses(o4)}`);

  // 5) cursor.* 미투영 참조 → IREL_RUNTIME_MISSING(loud) — 수집 파이프라인 소관, 조용한 false 금지.
  const e5 = await runThrows(loopScenario('cursor.last_review_id == "x"', 10), {});
  check(
    "cursor.* 미투영 → IREL_RUNTIME_MISSING(loud)",
    e5 instanceof Error && (e5 as { code?: string }).code === "IREL_RUNTIME_MISSING",
    e5 instanceof Error ? `${(e5 as { code?: string }).code ?? ""}: ${e5.message}` : String(e5),
  );

  // 6) 즉시 종료 — until 첫 도착에 true(max_pages=0) → body 0회, 바로 exit.
  const o6 = await runFull(loopScenario("loop.page_count >= params.max_pages", 10), { max_pages: 0 });
  check("즉시 종료(max_pages=0): body 0회", bodyPasses(o6) === 0 && o6.terminal === "success", `passes=${bodyPasses(o6)}`);

  // 7) high max_iterations graceful exit(break-it P2): max=300, 기본 budget(deps.maxSteps 미지정)에서 iteration>=250
  //    까지 돌고 graceful exit(IR_LOOP_LIMIT 아님). graph_max_steps(200)가 loop 누적을 막지 않음 = 두 가드 독립(D8-A7/A8).
  const o7 = await runFull(loopScenario("loop.iteration >= 250", 300), {});
  check("high max_iterations(300): iteration>=250 graceful exit(IR_LOOP_LIMIT 아님)", bodyPasses(o7) === 250 && o7.terminal === "success", `passes=${bodyPasses(o7)} term=${o7.terminal}`);

  // 8) until 참조 flag 를 resolver 가 누락 → IREL_RUNTIME_MISSING(loud). IREL eager-OR(non short-circuit)·조용한 false 금지.
  //    (플랫폼 IREL evaluator 동작 — on[]과 동형. 미설정 flag 를 false로 단락하지 않음.) resolver flags={}(no_next_page 미제공).
  const e8 = await runThrows(loopScenario("flags.no_next_page || loop.page_count >= params.max_pages", 10), { max_pages: 3 }, [{}]);
  check(
    "until 참조 flag 누락 → IREL_RUNTIME_MISSING(loud)",
    e8 instanceof Error && (e8 as { code?: string }).code === "IREL_RUNTIME_MISSING",
    e8 instanceof Error ? `${(e8 as { code?: string }).code ?? ""}: ${e8.message}` : String(e8),
  );

  // 9) loop 노드의 what 은 매 도착(탈출 도착 포함)마다 실행 — 컨트롤 포인트(D8-A8; 작업은 body_target에). iteration+1회.
  {
    let loopNodeExec = 0;
    const exec: ExecutorPlugin = {
      ...fakeExecutor,
      execute: async (stepId: string): Promise<StepResult> => {
        if (stepId.startsWith("L.")) loopNodeExec += 1;
        return stepResult("success");
      },
    };
    const scn: CompiledScenario = {
      start: "L",
      nodes: {
        L: { what: [{ type: "act" }], flow: { kind: "loop", until: ast("loop.iteration >= 2"), bodyTarget: "B", exitTarget: "done", maxIterations: 10 } },
        B: { what: [{ type: "act" }], flow: { kind: "next", target: "L" } },
        done: { what: [], flow: { kind: "terminal", terminal: "success" } },
      },
    };
    const o9 = await runScenario(scn, ctx(), { executor: exec, resolver: resolver(), params: {} });
    // iter0→body, iter1→body, iter2(2>=2)→exit. body 2회, L 도착 3회(탈출 포함) → L.what 3회.
    check("loop 노드 what: 매 도착(탈출 포함) 실행(iterations+1)", loopNodeExec === 3 && bodyPasses(o9) === 2, `loopNodeExec=${loopNodeExec} passes=${bodyPasses(o9)}`);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 loop — while-loop·loop.page_count/iteration·max_iterations cap·flags·cursor loud (RQ-002)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-loop unit fatal:", e);
  process.exit(1);
});
