/**
 * security-contracts §3 prompt-injection 신호 패턴 — 단일 진실원천(SSoT, RQ-031).
 *
 * §3(b) instruction-override 신호를 두 detector가 **동일 사전**으로 판정하도록 공유한다:
 *  - `gateway/redaction-boundary.ts` `DeterministicPromptInjectionDetector` (wired Gateway redaction 경로)
 *  - `security/compliance-scaffold.ts` `inspectPromptInjection` (reference detector + hidden-instruction)
 * 두 detector가 별도 패턴으로 분기해 같은 텍스트에 상이 판정하던 문제(RQ-031, break-it wf_c5cdd6d9 발견)를 닫는다.
 *
 * §53("신호(b)의 패턴 사전은 운영 정책으로 갱신")에 따라 확장 가능(closed-but-extensible). 영어 변형(비연속·역할
 * 재지정) + 한국어 canonical "너는 이제~"/축약/지시-무시를 포함한다. 모든 영어 패턴은 `i` 플래그라 호출측이
 * 원문/소문자 어느 쪽을 넘겨도 동일하게 동작한다(한국어는 대소문자 무관).
 *
 * §3(c) credential-exfiltration 은 두 detector가 **의도적으로 다른 전략**(gateway=구문 기반 "send credentials to
 * http", scaffold=키워드 기반 bare "password/token")을 쓴다 — 단순 union하면 gateway의 페이지-텍스트 경로가 모든
 * 로그인 페이지를 과차단한다. 따라서 §3(c) 통합은 별도 detection-strategy 결정이 필요해 여기서 통합하지 않는다.
 */

/** §3(b) instruction-override 패턴(영어 비연속/역할재지정 + 한국어 canonical/축약/지시-무시). */
export const INSTRUCTION_OVERRIDE_PATTERNS: readonly RegExp[] = [
  // 영어 — 이전/시스템 지시 무시(비연속 변형 "ignore all previous instructions" 포함):
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\b/i,
  /\b(?:ignore|disregard|override)\s+(?:the\s+)?(?:system|developer)?\s*(?:prompt|instructions?|rules?|message)\b/i,
  /\bsystem\s+prompt\b/i,
  /\bdeveloper\s+message\b/i,
  // 영어 — 역할 재지정("너는 이제~"의 영어 등가):
  /\b(?:you\s+are|you're)\s+now\b/i,
  /\bfrom\s+now\s+on\b[\s\S]{0,24}\byou\s+(?:are|will|must|should)\b/i,
  // 한국어 — security-contracts §3 canonical "너는 이제~" + 축약(넌)/어순(이제부터 너는) 변형:
  /(?:너는|넌|당신은)\s*(?:이제|이제부터)/,
  /(?:이제부터|지금부터)\s*(?:너는|넌|당신은)/,
  // 한국어 — 이전 지시/지침/규칙 무시·망각:
  /(?:이전|위|앞|기존)\s*(?:의)?\s*(?:지시|지침|명령|규칙|프롬프트)(?:사항)?\s*(?:을|를)?\s*(?:모두\s*)?(?:무시|잊)/,
  /(?:지시|지침|명령|규칙|프롬프트)(?:사항)?\s*(?:을|를)?\s*(?:모두\s*)?무시/,
  /시스템\s*프롬프트/,
];

/** 텍스트가 §3(b) instruction-override 신호를 담는지(대소문자 무관). */
export function matchesInstructionOverride(text: string): boolean {
  return INSTRUCTION_OVERRIDE_PATTERNS.some((pattern) => pattern.test(text));
}
