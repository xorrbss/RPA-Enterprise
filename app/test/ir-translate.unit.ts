/**
 * RQ-008 단위 테스트 — compiledScenarioFrom(ir + compiled_ast → CompiledScenario) 순수 변환 검증.
 *
 * 핵심: IR on[]과 compiled_ast on[]의 드리프트(개수 불일치/부재)는 구조 결함이므로 IR_SCHEMA_INVALID로
 * 표면화(조용한 빈 branches → 런타임 IR_NO_BRANCH_MATCHED 오분류 금지). 정상 변환·next/terminal·미지원 흐름도 확인.
 * 실행: tsx test/ir-translate.unit.ts.
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

function main(): void {
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
      err instanceof InterpreterError && (err as InterpreterError).code === "IR_SCHEMA_INVALID" && /드리프트/.test((err as Error).message),
      String(err),
    );
  }

  // 3) 드리프트: 개수 불일치(ir 1 vs compiled 0).
  {
    const err = caught(() => compiledScenarioFrom(irOn, { nodes: { n1: { on: [] } } }));
    check(
      "compiled_ast on 개수 불일치 → IR_SCHEMA_INVALID",
      err instanceof InterpreterError && (err as InterpreterError).code === "IR_SCHEMA_INVALID",
      String(err),
    );
  }

  // 4) next/terminal 흐름은 compiled_ast 불요 — 정상 변환.
  {
    const ir = { start: "a", nodes: { a: { next: "b" }, b: { terminal: "success" } } };
    const s = compiledScenarioFrom(ir, {});
    check("next/terminal 변환", s.nodes.a?.flow.kind === "next" && s.nodes.b?.flow.kind === "terminal");
  }

  // 5) 미지원 흐름(loop/fallback — on/next/terminal 모두 없음) → UNSUPPORTED_FLOW.
  {
    const ir = { start: "a", nodes: { a: { loop: {} } } };
    const err = caught(() => compiledScenarioFrom(ir, {}));
    check("미지원 흐름 → UNSUPPORTED_FLOW", err instanceof InterpreterError && (err as InterpreterError).code === "UNSUPPORTED_FLOW", String(err));
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: RQ-008 ir-translate compiled_ast drift unit green");
  process.exit(0);
}

main();
