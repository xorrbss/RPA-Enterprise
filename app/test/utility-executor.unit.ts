/**
 * 단위 테스트 — UtilityExecutor navigate scheme 가드(RQ-021 방어심층).
 *
 * 실행기는 url을 독립 재검증하는 신뢰경계다 — http(s)만 허용하고 opaque scheme(file:/javascript:/data:/blob:)은
 * fail-closed throw(producer site-resolution.originOf 가드와 동일 규약, 단일 producer 가정 비의존).
 * 외부 의존 없음(순수): assertUtilityAction 이 sessions.forLease 이전에 검증하므로 never-call 세션 스텁 사용.
 * 실행: `tsx test/utility-executor.unit.ts`.
 */
import { UtilityExecutor, UtilityExecutorError } from "../src/executor/utility-executor";
import type { CdpSessionProvider } from "../src/executor/cdp-session";
import type { RunContext } from "../../ts/core-types";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const neverSessions = {
  forLease() {
    throw new Error("session must not be reached — invalid navigate scheme should throw before session use");
  },
} as unknown as CdpSessionProvider;

// verify(criteria) 용 세션 스텁: evaluate 는 고정 결과, url() 은 고정 URL(슬라이스3 결정형 criteria 평가용).
function mockSessions(opts: { evalResult?: unknown; url?: string }): CdpSessionProvider {
  const session = {
    url: () => opts.url ?? "about:blank",
    evaluate: async () => opts.evalResult,
  };
  return { forLease: () => session } as unknown as CdpSessionProvider;
}

const exec = new UtilityExecutor(neverSessions);
// assertUtilityAction(scheme 가드)은 abort 체크(false) 직후·session 사용 이전에 실행되므로 ctx는 abortSignal만 필요.
const ctx = { abortSignal: { aborted: false } } as unknown as RunContext;
const policyCtx = {
  runId: "run-1",
  tenantId: "tenant-1",
  nodeId: "open",
  attempt: 0,
  pageState: {
    url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
    dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
    auth: "anonymous",
    flags: {},
    matchedWhere: [],
  },
  siteProfileId: "site-1",
  browserIdentityId: "bid-1",
  networkPolicyId: "np-1",
  networkAllowedDomains: ["example.com"],
  leaseId: "lease-1",
  assetRefs: {},
  abortSignal: new AbortController().signal,
} satisfies RunContext;

