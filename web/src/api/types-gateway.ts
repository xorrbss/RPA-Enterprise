export interface GatewayPolicy {
  readonly model: string;
  // 낙관적 동시성 토큰(GET ETag = gateway_policies.version). PUT If-Match에 사용. ETag 부재 시 undefined → 편집 차단.
  readonly version?: number;
  readonly capabilities?: Record<string, unknown>;
  readonly budget?: Record<string, unknown>;
  readonly fallback?: Record<string, unknown> | null;
  readonly is_default?: boolean;
}

// LLM 호출 사용량/비용 집계(api-surface §6 GET /v1/gateway/call-summary). 모델별 + 전체 합계. 토큰/비용이 전부
// NULL이면 합도 null(0 단정 금지). cost는 numeric 정밀도 보존(string).
export interface GatewayCallSummaryModel {
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: string | null;
}

export interface GatewayCallSummary {
  readonly window_days: number;
  readonly total: { readonly calls: number; readonly input_tokens: number | null; readonly output_tokens: number | null; readonly cost: string | null };
  readonly by_model: readonly GatewayCallSummaryModel[];
}

// PUT /v1/gateway/policy body(닫힌 shape — 백엔드 parsePolicyBody와 정합). model이 갱신 대상 정책 키.
export interface GatewayPolicyUpdate {
  readonly model: string;
  readonly capabilities: Record<string, unknown>;
  readonly budget: Record<string, unknown>;
  readonly fallback_config?: Record<string, unknown> | null;
  readonly is_default?: boolean;
}
