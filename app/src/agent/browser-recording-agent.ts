import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { findChrome } from "../executor/login-capture";

export class BrowserRecordingAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserRecordingAgentError";
  }
}

export type RecordingEventType = "navigate" | "click" | "input" | "select" | "submit" | "wait";

export interface SanitizedRecordingEvent {
  readonly event_type: RecordingEventType;
  readonly selector?: string;
  readonly label?: string;
  readonly url?: string;
  readonly value_preview?: string;
}

export interface BrowserRecordingAgentOptions {
  readonly apiBase: string;
  readonly siteId: string;
  readonly recordingId: string;
  readonly token: string;
  readonly startUrl: string;
  readonly chromePath?: string;
}

export interface BrowserRecordingLaunchInput {
  readonly startUrl: string;
  readonly chromePath?: string;
  readonly receive: (raw: unknown) => Promise<void>;
  readonly onNavigate: (url: string) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface BrowserRecordingLaunchHandle {
  waitUntilClosed(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserRecordingAgentDeps {
  readonly fetchImpl?: typeof fetch;
  readonly launchBrowser?: (input: BrowserRecordingLaunchInput) => Promise<BrowserRecordingLaunchHandle>;
  readonly newKey?: () => string;
  readonly log?: (message: string) => void;
}

interface PageRecordingEvent {
  readonly type?: unknown;
  readonly selector?: unknown;
  readonly label?: unknown;
  readonly url?: unknown;
  readonly tagName?: unknown;
  readonly inputType?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly placeholder?: unknown;
  readonly ariaLabel?: unknown;
  readonly text?: unknown;
  readonly selectedText?: unknown;
  readonly selectedValue?: unknown;
}

const SENSITIVE_TARGET_RE = /password|passwd|token|cookie|secret|otp|mfa|authorization|bearer|session|csrf/i;

function trimBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function assertSecureBase(apiBase: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new BrowserRecordingAgentError(`Invalid --api URL: ${apiBase}`);
  }
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback) return;
  throw new BrowserRecordingAgentError(`Security guard: --api must be https, except loopback dev URLs. Received ${parsed.protocol}//${parsed.hostname}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

function optionalHttpUrl(value: unknown): string | undefined {
  const text = optionalText(value, 2048);
  if (text === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.toString();
}

function eventType(value: unknown): RecordingEventType | undefined {
  if (value === "navigate" || value === "click" || value === "input" || value === "select" || value === "submit" || value === "wait") return value;
  return undefined;
}

function targetHaystack(event: PageRecordingEvent): string {
  return [
    event.selector,
    event.label,
    event.tagName,
    event.inputType,
    event.name,
    event.id,
    event.placeholder,
    event.ariaLabel,
    event.text,
  ]
    .map((value) => optionalText(value, 256) ?? "")
    .join(" ");
}

export function isSensitiveRecordingTarget(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return SENSITIVE_TARGET_RE.test(targetHaystack(raw));
}

export function sanitizePageEvent(raw: unknown): SanitizedRecordingEvent | null {
  if (!isRecord(raw)) return null;
  const event = raw as PageRecordingEvent;
  const type = eventType(event.type);
  if (type === undefined) return null;

  if (type === "navigate") {
    const url = optionalHttpUrl(event.url);
    return url === undefined ? null : { event_type: "navigate", url };
  }

  if (isSensitiveRecordingTarget(event)) return null;

  const selector = optionalText(event.selector, 512);
  if (selector === undefined) return null;
  const label = optionalText(event.label, 160) ?? optionalText(event.text, 160);

  if (type === "select") {
    const valuePreview = optionalText(event.selectedText, 160) ?? optionalText(event.selectedValue, 160);
    if (valuePreview === undefined || SENSITIVE_TARGET_RE.test(valuePreview)) return null;
    return { event_type: "select", selector, ...(label !== undefined ? { label } : {}), value_preview: valuePreview };
  }

  return { event_type: type, selector, ...(label !== undefined ? { label } : {}) };
}

export async function appendRecordingEvents(
  opts: Pick<BrowserRecordingAgentOptions, "apiBase" | "siteId" | "recordingId" | "token">,
  deps: Pick<BrowserRecordingAgentDeps, "fetchImpl" | "newKey">,
  events: readonly SanitizedRecordingEvent[],
): Promise<void> {
  if (events.length === 0) return;
  assertSecureBase(opts.apiBase);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const key = deps.newKey?.() ?? randomUUID();
  const res = await fetchImpl(`${trimBase(opts.apiBase)}/v1/sites/${opts.siteId}/recordings/${opts.recordingId}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      body = "<no body>";
    }
    throw new BrowserRecordingAgentError(`append recording events failed: HTTP ${res.status} ${body}`);
  }
}

