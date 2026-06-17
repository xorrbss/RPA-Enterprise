/**
 * 사이트 프로파일 기반 PageStateResolver (D3 가동 2단계 — 임의 실사이트 flags 산출).
 *
 * 마커(d3-dryrun-v1) 대신 **사이트 프로파일의 셀렉터→flag 규칙**으로 PageState flags 를 산출한다.
 * 즉 site profile 이 그 사이트의 "PageState 계약"이다 — 운영자/통합자가 site profile 에 셀렉터를 등록하면
 * 위저드가 만든 실 URL 시나리오도 돌 수 있다(쿠팡 등은 셀렉터 정의 + 봇차단/ToS 별개 — 4단계).
 *
 * "조용한 false/unknown 금지": flags 는 닫힌 레지스트리(PAGESTATE_FLAG_KEYS) 키만, 항상 명시 set 한다.
 * config 에 규칙이 없는 flag 는 false(사이트 프로파일이 그 flag 를 산출하지 않는다는 명시적 결정 — 추정 아님).
 * config 가 잘못/비어 on[] 무매칭이면 interpreter 가 IR_NO_BRANCH_MATCHED 로 표면화한다(은폐 없음).
 */
import { createHash } from "node:crypto";

import type { DomLandmark, FrameSummary, PageState, RunContext } from "../../../ts/core-types";
import type { CdpSessionProvider } from "./cdp-session";
import { getAccessibilityTree } from "./raw-cdp";
import { PAGESTATE_FLAG_KEYS } from "./page-state-resolver";

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

// 실 SPA 렌더 대기(settle) — navigate 직후 DOM 이 비어있다가 비동기 렌더되므로, 인식 가능한 상태(authenticatedWhen 또는
//   어떤 flag) 가 나타날 때까지 bounded 폴링한다. 동기 렌더(픽스처)는 첫 폴에서 즉시 통과(지연 0). 끝까지 인식 불가면
//   마지막 결과로 반환 → 상위 interpreter 가 IR_NO_BRANCH_MATCHED 로 표면화(은폐 없음, 추정 없음).
const SETTLE_TIMEOUT_MS = 10000;
const SETTLE_INTERVAL_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

export type PageStateFlagKey = (typeof PAGESTATE_FLAG_KEYS)[number];

/** flag 산출 규칙: 셀렉터의 존재/부재/개수로 boolean 산출. */
export type FlagRule =
  | { readonly kind: "present"; readonly selector: string }
  | { readonly kind: "absent"; readonly selector: string }
  | { readonly kind: "min_count"; readonly selector: string; readonly n: number };

/** 사이트의 PageState 산출 규칙(site_profiles.page_state_selectors 의 in-memory 표현). */
export interface SitePageStateConfig {
  /** 이 셀렉터가 present 면 authenticated, 아니면 anonymous. 미지정 시 anonymous. */
  readonly authenticatedWhen?: { readonly selector: string };
  /** 닫힌 레지스트리 6키 중 산출할 flag → 규칙. 미지정 키는 false. */
  readonly flags: Partial<Record<PageStateFlagKey, FlagRule>>;
}

function ruleExpr(rule: FlagRule): string {
  const sel = JSON.stringify(rule.selector);
  if (rule.kind === "present") return `!!document.querySelector(${sel})`;
  if (rule.kind === "absent") return `!document.querySelector(${sel})`;
  return `document.querySelectorAll(${sel}).length >= ${rule.n}`;
}

interface Probe {
  flags: Record<string, boolean>;
  authenticated: boolean;
  visibleText: string;
  iframeCount: number;
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

export class SitePageStateResolver {
  constructor(
    private readonly sessions: CdpSessionProvider,
    private readonly config: SitePageStateConfig,
  ) {}

  async resolvePageState(ctx: RunContext): Promise<PageState> {
    const session = this.sessions.forLease(ctx.leaseId);
    const probe = this.buildProbe();

    // settle: 인식 가능한 상태(auth 또는 어떤 flag)가 나타날 때까지 bounded 폴링(실 SPA 비동기 렌더 대응). 픽스처는 즉시 통과.
    let res = await session.evaluate<Probe>(probe);
    const recognized = (r: Probe): boolean => r.authenticated || PAGESTATE_FLAG_KEYS.some((k) => r.flags[k] === true);
    const settleStart = Date.now();
    while (!recognized(res) && Date.now() - settleStart < SETTLE_TIMEOUT_MS) {
      await sleep(SETTLE_INTERVAL_MS);
      try {
        res = await session.evaluate<Probe>(probe);
      } catch {
        // 네비게이션 중 일시 CDP 실패 — 다음 폴에서 재시도.
      }
    }

    // landmarks: a11y 트리(무거운 raw CDP). 실 SPA 에서 느리거나 단절될 수 있어 내성 처리 — 실패 시 빈 landmarks + loud 로그
    //   (결정 기준 flags/auth 는 probe 에서 별도 산출하므로 정확성 유지; landmarks 는 보조 — structuralHash/캐시용).
    const landmarks: DomLandmark[] = [];
    try {
      const nodes = await getAccessibilityTree(session);
      nodes.forEach((n, idx) => {
        const role = n.role?.value;
        if (typeof role !== "string" || !LANDMARK_ROLES.has(role)) return;
        const name = typeof n.name?.value === "string" ? (n.name.value as string) : "";
        landmarks.push({ role, name, pathHash: sha1(`${role}|${name}|${idx}`) });
      });
    } catch (e) {
      console.error(`site-page-state-resolver: a11y 트리 실패 — landmarks 빈값으로 진행(flags/auth 는 probe 산출) — ${e instanceof Error ? e.message : String(e)}`);
    }

    // 닫힌 레지스트리 6키만, 항상 명시 set(미지정=false).
    const flags: Record<string, boolean> = {};
    for (const key of PAGESTATE_FLAG_KEYS) flags[key] = res.flags[key] === true;

    const frames: FrameSummary[] = [];
    for (let i = 0; i < res.iframeCount; i += 1) frames.push({ kind: "iframe", landmarkCount: 1 });

    const raw = session.url();
    const pattern = urlPattern(raw);
    const structuralSeq = landmarks.map((l) => `${l.role}:${l.name}:${l.pathHash}`).join(">");

    return {
      url: { raw, canonical: raw.split("#")[0], pattern },
      dom: {
        structuralHash: sha1(`${pattern}||${structuralSeq}`),
        visibleTextHash: sha1(res.visibleText),
        landmarks,
        frames,
      },
      auth: res.authenticated ? "authenticated" : "anonymous",
      flags,
      matchedWhere: [],
    };
  }

  // config 규칙을 단일 evaluate 함수로 컴파일(셀렉터는 JSON.stringify로 안전 이스케이프 — CSS 셀렉터로만 사용).
  private buildProbe(): string {
    const assigns = Object.entries(this.config.flags)
      .filter((e): e is [string, FlagRule] => e[1] !== undefined)
      .map(([key, rule]) => `flags[${JSON.stringify(key)}] = ${ruleExpr(rule)};`)
      .join(" ");
    const authExpr =
      this.config.authenticatedWhen !== undefined
        ? `!!document.querySelector(${JSON.stringify(this.config.authenticatedWhen.selector)})`
        : "false";
    return `(() => { const flags = {}; ${assigns} return { flags, authenticated: ${authExpr}, visibleText: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim(), iframeCount: document.querySelectorAll('iframe').length }; })()`;
  }
}
