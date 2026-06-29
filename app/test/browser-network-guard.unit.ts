import {
  BrowserNetworkPolicyViolationError,
  evaluateBrowserNetworkPolicy,
  installBrowserNetworkGuardForStagehandPage,
  type BrowserNetworkGuardCdpSession,
  type BrowserNetworkGuardAuditOptions,
  type BrowserNetworkGuardPolicy,
} from "../src/executor/browser-network-guard";
import type {
  AuditedSecurityDecision,
  DurableSecurityAuditDecisionWriter,
  ImmutableAuditLogRecord,
  SecurityAuditDecisionAppendInput,
} from "../../ts/security-middleware-contract";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

interface SentCommand {
  readonly method: string;
  readonly params?: object;
}

class FakeCdpSession implements BrowserNetworkGuardCdpSession {
  readonly sent: SentCommand[] = [];
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();

  constructor(readonly id: string | null, private readonly events: string[] = []) {}

  async send<T = unknown>(method: string, params?: object): Promise<T> {
    this.events.push(`send:${method}`);
    this.sent.push(params === undefined ? { method } : { method, params });
    return {} as T;
  }

  on<T = unknown>(event: string, handler: (params: T) => void): void {
    const set = this.handlers.get(event) ?? new Set<(params: unknown) => void>();
    set.add(handler as (params: unknown) => void);
    this.handlers.set(event, set);
  }

  off<T = unknown>(event: string, handler: (params: T) => void): void {
    this.handlers.get(event)?.delete(handler as (params: unknown) => void);
  }

  emit(event: string, params: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(params);
  }

  sentMethod(method: string): boolean {
    return this.sent.some((cmd) => cmd.method === method);
  }
}

class FakeStagehandPage {
  readonly mainSession: FakeCdpSession;
  readonly sessions = new Map<string, FakeCdpSession>();
  registerCalls = 0;
  unregisterCalls = 0;

  constructor(private readonly events: string[] = []) {
    this.mainSession = new FakeCdpSession(null, events);
  }

  registerSessionForNetwork(session: BrowserNetworkGuardCdpSession): void {
    this.registerCalls += 1;
    if (session.id !== null) this.sessions.set(session.id, session as FakeCdpSession);
  }

  unregisterSessionForNetwork(sessionId: string | undefined): void {
    this.unregisterCalls += 1;
    if (sessionId !== undefined) this.sessions.delete(sessionId);
  }
}

class MemoryAuditWriter implements DurableSecurityAuditDecisionWriter {
  readonly inputs: SecurityAuditDecisionAppendInput[] = [];

  constructor(private readonly fail = false, private readonly events: string[] = []) {}

  async recordDecision<TDecision>(
    input: SecurityAuditDecisionAppendInput,
    decision: TDecision,
  ): Promise<AuditedSecurityDecision<TDecision>> {
    this.events.push(`audit:${input.action}:${input.outcome}`);
    if (this.fail) throw new Error("audit unavailable");
    this.inputs.push(input);
    return {
      decision,
      auditRecord: {
        ...input,
        sequence: this.inputs.length,
        previousHash: "GENESIS",
        hash: `hash-${this.inputs.length}`,
      } satisfies ImmutableAuditLogRecord,
    };
  }
}

const auditOptions = (writer: DurableSecurityAuditDecisionWriter): BrowserNetworkGuardAuditOptions => ({
  writer,
  actor: { subjectId: "10000000-0000-4000-8000-0000000000a5", roles: [] },
  clock: () => new Date("2026-06-29T00:00:00.000Z"),
  retentionDays: 1,
});

const policy = (
  allowedDomains: readonly string[] = ["example.com"],
  audit?: BrowserNetworkGuardAuditOptions,
): BrowserNetworkGuardPolicy => ({
  tenantId: "tenant-1",
  runId: "run-1",
  correlationId: "corr-1",
  networkPolicyId: "np-1",
  allowedDomains,
  ...(audit !== undefined ? { audit } : {}),
});

async function install(allowedDomains: readonly string[] = ["example.com"], audit?: BrowserNetworkGuardAuditOptions, events: string[] = []): Promise<{
  readonly page: FakeStagehandPage;
  readonly main: FakeCdpSession;
  readonly handle: Awaited<ReturnType<typeof installBrowserNetworkGuardForStagehandPage>>;
}> {
  const page = new FakeStagehandPage(events);
  const handle = await installBrowserNetworkGuardForStagehandPage(page, policy(allowedDomains, audit));
  return { page, main: page.mainSession, handle };
}