export async function runBrowserRecordingAgent(
  opts: BrowserRecordingAgentOptions,
  deps: BrowserRecordingAgentDeps = {},
): Promise<{ readonly appended: number }> {
  assertSecureBase(opts.apiBase);
  const log = deps.log ?? (() => undefined);
  const launchBrowser = deps.launchBrowser ?? defaultLaunchBrowser;
  let appended = 0;
  let lastNavigateUrl: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let lastError: unknown;

  const enqueue = async (raw: unknown): Promise<void> => {
    const event = sanitizePageEvent(raw);
    if (event === null) return;
    if (event.event_type === "navigate") {
      if (event.url === lastNavigateUrl) return;
      lastNavigateUrl = event.url ?? null;
    }
    chain = chain.then(async () => {
      await appendRecordingEvents(opts, deps, [event]);
      appended += 1;
      log(`recorded ${event.event_type}${event.label !== undefined ? `: ${event.label}` : ""}`);
    }).catch((error: unknown) => {
      lastError = error;
      throw error;
    });
    await chain.catch(() => undefined);
  };

  const handle = await launchBrowser({
    startUrl: opts.startUrl,
    chromePath: opts.chromePath,
    receive: enqueue,
    onNavigate: (url) => enqueue({ type: "navigate", url }),
    log,
  });

  try {
    await handle.waitUntilClosed();
    await chain.catch(() => undefined);
    if (lastError !== undefined) throw lastError;
    return { appended };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function defaultLaunchBrowser(input: BrowserRecordingLaunchInput): Promise<BrowserRecordingLaunchHandle> {
  const chrome = input.chromePath ?? findChrome();
  if (chrome === null) {
    throw new BrowserRecordingAgentError("Chrome not found. Pass --chrome <path> or set CHROME_PATH.");
  }
  const userDataDir = mkdtempSync(join(tmpdir(), "op-browser-recorder-"));
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: false,
      userDataDir,
      defaultViewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const page = await browser.newPage();
    await installRecordingHooks(page, input);
    await page.goto(input.startUrl, { waitUntil: "domcontentloaded" });
    return {
      async waitUntilClosed(): Promise<void> {
        await new Promise<void>((resolve) => {
          browser?.once("disconnected", resolve);
        });
      },
      async close(): Promise<void> {
        if (browser?.connected === true) await browser.close();
        rmSync(userDataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (browser?.connected === true) await browser.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function installRecordingHooks(page: Page, input: BrowserRecordingLaunchInput): Promise<void> {
  const bindingName = `__rpaRecordEvent_${randomUUID().replace(/-/g, "")}`;
  await page.exposeFunction(bindingName, async (raw: unknown) => {
    await input.receive(raw);
  });
  await page.evaluateOnNewDocument(recordingHookSource(bindingName));
  await page.evaluate(recordingHookSource(bindingName)).catch(() => undefined);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) void input.onNavigate(frame.url());
  });
  input.log("Recorder hooks installed. Close the Chrome window to finish.");
}

export function recordingHookSource(bindingName: string): string {
  const safeBinding = JSON.stringify(bindingName);
  return `(() => {
    const bindingName = ${safeBinding};
    if (window.__rpaBrowserRecorderInstalled === bindingName) return;
    window.__rpaBrowserRecorderInstalled = bindingName;
    const post = (payload) => {
      const fn = window[bindingName];
      if (typeof fn === "function") {
        try { void fn(payload); } catch (_) {}
      }
    };
    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    };
    const elementText = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text.slice(0, 160);
      const title = el.getAttribute("title");
      if (title) return title.slice(0, 160);
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.slice(0, 160);
      return undefined;
    };
    const selectorFor = (el) => {
      if (!(el instanceof Element)) return undefined;
      for (const attr of ["data-testid", "data-test", "data-qa"]) {
        const attrValue = el.getAttribute(attr);
        if (attrValue) return "[" + attr + "=" + JSON.stringify(String(attrValue)) + "]";
      }
      if (el.id) return "#" + cssEscape(el.id);
      const name = el.getAttribute("name");
      const tag = el.tagName.toLowerCase();
      if (name) return tag + "[name=" + JSON.stringify(String(name)) + "]";
      const classes = Array.from(el.classList || []).slice(0, 3).map(cssEscape);
      let base = tag + (classes.length > 0 ? "." + classes.join(".") : "");
      const parent = el.parentElement;
      if (!parent) return base;
      const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === el.tagName);
      if (siblings.length > 1) base += ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")";
      return base;
    };
    const payloadFor = (target, type) => {
      const el = target instanceof Element ? target.closest("button,a,input,textarea,select,[role='button'],[data-testid],[data-test],[data-qa]") : null;
      if (!el) return null;
      return {
        type,
        selector: selectorFor(el),
        label: elementText(el),
        tagName: el.tagName,
        inputType: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.id || undefined,
        placeholder: el.getAttribute("placeholder"),
        ariaLabel: el.getAttribute("aria-label"),
        text: elementText(el)
      };
    };
    const isEditable = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (isEditable(target)) return;
      const payload = payloadFor(target, "click");
      if (payload) post(payload);
    }, true);
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const payload = payloadFor(target, target instanceof HTMLSelectElement ? "select" : "input");
      if (!payload) return;
      if (target instanceof HTMLSelectElement) {
        const option = target.selectedOptions && target.selectedOptions[0];
        payload.selectedText = option ? option.text : undefined;
        payload.selectedValue = target.value;
      }
      post(payload);
    }, true);
    document.addEventListener("submit", (event) => {
      const payload = payloadFor(event.submitter || event.target, "submit");
      if (payload) post(payload);
    }, true);
    let lastUrl = String(location.href);
    const emitNavigate = () => {
      const next = String(location.href);
      if (next !== lastUrl) {
        lastUrl = next;
        post({ type: "navigate", url: next });
      }
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        setTimeout(emitNavigate, 0);
        return result;
      };
    }
    window.addEventListener("popstate", emitNavigate);
    post({ type: "navigate", url: String(location.href) });
  })();`;
}

interface CliArgs {
  api?: string;
  site?: string;
  recording?: string;
  startUrl?: string;
  chrome?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new BrowserRecordingAgentError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--api") out.api = next();
    else if (arg === "--site") out.site = next();
    else if (arg === "--recording") out.recording = next();
    else if (arg === "--start-url") out.startUrl = next();
    else if (arg === "--chrome") out.chrome = next();
  }
  return out;
}

const USAGE =
  "Usage: RPA_OPERATOR_TOKEN=<operator JWT> tsx src/agent/browser-recording-agent.ts --api <base-url> --site <uuid> --recording <uuid> --start-url <url> [--chrome <path>]";

async function cli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.RPA_OPERATOR_TOKEN?.trim();
  if (args.api === undefined || args.site === undefined || args.recording === undefined || args.startUrl === undefined || token === undefined || token.length === 0) {
    console.error(USAGE);
    process.exit(2);
    return;
  }
  console.log(`Starting browser recorder for recording=${args.recording.slice(0, 8)} site=${args.site.slice(0, 8)}.`);
  const result = await runBrowserRecordingAgent({
    apiBase: args.api,
    siteId: args.site,
    recordingId: args.recording,
    startUrl: args.startUrl,
    token,
    ...(args.chrome !== undefined ? { chromePath: args.chrome } : {}),
  }, {
    log: (message) => console.log(message),
  });
  console.log(`Recorder finished. Appended ${result.appended} event(s). Complete the recording in the console to generate a draft scenario.`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  cli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`browser recording agent error: ${message}`);
    process.exit(1);
  });
}
