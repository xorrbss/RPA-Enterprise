/**
 * codegen/validators.fixtures.ts — 경계 validator 스모크(positive/negative).
 * validators.ts(validateIR/validateVerify/validateEvent)를 실제 실행해 계약 스키마 검증 동작을 in-repo로 고정.
 * 실행: npm --prefix codegen run validators (tsx). 테스트 러너 비종속.
 */
import { validateIR, validateVerify, validateEvent, validators } from "./validators";
import { validateScenarioStatic } from "./static-validation";
import {
  EVENT_PAYLOAD_SCHEMA_REFS,
  EVENT_PAYLOAD_SCHEMAS,
} from "./event-payload-registry";
import { EVENT_TYPES, type EventType, type IRScenario } from "./types";

type Case = { name: string; fn: (d: unknown) => { valid: boolean }; data: unknown; expect: boolean };
type StaticCase = {
  name: string;
  data: IRScenario;
  expectErrors: string[];
  expectWarnings: string[];
  options?: Parameters<typeof validateScenarioStatic>[1];
};

const U = "11111111-1111-4111-8111-111111111111"; // UUID_RE 충족(version 4, variant 8)
const VALID_IR: IRScenario = {
  meta: { name: "t", version: 1 },
  start: "n1",
  nodes: { n1: { terminal: "success" } },
};
const STEP_EVENT_TYPES = new Set<EventType>(["step.started", "step.completed", "step.verify.failed"]);

function scenario(data: unknown): IRScenario {
  return data as IRScenario;
}

function eventEnvelope(eventType: EventType, payload: Record<string, unknown> = {}): unknown {
  return {
    event_id: U,
    event_type: eventType,
    event_version: 1,
    tenant_id: U,
    correlation_id: U,
    occurred_at: "2026-06-13T00:00:00Z",
    idempotency_key: `fixture:${eventType}`,
    payload_schema_ref: EVENT_PAYLOAD_SCHEMA_REFS[eventType],
    payload,
    ...(STEP_EVENT_TYPES.has(eventType) ? { run_id: U, step_id: "fixture.step", attempt: 0 } : {}),
  };
}