async function expectSchemeRejected(label: string, url: string): Promise<void> {
  try {
    await exec.execute("s1", { type: "navigate", url }, ctx);
    check(label, false, "throw 기대했으나 통과");
  } catch (e) {
    check(label, e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", e instanceof Error ? e.message : String(e));
  }
}

await (async () => {
  // RQ-021 방어심층: opaque scheme은 실행기에서 IR_SCHEMA_INVALID로 fail-closed.
  await expectSchemeRejected("navigate file: → IR_SCHEMA_INVALID", "file:///etc/passwd");
  await expectSchemeRejected("navigate javascript: → IR_SCHEMA_INVALID", "javascript:alert(document.cookie)");
  await expectSchemeRejected("navigate data: → IR_SCHEMA_INVALID", "data:text/html,<script>x</script>");
  await expectSchemeRejected("navigate blob: → IR_SCHEMA_INVALID", "blob:http://a/x");
  // 비-절대 URL은 기존대로 IR_SCHEMA_INVALID.
  await expectSchemeRejected("navigate 비-절대URL → IR_SCHEMA_INVALID", "orders_url");

  // http(s)는 scheme 가드를 통과해야 한다 → session 도달(neverSessions)로 인한 비-IR_SCHEMA_INVALID 에러로 구분.
  let httpsPassedSchemeGate = false;
  try {
    await exec.execute("s1", { type: "navigate", url: "https://shop.example/products/1" }, ctx);
  } catch (e) {
    httpsPassedSchemeGate = !(e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID");
  }
  check("navigate https: scheme 가드 통과(차단되지 않음)", httpsPassedSchemeGate);
  const blocked = await exec.execute("s2", { type: "navigate", url: "https://evil.example/path" }, policyCtx);
  check("navigate policy mismatch -> failed_security", blocked.status === "failed_security", blocked.status);
  check("navigate policy mismatch code", blocked.exception?.code === "DOMAIN_POLICY_VIOLATION", JSON.stringify(blocked.exception));
  check("navigate policy mismatch no commit", blocked.sideEffect?.committed === false, JSON.stringify(blocked.sideEffect));

  let wildcardPassedPolicyGate = false;
  try {
    await exec.execute(
      "s3",
      { type: "navigate", url: "https://shop.example.com/products/1" },
      { ...policyCtx, networkAllowedDomains: ["*.example.com"] },
    );
  } catch (e) {
    wildcardPassedPolicyGate = !(e instanceof UtilityExecutorError && e.code === "DOMAIN_POLICY_VIOLATION");
  }
  check("navigate wildcard policy allows subdomain before session", wildcardPassedPolicyGate);

  // ── 슬라이스3: 결정형 verify criteria 확장 (element_absent/text_includes/url_matches) ──
  {
    const r = await new UtilityExecutor(mockSessions({ evalResult: true })).verify({ type: "element_absent", target: { selector: ".spinner" } }, policyCtx);
    check("verify element_absent 부재→pass", r.status === "pass", JSON.stringify(r));
  }
  {
    const r = await new UtilityExecutor(mockSessions({ evalResult: false })).verify({ type: "element_absent", target: { selector: ".spinner" } }, policyCtx);
    check("verify element_absent 잔존→fail_det", r.status === "fail_det" && r.failedCriteria.includes("element_absent"), JSON.stringify(r));
  }
  {
    const r = await new UtilityExecutor(mockSessions({ evalResult: true })).verify({ type: "text_includes", texts: ["완료", "성공"] }, policyCtx);
    check("verify text_includes 포함→pass", r.status === "pass", JSON.stringify(r));
  }
  {
    const r = await new UtilityExecutor(mockSessions({ evalResult: false })).verify({ type: "text_includes", texts: ["없는문구"] }, policyCtx);
    check("verify text_includes 미포함→fail_det", r.status === "fail_det", JSON.stringify(r));
  }
  {
    const r = await new UtilityExecutor(mockSessions({ url: "https://shop.example/orders/done" })).verify({ type: "url_matches", pattern: "/orders/done$" }, policyCtx);
    check("verify url_matches 일치→pass", r.status === "pass", JSON.stringify(r));
  }
  {
    const r = await new UtilityExecutor(mockSessions({ url: "https://shop.example/cart" })).verify({ type: "url_matches", pattern: "/orders/done$" }, policyCtx);
    check("verify url_matches 불일치→fail_det", r.status === "fail_det", JSON.stringify(r));
  }
  {
    // 기존 지원(회귀): element_visible 유지
    const r = await new UtilityExecutor(mockSessions({ evalResult: true })).verify({ type: "element_visible", target: { selector: "#ok" } }, policyCtx);
    check("verify element_visible(기존) pass", r.status === "pass");
  }
  {
    // parse 오류 loud (조용한 false 금지)
    try { await new UtilityExecutor(mockSessions({})).verify({ type: "text_includes", texts: [] }, policyCtx); check("text_includes 빈배열→throw", false); }
    catch (e) { check("text_includes 빈배열→IR_SCHEMA_INVALID", e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", String(e)); }
  }
  {
    try { await new UtilityExecutor(mockSessions({})).verify({ type: "url_matches", pattern: "[invalid(regex" }, policyCtx); check("url_matches 잘못된 regex→throw", false); }
    catch (e) { check("url_matches 잘못된 regex→IR_SCHEMA_INVALID", e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", String(e)); }
  }
  {
    // 미지원 criterion 은 여전히 loud (value_match → vision 실행기)
    try { await new UtilityExecutor(mockSessions({})).verify({ type: "value_match", path: "x", equals: 1 }, policyCtx); check("value_match→throw", false); }
    catch (e) { check("value_match 미지원→EXECUTOR_CAPABILITY_MISMATCH", e instanceof UtilityExecutorError && e.code === "EXECUTOR_CAPABILITY_MISMATCH", String(e)); }
  }
})();

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: utility-executor navigate scheme 가드(RQ-021 방어심층) unit green");
process.exit(0);
