/**
 * PbD 승격 ② — DB read. 성공 run 의 해소된 act ActionPlan 을 node_id 별로 로드한다.
 *
 * 출처: run_steps(action='act', status='success') ⋈ stagehand_calls(stream_status='done', parsed_json) on
 * (tenant_id, run_id, step_id, attempt). stagehand_calls.parsed_json = LLM structured output(해소된 ActionPlan)
 * 으로, parseActionPlan 으로 {operation, selector, ...} 를 복원한다. parseActionPlan 이 undefined 면(예: extract
 * 결과 json) 제외한다 — act-plan 만 신호. 같은 node_id 다중 해소(loop iteration)는 created_at 오름차순 last-write-wins.
 *
 * 캐시-hit step 복구(PR-2): cache hit 는 LLM 미호출이라 stagehand_call 이 없지만, run_steps.action_plan_cache_id
 * (PR-1 배선)로 action_plan_cache.plan_ref(직렬화 ActionPlan)에서 plan 을 복구한다 → warm run 도 완전 승격.
 * 단 **active 한 캐시 entry 만** 복구한다(suspect/stale = 드리프트 플래그 → 알려진-나쁜 셀렉터 베이킹 금지).
 * RLS 스코프 client(현재 테넌트만). 순수 transform 은 scenario-promotion.ts.
 */
import type { PoolClient } from "pg";

import { parseActionPlan, type ActionPlan } from "../executor/action-plan-cache";

export async function loadRunActionPlans(client: PoolClient, runId: string): Promise<Record<string, ActionPlan>> {
  const result = await client.query<{ node_id: string; miss_plan: unknown; hit_plan: string | null }>(
    `SELECT rs.node_id, sc.parsed_json AS miss_plan, apc.plan_ref AS hit_plan
       FROM run_steps rs
       LEFT JOIN stagehand_calls sc
         ON sc.tenant_id = rs.tenant_id AND sc.run_id = rs.run_id
        AND sc.step_id = rs.step_id AND sc.attempt = rs.attempt
        AND sc.stream_status = 'done' AND sc.parsed_json IS NOT NULL
       LEFT JOIN action_plan_cache apc
         ON apc.id = rs.action_plan_cache_id AND apc.tenant_id = rs.tenant_id AND apc.status = 'active'
      WHERE rs.run_id = $1::uuid
        AND rs.action = 'act'
        AND rs.status = 'success'
        AND (sc.parsed_json IS NOT NULL OR apc.plan_ref IS NOT NULL)
      ORDER BY rs.created_at ASC, rs.step_id ASC`,
    [runId],
  );
  const plans: Record<string, ActionPlan> = {};
  for (const row of result.rows) {
    // miss step = stagehand_calls.parsed_json(LLM 출력) 우선. cache-hit step = action_plan_cache.plan_ref(직렬화 ActionPlan).
    const raw = row.miss_plan !== null && row.miss_plan !== undefined ? row.miss_plan : parsePlanRef(row.hit_plan);
    const plan = raw === undefined ? undefined : parseActionPlan(raw);
    if (plan !== undefined) plans[row.node_id] = plan; // node_id 별 last-write-wins(loop 재해소)
  }
  return plans;
}

/** action_plan_cache.plan_ref(직렬화 ActionPlan) → 객체. 손상 시 undefined(조용한 복구 금지 — 해당 노드 제외). */
function parsePlanRef(planRef: string | null): unknown {
  if (planRef === null) return undefined;
  try {
    return JSON.parse(planRef);
  } catch {
    return undefined;
  }
}
