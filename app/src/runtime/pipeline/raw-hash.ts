/**
 * raw_hash canonicalization (D6 — db/migration_concurrency_idempotency.sql FIX#6).
 *
 * `raw_hash = sha256(canonical_json(raw_payload − volatile_fields))` — raw_items 멱등 인입의 전제.
 * 미고정 시 동일 내용이 다른 해시로 중복 인입되어 #11 멱등 목적이 무력화된다.
 *
 * canonical_json 규칙(FIX#6):
 *  - object key 재귀 정렬(키 순서 비결정성 제거)
 *  - 직렬화 공백 없음(compact JSON.stringify) = "공백 normalize"
 *  - 문자열·키 UTF-8 NFC 정규화(합성/분해형 동일 처리)
 *  - volatile_fields(collected_at·page timestamp·request id·서버 echo nonce 등 매 수집 변동값)는
 *    이름 기준 재귀 제외. collect_tier도 hash 미포함(동일 내용을 다른 tier로 재수집해도 dedup) —
 *    별도 컬럼이라 payload에 없거나, 커넥터가 volatileFields로 전달해 제외한다.
 *
 * 결정론만 책임진다(부작용/now()/random 없음). 어떤 필드가 volatile인지는 커넥터 설정이 정하며
 * 인입측(raw-ingest)이 목록을 주입한다.
 */
import { createHash } from "node:crypto";

/** 재귀 정규화: 키 정렬 + NFC + volatile 제외. JSON 직렬화 가능한 표현으로 환원한다. */
function canonicalize(value: unknown, volatile?: ReadonlySet<string>): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, volatile));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (volatile?.has(key)) continue; // 이름 기준 재귀 제외
      out[key.normalize("NFC")] = canonicalize(source[key], volatile);
    }
    return out;
  }
  // number / boolean / null / undefined 는 그대로(JSON.stringify가 처리).
  return value;
}

/** canonical JSON 문자열(compact, 키 정렬, NFC). 같은 내용 → 같은 문자열. */
export function canonicalJson(value: unknown, volatileFields?: ReadonlySet<string>): string {
  return JSON.stringify(canonicalize(value, volatileFields));
}

/** raw_hash(sha256 hex). volatileFields는 이름 기준 재귀 제외 목록(커넥터 설정). */
export function computeRawHash(payload: unknown, volatileFields?: readonly string[]): string {
  const set = volatileFields && volatileFields.length > 0 ? new Set(volatileFields) : undefined;
  return createHash("sha256").update(canonicalJson(payload, set), "utf8").digest("hex");
}
