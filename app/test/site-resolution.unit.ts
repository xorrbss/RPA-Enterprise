/**
 * 단위 테스트 — site-resolution (extractEntryNavigateUrlRef / originOf / resolveSiteProfileId 심볼릭 가드).
 *
 * 외부 의존 없음(순수; resolveSiteProfileId 심볼릭 분기는 DB 질의 전에 throw하므로 never-call 스텁 사용).
 * 실행: `tsx test/site-resolution.unit.ts`. 매칭/0-match/ambiguity는 실 DB 필요라 run-multisite-resolution.int 에서 검증.
 */
import type pg from "pg";

import {
  extractEntryNavigateUrlRef,
  originOf,
  resolveSiteProfileId,
  resolveUrlRef,
  SiteResolutionError,
} from "../src/runtime/site-resolution";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function throwsCode(label: string, fn: () => void, code: string): void {
  try {
    fn();
    check(label, false, "throw 기대했으나 통과");
  } catch (e) {
    check(label, e instanceof SiteResolutionError && e.code === code, e instanceof Error ? e.message : String(e));
  }
}

// 1) originOf
check("originOf 절대 URL → origin", originOf("http://127.0.0.1:8080/fixture/reviews") === "http://127.0.0.1:8080");
check("originOf glob 접미사 무시(경로 제거)", originOf("https://shop.example/*") === "https://shop.example");
check("originOf full URL → origin", originOf("https://shop.example/vp/products/1?page=2") === "https://shop.example");
check("originOf 심볼릭(절대 URL 아님) → null", originOf("orders_url") === null);
// RQ-021/024: opaque-origin scheme(file:/javascript:/data:/blob:)은 http(s) 절대 URL 아님 → null(fail-closed).
//   (URL.origin 이 문자열 "null"을 반환해 `===null` 가드를 무력화하던 fail-open 교정.)
check("originOf file: → null", originOf("file:///etc/passwd") === null);
check("originOf javascript: → null", originOf("javascript:alert(document.cookie)") === null);
check("originOf data: → null", originOf("data:text/html,<script>x</script>") === null);
check("originOf blob: → null", originOf("blob:http://a/x") === null);

// 2) extractEntryNavigateUrlRef — 선형(start가 navigate)
check(
  "선형: start navigate url_ref 추출",
  extractEntryNavigateUrlRef({
    start: "open",
    nodes: { open: { what: [{ action: "navigate", url_ref: "http://a.example/x" }], next: "check" }, check: { terminal: "success" } },
  }) === "http://a.example/x",
);

// 3) BFS: start가 observe → next → navigate (깊은 navigate 도달)
check(
  "BFS next: 깊은 navigate 도달",
  extractEntryNavigateUrlRef({
    start: "s",
    nodes: {
      s: { what: [{ action: "observe" }], next: "go" },
      go: { what: [{ action: "navigate", url_ref: "http://b.example/y" }], next: "done" },
      done: { terminal: "success" },
    },
  }) === "http://b.example/y",
);

// 4) BFS: start가 on[] 분기 → 분기 target에 navigate
check(
  "BFS on[]: 분기 target navigate 도달",
  extractEntryNavigateUrlRef({
    start: "branch",
    nodes: {
      branch: { what: [{ action: "observe" }], on: [{ when: "flags.blocked", target: "go", priority: 1 }] },
      go: { what: [{ action: "navigate", url_ref: "http://c.example/z" }], terminal: "success" },
    },
  }) === "http://c.example/z",
);

// 5) navigate 부재 → IR_SCHEMA_INVALID
throwsCode(
  "navigate 부재 → IR_SCHEMA_INVALID",
  () => extractEntryNavigateUrlRef({ start: "s", nodes: { s: { what: [{ action: "observe" }], terminal: "success" } } }),
  "IR_SCHEMA_INVALID",
);

// 6) url_ref 누락 → IR_SCHEMA_INVALID
throwsCode(
  "navigate.url_ref 누락 → IR_SCHEMA_INVALID",
  () => extractEntryNavigateUrlRef({ start: "s", nodes: { s: { what: [{ action: "navigate" }] } } }),
  "IR_SCHEMA_INVALID",
);

// 7) ir 형식 무효 → IR_SCHEMA_INVALID
throwsCode("ir 형식 무효 → IR_SCHEMA_INVALID", () => extractEntryNavigateUrlRef({ nodes: {} }), "IR_SCHEMA_INVALID");

