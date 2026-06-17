/**
 * gateway_policies → StagehandDomExecutorConfig 의 policy-scoped 필드(model/budget) 적재 (PR-B0 — dom run-drive).
 * loadSitePageStateConfig 동형 — withTenantTx(RLS strict) 안에서 호출 전제. row 부재/budget 무효 시 loud throw
 * (조용한 default budget/model 금지). model 은 runs.model(run-create 시 1회 해소·동결, Gap2)에서 온다.
 */
import type { PoolClient } from "pg";

import type { LLMRequest } from "../../../ts/security-middleware-contract";

// 프롬프트 템플릿 코드 버전(Gap1). action_plan_cache 캐시 키의 결정 요소 — buildRequest 메시지-빌드 코드가 바뀌면 올린다.
// TODO(relocate): stagehand-dom-executor.ts 의 buildRequest 옆으로 이전(Gap1 cohesion — 상수는 프롬프트 코드와 공존해야
//   변경 누락 시 캐시 오염을 구조적으로 막는다). 현재 그 파일이 병렬 작업(fl/extract-schema-validator: secretRef fill) 대상이라
//   충돌 회피로 여기 임시 정의. 병렬 작업 정착 후 이전.
export const DOM_PROMPT_TEMPLATE_VERSION = "dom@1";

export interface DomGatewayPolicy {
  readonly model: string;
  readonly budget: LLMRequest["budget"];
}

/** (tenant_id, model) gateway_policy 의 budget 적재. 부재/무효 → loud throw(조용한 default 금지). */
export async function loadGatewayPolicyConfig(
  client: PoolClient,
  tenantId: string,
  model: string,
): Promise<DomGatewayPolicy> {
  const r = await client.query<{ budget: unknown }>(
    `SELECT budget FROM gateway_policies WHERE tenant_id = $1::uuid AND model = $2`,
    [tenantId, model],
  );
  const row = r.rows[0];
  if (row === undefined) {
    throw new Error(`gateway_policy 부재: tenant=${tenantId} model=${model} — dom 구동 불가(조용한 default 금지)`);
  }
  return { model, budget: parseBudget(row.budget, model) };
}

function parseBudget(raw: unknown, model: string): LLMRequest["budget"] {
  const b = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new Error(`gateway_policy.budget 무효(object 아님): model=${model}`);
  }
  const o = b as Record<string, unknown>;
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`gateway_policy.budget.${k} 무효(>=0 수치 필요): model=${model}`);
    }
    return v;
  };
  return { maxInputTokens: num("maxInputTokens"), maxOutputTokens: num("maxOutputTokens"), maxCost: num("maxCost") };
}
