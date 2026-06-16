/**
 * ResumeTokenCodec 구현 (RQ-016 suspend 경로 step3). reserved-handlers.md ResumeToken / security-contracts §5.
 *
 * 서명 모델(오너 결정): SecretStore.resolve(signingKeyRef)→PlainSecret 이 `{kid, key}`(활성 서명키, well-known SecretRef)를
 * 반환 → 로컬 HMAC-SHA256 서명(SecretStore 는 resolve 만 제공, sign op 없음). 키 자료는 SecretStore/KMS, DB 엔 서명 봉투만.
 * canonical bytes(오너 결정): hmac 제외 봉투를 **키 정렬 결정형 JSON(UTF-8)** → HMAC-SHA256 → hex. issue/verify 가
 * byte 단위 일치. 회전: 활성 {kid,key} 단일 — 폐기 키(grace) 검증은 후속(현재 token.kid≠활성 kid → invalid).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { PlainSecret, SecretRef, SecretStore } from "../../../ts/core-types";
import type { ResumeTokenCodec, ResumeTokenEnvelope, ResumeTokenVerification } from "../../../ts/runtime-contract";

interface SigningKey {
  readonly kid: string;
  readonly key: string;
}

function isSigningKey(v: unknown): v is SigningKey {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { kid?: unknown }).kid === "string" &&
    typeof (v as { key?: unknown }).key === "string" &&
    (v as { kid: string }).kid.length > 0 &&
    (v as { key: string }).key.length > 0
  );
}

/** 키 정렬 결정형 JSON(재귀). 서명 canonical bytes 의 SSoT — 외부 모듈 비의존(서명 안정성). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function signHex(envelopeWithoutHmac: Omit<ResumeTokenEnvelope, "hmac">, key: string): string {
  return createHmac("sha256", key).update(stableStringify(envelopeWithoutHmac), "utf8").digest("hex");
}

function hexEqual(a: string, b: string): boolean {
  // 길이 다르면 timingSafeEqual 이 throw → 먼저 길이 비교(불일치=즉시 false), 같으면 상수시간 비교.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export class HmacResumeTokenCodec implements ResumeTokenCodec {
  constructor(
    private readonly secretStore: SecretStore,
    private readonly signingKeyRef: SecretRef,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async issue(input: Omit<ResumeTokenEnvelope, "kid" | "hmac">): Promise<ResumeTokenEnvelope> {
    const { kid, key } = await this.resolveKey();
    const withoutHmac: Omit<ResumeTokenEnvelope, "hmac"> = { ...input, kid };
    return { ...withoutHmac, hmac: signHex(withoutHmac, key) };
  }

  async verify(token: ResumeTokenEnvelope): Promise<ResumeTokenVerification> {
    const { kid, key } = await this.resolveKey();
    if (token.kid !== kid) {
      // 폐기 키(grace) 검증은 후속 — 현재 활성 kid 만 인정.
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: `resume token kid '${token.kid}' is not the active signing kid` };
    }
    const { hmac, ...withoutHmac } = token;
    if (!hexEqual(hmac, signHex(withoutHmac, key))) {
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: "resume token hmac mismatch (위변조 의심)" };
    }
    if (Date.parse(token.expiresAt) <= this.now()) {
      return { kind: "expired", code: "CHALLENGE_UNRESOLVED", reason: `resume token expired at ${token.expiresAt}` };
    }
    return { kind: "valid", token };
  }

  private async resolveKey(): Promise<SigningKey> {
    const raw: PlainSecret = await this.secretStore.resolve(this.signingKeyRef);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw as string);
    } catch {
      throw new Error("HmacResumeTokenCodec: signing key SecretRef payload is not valid JSON (expected {kid,key})");
    }
    if (!isSigningKey(parsed)) {
      throw new Error("HmacResumeTokenCodec: signing key SecretRef payload must encode {kid, key}");
    }
    return parsed;
  }
}
