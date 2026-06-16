/**
 * 단위 — HmacResumeTokenCodec (resume-token 발행/검증, RQ-016 suspend step3). 외부 의존 없음(mock SecretStore).
 *
 * 검증: issue → kid+hmac(sha256 hex 64) 설정. verify 라운드트립 valid. 위변조(필드 변경)→invalid(hmac mismatch).
 * 만료→expired(CHALLENGE_UNRESOLVED). 활성 kid≠token.kid→invalid. SecretStore.resolve {kid,key} 페이로드.
 * 실행: tsx test/resume-token-codec.unit.ts.
 */
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { ResumeTokenEnvelope } from "../../ts/runtime-contract";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const KEY_PAYLOAD = JSON.stringify({ kid: "kid-1", key: "test-signing-key-abcdef" });
const fakeStore: SecretStore = { resolve: async () => KEY_PAYLOAD as unknown as PlainSecret };
const REF = "secret://test/resume_token_hmac" as unknown as SecretRef;

const baseInput = {
  runId: "71000000-0000-0000-0000-000000000001",
  resumeNodeId: "challenge",
  pageStateRef: "ps_after",
  issuedAt: "2026-06-16T00:00:00.000Z",
  expiresAt: "2026-06-16T00:30:00.000Z",
} as unknown as Omit<ResumeTokenEnvelope, "kid" | "hmac">;

async function main(): Promise<void> {
  const within = Date.parse("2026-06-16T00:10:00.000Z"); // 만료 전
  const codec = new HmacResumeTokenCodec(fakeStore, REF, () => within);

  const token = await codec.issue(baseInput);
  check("issue → kid='kid-1'", token.kid === "kid-1", token.kid);
  check("issue → hmac sha256 hex(64자)", typeof token.hmac === "string" && /^[0-9a-f]{64}$/.test(token.hmac), token.hmac);

  const v = await codec.verify(token);
  check("verify 라운드트립 → valid", v.kind === "valid", v.kind);

  // 결정형: 같은 입력 재발행 → 동일 hmac(canonical bytes 안정).
  const token2 = await codec.issue(baseInput);
  check("동일 입력 재발행 hmac 동일(결정형)", token2.hmac === token.hmac);

  // 위변조: resumeNodeId 변경 → hmac mismatch.
  const tampered: ResumeTokenEnvelope = { ...token, resumeNodeId: "evil" };
  const vt = await codec.verify(tampered);
  check("위변조(resumeNodeId) → invalid(hmac mismatch)", vt.kind === "invalid", vt.kind);

  // 만료: now > expiresAt → expired.
  const expiredCodec = new HmacResumeTokenCodec(fakeStore, REF, () => Date.parse("2026-06-16T01:00:00.000Z"));
  const ve = await expiredCodec.verify(token);
  check("만료 → expired(CHALLENGE_UNRESOLVED)", ve.kind === "expired" && (ve as { code: string }).code === "CHALLENGE_UNRESOLVED", ve.kind);

  // kid 불일치: token.kid != 활성 kid → invalid(폐기 키 grace 후속).
  const otherKid: ResumeTokenEnvelope = { ...token, kid: "kid-99" };
  const vk = await codec.verify(otherKid);
  check("활성 kid != token.kid → invalid", vk.kind === "invalid", vk.kind);

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: HmacResumeTokenCodec — issue/verify(round-trip·tamper·expired·kid) (RQ-016 suspend step3)");
  process.exit(0);
}

main().catch((e) => {
  console.error("resume-token-codec unit fatal:", e);
  process.exit(1);
});