async function main(): Promise<void> {
  {
    const { handle, main } = await install();
    check("install enables Network domain", main.sentMethod("Network.enable"));
    check("install enables Fetch interception", main.sentMethod("Fetch.enable"));
    await handle.dispose();
  }

  {
    const { handle, main } = await install();
    main.emit("Fetch.requestPaused", {
      requestId: "req-1",
      request: { url: "https://example.com/static/app.js" },
      resourceType: "Script",
    });
    await flush();
    check("allowed subrequest continues", main.sentMethod("Fetch.continueRequest"));
    check("allowed subrequest keeps guard clean", caughtSync(() => handle.assertNoViolation()) === undefined);
    await handle.dispose();
  }

  {
    const events: string[] = [];
    const audit = new MemoryAuditWriter(false, events);
    const { handle, main } = await install(["example.com"], auditOptions(audit), events);
    events.length = 0;
    main.emit("Fetch.requestPaused", {
      requestId: "req-audit-1",
      request: { url: "https://example.com/static/app.js" },
      resourceType: "Script",
    });
    await flush();
    check("allowed request records network.request audit", audit.inputs[0]?.action === "network.request" && audit.inputs[0]?.outcome === "allow");
    check(
      "allowed request audit is durable before continue",
      events.indexOf("audit:network.request:allow") >= 0 &&
        events.indexOf("audit:network.request:allow") < events.indexOf("send:Fetch.continueRequest"),
      events.join(","),
    );
    check(
      "allowed request audit payload is metadata-only",
      audit.inputs[0]?.payload !== undefined &&
        JSON.stringify(audit.inputs[0].payload).includes('"decision_kind":"network.request"') &&
        JSON.stringify(audit.inputs[0].payload).includes('"request_kind":"browser_subrequest"'),
    );
    await handle.dispose();
  }

  {
    const audit = new MemoryAuditWriter();
    const { handle, main } = await install(["example.com"], auditOptions(audit));
    main.emit("Fetch.requestPaused", {
      requestId: "req-2",
      request: { url: "https://evil.example/script.js" },
      resourceType: "Script",
    });
    await flush();
    check("denied subrequest is failed in Fetch", main.sentMethod("Fetch.failRequest"));
    check("denied subrequest records blocked audit", audit.inputs[0]?.action === "network.request" && audit.inputs[0]?.outcome === "blocked");
    const err = caughtSync(() => handle.assertNoViolation());
    check(
      "denied subrequest raises DOMAIN_POLICY_VIOLATION",
      err instanceof BrowserNetworkPolicyViolationError && err.code === "DOMAIN_POLICY_VIOLATION",
      String(err),
    );
    await handle.dispose();
  }

  {
    const audit = new MemoryAuditWriter(true);
    const { handle, main } = await install(["example.com"], auditOptions(audit));
    main.emit("Fetch.requestPaused", {
      requestId: "req-audit-fail",
      request: { url: "https://example.com/static/app.js" },
      resourceType: "Script",
    });
    await flush();
    check("audit append failure fails allowed request closed", main.sentMethod("Fetch.failRequest"));
    const err = caughtSync(() => handle.assertNoViolation());
    check("audit append failure trips guard", err instanceof BrowserNetworkPolicyViolationError, String(err));
    await handle.dispose();
  }

  {
    const { handle, main } = await install();
    main.emit("Fetch.requestPaused", {
      requestId: "req-3",
      request: { url: "https://evil.example/frame" },
      resourceType: "Document",
    });
    await flush();
    const err = caughtSync(() => handle.assertNoViolation());
    check(
      "denied document request is classified as browser_navigation",
      err instanceof BrowserNetworkPolicyViolationError && err.violation.kind === "browser_navigation",
      String(err),
    );
    await handle.dispose();
  }

  {
    const { handle, main } = await install();
    main.emit("Network.webSocketWillSendHandshakeRequest", {
      requestId: "ws-1",
      request: { url: "wss://evil.example/socket" },
    });
    const err = caughtSync(() => handle.assertNoViolation());
    check(
      "off-allowlist websocket handshake trips guard",
      err instanceof BrowserNetworkPolicyViolationError && err.violation.resourceType === "WebSocket",
      String(err),
    );
    await handle.dispose();
  }

  {
    const { handle, main } = await install();
    main.emit("Browser.downloadWillBegin", {
      guid: "download-1",
      url: "https://evil.example/export.csv",
      suggestedFilename: "export.csv",
    });
    await flush();
    const err = caughtSync(() => handle.assertNoViolation());
    check(
      "off-allowlist download is cancelled and reported",
      main.sentMethod("Browser.cancelDownload") &&
        err instanceof BrowserNetworkPolicyViolationError &&
        err.violation.kind === "download",
      String(err),
    );
    await handle.dispose();
  }

  {
    check(
      "wildcard allows subdomain",
      evaluateBrowserNetworkPolicy("https://a.example.com/x", ["*.example.com"]).kind === "allow",
    );
    check(
      "wildcard does not allow bare domain",
      evaluateBrowserNetworkPolicy("https://example.com/x", ["*.example.com"]).kind === "deny",
    );
    check(
      "blob URL with nested off-allowlist origin is denied",
      evaluateBrowserNetworkPolicy("blob:https://evil.example/uuid", ["example.com"]).kind === "deny",
    );
    check("data URL is internal", evaluateBrowserNetworkPolicy("data:text/plain,ok", []).kind === "allow");
  }

  {
    const page = new FakeStagehandPage();
    const originalRegister = page.registerSessionForNetwork;
    const originalUnregister = page.unregisterSessionForNetwork;
    const handle = await installBrowserNetworkGuardForStagehandPage(page, policy(["example.com"]));
    const child = new FakeCdpSession("child-1");
    page.registerSessionForNetwork(child);
    await flush();
    check("patched register preserves original behavior", page.registerCalls === 1 && page.sessions.get("child-1") === child);
    check("patched register tracks child session", child.sentMethod("Fetch.enable"));
    child.emit("Fetch.requestPaused", {
      requestId: "child-req",
      request: { url: "https://evil.example/child.js" },
      resourceType: "Script",
    });
    await flush();
    const err = caughtSync(() => handle.assertNoViolation());
    check("child session request is guarded", err instanceof BrowserNetworkPolicyViolationError, String(err));
    await handle.dispose();
    check("dispose restores register hook", page.registerSessionForNetwork === originalRegister);
    check("dispose restores unregister hook", page.unregisterSessionForNetwork === originalUnregister);
    check("dispose disables Fetch on tracked sessions", page.mainSession.sentMethod("Fetch.disable") && child.sentMethod("Fetch.disable"));
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: browser-network-guard unit green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