const CASES: Case[] = [
  // --- IR (ir.schema.json: meta+start+nodes, node 흐름키 정확히 1개 oneOf) ---
  { name: "IR valid: terminal 노드(흐름키 1개)", fn: validateIR, expect: true,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { terminal: "success" } } } },
  { name: "IR invalid: 흐름키 2개(oneOf 위반)", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { terminal: "success", next: "n2" } } } },
  { name: "IR invalid: 흐름키 0개(oneOf 위반)", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: {} } } },
  { name: "IR invalid: start 누락", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, nodes: { n1: { terminal: "success" } } } },
  { name: "IR invalid: meta 추가 키 금지", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1, typo: true }, start: "n1", nodes: { n1: { terminal: "success" } } } },
  { name: "IR invalid: node.verify 내부 min_rows:0 거부", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { verify: { criteria: [{ type: "min_rows", n: 0 }] }, terminal: "success" } } } },
  { name: "IR invalid: nodePolicy.timeout_ms 상한 초과", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { policy: { timeout_ms: 300001 }, terminal: "success" } } } },
  { name: "IR invalid: 빈 fallback_chain 금지", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { fallback_chain: [] } } } },
  { name: "IR invalid: fallback entry_node target 패턴 위반", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { fallback_chain: [{ tier: "T0", entry_node: "1bad" }] } } } },
  { name: "IR valid: 복귀형 예약 핸들러 closed call", fn: validateIR, expect: true,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: { handler: "@human_task", input: { kind: "validation" }, return_node: "n2" } }, n2: { terminal: "success" } } } },
  { name: "IR invalid: 복귀형 예약 핸들러 string target 금지", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: "@human_task" } } } },
  { name: "IR invalid: handler-call 추가 키 금지", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: { handler: "@challenge", input: {}, return_node: "n2", extra: true } }, n2: { terminal: "success" } } } },
  { name: "IR invalid: @end_no_data는 return_node 없음", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: { handler: "@end_no_data", input: {}, return_node: "n2" } }, n2: { terminal: "success" } } } },
  { name: "IR valid: loop body/exit target shape", fn: validateIR, expect: true,
    data: { meta: { name: "t", version: 1 }, start: "loop", nodes: { loop: { loop: { body_target: "body", exit_target: "done", until: "flags.no_next_page", max_iterations: 2 } }, body: { next: "loop" }, done: { terminal: "success" } } } },
  { name: "IR invalid: loop body/exit target 필수", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { loop: { until: "flags.no_next_page", max_iterations: 2 } } } } },
  { name: "IR invalid: action 최상위 typo 금지", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { what: [{ action: "act", instruction: "ok", instrucion: "typo" }], terminal: "success" } } } },
  { name: "IR invalid: shell action cmd_ref 필수", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { what: [{ action: "shell" }], terminal: "success" } } } },
  { name: "IR invalid: side_effect idempotency_key 빈 값 금지", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { side_effect: { kind: "submit", idempotency_key: "" }, terminal: "success" } } } },
  { name: "IR invalid: params_schema 자체가 JSON Schema가 아님", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, params_schema: { type: 1 }, start: "n1", nodes: { n1: { terminal: "success" } } } },

  // --- Verify (verify.schema.json) ---
  { name: "Verify valid: min_rows>=1", fn: validateVerify, expect: true,
    data: { criteria: [{ type: "min_rows", n: 5 }] } },
  { name: "Verify invalid: criteria 빈 배열 금지", fn: validateVerify, expect: false,
    data: { criteria: [] } },
  { name: "Verify invalid: min_rows:0 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "min_rows", n: 0 }] } },
  { name: "Verify invalid: criterion 추가 키 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "min_rows", n: 1, typo: true }] } },
  { name: "Verify invalid: text_includes 빈 texts 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "text_includes", texts: [] }] } },
  { name: "Verify invalid: text_includes 빈 문자열 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "text_includes", texts: [""] }] } },
  { name: "Verify invalid: http_status 범위 밖 코드 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "http_status", codes: [99, 600] }] } },
  { name: "Verify invalid: value_match path 인덱싱 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "value_match", path: "rows[0].id", equals: "x" }] } },
  { name: "Verify invalid: url_matches regex 문법 오류", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "url_matches", pattern: "[" }] } },
  { name: "Verify invalid: element_visible 음수 timeout 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "element_visible", target: { selector: "#ok" }, timeout_ms: -1 }] } },
  { name: "Verify invalid: elementTarget 빈 selector 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "element_visible", target: { selector: "" } }] } },
  { name: "Verify invalid: 빈 elementTarget(oneOf selector|role+name)", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "element_visible", target: {} }] } },
  { name: "Verify invalid: elementTarget selector와 role 혼합 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "element_visible", target: { selector: "#ok", role: "button" } }] } },
  { name: "Verify invalid: vlm_fallback 추가 키 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "min_rows", n: 1 }], vlm_fallback: { prompt: "check", typo: true } } },

  // --- Event (event-envelope.schema.json: uuid/date-time format, event_type enum, required) ---
  { name: "Event valid: run.completed 봉투", fn: validateEvent, expect: true,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "events/run.completed@1", payload: {} } },
  { name: "Event invalid: run.aborted(enum 외 — 어휘는 run.cancelled)", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.aborted", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "x", payload: {} } },
  { name: "Event invalid: correlation_id 누락(required)", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "x", payload: {} } },
  { name: "Event invalid: tenant_id uuid format 오류", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: "not-a-uuid", correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "x", payload: {} } },
  { name: "Event invalid: occurred_at date-time format 오류", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-13-99T99:00:00Z", idempotency_key: "k", payload_schema_ref: "events/run.completed@1", payload: {} } },
  { name: "Event invalid: 추가 envelope 키 금지", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "events/run.completed@1", payload: {}, typo: true } },
  { name: "Event invalid: event_type과 payload_schema_ref 불일치", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "events/run.started@1", payload: {} } },
  { name: "Event invalid: 빈 idempotency_key 금지", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "", payload_schema_ref: "events/run.completed@1", payload: {} } },
  { name: "Event invalid: placeholder payload extra key 금지", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "events/run.completed@1", payload: { undocumented: true } } },
];

