/**
 * OpenTelemetry 이름 계약 + span 헬퍼 (D2.6 — impl-contracts-bundle.md §E).
 *
 * §E: "span 이름·부모관계·필수 속성은 개발 계약"(수집 백엔드는 타팀). 따라서 이름을 코드 상수로
 * 고정해 D3+ 전 단계가 동일 이름을 쓰도록 한다. executor.execute/llm_gateway.call 등 실제 계측
 * 지점은 해당 컴포넌트(D3/D5)에서 본 상수로 span을 연다 — 여기서는 이름·공통속성·래퍼만 확정.
 */
import {
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

export const TRACER_NAME = "rpa-runtime";
export const METER_NAME = "rpa-runtime";

/** 필수 span(이름 고정, §E). 부모관계는 startActiveSpan 컨텍스트로 표현. */
export const SPAN = {
  runClaim: "run.claim",
  browserLeaseAcquire: "browser.lease.acquire",
  sessionRestore: "session.restore",
  pageStateResolve: "page_state.resolve",
  executorExecute: "executor.execute",
  actionPlanCacheLookup: "action_plan_cache.lookup",
  llmGatewayCall: "llm_gateway.call",
  verifyRun: "verify.run",
  artifactCapture: "artifact.capture",
  pipelineRawPersist: "pipeline.raw_persist",
  sinkDeliver: "sink.deliver",
} as const;
export type SpanName = (typeof SPAN)[keyof typeof SPAN];

/** 필수 메트릭(이름 고정, §E). 수집 백엔드 무관. */
export const METRIC = {
  runSuccessRate: "run_success_rate",
  cacheHitRate: "cache_hit_rate",
  selfHealRate: "self_heal_rate",
  vlmFallbackRate: "vlm_fallback_rate",
  challengeRate: "challenge_rate",
  siteBlockRate: "site_block_rate",
  workitemSlaViolation: "workitem_sla_violation",
  queueDepth: "queue_depth",
  llmTtfbMs: "llm_ttfb_ms",
  llmCost: "llm_cost",
} as const;
export type MetricName = (typeof METRIC)[keyof typeof METRIC];

/** 공통 속성(전 span, §E). correlation_id는 이벤트 envelope와 동일 값으로 trace↔event↔log 연결. */
export interface CommonSpanAttrs {
  readonly tenant_id: string;
  readonly run_id?: string;
  readonly workitem_id?: string;
  readonly correlation_id: string;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME);
}

// §E 필수 메트릭 — lazy 생성(전역 MeterProvider 등록 후 첫 record 시 바인딩). 속성은 저카디널리티만.
let llmCostCounter: Counter | undefined;
let llmTtfbHistogram: Histogram | undefined;

/** llm_cost(USD 누적) 기록. attrs는 저카디널리티(tenant_id/model)만 — run_id 등 고카디널리티 금지. */
export function recordLlmCost(cost: number, attrs: { tenant_id: string; model: string }): void {
  if (llmCostCounter === undefined) {
    llmCostCounter = getMeter().createCounter(METRIC.llmCost, { description: "LLM 호출 누적 비용(USD)", unit: "USD" });
  }
  llmCostCounter.add(cost, attrs);
}

/** llm_ttfb_ms(첫 토큰까지 지연) 기록. */
export function recordLlmTtfbMs(ms: number, attrs: { tenant_id: string; model: string }): void {
  if (llmTtfbHistogram === undefined) {
    llmTtfbHistogram = getMeter().createHistogram(METRIC.llmTtfbMs, { description: "LLM 첫 토큰까지 지연(ms)", unit: "ms" });
  }
  llmTtfbHistogram.record(ms, attrs);
}

function commonToAttributes(c: CommonSpanAttrs): Attributes {
  const a: Attributes = { tenant_id: c.tenant_id, correlation_id: c.correlation_id };
  if (c.run_id !== undefined) a.run_id = c.run_id;
  if (c.workitem_id !== undefined) a.workitem_id = c.workitem_id;
  return a;
}

/**
 * 고정 이름 span으로 fn을 감싼다. 공통속성 + 추가속성을 설정하고, 예외는 record + ERROR status로
 * 표면화(조용한 흡수 금지) 후 재던진다. 활성 컨텍스트라 내부 withSpan은 자동으로 자식 span이 된다.
 */
export async function withSpan<T>(
  name: SpanName,
  common: CommonSpanAttrs,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    span.setAttributes({ ...commonToAttributes(common), ...attrs });
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
