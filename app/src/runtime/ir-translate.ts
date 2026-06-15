/**
 * IR(ir 컬럼) + compiled_ast(캐시된 on[] when AST) → 인터프리터 입력(CompiledScenario) 변환 (D3 가동 1단계).
 *
 * compiled_ast(static-validation CompiledScenarioAst)는 on[].when/loop.until/fallback 등 **컴파일된 IREL AST만**
 * 캐시한다. what(액션)/next/terminal/start 는 ir에 있으므로 둘을 합쳐 변환한다.
 * 런타임 파싱 없음: on[].when 은 ir의 문자열이 아니라 compiled_ast의 AST를 사용한다("§10 단방향").
 *
 * 범위(1단계): 액션은 navigate(url_ref→url)/observe(drop, on[] resolve가 observe 역할)만, 흐름은 next/on[]/terminal만.
 * loop/fallback_chain·download/extract/act 등은 후속 — 미지원은 조용히 흘리지 않고 InterpreterError로 표면화한다.
 *
 * url_ref 해석: navigate.url_ref 는 run params 의 키다. resolveUrlRef(url_ref, params)로 절대 URL 을 산출해 navigate.url 로
 * 넣는다(site-match 와 동일 함수 → 드리프트 없음). 해소 실패(URL_REF_*)는 InterpreterError 로 환원해 타입 경계 유지.
 */
import type { IRELNode } from "../../../codegen/irel-compile";
import type { CompiledOnBranch } from "./flow-control";
import { resolveUrlRef, SiteResolutionError } from "./site-resolution";
import { InterpreterError, type CompiledScenario, type NodeFlow, type ScenarioNode } from "./ir-interpreter";

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function compiledScenarioFrom(
  ir: unknown,
  compiledAst: unknown,
  params?: Record<string, unknown>,
): CompiledScenario {
  if (!isRec(ir) || typeof ir.start !== "string" || !isRec(ir.nodes)) {
    throw new InterpreterError("IR_SCHEMA_INVALID", "compiledScenarioFrom: ir.start/nodes 누락");
  }
  const caNodes = isRec(compiledAst) && isRec(compiledAst.nodes) ? compiledAst.nodes : {};
  const nodes: Record<string, ScenarioNode> = {};

  for (const [id, raw] of Object.entries(ir.nodes)) {
    if (!isRec(raw)) throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${id}' 형식 오류`);
    const what = (Array.isArray(raw.what) ? raw.what : []).flatMap((a) => {
      const mapped = mapAction(id, a, params);
      return mapped === null ? [] : [mapped];
    });

    let flow: NodeFlow;
    if (typeof raw.terminal === "string") {
      flow = { kind: "terminal", terminal: raw.terminal };
    } else if (typeof raw.next === "string") {
      flow = { kind: "next", target: raw.next };
    } else if (Array.isArray(raw.on)) {
      const ca = isRec(caNodes[id]) ? (caNodes[id] as Record<string, unknown>) : {};
      const onAst = Array.isArray(ca.on) ? ca.on : [];
      // IR on[]과 compiled_ast on[]은 1:1 대응이어야 한다(승격 시 static-validation이 compile). 부재/개수
      // 불일치는 캐시 드리프트(구조 결함)이지 value 무매칭(IR_NO_BRANCH_MATCHED)이 아니다 — 빈 branches로
      // 조용히 떨어뜨리면 런타임에서 NoBranchMatched로 오분류되므로 IR_SCHEMA_INVALID로 표면화(RQ-008).
      if (raw.on.length !== onAst.length) {
        throw new InterpreterError(
          "IR_SCHEMA_INVALID",
          `compiledScenarioFrom: node '${id}' on[] compiled_ast 드리프트(ir ${raw.on.length} vs compiled ${onAst.length})`,
        );
      }
      flow = { kind: "on", branches: onAst.map((b) => toBranch(id, b)) };
    } else {
      throw new InterpreterError("UNSUPPORTED_FLOW", `compiledScenarioFrom: node '${id}' loop/fallback_chain 미지원(1단계)`);
    }
    nodes[id] = { what, flow };
  }
  return { start: ir.start, nodes };
}

// IR 액션 → ExecutorPlugin 액션. observe는 on[] PageState resolve가 대신하므로 drop(null).
function mapAction(nodeId: string, a: unknown, params: Record<string, unknown> | undefined): unknown | null {
  if (!isRec(a) || typeof a.action !== "string") {
    throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' action 형식 오류`);
  }
  if (a.action === "observe") return null;
  if (a.action === "navigate") {
    if (typeof a.url_ref !== "string") {
      throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' navigate.url_ref 누락`);
    }
    // url_ref(키) → params 의 절대 URL. URL_REF_* 해소 실패는 InterpreterError 로 환원(타입 경계 유지).
    try {
      return { type: "navigate", url: resolveUrlRef(a.url_ref, params) };
    } catch (e) {
      if (e instanceof SiteResolutionError) throw new InterpreterError(e.code, `node '${nodeId}': ${e.message}`);
      throw e;
    }
  }
  throw new InterpreterError("ACTION_UNSUPPORTED", `compiledScenarioFrom: node '${nodeId}' action '${a.action}' 미지원(1단계: navigate/observe)`);
}

// compiled_ast on[] branch(when=AST, target, priority) → CompiledOnBranch.
function toBranch(nodeId: string, b: unknown): CompiledOnBranch<string> {
  if (!isRec(b) || typeof b.target !== "string" || typeof b.priority !== "number" || b.when === undefined) {
    throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' compiled on[] branch 형식 오류`);
  }
  return { when: b.when as IRELNode, target: b.target, priority: b.priority };
}
