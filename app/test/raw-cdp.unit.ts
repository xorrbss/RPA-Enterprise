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
