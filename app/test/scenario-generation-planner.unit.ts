/**
 * Unit coverage for the deterministic scenario planner's navigate(open_start_url) verify 방출.
 *
 * 초점: startUrlLandingVerify 가 만드는 url_matches 정규식이 동일 host(서브도메인·www·http↔https)는 통과시키고
 * off-host 리다이렉트(로그인 벽·도메인 파킹·phishing 접미부)는 거부하는지 — 생성 시나리오의 조용한 false 를 막는
 * 게이트의 false-positive/false-negative 양쪽을 막는다.
 *
 * 실행: npm --prefix app exec -- tsx app/test/scenario-generation-planner.unit.ts
 */
import { startUrlLandingVerify } from "../src/api/scenario-generation-planner";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function patternFor(startUrl: string): string | undefined {
  const v = startUrlLandingVerify(startUrl);
  if (v === undefined) return undefined;
  const criteria = v.criteria as ReadonlyArray<{ type: string; pattern: string }>;
  return criteria[0]?.pattern;
}

function landsOk(startUrl: string, currentUrl: string): boolean {
  const pattern = patternFor(startUrl);
  if (pattern === undefined) throw new Error(`no verify pattern for ${startUrl}`);
  return new RegExp(pattern).test(currentUrl);
}

function main(): void {
  // 형태: url_matches criterion 단일, pattern 은 유효 정규식.
  const v = startUrlLandingVerify("https://example.com/notices");
  check("verify shape: criteria[0].type === url_matches", Array.isArray(v?.criteria) && (v!.criteria as Array<{ type: string }>)[0]?.type === "url_matches", JSON.stringify(v));
  check("pattern is a valid regex", (() => { try { new RegExp(patternFor("https://example.com")!); return true; } catch { return false; } })());

  // 동일 host — 통과해야 함(false-positive 금지).
  check("same url passes", landsOk("https://example.com/notices", "https://example.com/notices"));
  check("path change on same host passes", landsOk("https://example.com/notices", "https://example.com/home"));
  check("www added passes", landsOk("https://example.com/x", "https://www.example.com/y"));
  check("www dropped passes", landsOk("https://www.example.com/x", "https://example.com/y"));
  check("http<->https passes", landsOk("https://example.com", "http://example.com/"));
  check("subdomain passes", landsOk("https://example.com", "https://app.example.com/dashboard"));
  check("port passes", landsOk("https://example.com", "https://example.com:8443/"));
  check("query/hash boundary passes", landsOk("https://example.com", "https://example.com?q=1"));
  check("subdomain start_url stays on subdomain passes", landsOk("https://notices.example.com/list", "https://notices.example.com/p/2"));

  // off-host — 거부해야 함(조용한 false 금지: 로그인/에러/차단/파킹/phishing).
  check("off-host redirect fails", !landsOk("https://example.com", "https://login.idp.com/sso?return=example.com"));
  check("phishing suffix host fails", !landsOk("https://example.com", "https://example.com.evil.com/"));
  check("host only in path fails", !landsOk("https://example.com", "https://other.com/example.com"));
  check("different domain fails", !landsOk("https://example.com", "https://example.org/"));

  // 파싱 불가/비-http — verify 미방출(undefined). 잘못된 근거로 false 만들지 않는다.
  check("non-http url emits no verify", startUrlLandingVerify("ftp://example.com") === undefined);
  check("garbage emits no verify", startUrlLandingVerify("not a url") === undefined);
  check("empty emits no verify", startUrlLandingVerify("") === undefined);

  if (failures > 0) {
    console.error(`\nFAIL: scenario-generation-planner.unit (${failures})`);
    process.exit(1);
  }
  console.log("\nPASS: scenario-generation-planner.unit");
}

main();
