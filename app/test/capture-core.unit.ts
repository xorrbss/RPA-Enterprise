/**
 * 단위 — 운영자-보조 캡처 코어 awaitLoginAndCapture(dev/capture-loop). 브라우저/DB 없이 fake 로 검증:
 *  - 인증 감지(resolver.auth='authenticated') → origin-scoped 쿠키 캡처 → store.save → 'captured'.
 *  - 데드라인까지 미인증 → 'expired'(store.save 미호출, 조용한 캡처 금지).
 *  - 캡처/저장 키 = sessionKey(tenant,site,bid)(재사용 경로와 동일). 실행: tsx test/capture-core.unit.ts.
 */
import type { RunContext } from "../../ts/core-types";
import type { CdpSession } from "../src/executor/cdp-session";
import type { BrowserSessionStore, CookieBundle, SessionKey } from "../src/runtime/browser-session-store";
import { awaitLoginAndCapture } from "../dev/capture-loop";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const COOKIES = [
  { name: "rpa_sess", value: "1", domain: "127.0.0.1" },
  { name: "idp", value: "x", domain: "idp.example.com" }, // foreign — origin-scope 로 제외돼야
];

// authed: evaluate(authProbe) 반환값(로그인 감지). throwOnce: 첫 evaluate 는 throw(네비게이션 단절 시뮬) 후 authed.
function fakeSession(authed: boolean, throwOnce = false): CdpSession {
  let threw = false;
  return {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async <R = unknown>() => {
      if (throwOnce && !threw) {
        threw = true;
        throw new Error("target detached (navigation)");
      }
      return authed as unknown as R;
    },
    sendCDP: async (m: string) => (m === "Storage.getCookies" ? { cookies: COOKIES } : {}) as never,
    click: async () => {},
    fill: async () => {},
    selectOption: async () => {},
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
}

function ctx(): RunContext {
  return {
    runId: "cap", tenantId: "t1", nodeId: "cap", attempt: 0, siteProfileId: "s1",
    browserIdentityId: "b1", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal,
    pageState: { url: { raw: "", canonical: "", pattern: "" }, dom: { structuralHash: "", visibleTextHash: "", landmarks: [], frames: [] }, auth: "anonymous", flags: {}, matchedWhere: [] },
  };
}

function fakeStore(): { store: BrowserSessionStore; saved: Array<{ key: SessionKey; bundle: CookieBundle }> } {
  const saved: Array<{ key: SessionKey; bundle: CookieBundle }> = [];
  return {
    saved,
    store: {
      load: async () => null,
      save: async (key, bundle) => void saved.push({ key, bundle }),
    },
  };
}

async function main(): Promise<void> {
  // 1) 인증 감지(querySelector evaluate=true) → origin-scoped 캡처 → save → 'captured'.
  {
    const fs = fakeStore();
    const outcome = await awaitLoginAndCapture(fakeSession(true), ".new_header", fs.store, ctx(), "http://127.0.0.1:8080", 5000);
    check("인증 감지 → 'captured'", outcome === "captured");
    check("store.save 1회 호출", fs.saved.length === 1);
    const saved = fs.saved[0];
    check("저장 키 = sessionKey(tenant,site,bid)", saved?.key.tenantId === "t1" && saved.key.siteProfileId === "s1" && saved.key.browserIdentityId === "b1" && saved.key.identityKey === "");
    check("origin-scoped: rpa_sess 만(foreign idp 제외)", saved?.bundle.cookies.length === 1 && saved.bundle.cookies[0]?.name === "rpa_sess");
  }

  // 2) 미인증 데드라인 → 'expired'(save 미호출).
  {
    const fs = fakeStore();
    const start = Date.now();
    const outcome = await awaitLoginAndCapture(fakeSession(false), ".new_header", fs.store, ctx(), "http://127.0.0.1:8080", 300);
    check("미인증 데드라인 → 'expired'", outcome === "expired");
    check("expired 시 store.save 미호출(조용한 캡처 금지)", fs.saved.length === 0);
    check("데드라인 준수(<3s)", Date.now() - start < 3000);
  }

  // 3) 네비게이션 중 evaluate 일시 throw → catch 후 재시도 → 'captured'(리다이렉트 robust).
  {
    const fs = fakeStore();
    const outcome = await awaitLoginAndCapture(fakeSession(true, true), ".new_header", fs.store, ctx(), "http://127.0.0.1:8080", 5000);
    check("일시 CDP 단절(navigation) → 재시도 → 'captured'", outcome === "captured" && fs.saved.length === 1);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 운영자-보조 캡처 코어(awaitLoginAndCapture) green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
