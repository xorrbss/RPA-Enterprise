/**
 * D3 raw CDP unit tests.
 *
 * These tests keep raw CDP fallback behavior fail-closed without requiring Chrome:
 * malformed Accessibility responses must not become empty PageState, failures must be
 * classified, and original exception text must not leak into operator/user messages.
 */
import type { CdpSession } from "../src/executor/cdp-session";
import {
  CdpDisconnectedError,
  RawCdpError,
  RawCdpMalformedResponseError,
  getAccessibilityTree,
  getCookiesForOrigins,
  setDownloadBehavior,
} from "../src/executor/raw-cdp";

type CdpCall = { method: string; params?: object };

class FakeSession implements CdpSession {
  readonly calls: CdpCall[] = [];

  constructor(private readonly handler: (method: string, params?: object) => Promise<unknown>) {}

  url(): string {
    return "about:blank";
  }

  goto(_url: string): Promise<void> {
    throw new Error("unused");
  }

  reload(): Promise<void> {
    throw new Error("unused");
  }

  evaluate<R = unknown>(_expression: string): Promise<R> {
    throw new Error("unused");
  }

  sendCDP<T = unknown>(method: string, params?: object): Promise<T> {
    this.calls.push({ method, params });
    return this.handler(method, params) as Promise<T>;
  }

  fill(_selector: string, _value: string): Promise<void> {
    throw new Error("unused");
  }

  selectOption(_selector: string, _value: string): Promise<void> {
    throw new Error("unused");
  }

  click(_selector: string): Promise<void> {
    throw new Error("unused");
  }

  setInputFiles(_selector: string, _files: string | string[]): Promise<void> {
    throw new Error("unused");
  }

  downloadDir(): string {
    return "C:\\downloads";
  }

  waitForDownload(_fileName: string, _timeoutMs: number): Promise<boolean> {
    throw new Error("unused");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
): Promise<unknown> {
  try {
    await fn();
    check(label, false, "expected throw");
    return undefined;
  } catch (err) {
    check(label, predicate(err), String(err));
    return err;
  }
}

async function main(): Promise<void> {
  const axSession = new FakeSession(async () => ({
    nodes: [{ role: { value: "main" }, name: { value: "Body" } }],
  }));
  const nodes = await getAccessibilityTree(axSession);
  check("Accessibility.getFullAXTree called", axSession.calls[0]?.method === "Accessibility.getFullAXTree");
  check("AX nodes returned", nodes.length === 1 && nodes[0]?.role?.value === "main");

  const emptySession = new FakeSession(async () => ({ nodes: [] }));
  check("empty AX tree is valid", (await getAccessibilityTree(emptySession)).length === 0);

  await expectThrows(
    "missing AX nodes fails closed",
    () => getAccessibilityTree(new FakeSession(async () => ({}))),
    (err) => err instanceof RawCdpMalformedResponseError
      && (err as { code?: string }).code === "PAGE_STATE_UNRESOLVED",
  );

  await expectThrows(
    "non-array AX nodes fails closed",
    () => getAccessibilityTree(new FakeSession(async () => ({ nodes: { bogus: true } }))),
    (err) => err instanceof RawCdpMalformedResponseError
      && (err as { code?: string }).code === "PAGE_STATE_UNRESOLVED",
  );

  const protocolErr = await expectThrows(
    "CDP protocol error is classified without leaking cause",
    () => getAccessibilityTree(new FakeSession(async () => {
      throw new Error("SECRET_SHOULD_NOT_APPEAR: bad params");
    })),
    (err) => err instanceof RawCdpError
      && (err as RawCdpError).code === "CDP_DISCONNECTED"
      && (err as RawCdpError).failureKind === "protocol_error"
      && !String((err as Error).message).includes("SECRET_SHOULD_NOT_APPEAR"),
  );
  check("protocol error is not labelled disconnected", !(protocolErr instanceof CdpDisconnectedError));

  await expectThrows(
    "CDP disconnected error is classified",
    () => setDownloadBehavior(new FakeSession(async () => {
      throw new Error("Target closed");
    }), "C:\\downloads"),
    (err) => err instanceof CdpDisconnectedError
      && (err as RawCdpError).failureKind === "disconnected"
      && (err as RawCdpError).code === "CDP_DISCONNECTED",
  );

  await expectThrows(
    "CDP hang is bounded by timeout",
    () => getAccessibilityTree(new FakeSession(() => new Promise(() => undefined)), { timeoutMs: 5 }),
    (err) => err instanceof CdpDisconnectedError
      && (err as RawCdpError).failureKind === "timeout"
      && (err as RawCdpError).code === "CDP_DISCONNECTED",
  );

  const downloadSession = new FakeSession(async () => ({}));
  await setDownloadBehavior(downloadSession, "C:\\isolated-downloads");
  const call = downloadSession.calls[0];
  const params = call?.params as { behavior?: string; downloadPath?: string; eventsEnabled?: boolean } | undefined;
  check("Browser.setDownloadBehavior called", call?.method === "Browser.setDownloadBehavior");
  check(
    "download behavior params preserve isolation",
    params?.behavior === "allow"
      && params.downloadPath === "C:\\isolated-downloads"
      && params.eventsEnabled === true,
    JSON.stringify(params),
  );

  // getCookiesForOrigins — registrable-domain 스코프 캡처(over-capture 차단): 지정 origin 의 registrable domain 트리만 반환.
  const mixedCookies = [
    { name: "rpa_sess", value: "1", domain: "127.0.0.1" },
    { name: "idp_sso", value: "x", domain: "idp.example.com" }, // 외부 도메인 — 제외돼야
    { name: "hw_auth", value: "y", domain: ".hiworks.com" }, // 부모 도메인
    { name: "hw_mail", value: "z", domain: "mail-api.office.hiworks.com" }, // 형제 서브도메인(host-only) — registrable 로 포함
    { name: "ad", value: "t", domain: ".doubleclick.net" }, // 광고 추적 — 제외돼야
  ];
  const cookieSession = new FakeSession(async (m) => (m === "Storage.getCookies" ? { cookies: mixedCookies } : {}));
  const scoped = await getCookiesForOrigins(cookieSession, ["http://127.0.0.1:8080"]);
  check("registrable: 127.0.0.1(IP) 쿠키만(외부 제외)", scoped.length === 1 && scoped[0]?.name === "rpa_sess");
  const hw = await getCookiesForOrigins(cookieSession, ["https://dashboard.office.hiworks.com"]);
  const hwNames = hw.map((c) => c.name).sort();
  check("registrable: hiworks.com 트리 전체 캡처(부모+형제 서브도메인, 광고 제외)", hwNames.length === 2 && hwNames[0] === "hw_auth" && hwNames[1] === "hw_mail");
  const none = await getCookiesForOrigins(cookieSession, ["https://other.example"]);
  check("registrable: 매칭 없으면 빈 배열(foreign 쿠키 미캡처)", none.length === 0);

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 raw CDP unit green");
}

main().catch((err) => {
  console.error("FAIL: raw CDP unit threw:", err);
  process.exit(1);
});
