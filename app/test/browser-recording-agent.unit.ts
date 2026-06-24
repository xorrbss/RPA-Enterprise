import {
  appendRecordingEvents,
  BrowserRecordingAgentError,
  isSensitiveRecordingTarget,
  runBrowserRecordingAgent,
  sanitizePageEvent,
  type BrowserRecordingAgentDeps,
} from "../src/agent/browser-recording-agent";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

interface FetchCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

function recordingFetch(calls: FetchCall[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function main(): Promise<void> {
  const safeInput = sanitizePageEvent({
    type: "input",
    selector: "input[name='invoice_no']",
    label: "Invoice number",
    name: "invoice_no",
    value: "INV-2026-0001",
  });
  check("input raw value is not copied into append event", safeInput?.event_type === "input" && !JSON.stringify(safeInput).includes("INV-2026-0001"), JSON.stringify(safeInput));

  const passwordInput = {
    type: "input",
    selector: "input[name='current_password']",
    label: "Password",
    name: "current_password",
    inputType: "password",
    value: "secret",
  };
  check("password-like input target is sensitive", isSensitiveRecordingTarget(passwordInput));
  check("password-like input target is dropped", sanitizePageEvent(passwordInput) === null);

  const tokenClick = sanitizePageEvent({ type: "click", selector: "button[data-testid='refresh-token']", label: "Refresh token" });
  check("token-like click target is dropped", tokenClick === null, JSON.stringify(tokenClick));

  const select = sanitizePageEvent({
    type: "select",
    selector: "select[name='status']",
    label: "Status",
    name: "status",
    selectedText: "Approved",
    selectedValue: "approved",
  });
  check("select event keeps bounded preview", select?.event_type === "select" && select.value_preview === "Approved", JSON.stringify(select));

  const invalidNavigate = sanitizePageEvent({ type: "navigate", url: "javascript:alert(1)" });
  const validNavigate = sanitizePageEvent({ type: "navigate", url: "https://portal.example.com/invoices" });
  check("navigate only accepts http(s)", invalidNavigate === null && validNavigate?.url === "https://portal.example.com/invoices");

  const calls: FetchCall[] = [];
  await appendRecordingEvents(
    {
      apiBase: "https://rpa.example",
      siteId: "30000000-0000-4000-8000-000000000001",
      recordingId: "94000000-0000-4000-8000-000000000001",
      token: "jwt-operator",
    },
    { fetchImpl: recordingFetch(calls), newKey: () => "append-key-1" },
    [{ event_type: "click", selector: "button.approve", label: "Approve" }],
  );
  const first = calls[0];
  check("append uses existing recording events endpoint", first?.url === "https://rpa.example/v1/sites/30000000-0000-4000-8000-000000000001/recordings/94000000-0000-4000-8000-000000000001/events", first?.url);
  check("append sends bearer only in Node-side fetch header", first?.headers.get("authorization") === "Bearer jwt-operator");
  check("append sends idempotency key", first?.headers.get("idempotency-key") === "append-key-1");

  let fetchCalled = false;
  const insecure = await caught(appendRecordingEvents(
    {
      apiBase: "http://remote.example",
      siteId: "30000000-0000-4000-8000-000000000001",
      recordingId: "94000000-0000-4000-8000-000000000001",
      token: "jwt-operator",
    },
    {
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      },
    },
    [{ event_type: "click", selector: "button.approve" }],
  ));
  check("remote http api base is rejected before fetch", insecure instanceof BrowserRecordingAgentError && !fetchCalled);

  const runCalls: FetchCall[] = [];
  const deps: BrowserRecordingAgentDeps = {
    fetchImpl: recordingFetch(runCalls),
    newKey: (() => {
      let n = 0;
      return () => `run-key-${(n += 1)}`;
    })(),
    launchBrowser: async ({ startUrl, receive, onNavigate }) => {
      await onNavigate(startUrl);
      await onNavigate(startUrl);
      await receive({ type: "click", selector: "button.approve", label: "Approve" });
      await receive({ type: "input", selector: "input[name='password']", name: "password", inputType: "password", value: "do-not-send" });
      return {
        async waitUntilClosed() {},
        async close() {},
      };
    },
  };
  const result = await runBrowserRecordingAgent({
    apiBase: "https://rpa.example",
    siteId: "30000000-0000-4000-8000-000000000001",
    recordingId: "94000000-0000-4000-8000-000000000001",
    startUrl: "https://portal.example.com/invoices",
    token: "jwt-operator",
  }, deps);
  const sentBodies = runCalls.map((call) => call.body).join("\n");
  check("run appends deduped navigate plus click", result.appended === 2 && runCalls.length === 2, `result=${JSON.stringify(result)} calls=${runCalls.length}`);
  check("run never sends sensitive input value", !sentBodies.includes("do-not-send") && !sentBodies.includes("password"), sentBodies);
  check("run does not place bearer token in append body", !sentBodies.includes("jwt-operator"), sentBodies);

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} browser recording agent unit check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: browser recording agent unit green");
}

main().catch((error) => {
  console.error("browser recording agent unit fatal:", error);
  process.exit(1);
});
