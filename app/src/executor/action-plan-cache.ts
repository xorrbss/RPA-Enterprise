/**
 * ActionPlanCache 계약 (D3 — impl-contracts-bundle.md §D / db action_plan_cache).
 *
 * loop 페이지의 결정형 캐시: 같은 family = 1회 해석 후 재생(LLM 미호출). family 키는 **결정형**으로
 * `(url_pattern_normalized, dom_structural_hash)`(§D, visible_text 제외)이며, 캐시 스코프는 테이블 UNIQUE 7컬럼
 * (scenario_version_id·step_id·url_pattern·dom_structural_hash·model·prompt_template_version·browser_identity_version).
 *
 * status: active 만 재생. verify 실패 누적 → suspect→stale(재생 차단, §7.2). 본 모듈은 포트/타입만 정의 —
 * Postgres 구현은 pg-action-plan-cache.ts.
 */

/** act 의 결정형 동작 계획(재생 단위). */
export type ActionPlan =
  | { operation: "click"; selector: string }
  | { operation: "fill"; selector: string; value: string }
  | { operation: "select"; selector: string; value: string };

/** 캐시 키 — action_plan_cache UNIQUE(7컬럼) + tenant. */
export interface ActionPlanCacheKey {
  tenantId: string;
  scenarioVersionId: string;
  stepId: string;
  urlPattern: string;
  domStructuralHash: string;
  model: string;
  promptTemplateVersion: string;
  browserIdentityVersion: number;
}

export interface ActionPlanCache {
  /** active 한 family 의 plan 만 반환(suspect/stale/quarantined → undefined = miss → 재해석). */
  get(key: ActionPlanCacheKey): Promise<ActionPlan | undefined>;
  /** 성공 해석을 active 로 저장(ON CONFLICT success_count+1). */
  put(key: ActionPlanCacheKey, plan: ActionPlan): Promise<void>;
  /** verify 실패 → 재생 차단(active→suspect→stale; 미존재 시 suspect 1회 기록, §D failed plan). */
  markSuspect(key: ActionPlanCacheKey): Promise<void>;
}

/** 직렬화 plan(plan_ref) → ActionPlan 검증(계약 외 shape 는 undefined). */
export function parseActionPlan(value: unknown): ActionPlan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { operation?: unknown; selector?: unknown; value?: unknown };
  if (typeof v.selector !== "string" || v.selector.length === 0) return undefined;
  if (v.operation === "click") return { operation: "click", selector: v.selector };
  if ((v.operation === "fill" || v.operation === "select") && typeof v.value === "string") {
    return { operation: v.operation, selector: v.selector, value: v.value };
  }
  return undefined;
}
