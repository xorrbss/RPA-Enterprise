/**
 * D6 단위 — raw_hash canonicalization (db/migration_concurrency_idempotency.sql FIX#6).
 *
 * 규칙: raw_hash = sha256(canonical_json(raw_payload − volatile_fields))
 *   - canonical_json: object key 정렬(재귀) + 직렬화 공백 제거(compact) + 문자열 UTF-8 NFC
 *   - volatile_fields(collected_at·page timestamp·request id·서버 echo nonce 등) 제외(재귀, 이름 기준)
 *   - collect_tier는 hash 미포함(별도 컬럼이라 payload에 없거나, volatile로 전달돼 제외)
 * 결정론: 동일 내용은 키순서/NFC 차이와 무관히 동일 해시, 내용 변경 시 다른 해시.
 */
import { computeRawHash, canonicalJson } from "../src/runtime/pipeline/raw-hash";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1) 키 순서 무관(재귀)
const a = { b: 1, a: { y: 2, x: 3 }, c: [1, 2, 3] };
const b = { c: [1, 2, 3], a: { x: 3, y: 2 }, b: 1 };
check("key reorder -> same hash", computeRawHash(a) === computeRawHash(b), `${computeRawHash(a)} vs ${computeRawHash(b)}`);

// 2) canonical_json은 compact(직렬화 공백 없음) + 키 정렬
check(
  "canonicalJson is compact + sorted",
  canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}',
  canonicalJson({ b: 1, a: 2 }),
);

// 3) UTF-8 NFC: 합성형(U+00E9) vs 분해형(e + U+0301) → 동일 해시. 소스는 ASCII escape로 구성(에디터 정규화 회피).
const composed = { name: "café" };       // precomposed e-acute
const decomposed = { name: "café" };     // e + combining acute
check(
  "NFC composed == decomposed",
  composed.name !== decomposed.name && computeRawHash(composed) === computeRawHash(decomposed),
  composed.name === decomposed.name ? "inputs identical (test bug)" : "ok-distinct",
);

// 4) volatile 필드 제외(재귀): collected_at/request_id/nonce 변동 → 동일 해시
const volatile = ["collected_at", "request_id", "nonce"];
const v1 = { review: "good", collected_at: "2026-06-15T00:00:00Z", request_id: "r1", meta: { nonce: "n1" } };
const v2 = { review: "good", collected_at: "2026-06-15T09:09:09Z", request_id: "r2", meta: { nonce: "n2" } };
check("volatile fields excluded -> same hash", computeRawHash(v1, volatile) === computeRawHash(v2, volatile));

// 5) volatile 미제외 시에는 달라야(가드: 제외가 실제로 동작함을 반증)
check("without exclusion volatile changes hash", computeRawHash(v1) !== computeRawHash(v2));

// 6) 실제 내용 변경 → 다른 해시
check("content change -> different hash", computeRawHash({ review: "good" }) !== computeRawHash({ review: "bad" }));

// 7) collect_tier를 volatile로 전달하면 tier 차이 무시(재수집 dedup)
const tierA = { review: "good", collect_tier: "fast" };
const tierB = { review: "good", collect_tier: "full" };
check(
  "collect_tier excluded when listed volatile",
  computeRawHash(tierA, ["collect_tier"]) === computeRawHash(tierB, ["collect_tier"]),
);

// 8) 해시는 64-hex(sha256)
check("hash is 64-hex sha256", /^[0-9a-f]{64}$/.test(computeRawHash({ x: 1 })));

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: D6 raw-hash canonicalization unit green");
process.exit(0);
