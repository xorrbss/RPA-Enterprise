/**
 * IR(ir 컬럼) + compiled_ast(캐시된 on[] when AST) → 인터프리터 입력(CompiledScenario) 변환 (D3 가동 1단계).
 *
 * compiled_ast(static-validation CompiledScenarioAst)는 on[].when/loop.until/fallback 등 **컴파일된 IREL AST만**
 * 캐시한다. what(액션)/next/terminal/start 는 ir에 있으므로 둘을 합쳐 변환한다.
 * 런타임 파싱 없음: on[].when 은 ir의 문자열이 아니라 compiled_ast의 AST를 사용한다("§10 단방향").
 *
 * 범위: 액션은 navigate(url_ref→url)/observe(drop)/act/extract, 흐름은 next/on[]/terminal/**loop·fallback_chain**(RQ-002).
 * loop=compiled_ast.loop(until AST+body/exit/max), fallback=compiled_ast.fallback_chain(tier·entry_node·advance_when AST)
 * 를 NodeFlow 로 변환. download 등은 후속 — 미지원은 조용히 흘리지 않고 InterpreterError로 표면화한다.
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
    // act 의 sideEffect 는 node 레벨 side_effect.kind 에서 소싱(IR엔 action-level side_effect 없음 — 가정 금지).
    const nodeSideEffect =
      isRec(raw.side_effect) && typeof raw.side_effect.kind === "string" ? (raw.side_effect.kind as string) : undefined;
    const what = (Array.isArray(raw.what) ? raw.what : []).flatMap((a) => {
      const mapped = mapAction(id, a, params, nodeSideEffect);
      return mapped === null ? [] : [mapped];
    });

    let flow: NodeFlow;
    if (typeof raw.terminal === "string") {
      flow = { kind: "terminal", terminal: raw.terminal };
    } else if (typeof raw.next === "string") {
      flow = { kind: "next", target: raw.next };
    } else if (isRec(raw.next)) {
      // next 가 객체 → 복귀형 예약 핸들러 호출(reservedHandlerCall {handler,input,return_node}, reserved-handlers/ir.schema target).
      // @end_no_data 는 string const 이라 위 string 분기에 걸린다(별도 — 본 분기는 객체 핸들러 호출 전용).
      flow = reservedHandlerFlow(id, raw.next);
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
    } else if (isRec(raw.loop)) {
      // loop.until 은 on[].when 과 동형으로 compiled_ast 에 컴파일돼 있다(static-validation, allowLoopScope). body/exit/max도
      // compiled_ast.loop 에 함께 담긴다. 부재/불완전은 캐시 드리프트(구조 결함)이지 value 무매칭이 아니다 → IR_SCHEMA_INVALID(RQ-008 동형).
      const ca = isRec(caNodes[id]) ? (caNodes[id] as Record<string, unknown>) : {};
      const caLoop = isRec(ca.loop) ? (ca.loop as Record<string, unknown>) : undefined;
      if (
        caLoop === undefined ||
        caLoop.until === undefined ||
        typeof caLoop.body_target !== "string" ||
        typeof caLoop.exit_target !== "string" ||
        typeof caLoop.max_iterations !== "number"
      ) {
        throw new InterpreterError(
          "IR_SCHEMA_INVALID",
          `compiledScenarioFrom: node '${id}' loop compiled_ast 드리프트/불완전(until AST·body/exit/max 부재)`,
        );
      }
      flow = {
        kind: "loop",
        until: caLoop.until as IRELNode,
        bodyTarget: caLoop.body_target,
        exitTarget: caLoop.exit_target,
        maxIterations: caLoop.max_iterations,
      };
    } else if (Array.isArray(raw.fallback_chain)) {
      // fallback_chain.advance_when 은 compiled_ast 에 컴파일돼 있고(static-validation), tier·entry_node 도 함께 담긴다.
      // 부재/개수 불일치는 캐시 드리프트(구조 결함) → IR_SCHEMA_INVALID(RQ-008 동형, 조용한 흐름 금지).
      const ca = isRec(caNodes[id]) ? (caNodes[id] as Record<string, unknown>) : {};
      const caFb = Array.isArray(ca.fallback_chain) ? ca.fallback_chain : undefined;
      if (caFb === undefined || caFb.length === 0 || caFb.length !== raw.fallback_chain.length) {
        throw new InterpreterError(
          "IR_SCHEMA_INVALID",
          `compiledScenarioFrom: node '${id}' fallback_chain compiled_ast 드리프트(ir ${raw.fallback_chain.length} vs compiled ${caFb?.length ?? 0})`,
        );
      }
      flow = { kind: "fallback", tiers: caFb.map((tr) => toTier(id, tr)) };
    } else {
      throw new InterpreterError("UNSUPPORTED_FLOW", `compiledScenarioFrom: node '${id}' 미지원 흐름(next/on/loop/fallback_chain/terminal 중 하나 필요)`);
    }
    nodes[id] = { what, flow };
  }
  return { start: ir.start, nodes };
}

// IR 액션 → ExecutorPlugin 액션. observe는 on[] PageState resolve가 대신하므로 drop(null).
// dom 프리미티브(act/extract)는 StagehandDomExecutor 가 받는 DomAction 형태로 산출(composite-executor 가 type 으로 라우팅).
function mapAction(
  nodeId: string,
  a: unknown,
  params: Record<string, unknown> | undefined,
  nodeSideEffect: string | undefined,
): unknown | null {
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
  if (a.action === "act") {
    if (typeof a.instruction !== "string" || a.instruction.trim().length === 0) {
      throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' act.instruction 필요`);
    }
    // sideEffect 는 node 레벨 side_effect.kind 에서(미지정 시 생략 → 실행기 기본 'update'; 기본값 single-source 는 실행기).
    // vars(Assets/credential 참조)가 있으면 첫 키를 자격증명 fill 슬롯(secretRef)으로 — 실행기가 ctx.assetRefs 에서
    // SecretRef 를 SecretStore 경유로 해소해 LLM 미경유로 채운다. 비밀 대상은 LLM 출력이 아니라 IR 선언에서 옴(결정형).
    // 단일 자격증명 가정(login fill 1칸 = 1키); 다중 자격증명은 YAGNI(필요 시 selector→key 맵으로 확장).
    const secretRef = Array.isArray(a.vars) && typeof a.vars[0] === "string" && a.vars[0].length > 0 ? a.vars[0] : undefined;
    // 비-secret 결정형 fill: act.args.value_ref(run params 키)를 DomAction 에 스레드한다. valueRef(채울 값의 출처=INTENT)
    //   는 선언되면 **항상** 스레드하고(미해소여도), value(해소된 평문)는 params 에 있을 때만 싣는다. 실행기는 valueRef
    //   intent 기준으로 override 해 selector 만 LLM 에 맡기고 채울 값은 IR/params 로 고정한다(LLM 추측 value 무시).
    //   secretRef(자격증명)와 상호배타 — 둘 다면 IR 모순(loud). 해소는 eager 하되 미해소 시 throw 안 함: 전 노드를
    //   upfront 변환하므로(미실행 분기 포함) 안 쓰는 run 의 params 부재(예: approve run 의 reject reason)에 throw 하면 안 된다.
    //   실행 도달 시 value 가 미해소면 실행기가 valueRef intent 로 loud(LLM/캐시 값 무음 fill 금지 — "조용한 false 금지").
    const valueRef = isRec(a.args) && typeof a.args.value_ref === "string" && a.args.value_ref.length > 0 ? a.args.value_ref : undefined;
    if (valueRef !== undefined && secretRef !== undefined) {
      throw new InterpreterError(
        "IR_SCHEMA_INVALID",
        `compiledScenarioFrom: node '${nodeId}' act 는 vars(secret) 와 args.value_ref(비-secret) 동시 사용 불가`,
      );
    }
    const value = valueRef !== undefined && typeof params?.[valueRef] === "string" ? (params[valueRef] as string) : undefined;
    return {
      type: "act",
      instruction: a.instruction,
      ...(nodeSideEffect !== undefined ? { sideEffect: nodeSideEffect } : {}),
      ...(secretRef !== undefined ? { secretRef } : {}),
      ...(valueRef !== undefined ? { valueRef } : {}),
      ...(value !== undefined ? { value } : {}),
    };
  }
  if (a.action === "extract") {
    if (typeof a.instruction !== "string" || a.instruction.trim().length === 0) {
      throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' extract.instruction 필요`);
    }
    if (typeof a.schema_ref !== "string" || a.schema_ref.length === 0) {
      throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' extract.schema_ref 필요`);
    }
    // schemaVersion/strict 는 IR에 없음 → args(typo-safe 확장 슬롯)에서 명시 소싱. 기본 strict=true(미스매치 시 loud
    // EXTRACT_SCHEMA_INVALID, 조용한 repair 아님), schemaVersion="1". 버전드 schema_ref 메타 레지스트리는 후속.
    const args = isRec(a.args) ? a.args : {};
    const schemaVersion = typeof args.schema_version === "string" ? args.schema_version : "1";
    const strict = typeof args.strict === "boolean" ? args.strict : true;
    // Inline JSON Schema body (args.schema, typo-safe extension slot — same pattern as schema_version/strict).
    // Threaded to the gateway responseFormat so the ajv validator can check the extract output (no registry).
    const schema = isRec(args.schema) ? (args.schema as Record<string, unknown>) : undefined;
    return {
      type: "extract",
      instruction: a.instruction,
      output: { schemaRef: a.schema_ref, schemaVersion, strict, ...(schema !== undefined ? { schema } : {}) },
    };
  }
  throw new InterpreterError(
    "ACTION_UNSUPPORTED",
    `compiledScenarioFrom: node '${nodeId}' action '${a.action}' 미지원(1단계: navigate/observe/act/extract)`,
  );
}

// reservedHandlerCall({handler,input,return_node}, ir.schema target) → NodeFlow.reserved_handler. 구조 검증만(input.kind 등
// 의미 검증은 인터프리터 dispatch 소관). 미정/오류는 조용히 흘리지 않고 IR_SCHEMA_INVALID.
function reservedHandlerFlow(nodeId: string, raw: Record<string, unknown>): NodeFlow {
  const handler = raw.handler;
  if (handler !== "@challenge" && handler !== "@human_task") {
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `compiledScenarioFrom: node '${nodeId}' reservedHandlerCall.handler '${String(handler)}' 무효(@challenge|@human_task)`,
    );
  }
  if (!isRec(raw.input)) {
    throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' reservedHandlerCall.input 객체 필요`);
  }
  if (typeof raw.return_node !== "string" || raw.return_node.length === 0) {
    throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' reservedHandlerCall.return_node 필요(노드 id)`);
  }
  return { kind: "reserved_handler", handler, input: raw.input, returnNode: raw.return_node };
}

// compiled_ast on[] branch(when=AST, target, priority) → CompiledOnBranch.
function toBranch(nodeId: string, b: unknown): CompiledOnBranch<string> {
  // on[] 분기 target 이 reservedHandlerCall(@challenge/@human_task) 객체면 미지원(P3 은 next-target suspend 만) — 원인을
  // 가린 일반 "형식 오류" 대신 명시 표면화(문제 은폐 금지). 지원 시 on-branch dispatch + selectOnBranch 비-노드 target 확장 필요.
  if (isRec(b) && isRec(b.target) && typeof (b.target as { handler?: unknown }).handler === "string") {
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `compiledScenarioFrom: node '${nodeId}' on[] 분기 target 이 reservedHandlerCall(@challenge/@human_task) — 미지원(next-target 사용)`,
    );
  }
  if (!isRec(b) || typeof b.target !== "string" || typeof b.priority !== "number" || b.when === undefined) {
    throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' compiled on[] branch 형식 오류`);
  }
  return { when: b.when as IRELNode, target: b.target, priority: b.priority };
}

// compiled_ast fallback_chain tier(tier, entry_node, advance_when?=AST) → NodeFlow fallback tier.
function toTier(nodeId: string, tr: unknown): { tier: string; entryNode: string; advanceWhen?: IRELNode } {
  if (!isRec(tr) || typeof tr.tier !== "string" || typeof tr.entry_node !== "string") {
    throw new InterpreterError("IR_SCHEMA_INVALID", `compiledScenarioFrom: node '${nodeId}' compiled fallback tier 형식 오류`);
  }
  return {
    tier: tr.tier,
    entryNode: tr.entry_node,
    ...(tr.advance_when !== undefined ? { advanceWhen: tr.advance_when as IRELNode } : {}),
  };
}
