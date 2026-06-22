/**
 * 단위 — LLM 플래너 save_and_run 부작용 게이트가 프롬프트 키워드가 아니라 생성 IR 형상으로 판정 (감사 NLP-01).
 *
 * 종전: side-effect 블로커가 looksLikeSideEffectPrompt(프롬프트 키워드 정규식)에만 의존 → 키워드 없는 프롬프트로
 * LLM 이 mutating IR(act/download/...)을 방출하면 blockers=0 → 무심사 auto-run. 수정: draftIrContainsSideEffect 로
 * 생성 IR 의 mutating 노드를 검사해 키워드 무관하게 운영자 검토 게이트(side_effect_prompt_requires_review)로 라우팅.
 *
 * 실행: tsx app/test/scengen-side-effect-gate.unit.ts
 */
import { finalizePlannerEvidence } from "../src/api/scenario-generations";
import type { GenerationCapabilities, GenerationPlan, GenerationRequest } from "../src/api/scenario-generation-types";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// 키워드 없는 프롬프트(클릭/제출/삭제/submit/delete 등 미포함) — looksLikeSideEffectPrompt=false 를 보장.
const KEYWORD_FREE_PROMPT = "큐 페이지의 항목들을 차례로 처리해줘";
const TARGET = { site_profile_id: "s", browser_identity_id: "b", network_policy_id: "n" };

function irWith(action: string): Record<string, unknown> {
  return { meta: { name: "g", version: 1 }, start: "n1", nodes: { n1: { what: [{ action, instruction: "x" }], next: "done" }, done: { terminal: "success" } } };
}
function req(): GenerationRequest {
  return { prompt: KEYWORD_FREE_PROMPT, mode: "save_and_run", planner: "llm_v1", startUrl: "https://ok.example/queue", target: TARGET, params: {}, evidence: { screenshot: "never", video: "never" } };
}
function plan(draftIr: Record<string, unknown>): GenerationPlan {
  return { planner: "llm_v1", request: req(), promptHash: "h", draftIr, blockers: [] };
}
const caps: GenerationCapabilities = { videoRecording: false };
const blockersOf = (draftIr: Record<string, unknown>): string[] => [...finalizePlannerEvidence(plan(draftIr), req(), caps).blockers];

// 키워드 없는 프롬프트 + mutating IR → 게이트 발동(IR 형상 기반).
for (const action of ["act", "download", "upload", "api_call", "file", "shell"]) {
  const b = blockersOf(irWith(action));
  check(`키워드 없는 프롬프트 + mutating IR(${action}) → side_effect_prompt_requires_review 차단`, b.includes("side_effect_prompt_requires_review"), JSON.stringify(b));
}
// 읽기 전용 IR → 게이트 미발동(auto-run 허용 — over-block 아님).
for (const action of ["navigate", "observe", "extract", "human_task"]) {
  const b = blockersOf(irWith(action));
  check(`키워드 없는 프롬프트 + 읽기 IR(${action}) → 차단 안 함(over-block 아님)`, !b.includes("side_effect_prompt_requires_review"), JSON.stringify(b));
}

if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS: scengen LLM-planner 부작용 게이트 = IR 형상 기반(NLP-01)");
process.exit(0);
