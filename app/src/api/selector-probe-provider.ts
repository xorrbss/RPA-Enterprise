import puppeteer, { type Browser, type Page } from "puppeteer-core";

import type { SelectorProbeInput, SelectorProbeProvider, SelectorProbeResult } from "./server-shared";

export interface PuppeteerSelectorProbeProviderOptions {
  readonly chromeExecutablePath: string;
  readonly headless: boolean;
  readonly timeoutMs: number;
  readonly launchArgs?: readonly string[];
}

interface SelectorProbePage {
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  evaluate<R>(fn: (selector: string) => R, selector: string): Promise<R>;
}

interface SelectorProbeBrowser {
  newPage(): Promise<SelectorProbePage>;
  close(): Promise<unknown>;
}

interface PuppeteerSelectorProbeProviderDeps {
  readonly launchBrowser?: (options: PuppeteerSelectorProbeProviderOptions) => Promise<SelectorProbeBrowser>;
}

export class PuppeteerSelectorProbeProvider implements SelectorProbeProvider {
  private readonly launchBrowser: (options: PuppeteerSelectorProbeProviderOptions) => Promise<SelectorProbeBrowser>;

  constructor(
    private readonly options: PuppeteerSelectorProbeProviderOptions,
    deps: PuppeteerSelectorProbeProviderDeps = {},
  ) {
    this.launchBrowser = deps.launchBrowser ?? defaultLaunchBrowser;
  }

  async probe(input: SelectorProbeInput): Promise<SelectorProbeResult> {
    let browser: SelectorProbeBrowser | null = null;
    try {
      browser = await this.launchBrowser(this.options);
      const page = await browser.newPage();
      page.setDefaultTimeout(this.options.timeoutMs);
      page.setDefaultNavigationTimeout(this.options.timeoutMs);
      await page.goto(input.sampleUrl ?? "", { waitUntil: "domcontentloaded", timeout: this.options.timeoutMs });
      const matchCount = await countMatches(page, input.selector);
      return matchCount > 0
        ? { status: "matched", matchCount }
        : { status: "not_found", matchCount: 0, reasonCode: "SELECTOR_NOT_FOUND" };
    } catch (err) {
      if (isInvalidSelectorError(err)) {
        return { status: "invalid_selector", matchCount: null, reasonCode: "SELECTOR_INVALID" };
      }
      return { status: "failed", matchCount: null, reasonCode: selectorProbeFailureReason(err) };
    } finally {
      if (browser !== null) await Promise.resolve(browser.close()).catch(() => undefined);
    }
  }
}

async function defaultLaunchBrowser(options: PuppeteerSelectorProbeProviderOptions): Promise<SelectorProbeBrowser> {
  const browser: Browser = await puppeteer.launch({
    executablePath: options.chromeExecutablePath,
    headless: options.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      ...(options.launchArgs ?? []),
    ],
  });
  return browserAdapter(browser);
}

function browserAdapter(browser: Browser): SelectorProbeBrowser {
  return {
    async newPage() {
      const page = await browser.newPage();
      return pageAdapter(page);
    },
    close: () => browser.close(),
  };
}

function pageAdapter(page: Page): SelectorProbePage {
  return {
    setDefaultTimeout: (ms) => page.setDefaultTimeout(ms),
    setDefaultNavigationTimeout: (ms) => page.setDefaultNavigationTimeout(ms),
    goto: (url, opts) => page.goto(url, opts),
    evaluate: (fn, selector) => page.evaluate(fn, selector),
  };
}

function countMatches(page: SelectorProbePage, selector: string): Promise<number> {
  return page.evaluate((cssSelector) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): { length: number } } }).document;
    return doc.querySelectorAll(cssSelector).length;
  }, selector);
}

function isInvalidSelectorError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /syntaxerror|invalid selector|not a valid selector|queryselectorall/i.test(text);
}

function selectorProbeFailureReason(err: unknown): string {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/timeout|timed out|navigation/i.test(text)) return "SELECTOR_PROBE_NAVIGATION_FAILED";
  if (/executable|chrome|browser|launch/i.test(text)) return "SELECTOR_PROBE_BROWSER_UNAVAILABLE";
  return "SELECTOR_PROBE_FAILED";
}
