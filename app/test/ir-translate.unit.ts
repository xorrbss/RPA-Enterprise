/**
 * 단위 테스트 — compiledScenarioFrom(ir + compiled_ast → CompiledScenario) 순수 변환.
 *
 * 두 관심사를 함께 검증한다(외부 의존 없음). 실행: tsx test/ir-translate.unit.ts.
 *  (A) RQ-008 compiled_ast on[] 드리프트: IR on[]과 compiled_ast on[]의 개수 불일치/부재는 구조 결함이므로
 *      IR_SCHEMA_INVALID로 표면화(조용한 빈 branches → 런타임 IR_NO_BRANCH_MATCHED 오분류 금지).
 *  (B) url_ref → params URL 해소: navigate.url_ref(키)가 params로 해소돼 navigate.url로 들어가고, 해소 실패(URL_REF_*)는
 *      InterpreterError로 환원돼 타입 경계를 넘지 않는다(조용한 unknown 금지). 드라이버는 compiledScenarioFrom(ir,ast,run.params)로 이 경로를 탄다.
 */
import { compiledScenarioFrom } from "../src/runtime/ir-translate";
import { InterpreterError } from "../src/runtime/ir-interpreter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

// on[] 1개 분기를 가진 IR + 대응 compiled_ast(when=AST).
const irOn = {
  start: "n1",
  nodes: {
    n1: { on: [{ when: "flags.x", target: "n2", priority: 0 }] },
    n2: { terminal: "success" },
  },
};
const astOn1 = { nodes: { n1: { on: [{ when: { kind: "flag", name: "x" }, target: "n2", priority: 0 }] } } };

