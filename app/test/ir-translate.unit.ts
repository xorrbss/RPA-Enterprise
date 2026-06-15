/**
 * 단위 테스트 — compiledScenarioFrom 의 navigate.url_ref → params URL 해소 + 에러 경계.
 *
 * 외부 의존 없음(순수). 실행: `tsx test/ir-translate.unit.ts`.
 * 검증: navigate.url_ref(키)가 params 로 해소돼 navigate.url 로 들어가고, 해소 실패(URL_REF_*)는
 *  InterpreterError 로 환원돼 타입 경계를 넘지 않는다(조용한 unknown 금지). 드라이버는 compiledScenarioFrom(ir,ast,run.params)로 이 경로를 탄다.
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

const ir = {
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

function throwsInterpreter(label: string, fn: () => void, code: string): void {
  try {
    fn();
    check(label, false, "throw 기대");
  } catch (e) {
    check(label, e instanceof InterpreterError && e.code === code, e instanceof Error ? `${(e as InterpreterError).code ?? ""}: ${e.message}` : String(e));
  }
}

// 1) 정상: url_ref(키) → params 의 절대 URL 이 navigate.url 로.
const scenario = compiledScenarioFrom(ir, {}, { entry_url: "http://a.example/orders" });
const navAction = scenario.nodes.open?.what[0] as { type: string; url: string } | undefined;
check("navigate.url_ref(키) → params URL 해소", navAction?.type === "navigate" && navAction.url === "http://a.example/orders", JSON.stringify(navAction));

// 2) params 누락 → InterpreterError(URL_REF_PARAM_MISSING) (SiteResolutionError 가 타입 경계 넘지 않음)
throwsInterpreter("params 누락 → InterpreterError(URL_REF_PARAM_MISSING)", () => compiledScenarioFrom(ir, {}, {}), "URL_REF_PARAM_MISSING");
throwsInterpreter("params undefined → InterpreterError(URL_REF_PARAM_MISSING)", () => compiledScenarioFrom(ir, {}), "URL_REF_PARAM_MISSING");

// 3) 비-절대URL 값 → InterpreterError(URL_REF_VALUE_NOT_ABSOLUTE_URL)
throwsInterpreter(
  "비-절대URL params 값 → InterpreterError(URL_REF_VALUE_NOT_ABSOLUTE_URL)",
  () => compiledScenarioFrom(ir, {}, { entry_url: "orders_url" }),
  "URL_REF_VALUE_NOT_ABSOLUTE_URL",
);

// 4) url_ref 자체 누락(키 부재) → IR_SCHEMA_INVALID (키는 문자열이어야)
throwsInterpreter(
  "navigate.url_ref 키 누락 → IR_SCHEMA_INVALID",
  () => compiledScenarioFrom({ start: "o", nodes: { o: { what: [{ action: "navigate" }], terminal: "success" } } }, {}, {}),
  "IR_SCHEMA_INVALID",
);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: ir-translate — navigate.url_ref→params URL 해소 + URL_REF_* → InterpreterError 환원(타입 경계)");
process.exit(0);
