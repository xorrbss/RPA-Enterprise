/**
 * 결정형 PageStateResolver (architecture.md §9.3 / core-types.ts PageState).
 *
 * Stagehand v3 `act` 없이(LLM 미사용) CDP-native page 표면만으로 structuralHash·visibleTextHash·
 * landmarks·frames·auth·flags 를 산출한다. landmark role/name 은 a11y 트리(Accessibility.getFullAXTree,
 * page.sendCDP 경유 — Stagehand 공개 API)에서, 나머지 신호는 page.evaluate 로 얻는다.
 *
 * flags 는 ir-static-validation §2 닫힌 레지스트리 키만 set 한다(미등록 키 금지).
 * `cursor_reached` 는 interpreter 원천이라 PageState 단계에서 산출하지 않는다(§2).
 */
import { createHash } from "node:crypto";

import type { Protocol } from "devtools-protocol";

/** PageState 산출에 필요한 최소 page 표면(저결합 — Stagehand Page 에 구조적으로 호환). */
export interface CdpPage {
  url(): string;
  evaluate<R = unknown, A = unknown>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R>;
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
  frames(): unknown[];
  mainFrameId(): string;
}

export type DomLandmark = { role: string; name: string; pathHash: string };
export type FrameSummary = { kind: "iframe" | "shadow"; urlPattern?: string; landmarkCount: number };
export type Auth = "unknown" | "anonymous" | "authenticated" | "expired";

export type PageStateLite = {
  url: { raw: string; canonical: string; pattern: string };
  dom: { structuralHash: string; visibleTextHash: string; landmarks: DomLandmark[]; frames: FrameSummary[] };
  auth: Auth;
  flags: Record<string, boolean>;
};

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** landmark 로 취급할 ARIA role(a11y 트리 필터). */
const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "region",
  "form",
  "search",
  "complementary",
]);

/** ir-static-validation §2 닫힌 flags 레지스트리(PageState 원천 키만; cursor_reached 는 interpreter). */
export const PAGESTATE_FLAG_KEYS = [
  "no_next_page",
  "login_required",
  "blocked",
  "not_found",
  "no_review_message_visible",
  "reviews_visible",
] as const;
export const PAGESTATE_CONTRACT_MARKER = "d3-dryrun-v1";

/** url 정규화: 쿼리/프래그먼트/말단 숫자 id 를 패턴화(structuralHash 안정화). */
function urlPattern(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
    return `${u.origin}${path}`;
  } catch {
    return raw;
  }
}

async function landmarksFromAxTree(page: CdpPage): Promise<DomLandmark[]> {
  // page.sendCDP 는 Stagehand v3 공개 메서드 — raw CDP 를 동일 세션에서 호출(§9.5).
  const { nodes } = await page.sendCDP<Protocol.Accessibility.GetFullAXTreeResponse>(
    "Accessibility.getFullAXTree",
  );
  const out: DomLandmark[] = [];
  nodes.forEach((n, idx) => {
    const role = n.role?.value;
    if (typeof role !== "string" || !LANDMARK_ROLES.has(role)) return;
    const name = (n.name?.value as string | undefined) ?? "";
    out.push({ role, name, pathHash: sha1(`${role}|${name}|${idx}`) });
  });
  return out;
}

/** page.evaluate 로 DOM 신호를 한 번에 수집(결정형, 비-LLM). */
const COLLECT_FN = `(() => {
  const q = (s) => document.querySelector(s);
  const text = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim();
  const nextEl = document.querySelector('a[rel="next"]');
  const nextDisabled = !nextEl || nextEl.getAttribute('aria-disabled') === 'true';
  return {
    contractMarker: (document.body && document.body.getAttribute('data-page-state-contract')) || '',
    visibleText: text,
    authAttr: (document.body && document.body.getAttribute('data-auth')) || '',
    hasLogout: !!document.querySelector('[data-action="logout"]'),
    reviewsVisible: !!document.querySelector('[data-landmark="reviews"] .review-item'),
    emptyMsg: !!document.querySelector('[data-empty-msg]'),
    loginRequired: !!q('[data-login-required]'),
    blocked: !!q('[data-block-page]'),
    notFound: !!q('[data-not-found]'),
    noNextPage: nextDisabled,
    iframeCount: document.querySelectorAll('iframe').length,
  };
})()`;

type Signals = {
  contractMarker: string;
  visibleText: string;
  authAttr: string;
  hasLogout: boolean;
  reviewsVisible: boolean;
  emptyMsg: boolean;
  loginRequired: boolean;
  blocked: boolean;
  notFound: boolean;
  noNextPage: boolean;
  iframeCount: number;
};

function classifyAuth(s: Signals): Auth {
  if (s.authAttr === "authenticated" || s.hasLogout) return "authenticated";
  if (s.authAttr === "expired") return "expired";
  if (s.authAttr === "anonymous") return "anonymous";
  throw new Error(`PAGE_STATE_UNRESOLVED: page auth signal is not covered by ${PAGESTATE_CONTRACT_MARKER}`);
}

function classifyFlags(s: Signals): Record<string, boolean> {
  // 닫힌 레지스트리 키만 set(§2). 미등록 키 추가 금지.
  return {
    no_next_page: s.noNextPage,
    login_required: s.loginRequired,
    blocked: s.blocked,
    not_found: s.notFound,
    no_review_message_visible: s.emptyMsg,
    reviews_visible: s.reviewsVisible,
  };
}

export async function resolvePageState(page: CdpPage): Promise<PageStateLite> {
  const raw = page.url();
  const landmarks = await landmarksFromAxTree(page);
  const s = await page.evaluate<Signals>(COLLECT_FN);
  if (s.contractMarker !== PAGESTATE_CONTRACT_MARKER) {
    throw new Error(`PAGE_STATE_UNRESOLVED: missing data-page-state-contract=${PAGESTATE_CONTRACT_MARKER}`);
  }

  const frames: FrameSummary[] = [];
  for (let i = 0; i < s.iframeCount; i++) {
    frames.push({ kind: "iframe", landmarkCount: 1 });
  }

  const structuralSeq = landmarks.map((l) => `${l.role}:${l.name}:${l.pathHash}`).join(">");
  const pattern = urlPattern(raw);

  return {
    url: { raw, canonical: raw.split("#")[0], pattern },
    dom: {
      structuralHash: sha1(`${pattern}||${structuralSeq}`),
      visibleTextHash: sha1(s.visibleText),
      landmarks,
      frames,
    },
    auth: classifyAuth(s),
    flags: classifyFlags(s),
  };
}
