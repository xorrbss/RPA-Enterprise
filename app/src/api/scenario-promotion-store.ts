/**
 * PbD 승격 ② — DB read. 성공 run 의 해소된 act ActionPlan 을 node_id 별로 로드한다.
 *
 * 출처: run_steps(action='act', status='success') ⋈ stagehand_calls(stream_status='done', parsed_json) on
 * (tenant_id, run_id, step_id, attempt). stagehand_calls.parsed_json = LLM structured output(해소된 ActionPlan)
 * 으로, parseActionPlan 으로 {operation, selector, ...} 를 복원한다. parseActionPlan 이 undefined 면(예: extract
 * 결과 json) 제외한다 — act-plan 만 신호. 같은 node_id 다중 해소(loop iteration)는 created_at 오름차순 last-write-wins.
 *
 * 한계(명시): 캐시-hit step(LLM 미호출)은 stagehand_call 이 없어 제외된다 — PbD demonstration 은 cold-cache 성공 run
 * 전제(첫 성공 run 은 전 act 가 LLM 해소). RLS 스코프 client(현재 테넌트만). 순수 transform 은 scenario-promotion.ts.
 */
import type { PoolClient } from "pg";

import { parseActionPlan, type ActionPlan } from "../executor/action-plan-cache";

export async function loadRunActionPlans(client: PoolClient, runId: string): Promise<Record<string, ActionPlan>> {
  const result = await client.query<{ node_id: string; parsed_json: unknown }>(
    `SELECT rs.node_id, sc.parsed_json
       FROM run_steps rs
       JOIN stagehand_calls sc
         ON sc.tenant_id = rs.tenant_id AND sc.run_id = rs.run_id
        AND sc.step_id = rs.step_id AND sc.attempt = rs.attempt
      WHERE rs.run_id = $1::uuid
        AND rs.action = 'act'
        AND rs.status = 'success'
        AND sc.stream_status = 'done'
        AND sc.parsed_json IS NOT NULL
      ORDER BY sc.created_at ASC`,
    [runId],
  );
  const plans: Record<string, ActionPlan> = {};
  for (const row of result.rows) {
    const plan = parseActionPlan(row.parsed_json);
    if (plan !== undefined) plans[row.node_id] = plan; // node_id 별 last-write-wins(loop 재해소)
  }
  return plans;
}
