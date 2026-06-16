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

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: ir-translate — 드리프트(RQ-008) + url_ref→params 해소 + act/extract→DomAction 매핑");
  process.exit(0);
}

main();
