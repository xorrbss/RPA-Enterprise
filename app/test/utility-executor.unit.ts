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
import type { PlainSecret, RunContext } from "../../ts/core-types";
import type { AuthenticatedPrincipal, SecretStoreBoundary } from "../../ts/security-middleware-contract";

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

// NPA-02 용: goto 는 no-op, url() 은 **착지 URL**(30x redirect 후 결과)을 반환하는 세션(요청≠착지 모사).
function redirectSessions(landedUrl: string): CdpSessionProvider {
  const session = { goto: async () => {}, url: () => landedUrl };
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
const connectorPrincipal = {
  subjectId: "runtime-connector" as AuthenticatedPrincipal["subjectId"],
  tenantId: "tenant-1" as AuthenticatedPrincipal["tenantId"],
  roles: ["operator"],
  source: "jwt",
  claims: {},
} satisfies AuthenticatedPrincipal;

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

  // ── NPA-02: navigate 착지 URL(30x redirect 후) 정책 재검증 (요청 URL 만 검사하면 redirect 로 우회) ──
  {
    // 요청은 allowlist 내(example.com)→pre-check 통과→goto 가 정책 밖(169.254.169.254=메타데이터 IMDS)으로 착지→재검증 차단.
    const redirected = await new UtilityExecutor(redirectSessions("https://169.254.169.254/latest/meta-data/")).execute(
      "s4", { type: "navigate", url: "https://example.com/start" }, policyCtx,
    );
    check("NPA-02 redirect 정책밖 착지 → failed_security", redirected.status === "failed_security", redirected.status);
    check("NPA-02 redirect 착지 DOMAIN_POLICY_VIOLATION", redirected.exception?.code === "DOMAIN_POLICY_VIOLATION", JSON.stringify(redirected.exception));
    check("NPA-02 redirect 착지 no commit", redirected.sideEffect?.committed === false, JSON.stringify(redirected.sideEffect));
    // 대조: allowlist 내 착지(같은 호스트 redirect)는 차단되지 않는다(false positive 아님).
    const okLanded = await new UtilityExecutor(redirectSessions("https://example.com/after-redirect")).execute(
      "s5", { type: "navigate", url: "https://example.com/start" }, policyCtx,
    );
    check("NPA-02 allowlist 내 착지 → 차단 안 됨", okLanded.status !== "failed_security", JSON.stringify(okLanded));
  }

  // ── 슬라이스3: 결정형 verify criteria 확장 (element_absent/text_includes/url_matches) ──
  // HTTP api_call P1: HTTP-only + SecretRef bearer only + network policy. Browser session is not required.
  {
    try {
      await new UtilityExecutor(neverSessions).execute(
        "api.noDeps",
        { type: "api_call", method: "GET", url: "https://api.example.com/status" },
        { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
      );
      check("api_call without HTTP deps -> throw", false);
    } catch (e) {
      check("api_call without HTTP deps -> EXECUTOR_CAPABILITY_MISMATCH", e instanceof UtilityExecutorError && e.code === "EXECUTOR_CAPABILITY_MISMATCH", String(e));
    }
  }
  {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const http = new UtilityExecutor(neverSessions, {
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
        return { status: 200, ok: true, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true }) };
      },
    });
    const res = await http.execute(
      "api.ok",
      { type: "api_call", method: "GET", url: "https://api.example.com/status", headers: { Accept: "application/json" } },
      { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
    );
    check("api_call GET succeeds without browser session", res.status === "success" && res.action === "api_call", JSON.stringify(res));
    check("api_call GET output status/body", (res.output as { status?: number; body?: { ok?: boolean } }).status === 200 && (res.output as { body?: { ok?: boolean } }).body?.ok === true, JSON.stringify(res.output));
    check("api_call GET sideEffect read_only", res.sideEffect?.kind === "read_only" && res.sideEffect.committed === true, JSON.stringify(res.sideEffect));
    check("api_call fetch called once", calls.length === 1 && calls[0].url === "https://api.example.com/status", JSON.stringify(calls));
  }
  {
    const resolved: Array<{ purpose: string; connectorId?: string }> = [];
    const secrets = {
      store: { resolve: async () => "bearer-token-123" as PlainSecret },
      authorize: async (request) => ({ kind: "allow", ref: request.ref }),
      resolveAuthorized: async (request) => {
        resolved.push({ purpose: request.purpose, ...(request.connectorId !== undefined ? { connectorId: request.connectorId } : {}) });
        return "bearer-token-123" as PlainSecret;
      },
    } satisfies SecretStoreBoundary;
    let authHeader = "";
    const http = new UtilityExecutor(neverSessions, {
      secrets,
      principal: connectorPrincipal,
      fetch: async (_url, init) => {
        authHeader = init.headers.Authorization ?? "";
        return {
          status: 200,
          ok: true,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ echoed: init.headers.Authorization }),
        };
      },
    });
    const res = await http.execute(
      "api.secret",
      {
        type: "api_call",
        method: "GET",
        url: "https://api.example.com/secure",
        connectorId: "http-api",
        auth: { type: "secret_ref_bearer", secret_ref: "secret://prod/connector/http-api/token" },
      },
      { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
    );
    check("api_call SecretRef bearer sends Authorization", authHeader === "Bearer bearer-token-123", authHeader);
    check("api_call SecretRef purpose connector", resolved.length === 1 && resolved[0].purpose === "connector" && resolved[0].connectorId === "http-api", JSON.stringify(resolved));
    check("api_call output redacts echoed secret", !JSON.stringify(res.output).includes("bearer-token-123") && JSON.stringify(res.output).includes("[REDACTED]"), JSON.stringify(res.output));
  }
  {
    const calls: string[] = [];
    const http = new UtilityExecutor(neverSessions, {
      fetch: async (url) => {
        calls.push(url);
        return { status: 200, ok: true, headers: { get: () => "text/plain" }, text: async () => "ok" };
      },
    });
    const res = await http.execute(
      "api.blocked",
      { type: "api_call", method: "GET", url: "https://evil.example/status" },
      { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
    );
    check("api_call policy mismatch -> failed_security", res.status === "failed_security" && res.action === "api_call", JSON.stringify(res));
    check("api_call policy mismatch no fetch", calls.length === 0, JSON.stringify(calls));
  }
  {
    let redirectMode = "";
    const http = new UtilityExecutor(neverSessions, {
      fetch: async (_url, init) => {
        redirectMode = init.redirect;
        return {
          status: 302,
          ok: false,
          headers: { get: (name) => name.toLowerCase() === "location" ? "https://169.254.169.254/latest/meta-data/" : "text/plain" },
          text: async () => "",
        };
      },
    });
    const res = await http.execute(
      "api.redirectBlocked",
      { type: "api_call", method: "GET", url: "https://api.example.com/status" },
      { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
    );
    check("api_call fetch uses manual redirect", redirectMode === "manual", redirectMode);
    check("api_call redirect landing outside policy -> failed_security", res.status === "failed_security" && res.exception?.code === "DOMAIN_POLICY_VIOLATION", JSON.stringify(res));
    check("api_call redirect policy mismatch no commit", res.sideEffect?.committed === false, JSON.stringify(res.sideEffect));
  }
  {
    try {
      await new UtilityExecutor(neverSessions, { fetch: async () => ({ status: 200, ok: true, headers: { get: () => "text/plain" }, text: async () => "ok" }) }).execute(
        "api.rawAuth",
        { type: "api_call", method: "GET", url: "https://api.example.com/status", headers: { Authorization: "Bearer plaintext" } },
        { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
      );
      check("api_call raw Authorization header -> throw", false);
    } catch (e) {
      check("api_call raw Authorization header -> IR_SCHEMA_INVALID", e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", String(e));
    }
  }
  {
    try {
      await new UtilityExecutor(neverSessions, { fetch: async () => ({ status: 200, ok: true, headers: { get: () => "text/plain" }, text: async () => "ok" }) }).execute(
        "api.basic",
        { type: "api_call", method: "GET", url: "https://api.example.com/status", auth: { type: "basic", username: "u", password: "p" } },
        { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
      );
      check("api_call basic auth -> throw", false);
    } catch (e) {
      check("api_call basic auth -> IR_SCHEMA_INVALID", e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", String(e));
    }
  }
  {
    try {
      await new UtilityExecutor(neverSessions, { fetch: async () => ({ status: 200, ok: true, headers: { get: () => "text/plain" }, text: async () => "ok" }) }).execute(
        "api.mutateNoKey",
        { type: "api_call", method: "POST", url: "https://api.example.com/update", body: { x: 1 } },
        { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
      );
      check("api_call POST without idempotency_key -> throw", false);
    } catch (e) {
      check("api_call POST without idempotency_key -> IR_SCHEMA_INVALID", e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", String(e));
    }
  }
  {
    let bodySeen = "";
    let contentTypeSeen = "";
    const http = new UtilityExecutor(neverSessions, {
      fetch: async (_url, init) => {
        bodySeen = init.body ?? "";
        contentTypeSeen = init.headers["Content-Type"] ?? "";
        return { status: 202, ok: true, headers: { get: () => "text/plain" }, text: async () => "accepted" };
      },
    });
    const res = await http.execute(
      "api.post",
      { type: "api_call", method: "POST", url: "https://api.example.com/update", body: { x: 1 }, idempotency_key: "api.post.1" },
      { ...policyCtx, networkAllowedDomains: ["api.example.com"] },
    );
    check("api_call POST serializes JSON body", bodySeen === "{\"x\":1}" && contentTypeSeen === "application/json", `${bodySeen} / ${contentTypeSeen}`);
    check("api_call POST sideEffect update with idempotency", res.sideEffect?.kind === "update" && res.sideEffect.idempotencyKey === "api.post.1", JSON.stringify(res.sideEffect));
  }
  {
    for (const action of ["file", "shell"]) {
      try {
        await new UtilityExecutor(neverSessions).execute(`nonbrowser.${action}`, { type: action }, policyCtx);
        check(`${action} remains blocked`, false);
      } catch (e) {
        check(`${action} remains EXECUTOR_CAPABILITY_MISMATCH`, e instanceof UtilityExecutorError && e.code === "EXECUTOR_CAPABILITY_MISMATCH", String(e));
      }
    }
  }

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
    const httpCtx = {
      ...policyCtx,
      lastHttpResponse: {
        status: 202,
        ok: true,
        contentType: "application/json",
        finalUrl: "https://api.example.com/status",
        redirected: false,
        body: { ok: true },
        bodyTruncated: false,
      },
    };
    const httpPass = await new UtilityExecutor(neverSessions).verify({ type: "http_status", codes: [200, 202] }, httpCtx);
    check("verify http_status 직전 api_call 응답 -> pass", httpPass.status === "pass", JSON.stringify(httpPass));
    const httpFail = await new UtilityExecutor(neverSessions).verify({ type: "http_status", codes: [200] }, httpCtx);
    check("verify http_status 불일치 -> fail_det", httpFail.status === "fail_det" && httpFail.failedCriteria.includes("http_status"), JSON.stringify(httpFail));
    try {
      await new UtilityExecutor(neverSessions).verify({ type: "http_status", codes: [200] }, policyCtx);
      check("verify http_status without response -> throw", false);
    } catch (e) {
      check("verify http_status without response -> IR_SCHEMA_INVALID", e instanceof UtilityExecutorError && e.code === "IR_SCHEMA_INVALID", String(e));
    }
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
