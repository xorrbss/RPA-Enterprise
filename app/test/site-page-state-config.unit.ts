/**
 * 단위 테스트 — parseSitePageStateConfig (site_profiles.page_state_selectors jsonb 엄격 검증).
 *
 * 외부 의존 없음(순수). 실행: `tsx test/site-page-state-config.unit.ts`.
 * 검증("조용한 false/unknown 금지" — 무효 config 는 조용히 수용하지 않고 PAGE_STATE_UNRESOLVED throw):
 *  - 유효 config(authenticatedWhen + flags 3종 rule) 환원
 *  - authenticatedWhen 생략 가능
 *  - 닫힌 레지스트리 밖 flag 키 거부 / 잘못된 rule.kind / 빈 selector / min_count n 누락 / 비객체 거부
 */
import { parseSitePageStateConfig } from "../src/executor/site-page-state-config";
import { PageStateResolverError } from "../src/executor/page-state-resolver";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function rejects(label: string, raw: unknown): void {
  try {
    parseSitePageStateConfig(raw);
    check(label, false, "throw 기대했으나 통과함");
  } catch (e) {
    check(label, e instanceof PageStateResolverError && e.code === "PAGE_STATE_UNRESOLVED", e instanceof Error ? e.message : String(e));
  }
}

// 1) 유효 config 환원
const ok = parseSitePageStateConfig({
  authenticatedWhen: { selector: ".user-menu" },
  flags: {
    reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
    not_found: { kind: "present", selector: ".empty" },
    no_next_page: { kind: "absent", selector: "a.next:not(.disabled)" },
  },
});
check("유효 config: authenticatedWhen 환원", ok.authenticatedWhen?.selector === ".user-menu");
check("유효 config: min_count rule 환원", ok.flags.reviews_visible?.kind === "min_count" && (ok.flags.reviews_visible as { n: number }).n === 1);
check("유효 config: present/absent rule 환원", ok.flags.not_found?.kind === "present" && ok.flags.no_next_page?.kind === "absent");

// 2) authenticatedWhen 생략 가능
const noAuth = parseSitePageStateConfig({ flags: { blocked: { kind: "present", selector: ".b" } } });
check("authenticatedWhen 생략 허용", noAuth.authenticatedWhen === undefined && noAuth.flags.blocked?.kind === "present");

// 3) 무효 거부(전부 PAGE_STATE_UNRESOLVED)
rejects("비객체 거부", "nope");
rejects("flags 누락 거부", { authenticatedWhen: { selector: ".x" } });
rejects("flags 비객체 거부", { flags: 7 });
rejects("닫힌 레지스트리 밖 flag 키 거부", { flags: { cursor_reached: { kind: "present", selector: ".x" } } });
rejects("알 수 없는 rule.kind 거부", { flags: { blocked: { kind: "regex", selector: ".x" } } });
rejects("빈 selector 거부", { flags: { blocked: { kind: "present", selector: "" } } });
rejects("min_count n 누락 거부", { flags: { reviews_visible: { kind: "min_count", selector: ".r" } } });
rejects("min_count 음수 n 거부", { flags: { reviews_visible: { kind: "min_count", selector: ".r", n: -1 } } });
rejects("authenticatedWhen.selector 무효 거부", { authenticatedWhen: { selector: 5 }, flags: {} });

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: parseSitePageStateConfig — 유효 환원 + 무효 거부(조용한 수용 금지)");
process.exit(0);
