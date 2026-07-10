/**
 * 말로 고치기(revise) 순수 헬퍼 유닛 (F1/v2.37).
 *
 * 초점: (1) parseGenerationReviseRequest 경계 — instruction 1..2,000자·base_version 정수·unknown field 거부
 * (2) synthesizeRevisePrompt 합성 형식과 총길이 20,000자 상한(prompt_too_long 재사용)
 * (3) redactGenerationPrompt negative control — 비밀 포함 프롬프트가 마스킹 토큰으로 치환되고 비밀 원문이
 *     절대 남지 않는다(원문 저장 금지의 저장측 게이트). 비밀 없는 프롬프트는 무손실 통과.
 *
 * 실행: npm --prefix app exec -- tsx app/test/scenario-generation-revise.unit.ts
 */
import { parseGenerationReviseRequest } from "../src/api/scenario-generation-parse";
import { redactGenerationPrompt } from "../src/api/scenario-generation-redaction";
import { synthesizeRevisePrompt } from "../src/api/scenario-generation-revise";
import { ApiResponseError } from "../src/runtime/errors";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 실패 사유 추출 — throw 하지 않으면 undefined(조용한 통과를 FAIL 로 드러낸다). */
function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof ApiResponseError && isRecord(err.details) && typeof err.details.reason === "string") {
      return err.details.reason;
    }
    return "unexpected_error_shape";
  }
}

function main(): void {
  // ── parseGenerationReviseRequest ────────────────────────────────────────
  const ok = parseGenerationReviseRequest({ instruction: "  링크 주소도 함께 수집해줘  ", base_version: 3 });
  check("valid body parses with trimmed instruction", ok.instruction === "링크 주소도 함께 수집해줘" && ok.baseVersion === 3);
  check("instruction at 2000 chars passes", parseGenerationReviseRequest({ instruction: "가".repeat(2000), base_version: 1 }).instruction.length === 2000);

  check("non-object body rejected", reasonOf(() => parseGenerationReviseRequest("x")) === "request_body_object_required");
  check("empty instruction rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "", base_version: 1 })) === "instruction_required");
  check("whitespace-only instruction rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "   ", base_version: 1 })) === "instruction_required");
  check("missing instruction rejected", reasonOf(() => parseGenerationReviseRequest({ base_version: 1 })) === "instruction_required");
  check("instruction over 2000 chars rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "가".repeat(2001), base_version: 1 })) === "instruction_too_long");
  check("missing base_version rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "고쳐줘" })) === "invalid_base_version");
  check("zero base_version rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "고쳐줘", base_version: 0 })) === "invalid_base_version");
  check("fractional base_version rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "고쳐줘", base_version: 1.5 })) === "invalid_base_version");
  check("string base_version rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "고쳐줘", base_version: "1" })) === "invalid_base_version");
  check("unknown field rejected", reasonOf(() => parseGenerationReviseRequest({ instruction: "고쳐줘", base_version: 1, prompt: "x" })) === "unknown_field");

  // ── synthesizeRevisePrompt ──────────────────────────────────────────────
  check(
    "synthesized prompt keeps original + [수정 요청] marker + instruction",
    synthesizeRevisePrompt("공지 목록을 수집해줘", "링크도 담아줘") === "공지 목록을 수집해줘\n\n[수정 요청] 링크도 담아줘",
  );
  // 구분자("\n\n[수정 요청] ")는 10자: 총길이 = 원문 + 10 + 지시.
  check("synthesized prompt at exactly 20000 chars passes", synthesizeRevisePrompt("p".repeat(19000), "i".repeat(990)).length === 20000);
  check(
    "synthesized prompt over 20000 chars rejected as prompt_too_long",
    reasonOf(() => synthesizeRevisePrompt("p".repeat(19000), "i".repeat(991))) === "prompt_too_long",
  );

  // ── redactGenerationPrompt negative control ────────────────────────────
  const secretPrompt = "https://example.com 로그인 후 수집. 계정 password: hunter2 를 사용";
  const redacted = redactGenerationPrompt(secretPrompt);
  check("secret-bearing prompt is masked", redacted.includes("[REDACTED]"), redacted);
  check("secret plaintext never survives redaction", !redacted.includes("hunter2"), redacted);
  check("non-secret remainder is preserved", redacted.includes("https://example.com") && redacted.includes("수집"), redacted);
  const emailRedacted = redactGenerationPrompt("manager@example.com 에게 보고서를 보내는 절차를 정리해줘");
  check("email is masked", emailRedacted.includes("[REDACTED]") && !emailRedacted.includes("manager@example.com"), emailRedacted);
  const plain = "공지사항에서 최근 게시글 제목을 수집해줘";
  check("secret-free prompt passes through unchanged", redactGenerationPrompt(plain) === plain);

  if (failures > 0) {
    console.error(`scenario-generation-revise unit failures: ${failures}`);
    process.exit(1);
  }
  console.log("scenario-generation-revise unit passed");
}

main();
