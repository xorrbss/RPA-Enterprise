/**
 * site_profiles.page_state_selectors(jsonb) ↔ SitePageStateConfig 로더/파서 (D3 가동 2단계 — DB 영속화).
 *
 * 실행 모델은 run당 site_profile 1개(BrowserLeasePlan.siteProfileId 포트) — 그 site_profile 의 page_state_selectors 가
 * 그 사이트의 PageState 산출 규칙이다. 로더가 DB에서 읽어 SitePageStateResolver 에 줄 config 로 검증·환원한다.
 *
 * "조용한 false/unknown 금지": 미설정(null)/무효 config 는 PAGE_STATE_UNRESOLVED 로 표면화한다(조용히 all-false 아님).
 */
import type pg from "pg";

import { PageStateResolverError, PAGESTATE_FLAG_KEYS } from "./page-state-resolver";
import type { FlagRule, PageStateFlagKey, SitePageStateConfig } from "./site-page-state-resolver";

const FLAG_KEYS = new Set<string>(PAGESTATE_FLAG_KEYS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRule(key: string, raw: unknown): FlagRule {
  if (!isRecord(raw)) throw invalid(`flags.${key} 는 객체여야 함`);
  const kind = raw.kind;
  const selector = raw.selector;
  if (typeof selector !== "string" || selector.length === 0) throw invalid(`flags.${key}.selector 는 비어있지 않은 문자열이어야 함`);
  if (kind === "present" || kind === "absent") return { kind, selector };
  if (kind === "min_count") {
    const n = raw.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw invalid(`flags.${key}.n 은 0 이상의 정수여야 함`);
    return { kind, selector, n };
  }
  throw invalid(`flags.${key}.kind 는 present|absent|min_count 여야 함(got ${String(kind)})`);
}

function invalid(detail: string): PageStateResolverError {
  return new PageStateResolverError("PAGE_STATE_UNRESOLVED", `site page_state_selectors 무효: ${detail}`);
}

/** jsonb 원본을 SitePageStateConfig 로 엄격 검증·환원. 무효 시 PAGE_STATE_UNRESOLVED throw(조용한 수용 금지). */
export function parseSitePageStateConfig(raw: unknown): SitePageStateConfig {
  if (!isRecord(raw)) throw invalid("최상위는 객체여야 함");

  let authenticatedWhen: SitePageStateConfig["authenticatedWhen"];
  if (raw.authenticatedWhen !== undefined) {
    const aw = raw.authenticatedWhen;
    if (!isRecord(aw) || typeof aw.selector !== "string" || aw.selector.length === 0) {
      throw invalid("authenticatedWhen.selector 는 비어있지 않은 문자열이어야 함");
    }
    authenticatedWhen = { selector: aw.selector };
  }

  if (!isRecord(raw.flags)) throw invalid("flags 는 객체여야 함");
  const flags: Partial<Record<PageStateFlagKey, FlagRule>> = {};
  for (const [key, rule] of Object.entries(raw.flags)) {
    if (!FLAG_KEYS.has(key)) throw invalid(`flags 키 '${key}' 는 닫힌 레지스트리(${PAGESTATE_FLAG_KEYS.join(",")}) 밖`);
    flags[key as PageStateFlagKey] = parseRule(key, rule);
  }

  return authenticatedWhen !== undefined ? { authenticatedWhen, flags } : { flags };
}

/**
 * run 의 site_profile 에서 page_state_selectors 를 읽어 SitePageStateConfig 로 환원.
 * client 는 테넌트 tx(withTenantTx) 내여야 한다(site_profiles 는 RLS 스코프).
 * site 부재/page_state_selectors null → PAGE_STATE_UNRESOLVED(해당 사이트는 비-마커 실행 불가).
 */
export async function loadSitePageStateConfig(
  client: pg.PoolClient,
  tenantId: string,
  siteProfileId: string,
): Promise<SitePageStateConfig> {
  const r = await client.query<{ page_state_selectors: unknown }>(
    `SELECT page_state_selectors FROM site_profiles WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, siteProfileId],
  );
  const row = r.rows[0];
  if (row === undefined) {
    throw new PageStateResolverError("PAGE_STATE_UNRESOLVED", `site_profile ${siteProfileId} 부재 — page_state_selectors 로드 불가`);
  }
  if (row.page_state_selectors === null || row.page_state_selectors === undefined) {
    throw new PageStateResolverError("PAGE_STATE_UNRESOLVED", `site_profile ${siteProfileId} 에 page_state_selectors 미설정 — 비-마커 실행 불가`);
  }
  return parseSitePageStateConfig(row.page_state_selectors);
}