// 8) resolveUrlRef — url_ref(키) → params 의 절대 URL. 키-only, fallback 없음(조용한 coercion 금지).
check("resolveUrlRef: 정상 키→절대 URL", resolveUrlRef("entry_url", { entry_url: "http://a.example/x" }) === "http://a.example/x");
throwsCode("resolveUrlRef: params undefined → URL_REF_PARAM_MISSING", () => resolveUrlRef("entry_url", undefined), "URL_REF_PARAM_MISSING");
throwsCode("resolveUrlRef: 키 부재 → URL_REF_PARAM_MISSING", () => resolveUrlRef("entry_url", {}), "URL_REF_PARAM_MISSING");
throwsCode("resolveUrlRef: 비-문자열 → URL_REF_PARAM_NOT_STRING", () => resolveUrlRef("k", { k: 7 }), "URL_REF_PARAM_NOT_STRING");
throwsCode("resolveUrlRef: 빈 문자열 → URL_REF_PARAM_EMPTY", () => resolveUrlRef("k", { k: "" }), "URL_REF_PARAM_EMPTY");
throwsCode("resolveUrlRef: 비-절대URL 값 → URL_REF_VALUE_NOT_ABSOLUTE_URL", () => resolveUrlRef("k", { k: "orders_url" }), "URL_REF_VALUE_NOT_ABSOLUTE_URL");
// RQ-021: opaque scheme 값은 절대 URL로 흡수 금지(file:/javascript:/data: navigation fail-open) → loud throw.
throwsCode("resolveUrlRef: file: → URL_REF_VALUE_NOT_ABSOLUTE_URL", () => resolveUrlRef("k", { k: "file:///etc/passwd" }), "URL_REF_VALUE_NOT_ABSOLUTE_URL");
throwsCode("resolveUrlRef: javascript: → URL_REF_VALUE_NOT_ABSOLUTE_URL", () => resolveUrlRef("k", { k: "javascript:alert(1)" }), "URL_REF_VALUE_NOT_ABSOLUTE_URL");
throwsCode("resolveUrlRef: data: → URL_REF_VALUE_NOT_ABSOLUTE_URL", () => resolveUrlRef("k", { k: "data:text/html,x" }), "URL_REF_VALUE_NOT_ABSOLUTE_URL");

// 9) resolveSiteProfileId 방어적 불변식 — 비-절대URL 직접 전달(해소 누락 호출측 버그)은 질의 전 loud throw.
const neverClient = {
  query: () => {
    throw new Error("DB가 호출되면 안 됨(비-절대URL은 질의 전 throw)");
  },
} as unknown as pg.PoolClient;

await (async () => {
  try {
    await resolveSiteProfileId(neverClient, { tenantId: "t", entryUrlRef: "orders_url" });
    check("resolveSiteProfileId 방어 가드: 비-절대URL → URL_REF_SYMBOLIC_UNRESOLVED(질의 전)", false, "throw 기대");
  } catch (e) {
    check(
      "resolveSiteProfileId 방어 가드: 비-절대URL → URL_REF_SYMBOLIC_UNRESOLVED(질의 전)",
      e instanceof SiteResolutionError && e.code === "URL_REF_SYMBOLIC_UNRESOLVED",
      e instanceof Error ? e.message : String(e),
    );
  }
})();

// RQ-024: opaque-origin entryUrlRef(file: 등)도 질의 전 loud throw — 이전엔 originOf "null" 문자열로 가드가
//   무력화돼 무관 site_profile에 오매칭(잘못된 selector/identity/network policy)될 수 있었다.
await (async () => {
  try {
    await resolveSiteProfileId(neverClient, { tenantId: "t", entryUrlRef: "file:///etc/passwd" });
    check("resolveSiteProfileId: opaque file: → URL_REF_SYMBOLIC_UNRESOLVED(질의 전)", false, "throw 기대");
  } catch (e) {
    check(
      "resolveSiteProfileId: opaque file: → URL_REF_SYMBOLIC_UNRESOLVED(질의 전)",
      e instanceof SiteResolutionError && e.code === "URL_REF_SYMBOLIC_UNRESOLVED",
      e instanceof Error ? e.message : String(e),
    );
  }
})();

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: site-resolution — entry navigate 추출(BFS) + origin 정규화 + 심볼릭 url_ref loud 가드");
process.exit(0);
