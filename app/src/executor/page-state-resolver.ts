/**
 * 결정형 PageStateResolver (D3 — core-types.ts PageStateResolver / architecture.md §9.3).
 *
 * Stagehand `act` 없이(LLM 미사용) CDP-native 표면만으로 PageState 를 산출한다. landmark role/name 은
 * a11y 트리(Accessibility.getFullAXTree, sendCDP), 나머지 신호는 단일 evaluate 로 수집한다.
 * flags 는 ir-static-validation §2 닫힌 레지스트리의 **PageState 원천 키만** set(미등록 키 금지;
 * cursor_reached 는 interpreter 원천이라 여기서 산출하지 않음).
 *
 * "조용한 false/unknown 금지": 이 D3 dry-run resolver 는 명시적 fixture contract marker 가 있는 페이지에서만
 * auth/flags 를 산출한다. 임의 staging 사이트나 미계약 페이지는 blocked=false 같은 추정을 만들지 않고
 * PAGE_STATE_UNRESOLVED 로 실패시킨다.
 */
import { createHash } from "node:crypto";

import type { DomLandmark, FrameSummary, PageState, RunContext } from "../../../ts/core-types";
import { IREL_ALLOWED_FLAGS } from "../../../codegen/irel-compile";
import type { CdpSessionProvider } from "./cdp-session";

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);
export const PAGESTATE_CONTRACT_MARKER = "d3-dryrun-v1";

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

/** ir-static-validation §2 닫힌 flags 레지스트리 중 PageState 가 산출하는 키(cursor_reached 제외). */
export const PAGESTATE_FLAG_KEYS = [
  "no_next_page",
  "login_required",
  "blocked",
  "not_found",
  "no_review_message_visible",
  "reviews_visible",
] as const;

// 드리프트 방지(SSoT 결속): resolver 가 산출하는 flag 는 전부 §2 닫힌 레지스트리(codegen IREL_ALLOWED_FLAGS)
// 소속이어야 한다. 미등록 키를 PAGESTATE_FLAG_KEYS 에 추가하면 아래 타입이 false 가 되어 빌드가 깨진다
// (손복제 리스트가 레지스트리에서 말없이 갈라져 런타임 IREL_RUNTIME_MISSING 으로 터지는 것을 컴파일에서 예방).
type _PagestateFlagsRegistered =
  `flags.${(typeof PAGESTATE_FLAG_KEYS)[number]}` extends (typeof IREL_ALLOWED_FLAGS)[number] ? true : false;
const _pagestateFlagsRegistered: _PagestateFlagsRegistered = true;
void _pagestateFlagsRegistered;

type AxNode = { role?: { value?: unknown }; name?: { value?: unknown } };

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

export class PageStateResolverError extends Error {
  constructor(
    readonly code: "PAGE_STATE_UNRESOLVED",
    message: string,
  ) {
    super(message);
    this.name = "PageStateResolverError";
  }
}

function urlPattern(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
    return `${u.origin}${path}`;
  } catch {
    return raw;
  }
}

function classifyAuth(s: Signals): PageState["auth"] {
  if (s.authAttr === "authenticated" || s.hasLogout) return "authenticated";
  if (s.authAttr === "expired") return "expired";
  if (s.authAttr === "anonymous") return "anonymous";
  throw new PageStateResolverError(
    "PAGE_STATE_UNRESOLVED",
    `page auth signal is not covered by ${PAGESTATE_CONTRACT_MARKER}`,
  );
}

function classifyFlags(s: Signals): Record<string, boolean> {
  // 닫힌 레지스트리 키만, 항상 명시 set(§2 / 조용한 false 금지).
  return {
    no_next_page: s.noNextPage,
    login_required: s.loginRequired,
    blocked: s.blocked,
    not_found: s.notFound,
    no_review_message_visible: s.emptyMsg,
    reviews_visible: s.reviewsVisible,
  };
}

/** PageStateRef 생성(structuralHash 기반 — 결정형 식별자). */
export function pageStateRef(ps: PageState): string {
  return `ps_${ps.dom.structuralHash}`;
}

export class CdpPageStateResolver {
  constructor(private readonly sessions: CdpSessionProvider) {}

  async resolvePageState(ctx: RunContext): Promise<PageState> {
    const session = this.sessions.forLease(ctx.leaseId);

    const { nodes } = await session.sendCDP<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
    const landmarks: DomLandmark[] = [];
    nodes.forEach((n, idx) => {
      const role = n.role?.value;
      if (typeof role !== "string" || !LANDMARK_ROLES.has(role)) return;
      const name = typeof n.name?.value === "string" ? (n.name.value as string) : "";
      landmarks.push({ role, name, pathHash: sha1(`${role}|${name}|${idx}`) });
    });

    const s = await session.evaluate<Signals>(COLLECT_FN);
    if (s.contractMarker !== PAGESTATE_CONTRACT_MARKER) {
      throw new PageStateResolverError(
        "PAGE_STATE_UNRESOLVED",
        `page is missing data-page-state-contract=${PAGESTATE_CONTRACT_MARKER}; refusing silent auth/flag inference`,
      );
    }
    const frames: FrameSummary[] = [];
    for (let i = 0; i < s.iframeCount; i += 1) frames.push({ kind: "iframe", landmarkCount: 1 });

    const raw = session.url();
    const pattern = urlPattern(raw);
    const structuralSeq = landmarks.map((l) => `${l.role}:${l.name}:${l.pathHash}`).join(">");

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
      matchedWhere: [],
    };
  }
}
