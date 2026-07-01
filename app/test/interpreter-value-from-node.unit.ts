/**
 * 단위 — 사람-승인 단일 인박스 두 능력: (A) @human_task payload from_param 해소(리뷰어가 이 run 의 실제 데이터 확인 + form
 * pre-fill) (B) act.value_from_node 해소(리뷰어가 편집·승인한 correction 값을 재개된 액션에 결정형 주입). 외부 의존 없음.
 *
 * 검증:
 *  A1 payload {from_param:"k"} → run params 값으로 해소(정적 리터럴은 무영향).  A2 params 부재 키 → IR_SCHEMA_INVALID(조용한 false 금지).
 *  B1 resume 시 nodeScope[review].correction[key] → 액션 value 로 고정(executor 가 편집값 수신).  B2 correction 부재 → IR_SCHEMA_INVALID.
 *  B3 value_from_node 인데 대상 노드 미scope → IR_SCHEMA_INVALID.  (조용한 LLM/캐시 값 fill 거부 — "조용한 false 금지").
 * 실행: tsx test/interpreter-value-from-node.unit.ts.
 */
import type { ExecutorPlugin, PageState, RunContext, StepResult, StepStatus, VerifyResult } from "../../ts/core-types";
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

function stepResult(status: StepStatus): StepResult {
  return {
    stepId: "s", action: "act", status,
    pageStateBefore: "ps_before", pageStateAfter: "ps_after",
    artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: "t", endedAt: "t", durationMs: 0 },
  };
}

// 액션 인자를 포착하는 executor — resolveActionValueFromNode 가 dispatch 전 value 를 고정했는지 확인용.
function capturingExecutor(sink: { last?: Record<string, unknown> }): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    execute: async (_stepId, action): Promise<StepResult> => {
      sink.last = action as Record<string, unknown>;
      return stepResult("success");
    },
    verify: async (): Promise<VerifyResult> => ({ passed: true, criteria: [] }) as unknown as VerifyResult,
  };
}

function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "n", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: cannedPageState,
  };
}

async function main(): Promise<void> {
  // ── A) @human_task payload from_param 해소 ────────────────────────────────────────────────
  const htScenario = (payload: Record<string, unknown>): CompiledScenario => ({
    start: "task",
    nodes: {
      task: { what: [], flow: { kind: "reserved_handler", handler: "@human_task", input: { kind: "validation", assignee_role: "reviewer", payload }, returnNode: "after" } },
      after: { what: [], flow: { kind: "terminal", terminal: "success" } },
    },
  });
  const htDeps = (params?: Record<string, unknown>) => ({ executor: capturingExecutor({}), resolver: fakeResolver, ...(params !== undefined ? { params } : {}) });

  {
    // A1: from_param 리프 → params 값; 정적 리터럴은 그대로.
    const o = await runScenario(
      htScenario({ 제목: { from_param: "mail_subject" }, 원문: { from_param: "mail_body" }, 상태: "검토대기" }),
      ctx(),
      htDeps({ mail_subject: "6월 정산 문의", mail_body: "본문…" }),
    );
    const p = o.suspend?.kind === "human_task" ? o.suspend.payload : undefined;
    check("A1 payload.제목 = params.mail_subject 해소", p?.제목 === "6월 정산 문의", JSON.stringify(p));
    check("A1 payload.원문 = params.mail_body 해소", p?.원문 === "본문…", JSON.stringify(p));
    check("A1 정적 리터럴(상태)은 그대로", p?.상태 === "검토대기", JSON.stringify(p));
  }
  {
    // A2: params 에 없는 키 → loud IR_SCHEMA_INVALID(조용한 false 금지).
    let threw: unknown;
    try { await runScenario(htScenario({ x: { from_param: "missing_key" } }), ctx(), htDeps({})); } catch (e) { threw = e; }
    check("A2 params 부재 from_param → IR_SCHEMA_INVALID throw", threw instanceof Error && (threw as { code?: string }).code === "IR_SCHEMA_INVALID", String(threw));
  }
  {
    // A3(PAYLOAD-02 회귀): 루트 payload 자체가 {from_param:"k"} 여도 스칼라로 collapse 되지 않는다(루트는 표시용 레코드 보존).
    //   → payload 는 항상 객체; jsonb 에 문자열 영속 + unsound cast 방지. 루트 from_param 은 리터럴 필드로 취급(마커 아님).
    const o = await runScenario(htScenario({ from_param: "subj" }), ctx(), htDeps({ subj: "RESOLVED" }));
    const p = o.suspend?.kind === "human_task" ? o.suspend.payload : undefined;
    check("A3 루트 {from_param} 이 스칼라로 collapse 안 됨(payload=객체 보존)", p !== undefined && typeof p === "object" && !Array.isArray(p), JSON.stringify(p));
    check("A3 루트 from_param 은 리터럴 필드(값 미치환)", p?.from_param === "subj", JSON.stringify(p));
  }

  // ── B) act.value_from_node 해소(resume 시 사람 편집값 주입) ──────────────────────────────────
  const fillScenario: CompiledScenario = {
    start: "fill",
    nodes: {
      fill: { what: [{ type: "act", instruction: "본문 채움", richBodyFrame: "iframe.reply-editor", valueFromNode: { node: "review", key: "reply_body" } }], flow: { kind: "terminal", terminal: "success" } },
    },
  };
  {
    // B1: nodeScope[review].correction.reply_body → 액션 value 로 고정(executor 수신).
    const sink: { last?: Record<string, unknown> } = {};
    const o = await runScenario(fillScenario, ctx(), {
      executor: capturingExecutor(sink), resolver: fakeResolver,
      resumeNodeOutputs: { review: { decision: "approve", correction: { reply_body: "사람이 편집·승인한 답장" } } },
    });
    check("B1 fill 노드 도달(terminal success)", o.terminal === "success", o.terminal);
    check("B1 executor 가 편집값을 value 로 수신(LLM 미경유 결정형 주입)", sink.last?.value === "사람이 편집·승인한 답장", JSON.stringify(sink.last));
    check("B1 valueFromNode 마커 보존(executor override 판별)", (sink.last?.valueFromNode as { key?: string } | undefined)?.key === "reply_body", JSON.stringify(sink.last));
  }
  {
    // B2: correction 에 해당 key 없음 → loud IR_SCHEMA_INVALID(조용한 빈/LLM fill 금지).
    let threw: unknown;
    try {
      await runScenario(fillScenario, ctx(), {
        executor: capturingExecutor({}), resolver: fakeResolver,
        resumeNodeOutputs: { review: { decision: "approve", correction: { other: "x" } } },
      });
    } catch (e) { threw = e; }
    check("B2 correction 키 부재 → IR_SCHEMA_INVALID throw", threw instanceof Error && (threw as { code?: string }).code === "IR_SCHEMA_INVALID", String(threw));
  }
  {
    // B3: 대상 노드가 nodeScope 에 아예 없음(resume 미시드) → loud IR_SCHEMA_INVALID.
    let threw: unknown;
    try {
      await runScenario(fillScenario, ctx(), { executor: capturingExecutor({}), resolver: fakeResolver });
    } catch (e) { threw = e; }
    check("B3 대상 노드 미scope → IR_SCHEMA_INVALID throw", threw instanceof Error && (threw as { code?: string }).code === "IR_SCHEMA_INVALID", String(threw));
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: @human_task payload from_param 해소 + act.value_from_node 편집값 주입 (사람-승인 단일 인박스 능력)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-value-from-node unit fatal:", e);
  process.exit(1);
});