// navigate(url_ref=키) → terminal IR.
const irNav = {
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

function main(): void {
  // ── (A) compiled_ast on[] 드리프트 (RQ-008) ──
  // 1) 정상: ir on[] 1개 ↔ compiled on[] 1개 → branches 1개.
  {
    const s = compiledScenarioFrom(irOn, astOn1);
    const n1 = s.nodes.n1;
    check("on[] 정상 변환 → branches 1", n1?.flow.kind === "on" && n1.flow.branches.length === 1, JSON.stringify(n1?.flow));
  }

  // 2) 드리프트: ir on[] 1개인데 compiled_ast에 노드 on 부재 → IR_SCHEMA_INVALID(빈 branches로 떨어뜨리지 않음).
  {
    const err = caught(() => compiledScenarioFrom(irOn, { nodes: {} }));
    check(
      "compiled_ast on 부재 → IR_SCHEMA_INVALID(드리프트)",
      err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID" && /드리프트/.test((err as Error).message),
      String(err),
    );
  }

  // 3) 드리프트: 개수 불일치(ir 1 vs compiled 0).
  {
    const err = caught(() => compiledScenarioFrom(irOn, { nodes: { n1: { on: [] } } }));
    check(
      "compiled_ast on 개수 불일치 → IR_SCHEMA_INVALID",
      err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID",
      String(err),
    );
  }

  // 4) next/terminal 흐름은 compiled_ast 불요 — 정상 변환.
  {
    const ir = { start: "a", nodes: { a: { next: "b" }, b: { terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    check("next/terminal 변환", s.nodes.a?.flow.kind === "next" && s.nodes.b?.flow.kind === "terminal");
  }

  // 4b) P0b: node.verify 투영 — criteria[] 운반(criterion shape 미검증, executor 권위) + on_fail/max_self_heal 기본값(self_heal/2).
  {
    const ir = { start: "a", nodes: { a: { what: [], verify: { criteria: [{ type: "element_visible", target: { selector: "#ok" } }] }, next: "b" }, b: { terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    check(
      "node.verify 투영 → criteria1·on_fail기본 self_heal·max_self_heal기본 2",
      s.nodes.a?.verify?.criteria.length === 1 && s.nodes.a.verify.onFail === "self_heal" && s.nodes.a.verify.maxSelfHeal === 2,
      JSON.stringify(s.nodes.a?.verify),
    );
  }

  // 4b2) on_fail 명시 + policy.max_self_heal 투영(스키마 default 미실체화 → ir-translate 가 적용).
  {
    const ir = { start: "a", nodes: { a: { what: [], policy: { max_self_heal: 0 }, verify: { criteria: [{ type: "min_rows", n: 1 }], on_fail: "abort_security" }, next: "b" }, b: { terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    check("node.verify on_fail/max_self_heal 투영(abort_security·0)", s.nodes.a?.verify?.onFail === "abort_security" && s.nodes.a.verify.maxSelfHeal === 0, JSON.stringify(s.nodes.a?.verify));
  }

  // 4c) verify 미지정 → ScenarioNode.verify undefined(기존 동작 보존).
  {
    const ir = { start: "a", nodes: { a: { what: [], next: "b" }, b: { terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    check("verify 미지정 → ScenarioNode.verify undefined", s.nodes.a?.verify === undefined);
  }

  // 4d) verify.criteria 빈 배열/형식 오류 → IR_SCHEMA_INVALID(조용한 false 금지).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [], verify: { criteria: [] }, terminal: "success" } } }, {}));
    check("verify.criteria 빈 배열 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 5) loop 변환(RQ-002): ir loop + compiled_ast.loop(until AST + body/exit/max) → NodeFlow loop.
  {
    const irLoop = { start: "L", nodes: { L: { loop: { body_target: "B", exit_target: "done", until: "flags.no_next_page", max_iterations: 5 } }, B: { next: "L" }, done: { terminal: "success" } } };
    const astLoop = { nodes: { L: { loop: { until: { kind: "flag", name: "no_next_page" }, body_target: "B", exit_target: "done", max_iterations: 5 } } } };
    const s = compiledScenarioFrom(irLoop, astLoop);
    const L = s.nodes.L;
    check(
      "loop 변환 → NodeFlow loop(body/exit/max)",
      L?.flow.kind === "loop" && L.flow.bodyTarget === "B" && L.flow.exitTarget === "done" && L.flow.maxIterations === 5,
      JSON.stringify(L?.flow),
    );
  }

  // 5b) loop 드리프트: ir loop 인데 compiled_ast.loop 부재 → IR_SCHEMA_INVALID(조용한 빈 흐름 금지, RQ-008 동형).
  {
    const irLoop = { start: "L", nodes: { L: { loop: { body_target: "B", exit_target: "done", until: "flags.no_next_page", max_iterations: 5 } }, B: { next: "L" }, done: { terminal: "success" } } };
    const err = caught(() => compiledScenarioFrom(irLoop, { nodes: {} }));
    check("loop compiled_ast 부재 → IR_SCHEMA_INVALID(드리프트)", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 5c) fallback_chain 변환(RQ-002): ir fallback_chain + compiled_ast.fallback_chain(tier·entry_node·advance_when AST) → NodeFlow fallback.
  {
    const irFb = {
      start: "F",
      nodes: {
        F: { fallback_chain: [{ tier: "T0", entry_node: "t0", advance_when: 'node.t0.status == "failed_system"' }, { tier: "T1", entry_node: "t1" }] },
        t0: { terminal: "fail_system" },
        t1: { terminal: "success" },
      },
    };
    const astFb = { nodes: { F: { fallback_chain: [{ tier: "T0", entry_node: "t0", advance_when: { kind: "flag", name: "x" } }, { tier: "T1", entry_node: "t1" }] } } };
    const s = compiledScenarioFrom(irFb, astFb);
    const F = s.nodes.F;
    check(
      "fallback_chain 변환 → NodeFlow fallback(tier·entryNode·advanceWhen)",
      F?.flow.kind === "fallback" && F.flow.tiers.length === 2 && F.flow.tiers[0].tier === "T0" && F.flow.tiers[0].entryNode === "t0" && F.flow.tiers[0].advanceWhen !== undefined && F.flow.tiers[1].advanceWhen === undefined,
      JSON.stringify(F?.flow),
    );
  }

  // 5d) fallback 드리프트: ir fallback 2티어인데 compiled 1티어 → IR_SCHEMA_INVALID(조용한 흐름 금지).
  {
    const irFb = { start: "F", nodes: { F: { fallback_chain: [{ tier: "T0", entry_node: "t0" }, { tier: "T1", entry_node: "t1" }] }, t0: { terminal: "success" }, t1: { terminal: "success" } } };
    const err = caught(() => compiledScenarioFrom(irFb, { nodes: { F: { fallback_chain: [{ tier: "T0", entry_node: "t0" }] } } }));
    check("fallback compiled_ast 개수 불일치 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 5e) 흐름 키 전무(next/on/loop/fallback/terminal 모두 없음) → UNSUPPORTED_FLOW.
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [] } } }, {}));
    check("흐름 키 전무 → UNSUPPORTED_FLOW", err instanceof InterpreterError && err.code === "UNSUPPORTED_FLOW", String(err));
  }

  // ── (R) reservedHandlerCall next-target(@human_task/@challenge, P3) ──
  // 16) next 객체 @human_task → NodeFlow.reserved_handler(handler/input/returnNode). input 의미검증은 인터프리터 소관.
  {
    const ir = { start: "t", nodes: { t: { next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver" }, return_node: "after" } }, after: { terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    const f = s.nodes.t?.flow;
    check(
      "@human_task next → reserved_handler(handler/returnNode/input)",
      f?.kind === "reserved_handler" && f.handler === "@human_task" && f.returnNode === "after" && (f.input as { kind?: string }).kind === "approval",
      JSON.stringify(f),
    );
  }
  // 17) next 객체 @challenge → reserved_handler(translate 는 구조만; @challenge dispatch 거부는 인터프리터).
  {
    const ir = { start: "c", nodes: { c: { next: { handler: "@challenge", input: {}, return_node: "after" } }, after: { terminal: "success" } } };
    const f = compiledScenarioFrom(ir, {}).nodes.c?.flow;
    check("@challenge next → reserved_handler(handler=@challenge)", f?.kind === "reserved_handler" && f.handler === "@challenge", JSON.stringify(f));
  }
  // 18) handler 무효(@foo) → IR_SCHEMA_INVALID(조용한 false 금지).
  {
    const err = caught(() => compiledScenarioFrom({ start: "t", nodes: { t: { next: { handler: "@foo", input: {}, return_node: "after" } }, after: { terminal: "success" } } }, {}));
    check("reservedHandler handler 무효 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }
  // 19) return_node 누락 → IR_SCHEMA_INVALID.
  {
    const err = caught(() => compiledScenarioFrom({ start: "t", nodes: { t: { next: { handler: "@human_task", input: { kind: "approval" } } }, after: { terminal: "success" } } }, {}));
    check("reservedHandler return_node 누락 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }
  // 20) input 비-객체 → IR_SCHEMA_INVALID.
  {
    const err = caught(() => compiledScenarioFrom({ start: "t", nodes: { t: { next: { handler: "@human_task", input: "x", return_node: "after" } }, after: { terminal: "success" } } }, {}));
    check("reservedHandler input 비-객체 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }
  // 21) on[] 분기 target 이 reservedHandlerCall → 미지원 명시 표면화(IR_SCHEMA_INVALID, 일반 "형식 오류" 아닌 명확 메시지).
  {
    const ir = { start: "c", nodes: { c: { on: [{ when: "flags.x", target: { handler: "@human_task", input: {}, return_node: "after" }, priority: 1 }] }, after: { terminal: "success" } } };
    const ast = { nodes: { c: { on: [{ when: { kind: "flag", name: "x" }, target: { handler: "@human_task", input: {}, return_node: "after" }, priority: 1 }] } } };
    const err = caught(() => compiledScenarioFrom(ir, ast));
    check(
      "on[] reservedHandlerCall target → IR_SCHEMA_INVALID(미지원, 명시)",
      err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID" && /reservedHandlerCall/.test((err as Error).message),
      String(err),
    );
  }

  // ── (B) url_ref → params URL 해소 ──
  // 6) 정상: url_ref(키) → params 의 절대 URL 이 navigate.url 로.
  {
    const s = compiledScenarioFrom(irNav, {}, { entry_url: "http://a.example/orders" });
    const nav = s.nodes.open?.what[0] as { type: string; url: string } | undefined;
    check("navigate.url_ref(키) → params URL 해소", nav?.type === "navigate" && nav.url === "http://a.example/orders", JSON.stringify(nav));
  }

  // 7) params 누락 → InterpreterError(URL_REF_PARAM_MISSING) (SiteResolutionError 가 타입 경계 넘지 않음)
  {
    const err1 = caught(() => compiledScenarioFrom(irNav, {}, {}));
    const err2 = caught(() => compiledScenarioFrom(irNav, {}));
    check(
      "params 누락/undefined → InterpreterError(URL_REF_PARAM_MISSING)",
      err1 instanceof InterpreterError && err1.code === "URL_REF_PARAM_MISSING" && err2 instanceof InterpreterError && err2.code === "URL_REF_PARAM_MISSING",
      `${String(err1)} / ${String(err2)}`,
    );
  }

  // 8) 비-절대URL params 값 → InterpreterError(URL_REF_VALUE_NOT_ABSOLUTE_URL)
  {
    const err = caught(() => compiledScenarioFrom(irNav, {}, { entry_url: "orders_url" }));
    check(
      "비-절대URL params 값 → InterpreterError(URL_REF_VALUE_NOT_ABSOLUTE_URL)",
      err instanceof InterpreterError && err.code === "URL_REF_VALUE_NOT_ABSOLUTE_URL",
      String(err),
    );
  }

  // 9) url_ref 키 자체 누락(문자열 아님) → IR_SCHEMA_INVALID
  {
    const err = caught(() => compiledScenarioFrom({ start: "o", nodes: { o: { what: [{ action: "navigate" }], terminal: "success" } } }, {}, {}));
    check("navigate.url_ref 키 누락 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // ── (C) dom 프리미티브 act/extract 매핑 ──
  // 10) act: instruction + node side_effect.kind → sideEffect 소싱.
  {
    const ir = { start: "a", nodes: { a: { what: [{ action: "act", instruction: "click login" }], side_effect: { kind: "submit" }, terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    const act = s.nodes.a?.what[0] as { type: string; instruction: string; sideEffect?: string } | undefined;
    check("act: instruction + node side_effect.kind → sideEffect", act?.type === "act" && act.instruction === "click login" && act.sideEffect === "submit", JSON.stringify(act));
  }

  // 11) act: node side_effect 없으면 sideEffect 생략(실행기 기본 'update' 경로).
  {
    const s = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "fill name" }], terminal: "success" } } }, {});
    const act = s.nodes.a?.what[0] as { type: string; sideEffect?: string } | undefined;
    check("act: side_effect 없으면 sideEffect 생략", act?.type === "act" && act.sideEffect === undefined, JSON.stringify(act));
  }

  // 11b) act: args.value_ref(params 키) → valueRef(intent) + 해소된 value 둘 다 스레드(LLM 미경유 결정형 fill).
  {
    const ir = { start: "a", nodes: { a: { what: [{ action: "act", instruction: "fill reason", args: { value_ref: "reason" } }], terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {}, { reason: "반려 사유 텍스트" });
    const act = s.nodes.a?.what[0] as { type: string; valueRef?: string; value?: string; secretRef?: string } | undefined;
    check("act: args.value_ref → valueRef(intent)+value 스레드", act?.type === "act" && act.valueRef === "reason" && act.value === "반려 사유 텍스트" && act.secretRef === undefined, JSON.stringify(act));
  }

  // 11c) act: args.value_ref 인데 params 부재 → valueRef(intent) 보존 + value 미설정(무throw). 전 노드 upfront 변환이라
  //      미실행 분기의 부재 param 에 throw 하면 안 된다(예: approve run 의 reject 노드 reason). 실행 도달 시 실행기가
  //      valueRef intent 로 loud(LLM/캐시 값 무음 fill 거부) — intent 가 소실되지 않아야 결정형 보장이 성립한다(break-it 후속).
  {
    const ir = { start: "a", nodes: { a: { what: [{ action: "act", instruction: "fill reason", args: { value_ref: "reason" } }], terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {}, { other: "x" });
    const act = s.nodes.a?.what[0] as { type: string; valueRef?: string; value?: string } | undefined;
    check("act: value_ref 미해소(params 부재) → valueRef(intent) 보존 + value 미설정(무throw)", act?.type === "act" && act.valueRef === "reason" && act.value === undefined, JSON.stringify(act));
  }

  // 11d) act: vars(secret) + args.value_ref(비-secret) 동시 → IR_SCHEMA_INVALID(상호배타 — 한 fill 은 비밀이거나 비-secret).
  {
    const ir = { start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", vars: ["login.password"], args: { value_ref: "reason" } }], terminal: "success" } } };
    const err = caught(() => compiledScenarioFrom(ir, {}, { reason: "r" }));
    check("act: vars(secret)+args.value_ref 동시 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 12) extract: schema_ref→schemaRef + 기본 schemaVersion='1'/strict=true.
  {
    const s = compiledScenarioFrom({ start: "g", nodes: { g: { what: [{ action: "extract", instruction: "get reviews", schema_ref: "reviews" }], terminal: "success" } } }, {});
    const ex = s.nodes.g?.what[0] as { type: string; output: { schemaRef: string; schemaVersion: string; strict: boolean } } | undefined;
    check("extract: schema_ref→schemaRef + 기본 v1/strict", ex?.type === "extract" && ex.output.schemaRef === "reviews" && ex.output.schemaVersion === "1" && ex.output.strict === true, JSON.stringify(ex));
  }

  // 13) extract: args.schema_version/args.strict 오버라이드.
  {
    const s = compiledScenarioFrom({ start: "g", nodes: { g: { what: [{ action: "extract", instruction: "x", schema_ref: "r", args: { schema_version: "2", strict: false } }], terminal: "success" } } }, {});
    const ex = s.nodes.g?.what[0] as { output: { schemaVersion: string; strict: boolean } } | undefined;
    check("extract: args 오버라이드(v2/strict=false)", ex?.output.schemaVersion === "2" && ex.output.strict === false, JSON.stringify(ex));
  }

  // 14) extract: schema_ref 누락 → IR_SCHEMA_INVALID.
  {
    const err = caught(() => compiledScenarioFrom({ start: "g", nodes: { g: { what: [{ action: "extract", instruction: "x" }], terminal: "success" } } }, {}));
    check("extract: schema_ref 누락 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 15) act: instruction 누락 → IR_SCHEMA_INVALID.
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act" }], terminal: "success" } } }, {}));
    check("act: instruction 누락 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 16) extract: args.row_anchor → rowAnchor(결정형 행 필드; snake→camel: match_field→matchField).
  {
    const rowAnchorArg = { selector: "td.docu-num", match_field: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "getView\\(['\"](\\d+)['\"]", template: "https://x/view/$1" };
    const s = compiledScenarioFrom({ start: "g", nodes: { g: { what: [{ action: "extract", instruction: "x", schema_ref: "r", args: { row_anchor: rowAnchorArg } }], terminal: "success" } } }, {});
    const ex = s.nodes.g?.what[0] as { rowAnchor?: { selector: string; matchField: string; field: string; attribute: string; pattern: string; template: string } } | undefined;
    check(
      "extract: row_anchor → rowAnchor(match_field→matchField 카멜)",
      ex?.rowAnchor?.selector === "td.docu-num" && ex.rowAnchor.matchField === "approval_id" && ex.rowAnchor.field === "doc_ref" && ex.rowAnchor.attribute === "data-href" && ex.rowAnchor.template === "https://x/view/$1",
      JSON.stringify(ex?.rowAnchor),
    );
  }

  // 17) extract: row_anchor 필드 누락(match_field) → IR_SCHEMA_INVALID(compile-time loud).
  {
    const bad = { selector: "td.docu-num", field: "doc_ref", attribute: "data-href", pattern: "x", template: "y" };
    const err = caught(() => compiledScenarioFrom({ start: "g", nodes: { g: { what: [{ action: "extract", instruction: "x", schema_ref: "r", args: { row_anchor: bad } }], terminal: "success" } } }, {}));
    check("extract: row_anchor.match_field 누락 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 18) extract: row_anchor 무효 정규식 → IR_SCHEMA_INVALID.
  {
    const bad = { selector: "td", match_field: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "getView\\((", template: "y" };
    const err = caught(() => compiledScenarioFrom({ start: "g", nodes: { g: { what: [{ action: "extract", instruction: "x", schema_ref: "r", args: { row_anchor: bad } }], terminal: "success" } } }, {}));
    check("extract: row_anchor.pattern 무효 정규식 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 19) act: args.click_selector → clickSelector 스레드(결정형 클릭, LLM 미경유).
  {
    const s = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "결재 클릭", args: { click_selector: 'button[onclick*="getApprovalLayer"]' } }], terminal: "success" } } }, {});
    const act = s.nodes.a?.what[0] as { type: string; clickSelector?: string } | undefined;
    check("act: click_selector → clickSelector 스레드", act?.type === "act" && act.clickSelector === 'button[onclick*="getApprovalLayer"]', JSON.stringify(act));
  }

  // 20) act: click_selector + value_ref 동시 → IR_SCHEMA_INVALID(클릭/fill 상호배타).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", args: { click_selector: "#b", value_ref: "reason" } }], terminal: "success" } } }, {}));
    check("act: click_selector + value_ref 동시 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 21) act: args.assert_absent → assertAbsent 스레드(커밋 효과 witness).
  {
    const s = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "witness", args: { assert_absent: 'button[onclick*="getApprovalLayer"]' } }], terminal: "success" } } }, {});
    const act = s.nodes.a?.what[0] as { type: string; assertAbsent?: string } | undefined;
    check("act: assert_absent → assertAbsent 스레드", act?.type === "act" && act.assertAbsent === 'button[onclick*="getApprovalLayer"]', JSON.stringify(act));
  }

  // 22) act: assert_absent + click_selector 동시 → IR_SCHEMA_INVALID(결정형 모드 상호배타).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", args: { assert_absent: "#b", click_selector: "#c" } }], terminal: "success" } } }, {}));
    check("act: assert_absent + click_selector 동시 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 22a) act: args.fill_selector + value_ref → fillSelector+valueRef 스레드(결정형 fill, 셀렉터·값 둘 다 결정형).
  {
    const s = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "사유 입력", args: { fill_selector: "textarea#reason", value_ref: "reason" } }], terminal: "success" } } }, {}, { reason: "반려 사유" });
    const act = s.nodes.a?.what[0] as { type: string; fillSelector?: string; valueRef?: string; value?: string } | undefined;
    check("act: fill_selector + value_ref → fillSelector+valueRef 스레드", act?.type === "act" && act.fillSelector === "textarea#reason" && act.valueRef === "reason" && act.value === "반려 사유", JSON.stringify(act));
  }

  // 22b) act: args.fill_selector + vars(secret) → fillSelector+secretRef 스레드(결정형 자격증명 fill).
  {
    const s = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "비밀번호 입력", vars: ["login.password"], args: { fill_selector: "input#pw" } }], terminal: "success" } } }, {});
    const act = s.nodes.a?.what[0] as { type: string; fillSelector?: string; secretRef?: string } | undefined;
    check("act: fill_selector + vars(secret) → fillSelector+secretRef 스레드", act?.type === "act" && act.fillSelector === "input#pw" && act.secretRef === "login.password", JSON.stringify(act));
  }

  // 22c) act: fill_selector 인데 값 출처 없음 → IR_SCHEMA_INVALID(빈 fill 금지).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", args: { fill_selector: "input#pw" } }], terminal: "success" } } }, {}));
    check("act: fill_selector 값 출처 없음 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 22d) act: fill_selector + click_selector 동시 → IR_SCHEMA_INVALID(클릭 vs fill 모드 상호배타).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", vars: ["login.password"], args: { fill_selector: "input#pw", click_selector: "#b" } }], terminal: "success" } } }, {}));
    check("act: fill_selector + click_selector 동시 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 22e) act: select_selector + select_value → selectSelector+selectValue 스레드(결정형 select).
  {
    const s = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "연도 선택", args: { select_selector: "select#year", select_value: "2026" } }], terminal: "success" } } }, {});
    const act = s.nodes.a?.what[0] as { type: string; selectSelector?: string; selectValue?: string } | undefined;
    check("act: select_selector + select_value → 스레드", act?.type === "act" && act.selectSelector === "select#year" && act.selectValue === "2026", JSON.stringify(act));
  }

  // 22f) act: select_selector 만(select_value 없음) → IR_SCHEMA_INVALID(둘 다 필요).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", args: { select_selector: "select#year" } }], terminal: "success" } } }, {}));
    check("act: select_selector 만 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 22g) act: select + click_selector 동시 → IR_SCHEMA_INVALID(select vs click 모드 그룹 상호배타).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "x", args: { select_selector: "select#y", select_value: "v", click_selector: "#b" } }], terminal: "success" } } }, {}));
    check("act: select + click_selector 동시 → IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // 22h) AUD-4/SSB-01: 자격증명 fill(secretRef)은 fill_selector(결정형) 또는 allow_llm_secret_selector opt-in 필요(보안 기본값).
  {
    const err = caught(() => compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "fill pw", vars: ["login.password"] }], terminal: "success" } } }, {}));
    check(
      "act: secretRef without fill_selector/opt-in → IR_SCHEMA_INVALID(SSB-01)",
      err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID" && /allow_llm_secret_selector|SSB-01/.test((err as Error).message),
      String(err),
    );
    const s1 = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "fill pw", vars: ["login.password"], args: { fill_selector: "input#pw" } }], terminal: "success" } } }, {});
    const a1 = s1.nodes.a?.what[0] as { type: string; secretRef?: string; fillSelector?: string } | undefined;
    check("act: secretRef + fill_selector → ok(결정형 셀렉터)", a1?.type === "act" && a1.secretRef === "login.password" && a1.fillSelector === "input#pw", JSON.stringify(a1));
    const s2 = compiledScenarioFrom({ start: "a", nodes: { a: { what: [{ action: "act", instruction: "fill pw", vars: ["login.password"], args: { allow_llm_secret_selector: true } }], terminal: "success" } } }, {});
    const a2 = s2.nodes.a?.what[0] as { type: string; secretRef?: string; fillSelector?: string } | undefined;
    check("act: secretRef + allow_llm_secret_selector:true → ok(명시 opt-in)", a2?.type === "act" && a2.secretRef === "login.password" && a2.fillSelector === undefined, JSON.stringify(a2));
  }

  // 23) observe: instruction 없는 observe는 on[] PageState resolver 전용으로 drop한다.
  {
    const s = compiledScenarioFrom({ start: "o", nodes: { o: { what: [{ action: "observe" }], terminal: "success" } } }, {});
    check("observe: instruction 없으면 resolver-only drop", s.nodes.o?.what.length === 0, JSON.stringify(s.nodes.o?.what));
  }

  // 24) observe: instruction 있는 observe는 executor action으로 변환한다.
  {
    const s = compiledScenarioFrom({ start: "o", nodes: { o: { what: [{ action: "observe", instruction: "assess the current page" }], terminal: "success" } } }, {});
    const ob = s.nodes.o?.what[0] as { type?: string; instruction?: string } | undefined;
    check(
      "observe: instruction 있으면 executor action",
      ob?.type === "observe" && ob.instruction === "assess the current page",
      JSON.stringify(ob),
    );
  }

  // 25) observe: blank instruction은 조용히 drop하지 않고 schema 오류로 처리한다.
  {
    const err = caught(() => compiledScenarioFrom({ start: "o", nodes: { o: { what: [{ action: "observe", instruction: "   " }], terminal: "success" } } }, {}));
    check("observe: blank instruction -> IR_SCHEMA_INVALID", err instanceof InterpreterError && err.code === "IR_SCHEMA_INVALID", String(err));
  }

  // ── (D) node.policy.recording → executor action 스레딩 ──
  // 26) node-level recording 정책은 executor action으로 변환된 observe/navigate/act/extract 에 전달된다.
  {
    const ir = {
      start: "open",
      nodes: {
        open: {
          policy: { recording: "always" },
          what: [
            { action: "observe", label: "resolver-only" },
            { action: "observe", instruction: "check visible result" },
            { action: "navigate", url_ref: "entry_url" },
            { action: "act", instruction: "click search" },
            { action: "extract", instruction: "read result", schema_ref: "result" },
          ],
          terminal: "success",
        },
      },
    };
    const s = compiledScenarioFrom(ir, {}, { entry_url: "https://example.com" });
    const actions = s.nodes.open?.what as Array<{ type: string; recording?: string }> | undefined;
    check(
      "node.policy.recording -> observe/navigate/act/extract actions",
      actions?.length === 4 && actions[0]?.type === "observe" && actions.every((a) => a.recording === "always"),
      JSON.stringify(actions),
    );
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: ir-translate — 드리프트(RQ-008) + url_ref→params 해소 + act/extract 매핑 + reservedHandlerCall(@human_task/@challenge)");
  process.exit(0);
}

main();