const STATIC_CASES: StaticCase[] = [
  {
    name: "Static valid: start에서 terminal 도달",
    data: VALID_IR,
    expectErrors: [],
    expectWarnings: [],
  },
  {
    name: "Static invalid: target_not_found",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: "missing" } } },
    expectErrors: ["target_not_found", "no_reachable_terminal"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: duplicate_priority",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "flags.blocked", target: "n2", priority: 1 }, { when: "flags.not_found", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["duplicate_priority"],
    expectWarnings: [],
  },
  {
    name: "Static warning: @end_no_data witness 누락",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "flags.not_found", target: "@end_no_data", priority: 1 }] } } },
    expectErrors: [],
    expectWarnings: ["empty_result_without_witness"],
  },
  {
    name: "Static warning: success_empty witness 누락",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { terminal: "success_empty" } } },
    expectErrors: [],
    expectWarnings: ["empty_result_without_witness"],
  },
  {
    name: "Static invalid: unknown flag",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "flags.no_such_flag", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["unknown_flag"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: vlm_fallback.when unknown flag",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { verify: { criteria: [{ type: "min_rows", n: 1 }], vlm_fallback: { prompt: "check", when: "flags.no_such_flag" } }, terminal: "success" } } },
    expectErrors: ["unknown_flag"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: IREL parse error",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "flags.blocked &&", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["irel_parse_error"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: IREL type error for non-boolean condition",
    data: { meta: { name: "t", version: 1 }, params_schema: { type: "object", properties: { max_pages: { type: "integer" } } }, start: "n1", nodes: { n1: { on: [{ when: "params.max_pages", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["irel_type_error"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: unknown IREL function",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "now() == null", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["unknown_function"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: unknown IREL variable",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "params.max_pages > 0", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["unknown_variable"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: IREL forward node reference",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "node.n2.row_count > 0", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["forward_ref"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: loop scope outside loop node",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "loop.page_count > 0", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["loop_scope_violation"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: params_schema root type is not object",
    data: { meta: { name: "t", version: 1 }, params_schema: { type: "array" }, start: "n1", nodes: { n1: { terminal: "success" } } },
    expectErrors: ["params_schema_type_invalid"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: params_schema property type is not scalar",
    data: { meta: { name: "t", version: 1 }, params_schema: { type: "object", properties: { items: { type: "array" } } }, start: "n1", nodes: { n1: { on: [{ when: "params.items == null", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["params_schema_type_invalid"],
    expectWarnings: [],
  },
  {
    name: "Static valid: typed params_schema boolean expression",
    data: { meta: { name: "t", version: 1 }, params_schema: { type: "object", properties: { max_pages: { type: "integer" } } }, start: "n1", nodes: { n1: { on: [{ when: "params.max_pages > 0", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: [],
    expectWarnings: [],
  },
  {
    name: "Static invalid: illegal cycle",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: "n2" }, n2: { next: "n1" } } },
    expectErrors: ["illegal_cycle", "no_reachable_terminal"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: start_not_found",
    data: { meta: { name: "t", version: 1 }, start: "missing", nodes: { n1: { terminal: "success" } } },
    expectErrors: ["start_not_found"],
    expectWarnings: ["unreachable_node"],
  },
  {
    name: "Static warning: unreachable_node",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { terminal: "success" }, orphan: { terminal: "success" } } },
    expectErrors: [],
    expectWarnings: ["unreachable_node"],
  },
  {
    name: "Static invalid: unknown node field",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { on: [{ when: "node.n0.secret == true", target: "n2", priority: 1 }] }, n2: { terminal: "success" } } },
    expectErrors: ["unknown_node_field"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: invalid value path",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { verify: { criteria: [{ type: "value_match", path: "rows[0].id", equals: "x" }] }, terminal: "success" } } },
    expectErrors: ["invalid_value_path"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: fallback duplicate tier",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { fallback_chain: [{ tier: "T1", entry_node: "n2" }, { tier: "T1", entry_node: "n2" }] }, n2: { terminal: "success" } } },
    expectErrors: ["fallback_chain_invalid"],
    expectWarnings: [],
  },
  {
    name: "Static valid: fallback advance_when may reference current tier entry_node",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { fallback_chain: [{ tier: "T0", entry_node: "t0", advance_when: "node.t0.status == \"failed_system\"" }] }, t0: { terminal: "success" } } },
    expectErrors: [],
    expectWarnings: [],
  },
  {
    name: "Static valid: registered shell cmd_ref",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { what: [{ action: "shell", cmd_ref: "signed.export_report" }], terminal: "success" } } },
    expectErrors: [],
    expectWarnings: [],
    options: { signedCommandRefs: ["signed.export_report"] },
  },
  {
    name: "Static invalid: unregistered shell cmd_ref",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { what: [{ action: "shell", cmd_ref: "signed.unknown" }], terminal: "success" } } },
    expectErrors: ["shell_cmd_unregistered"],
    expectWarnings: [],
    options: { signedCommandRefs: ["signed.export_report"] },
  },
  {
    name: "Static invalid: shell registry unavailable",
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { what: [{ action: "shell", cmd_ref: "signed.export_report" }], terminal: "success" } } },
    expectErrors: ["shell_cmd_registry_unavailable"],
    expectWarnings: [],
  },
  {
    name: "Static valid: loop body cycle exits to terminal",
    data: scenario({
      meta: { name: "t", version: 1 },
      params_schema: { type: "object", properties: { max_pages: { type: "integer" } } },
      start: "loop",
      nodes: {
        loop: { loop: { body_target: "body", exit_target: "done", until: "loop.page_count >= params.max_pages || flags.no_next_page", max_iterations: 2 } },
        body: { next: "loop" },
        done: { terminal: "success" },
      },
    }),
    expectErrors: [],
    expectWarnings: [],
  },
  {
    name: "Static invalid: loop body_target missing",
    data: scenario({
      meta: { name: "t", version: 1 },
      start: "loop",
      nodes: {
        loop: { loop: { body_target: "missing", exit_target: "done", until: "flags.no_next_page", max_iterations: 2 } },
        done: { terminal: "success" },
      },
    }),
    expectErrors: ["target_not_found"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: loop exit_target missing",
    data: scenario({
      meta: { name: "t", version: 1 },
      start: "loop",
      nodes: {
        loop: { loop: { body_target: "body", exit_target: "missing", until: "flags.no_next_page", max_iterations: 2 } },
        body: { next: "loop" },
      },
    }),
    expectErrors: ["target_not_found", "no_reachable_terminal"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: loop max_iterations above ops bound",
    data: scenario({
      meta: { name: "t", version: 1 },
      start: "loop",
      nodes: {
        loop: { loop: { body_target: "body", exit_target: "done", until: "flags.no_next_page", max_iterations: 10001 } },
        body: { next: "loop" },
        done: { terminal: "success" },
      },
    }),
    expectErrors: ["loop_max_iterations_unbounded"],
    expectWarnings: [],
  },
  {
    name: "Static valid: reserved handler return_node target exists",
    data: scenario({ meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: { handler: "@human_task", input: { kind: "validation" }, return_node: "n2" } }, n2: { terminal: "success" } } }),
    expectErrors: [],
    expectWarnings: [],
  },
  {
    name: "Static invalid: reserved handler return_node missing target",
    data: scenario({ meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: { handler: "@challenge", input: {}, return_node: "missing" } } } }),
    expectErrors: ["target_not_found", "no_reachable_terminal"],
    expectWarnings: [],
  },
  {
    name: "Static invalid: returning reserved handler string target",
    data: scenario({ meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { next: "@human_task" } } }),
    expectErrors: ["reserved_handler_call_shape_invalid", "no_reachable_terminal"],
    expectWarnings: [],
  },
];

const fails: string[] = [];
for (const c of CASES) {
  const got = c.fn(c.data).valid;
  if (got !== c.expect) fails.push(`${c.name} -- expected valid=${c.expect}, got ${got}`);
}
if (validators.event(CASES[CASES.length - 3].data) !== false) {
  fails.push("Public validators.event must include payload_schema_ref registry validation");
}
for (const eventType of EVENT_TYPES) {
  const expectedRef = `events/${eventType}@1`;
  const schema = EVENT_PAYLOAD_SCHEMAS[eventType];
  if (EVENT_PAYLOAD_SCHEMA_REFS[eventType] !== expectedRef) {
    fails.push(`${eventType} payload_schema_ref must be ${expectedRef}`);
  }
  if (schema === undefined) {
    fails.push(`${eventType} payload schema must be registered`);
    continue;
  }
  if (schema.$id !== `https://rpa.local/contracts/events/${eventType}@1`) {
    fails.push(`${eventType} payload schema $id mismatch`);
  }
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    fails.push(`${eventType} payload schema must be a closed object`);
  }
  if (!validateEvent(eventEnvelope(eventType)).valid) {
    fails.push(`${eventType} closed empty payload must validate`);
  }
  if (validateEvent(eventEnvelope(eventType, { undocumented: true })).valid) {
    fails.push(`${eventType} undocumented payload field must be rejected`);
  }
}
console.log(`validators smoke: ${CASES.length} total, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error("FAIL:", f); process.exit(1); }

const staticFails: string[] = [];
for (const c of STATIC_CASES) {
  const report = validateScenarioStatic(c.data, c.options);
  const errorReasons = report.errors.map((issue) => issue.reason);
  const warningReasons = report.warnings.map((issue) => issue.reason);
  for (const reason of c.expectErrors) {
    if (!errorReasons.includes(reason)) staticFails.push(`${c.name} — missing error ${reason}`);
  }
  for (const reason of c.expectWarnings) {
    if (!warningReasons.includes(reason)) staticFails.push(`${c.name} — missing warning ${reason}`);
  }
  if (errorReasons.some((reason) => !c.expectErrors.includes(reason))) {
    staticFails.push(`${c.name} — unexpected errors [${errorReasons.join(", ")}]`);
  }
  if (warningReasons.some((reason) => !c.expectWarnings.includes(reason))) {
    staticFails.push(`${c.name} — unexpected warnings [${warningReasons.join(", ")}]`);
  }
}
console.log(`static validation smoke: ${STATIC_CASES.length} total, ${staticFails.length} failed`);
if (staticFails.length) { for (const f of staticFails) console.error("FAIL:", f); process.exit(1); }
console.log("ALL PASS");
