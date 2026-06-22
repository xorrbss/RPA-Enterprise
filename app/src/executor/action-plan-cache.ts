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

/**
 * act 의 결정형 동작 계획(재생 단위).
 * fill 은 리터럴 `value`(비민감) 또는 `valueRef`(자격증명 에셋 키 — 평문 아님, 실행기가 SecretStore 경유로 해소) 중 하나를
 * 싣는다. valueRef 는 **에셋 키 문자열**이지 SecretRef 경로/평문이 아니므로 캐시·로그·직렬화에 안전하다.
 */
export type ActionPlan =
  | { operation: "click"; selector: string }
  | { operation: "fill"; selector: string; value?: string; valueRef?: string }
  | { operation: "select"; selector: string; value: string };

// POC 전용: 캔드/가짜 게이트웨이가 `value:"{{secret:<assetKey>}}"` 를 주면 valueRef 로 정규화(평문 미운반).
// 프로덕션 경로는 실행기가 act.vars→secretRef 로 valueRef 를 결정형 세팅하므로 이 정규화에 의존하지 않는다.
const SECRET_PLACEHOLDER_RE = /^\{\{secret:([A-Za-z0-9._:-]+)\}\}$/;

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

/** cache hit 결과 — plan + cacheId(action_plan_cache.id). cacheId 는 run_steps.action_plan_cache_id 로 영속돼
 *  cache-hit step 의 결정형 plan 을 역추적(PbD 승격이 warm run 의 cache-hit 노드도 복구)하는 링크다. */
export interface ActionPlanCacheHit {
  readonly plan: ActionPlan;
  readonly cacheId: string;
}

export interface ActionPlanCache {
  /** active 한 family 의 plan(+cacheId) 만 반환(suspect/stale/quarantined → undefined = miss → 재해석). */
  get(key: ActionPlanCacheKey): Promise<ActionPlanCacheHit | undefined>;
  /** 성공 해석을 active 로 저장(ON CONFLICT success_count+1). */
  put(key: ActionPlanCacheKey, plan: ActionPlan): Promise<void>;
  /** verify 실패 → 재생 차단(active→suspect→stale; 미존재 시 suspect 1회 기록, §D failed plan). */
  markSuspect(key: ActionPlanCacheKey): Promise<void>;
}

/** 직렬화 plan(plan_ref) → ActionPlan 검증(계약 외 shape 는 undefined). */
export function parseActionPlan(value: unknown): ActionPlan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { operation?: unknown; selector?: unknown; value?: unknown; valueRef?: unknown };
  if (typeof v.selector !== "string" || v.selector.length === 0) return undefined;
  if (v.operation === "click") return { operation: "click", selector: v.selector };
  if (v.operation === "select" && typeof v.value === "string") {
    return { operation: "select", selector: v.selector, value: v.value };
  }
  if (v.operation === "fill") {
    // 명시 valueRef(에셋 키) 우선 — 평문 미운반. (캐시 라운드트립/실행기 주입 plan)
    if (typeof v.valueRef === "string" && v.valueRef.length > 0) {
      return { operation: "fill", selector: v.selector, valueRef: v.valueRef };
    }
    if (typeof v.value === "string") {
      const m = SECRET_PLACEHOLDER_RE.exec(v.value);
      // POC 전용 placeholder → valueRef. 그 외는 리터럴 fill(비민감) 보존.
      return m ? { operation: "fill", selector: v.selector, valueRef: m[1] } : { operation: "fill", selector: v.selector, value: v.value };
    }
    // value/valueRef 둘 다 부재 — 자격증명 fill(실행기가 secretRef 로 valueRef 를 주입) 경로에서만 유효.
    return { operation: "fill", selector: v.selector };
  }
  return undefined;
}
