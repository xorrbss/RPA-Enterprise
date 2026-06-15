/**
 * run → site_profile 해소 (D3 가동 2단계 — 멀티사이트). 계약이 명시적으로 "연기"한 run별 site_profile 매핑의 dev 절반.
 *
 * 실행 모델은 run당 site_profile 1개(BrowserLeasePlan.siteProfileId). 계약은 runs/scenario_versions에 site 링크를
 * 두지 않고(런타임 해소가 설계 의도) site_profiles.url_pattern("사이트 식별 패턴")만 가진다. 따라서 run의 시나리오
 * **entry navigate URL의 origin**을 site_profiles.url_pattern의 origin과 매칭해 단일 site_profile을 고른다.
 *
 * canonical url_pattern 매칭 규칙(이 증분에서 확정): URL.origin(scheme://host:port) 동일성. url_pattern의 경로/glob
 * 접미사는 run→site 선택에서 무시(URL.origin이 정규화). 같은 origin 다중 = config 오류로 loud(SQL LIMIT 의존 금지).
 *
 * "조용한 false/unknown 금지":
 *  - entry navigate 없음/형식 무효 → IR_SCHEMA_INVALID
 *  - symbolic url_ref(절대 URL 아님; url_ref 심볼 해석은 별도 연기) → URL_REF_SYMBOLIC_UNRESOLVED (조용한 0-match 아님)
 *  - 0-match → SITE_PROFILE_UNRESOLVED, 같은 origin 다중 → SITE_PROFILE_AMBIGUOUS
 */
import type pg from "pg";

export type SiteResolutionCode =
  | "IR_SCHEMA_INVALID"
  | "URL_REF_SYMBOLIC_UNRESOLVED"
  | "SITE_PROFILE_UNRESOLVED"
  | "SITE_PROFILE_AMBIGUOUS";

export class SiteResolutionError extends Error {
  constructor(
    readonly code: SiteResolutionCode,
    message: string,
  ) {
    super(message);
    this.name = "SiteResolutionError";
  }
}

/** 절대 URL의 origin(scheme://host:port). 절대 URL 아니면 null(심볼릭 url_ref). */
export function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

interface IrNodeLike {
  what?: unknown;
  next?: unknown;
  on?: unknown;
}

/**
 * ir.start에서 도달 가능한(next + on[].target BFS) 첫 navigate의 url_ref를 반환.
 * navigate 부재/url_ref 누락 → IR_SCHEMA_INVALID. 멀티-오리진(시나리오 내 다중 사이트)은 entry만 바인딩(연기).
 */
export function extractEntryNavigateUrlRef(ir: unknown): string {
  const root = ir as { start?: unknown; nodes?: unknown };
  if (typeof root.start !== "string" || typeof root.nodes !== "object" || root.nodes === null) {
    throw new SiteResolutionError("IR_SCHEMA_INVALID", "ir.start/nodes 형식 무효 — entry URL 판정 불가");
  }
  const nodes = root.nodes as Record<string, IrNodeLike>;
  const queue: string[] = [root.start];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (node === undefined) continue;

    if (Array.isArray(node.what)) {
      for (const action of node.what) {
        if (action !== null && typeof action === "object" && (action as { action?: unknown }).action === "navigate") {
          const ref = (action as { url_ref?: unknown }).url_ref;
          if (typeof ref !== "string" || ref.length === 0) {
            throw new SiteResolutionError("IR_SCHEMA_INVALID", `navigate.url_ref 누락/무효 (node ${id})`);
          }
          return ref;
        }
      }
    }

    if (typeof node.next === "string") queue.push(node.next);
    if (Array.isArray(node.on)) {
      for (const branch of node.on) {
        const target = branch !== null && typeof branch === "object" ? (branch as { target?: unknown }).target : undefined;
        if (typeof target === "string") queue.push(target);
      }
    }
  }

  throw new SiteResolutionError("IR_SCHEMA_INVALID", "start에서 도달 가능한 navigate 없음 — entry URL 판정 불가");
}

/**
 * entry url_ref를 site_profiles.url_pattern(origin)에 매칭해 단일 site_profile_id 반환.
 * client는 테넌트 tx(withTenantTx) 내여야 한다(site_profiles는 RLS 스코프).
 * 후보 전부를 앱측에서 origin 비교(SQL LIMIT 1로 임의 선택 금지).
 */
export async function resolveSiteProfileId(
  client: pg.PoolClient,
  input: { tenantId: string; entryUrlRef: string },
): Promise<string> {
  const origin = originOf(input.entryUrlRef);
  if (origin === null) {
    throw new SiteResolutionError(
      "URL_REF_SYMBOLIC_UNRESOLVED",
      `entry url_ref '${input.entryUrlRef}' 는 절대 URL 아님 — symbolic url_ref 해석은 연기(README run→site 연기 항목)`,
    );
  }

  const r = await client.query<{ id: string; url_pattern: string }>(
    `SELECT id::text AS id, url_pattern FROM site_profiles WHERE tenant_id = $1::uuid`,
    [input.tenantId],
  );
  const matches = r.rows.filter((row) => originOf(row.url_pattern) === origin);

  if (matches.length === 0) {
    throw new SiteResolutionError("SITE_PROFILE_UNRESOLVED", `origin ${origin} 에 매칭되는 site_profile 없음`);
  }
  if (matches.length > 1) {
    throw new SiteResolutionError(
      "SITE_PROFILE_AMBIGUOUS",
      `origin ${origin} 에 site_profile ${matches.length}개 매칭 — url_pattern origin 중복(config 오류)`,
    );
  }
  return (matches[0] as { id: string }).id;
}
