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
 * 또한 **run 이 그 step 을 실행한 후 캐시가 덮어써진(cross-run 재해소) plan 은 제외**한다(CHP-01): plan_ref 는 가변이라
 * (put 이 ON CONFLICT DO UPDATE 로 같은 행의 plan_ref·last_success_at=now() 갱신) run R 이 hit 한 셀렉터가, 무관한
 * 후속 run 의 재해소로 덮어써질 수 있다. 그 경우 현재 plan_ref 는 R 이 실행한 적 없는 셀렉터이므로 PbD 소운드니스
 * (데모한 동작만 굳힘)에 위배된다 → `apc.last_success_at <= rs.created_at`(put 시각 ≤ R 의 step 기록 시각, get 은
 * read-only 라 last_success_at 미갱신)로 덮어쓰기된 plan 을 제외(n7 stale 과 동형의 안전 제외 — false 가 아니라 부재).
 * RLS 스코프 client(현재 테넌트만). 순수 transform 은 scenario-promotion.ts.
 *
 * 다중-act 노드 모호성(plan→act 귀속): 인터프리터는 한 노드의 what[k] 를 distinct step_id(`${nodeId}.${k}`)로
 * 분리 실행하므로, 한 노드에 act 가 둘 이상이면(distinct step_id ≥ 2) node_id 키잉이 plan 을 1개로 접어
 * transform 의 '첫 매칭 act' 휴리스틱이 엉뚱한 act 에 셀렉터를 베이킹할 수 있다(최악: 자격증명 fill 셀렉터 오필드).
 * 이런 노드는 plan 을 1개로 신뢰 귀속할 수 없으므로 **승격에서 제외하고 ambiguousNodeIds 로 명시 보고**한다
 * (transform 이 'multi_act_node_ambiguous' 로 loud skip — 조용한 오귀속 금지). loop 재해소(같은 step_id 다중
 * attempt)는 distinct step_id 가 1 개라 모호하지 않다(last-write-wins 유지).
 */
import type { PoolClient } from "pg";

import { parseActionPlan, type ActionPlan } from "../executor/action-plan-cache";

export interface LoadedRunActionPlans {
  /** node_id → 결정형화 대상 ActionPlan(다중-act 노드는 제외됨 — ambiguousNodeIds 참조). */
  readonly plans: Record<string, ActionPlan>;
  /** 한 노드에 act 스텝이 둘 이상(distinct step_id ≥ 2)이라 plan→act 귀속이 모호한 노드. 승격에서 loud skip. */
  readonly ambiguousNodeIds: readonly string[];
}

export async function loadRunActionPlans(client: PoolClient, runId: string): Promise<LoadedRunActionPlans> {
  const result = await client.query<{ node_id: string; step_id: string; miss_plan: unknown; hit_plan: string | null }>(
    `SELECT rs.node_id, rs.step_id, sc.parsed_json AS miss_plan, apc.plan_ref AS hit_plan
       FROM run_steps rs
       LEFT JOIN stagehand_calls sc
         ON sc.tenant_id = rs.tenant_id AND sc.run_id = rs.run_id
        AND sc.step_id = rs.step_id AND sc.attempt = rs.attempt
        AND sc.stream_status = 'done' AND sc.parsed_json IS NOT NULL
       LEFT JOIN action_plan_cache apc
         ON apc.id = rs.action_plan_cache_id AND apc.tenant_id = rs.tenant_id AND apc.status = 'active'
        AND apc.last_success_at <= rs.created_at
      WHERE rs.run_id = $1::uuid
        AND rs.action = 'act'
        AND rs.status = 'success'
        AND (sc.parsed_json IS NOT NULL OR apc.plan_ref IS NOT NULL)
      ORDER BY rs.created_at ASC, rs.step_id ASC`,
    [runId],
  );
  const plans: Record<string, ActionPlan> = {};
  // 노드별 distinct step_id 집합 — size ≥ 2 면 다중-act 노드(plan→act 귀속 모호) → 승격 제외.
  const stepIdsByNode = new Map<string, Set<string>>();
  for (const row of result.rows) {
    // miss step = stagehand_calls.parsed_json(LLM 출력) 우선. cache-hit step = action_plan_cache.plan_ref(직렬화 ActionPlan).
    const raw = row.miss_plan !== null && row.miss_plan !== undefined ? row.miss_plan : parsePlanRef(row.hit_plan);
    const plan = raw === undefined ? undefined : parseActionPlan(raw);
    if (plan === undefined) continue;
    let stepIds = stepIdsByNode.get(row.node_id);
    if (stepIds === undefined) {
      stepIds = new Set();
      stepIdsByNode.set(row.node_id, stepIds);
    }
    stepIds.add(row.step_id);
    plans[row.node_id] = plan; // node_id 별 last-write-wins(loop 재해소: 같은 step_id 다중 attempt)
  }
  const ambiguousNodeIds: string[] = [];
  for (const [nodeId, stepIds] of stepIdsByNode) {
    if (stepIds.size > 1) {
      ambiguousNodeIds.push(nodeId);
      delete plans[nodeId]; // 다중-act 노드는 신뢰 귀속 불가 → 제외(조용한 오귀속 대신 transform 이 loud skip)
    }
  }
  return { plans, ambiguousNodeIds };
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
