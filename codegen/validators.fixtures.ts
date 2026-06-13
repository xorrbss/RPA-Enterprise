/**
 * codegen/validators.fixtures.ts — 경계 validator 스모크(positive/negative).
 * validators.ts(validateIR/validateVerify/validateEvent)를 실제 실행해 계약 스키마 검증 동작을 in-repo로 고정.
 * 실행: npm --prefix codegen run validators (tsx). 테스트 러너 비종속.
 */
import { validateIR, validateVerify, validateEvent } from "./validators";

type Case = { name: string; fn: (d: unknown) => { valid: boolean }; data: unknown; expect: boolean };

const U = "11111111-1111-4111-8111-111111111111"; // UUID_RE 충족(version 4, variant 8)

const CASES: Case[] = [
  // --- IR (ir.schema.json: meta+start+nodes, node 흐름키 정확히 1개 oneOf) ---
  { name: "IR valid: terminal 노드(흐름키 1개)", fn: validateIR, expect: true,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { terminal: "success" } } } },
  { name: "IR invalid: 흐름키 2개(oneOf 위반)", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, start: "n1", nodes: { n1: { terminal: "success", next: "n2" } } } },
  { name: "IR invalid: start 누락", fn: validateIR, expect: false,
    data: { meta: { name: "t", version: 1 }, nodes: { n1: { terminal: "success" } } } },

  // --- Verify (verify.schema.json) ---
  { name: "Verify valid: min_rows>=1", fn: validateVerify, expect: true,
    data: { criteria: [{ type: "min_rows", n: 5 }] } },
  { name: "Verify invalid: min_rows:0 금지", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "min_rows", n: 0 }] } },
  { name: "Verify invalid: 빈 elementTarget(oneOf selector|role+name)", fn: validateVerify, expect: false,
    data: { criteria: [{ type: "element_visible", target: {} }] } },

  // --- Event (event-envelope.schema.json: uuid/date-time format, event_type enum, required) ---
  { name: "Event valid: run.completed 봉투", fn: validateEvent, expect: true,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "events/run.completed@1", payload: {} } },
  { name: "Event invalid: run.aborted(enum 외 — 어휘는 run.cancelled)", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.aborted", event_version: 1, tenant_id: U, correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "x", payload: {} } },
  { name: "Event invalid: correlation_id 누락(required)", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "x", payload: {} } },
  { name: "Event invalid: tenant_id uuid format 오류", fn: validateEvent, expect: false,
    data: { event_id: U, event_type: "run.completed", event_version: 1, tenant_id: "not-a-uuid", correlation_id: U, occurred_at: "2026-06-13T00:00:00Z", idempotency_key: "k", payload_schema_ref: "x", payload: {} } },
];

const fails: string[] = [];
for (const c of CASES) {
  const got = c.fn(c.data).valid;
  if (got !== c.expect) fails.push(`${c.name} — expected valid=${c.expect}, got ${got}`);
}
console.log(`validators smoke: ${CASES.length} total, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error("FAIL:", f); process.exit(1); }
console.log("ALL PASS");
