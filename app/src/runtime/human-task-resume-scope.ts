/**
 * Resume nodeScope 시드 — 해소된 @human_task 노드의 사람 판정을 IREL `node.<id>.decision/correction` 스코프로 투영한다.
 *
 * 신뢰 경계(reserved-handlers.md): resume token 은 판정을 적재하지 않는다. 재개 시 드라이버가 `human_tasks.result` 를
 * **re-SELECT**(서버 권위·RLS 뒤·resolve 후 불변·idempotent)해 이 모듈로 nodeScope 를 구성한다. 토큰 변조·재사용으로
 * 판정을 위조할 수 없다. 같은 노드가 다중 cycle(loop/재suspend)로 여러 task 를 만들면 최신 해소분이 권위(later overwrites).
 */
import type { Pool } from "pg";

import { withTenantTx } from "../db/pool";
import type { HumanTaskNodeOutput } from "./ir-interpreter-types";

interface ResolvedHumanTaskRow {
  node_id: string;
  result: unknown;
}

/**
 * run 의 해소된 @human_task 행을 읽어 `node_id → {decision, correction}` 맵을 만든다. node_id NULL(challenge task)·
 * result NULL·malformed(decision 비-string)은 미투영(스킵) — 참조 시 IREL_RUNTIME_MISSING 으로 loud(조용한 false 금지).
 * 정렬: resolved_at→created_at 오름차순으로 읽어 같은 node_id 는 최신 해소분이 마지막에 덮어쓴다.
 */
export async function loadResolvedHumanTaskNodeOutputs(
  pool: Pool,
  tenantId: string,
  runId: string,
): Promise<Record<string, HumanTaskNodeOutput>> {
  const rows = await withTenantTx(pool, tenantId, async (client) => {
    const r = await client.query<ResolvedHumanTaskRow>(
      `SELECT node_id, result
         FROM human_tasks
        WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND state = 'resolved' AND node_id IS NOT NULL
        ORDER BY resolved_at ASC NULLS FIRST, created_at ASC`,
      [tenantId, runId],
    );
    return r.rows;
  });

  const outputs: Record<string, HumanTaskNodeOutput> = {};
  for (const row of rows) {
    // 행은 resolved_at→created_at ASC — 같은 node_id 는 최신 해소가 권위(latest-wins). 최신이 malformed/decision 부재면
    //   이전 사이클의 유효 출력으로 폴백하지 않는다(stale 판정 사용 금지) → 부재 = 참조 시 IREL_RUNTIME_MISSING(loud).
    const output = humanTaskNodeOutput(row.result);
    if (output !== undefined) outputs[row.node_id] = output;
    else delete outputs[row.node_id];
  }
  return outputs;
}

/** human_tasks.result(JSONB) → {decision, correction?}. decision 은 닫힌 enum(API 검증 완료), corrections 는 business_form 교정값. */
function humanTaskNodeOutput(result: unknown): HumanTaskNodeOutput | undefined {
  if (!isRecord(result) || typeof result.decision !== "string") return undefined;
  const corrections = result.corrections;
  return isRecord(corrections)
    ? { decision: result.decision, correction: corrections }
    : { decision: result.decision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
