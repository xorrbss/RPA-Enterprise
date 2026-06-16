/**
 * 단위 테스트 — 인터프리터 on[] 스코프(params.* / node.<id>.status) 배선 (RQ-002).
 *
 * 외부 의존 없음(fake executor + fake resolver, 순수). 실행: tsx test/interpreter-scope.unit.ts.
 * 검증:
 *  - params.* 분기: 값에 따라 다른 terminal 도달(스코프 주입 증명).
 *  - node.<id>.status 분기: 실행 완료 노드의 status 가 투영돼 매칭.
 *  - 미실행/부재 노드 참조 → IREL_RUNTIME_MISSING(node-missing 경로, loud).
 *  - **실행된 노드의 미투영 필드(row_count) 참조 → IREL_RUNTIME_MISSING(field-absent 경로, loud)** — DEFER 준수 증명(가정 금지).
 *
 * "조용한 false/unknown 금지": 미설정 스코프/필드는 false 단락이 아니라 IREL_RUNTIME_MISSING.
 */
import type { ExecutorPlugin, PageState, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
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
    stepId: "s",
    action: "act",
    status,
    pageStateBefore: "ps",
    pageStateAfter: "ps",
    artifacts: [],
    cache: { mode: "bypass" },
    timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
  };
}

// fake executor: 모든 액션 success. fake resolver: 빈 flags PageState.
const fakeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  execute: async () => stepResult("success"),
  verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
};
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

const term = (t: string): CompiledScenario["nodes"][string] => ({ what: [], flow: { kind: "terminal", terminal: t } });
const onNode = (branches: CompiledOnBranch<string>[]): CompiledScenario["nodes"][string] => ({ what: [], flow: { kind: "on", branches } });

async function run(scenario: CompiledScenario, params?: Record<string, unknown>): Promise<string> {
  const o = await runScenario(scenario, ctx(), { executor: fakeExecutor, resolver: fakeResolver, params });
  return o.terminal;
}

async function runThrows(scenario: CompiledScenario, params?: Record<string, unknown>): Promise<unknown> {
  try {
    await runScenario(scenario, ctx(), { executor: fakeExecutor, resolver: fakeResolver, params });
    return undefined;
  } catch (e) {
    return e;
  }
}

async function main(): Promise<void> {
  // 1) params.* 분기 — 값에 따라 다른 terminal.
  const paramsScenario: CompiledScenario = {
    start: "check",
    nodes: {
      check: onNode([
        { when: ast("params.max_pages > 0"), target: "hi", priority: 2 },
        { when: ast("params.max_pages == 0"), target: "lo", priority: 1 },
      ]),
      hi: term("success"),
      lo: term("success_empty"),
    },
  };
  check("params.max_pages=3 → hi(success)", (await run(paramsScenario, { max_pages: 3 })) === "success");
  check("params.max_pages=0 → lo(success_empty)", (await run(paramsScenario, { max_pages: 0 })) === "success_empty");

  // 2) node.<id>.status 분기 — 실행 완료 노드의 status 투영.
  const nodeStatusScenario: CompiledScenario = {
    start: "grab",
    nodes: {
      grab: { what: [{ type: "act" }], flow: { kind: "next", target: "check" } }, // 실행 → nodeScope[grab]={status:success}
      check: onNode([
        { when: ast('node.grab.status == "success"'), target: "ok", priority: 2 },
        { when: ast('node.grab.status == "failed_business"'), target: "bad", priority: 1 },
      ]),
      ok: term("success"),
      bad: term("fail_business"),
    },
  };
  check("node.grab.status == 'success' 매칭 → ok", (await run(nodeStatusScenario)) === "success");

  // 3) 부재 노드 참조 → IREL_RUNTIME_MISSING (node-missing 경로).
  const missingScenario: CompiledScenario = {
    start: "check",
    nodes: {
      check: onNode([{ when: ast('node.absent.status == "success"'), target: "x", priority: 1 }]),
      x: term("success"),
    },
  };
  const missErr = await runThrows(missingScenario);
  check(
    "부재 노드 node.absent.status → IREL_RUNTIME_MISSING(loud)",
    missErr instanceof Error && (missErr as { code?: string }).code === "IREL_RUNTIME_MISSING",
    missErr instanceof Error ? `${(missErr as { code?: string }).code ?? ""}: ${missErr.message}` : String(missErr),
  );

  // 4) 실행된 노드의 미투영 필드(row_count) 참조 → IREL_RUNTIME_MISSING (field-absent 경로 — DEFER 준수).
  const fieldAbsentScenario: CompiledScenario = {
    start: "grab",
    nodes: {
      grab: { what: [{ type: "act" }], flow: { kind: "next", target: "check" } }, // grab 실행 → {status}만 기록
      check: onNode([{ when: ast("node.grab.row_count >= 1"), target: "x", priority: 1 }]),
      x: term("success"),
    },
  };
  const fieldErr = await runThrows(fieldAbsentScenario);
  check(
    "실행된 노드의 row_count(미투영) → IREL_RUNTIME_MISSING(field-absent, DEFER 준수)",
    fieldErr instanceof Error && (fieldErr as { code?: string }).code === "IREL_RUNTIME_MISSING",
    fieldErr instanceof Error ? `${(fieldErr as { code?: string }).code ?? ""}: ${fieldErr.message}` : String(fieldErr),
  );

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 스코프 — params.* + node.status 분기, 부재 노드·미투영 필드는 IREL_RUNTIME_MISSING(loud) (RQ-002)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-scope unit fatal:", e);
  process.exit(1);
});
