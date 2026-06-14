/**
 * 결정형 PageStateResolver (D3 — core-types.ts PageStateResolver / architecture.md §9.3).
 *
 * Stagehand `act` 없이(LLM 미사용) CDP-native 표면만으로 PageState 를 산출한다. landmark role/name 은
 * a11y 트리(Accessibility.getFullAXTree, sendCDP), 나머지 신호는 단일 evaluate 로 수집한다.
 * flags 는 ir-static-validation §2 닫힌 레지스트리의 **PageState 원천 키만** set(미등록 키 금지;
 * cursor_reached 는 interpreter 원천이라 여기서 산출하지 않음).
 *
 * "조용한 false/unknown 금지": 6개 PageState-origin flag 를 항상 명시적으로 set 한다(부재 시 IREL 평가가
 * IREL_RUNTIME_MISSING 으로 표면화되도록 — 흡수하지 않음).
 */
import { createHash } from "node:crypto";

import type { DomLandmark, FrameSummary, PageState, RunContext } from "../../../ts/core-types";
import type { CdpSessionProvider } from "./cdp-session";

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

/** ir-static-validation §2 닫힌 flags 레지스트리 중 PageState 가 산출하는 키(cursor_reached 제외). */
export const PAGESTATE_FLAG_KEYS = [
  "no_next_page",
  "login_required",
  "blocked",
  "not_found",
  "no_review_message_visible",
  "reviews_visible",
] as const;

type AxNode = { role?: { value?: unknown }; name?: { value?: unknown } };

type Signals = {
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
    visibleText: text,
    authAttr: (document.body && document.body.getAttribute('data-auth')) || 'unknown',
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
  return "unknown";
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
