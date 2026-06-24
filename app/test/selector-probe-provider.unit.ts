import { PuppeteerSelectorProbeProvider } from "../src/api/selector-probe-provider";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

interface FakePage {
  count?: number;
  evaluateError?: Error;
  gotoError?: Error;
  navigatedTo?: string;
  timeout?: number;
  navTimeout?: number;
}

function providerWith(page: FakePage, closed: { value: number }): PuppeteerSelectorProbeProvider {
  return new PuppeteerSelectorProbeProvider(
    { chromeExecutablePath: "/x/chrome", headless: true, timeoutMs: 1234 },
    {
      launchBrowser: async () => ({
        async newPage() {
          return {
            setDefaultTimeout(ms: number) {
              page.timeout = ms;
            },
            setDefaultNavigationTimeout(ms: number) {
              page.navTimeout = ms;
            },
            async goto(url: string) {
              page.navigatedTo = url;
              if (page.gotoError !== undefined) throw page.gotoError;
            },
            async evaluate<R>() {
              if (page.evaluateError !== undefined) throw page.evaluateError;
              return (page.count ?? 0) as R;
            },
          };
        },
        async close() {
          closed.value += 1;
        },
      }),
    },
  );
}

async function main(): Promise<void> {
  {
    const closed = { value: 0 };
    const page: FakePage = { count: 2 };
    const result = await providerWith(page, closed).probe({
      tenantId: "tenant-a",
      siteProfileId: "site-a",
      elementId: "element-a",
      selector: "button.primary",
      sampleUrl: "https://portal.example/form",
      correlationId: "corr-a",
    });
    check("matched returns match count", result.status === "matched" && result.matchCount === 2, JSON.stringify(result));
    check("page navigates to sample url and applies timeout", page.navigatedTo === "https://portal.example/form" && page.timeout === 1234 && page.navTimeout === 1234);
    check("browser closes after matched probe", closed.value === 1, `closed=${closed.value}`);
  }
  {
    const closed = { value: 0 };
    const result = await providerWith({ count: 0 }, closed).probe({
      tenantId: "tenant-a",
      siteProfileId: "site-a",
      elementId: "element-a",
      selector: ".missing",
      sampleUrl: "https://portal.example/form",
      correlationId: "corr-a",
    });
    check("zero matches returns not_found", result.status === "not_found" && result.matchCount === 0 && result.reasonCode === "SELECTOR_NOT_FOUND", JSON.stringify(result));
    check("browser closes after not_found probe", closed.value === 1, `closed=${closed.value}`);
  }
  {
    const closed = { value: 0 };
    const result = await providerWith({ evaluateError: new SyntaxError("Failed to execute 'querySelectorAll': invalid selector") }, closed).probe({
      tenantId: "tenant-a",
      siteProfileId: "site-a",
      elementId: "element-a",
      selector: "[bad",
      sampleUrl: "https://portal.example/form",
      correlationId: "corr-a",
    });
    check("invalid selector is classified", result.status === "invalid_selector" && result.reasonCode === "SELECTOR_INVALID", JSON.stringify(result));
    check("browser closes after invalid selector", closed.value === 1, `closed=${closed.value}`);
  }
  {
    const closed = { value: 0 };
    const result = await providerWith({ gotoError: new Error("Navigation timeout of 1234 ms exceeded") }, closed).probe({
      tenantId: "tenant-a",
      siteProfileId: "site-a",
      elementId: "element-a",
      selector: ".x",
      sampleUrl: "https://slow.example/form",
      correlationId: "corr-a",
    });
    check("navigation failure is explicit failed reason", result.status === "failed" && result.reasonCode === "SELECTOR_PROBE_NAVIGATION_FAILED", JSON.stringify(result));
    check("browser closes after failed probe", closed.value === 1, `closed=${closed.value}`);
  }

  if (failures > 0) {
    console.error(`\nselector-probe-provider.unit: ${failures} FAIL`);
    process.exit(1);
  }
  console.log("\nselector-probe-provider.unit: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
