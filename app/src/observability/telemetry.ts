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

import { redactUrlSecrets } from "./log";

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

/**
 * RunContext(또는 동형) → CommonSpanAttrs. correlation_id 는 ctx.correlationId(driver 가 run.correlation_id 주입),
 * 미주입(테스트/엣지)이면 run_id 로 폴백해 §E 필수 공통속성을 항상 채운다.
 */
export function spanCommonFromContext(ctx: {
  tenantId: string;
  runId: string;
  workitemId?: string;
  correlationId?: string;
}): CommonSpanAttrs {
  return {
    tenant_id: ctx.tenantId,
    correlation_id: ctx.correlationId ?? ctx.runId,
    run_id: ctx.runId,
    ...(ctx.workitemId !== undefined ? { workitem_id: ctx.workitemId } : {}),
  };
}

export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME);
}

// §E 필수 메트릭 — lazy 생성(전역 MeterProvider 등록 후 첫 record 시 바인딩). 속성은 저카디널리티만.
let llmCostCounter: Counter | undefined;
let llmTtfbHistogram: Histogram | undefined;
let runTerminalCounter: Counter | undefined;
let cacheLookupCounter: Counter | undefined;
let challengeCounter: Counter | undefined;
let siteBlockCounter: Counter | undefined;

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

/**
 * run_success_rate(§E) — Run 종결을 outcome(completed/failed_business/failed_system/cancelled)별로 카운트한다.
 * 수집 백엔드가 completed/total 로 성공률을 산출(여기서 rate 계산 안 함). attrs는 저카디널리티(tenant_id/outcome)만 — run_id 금지.
 */
export function recordRunTerminal(outcome: string, attrs: { tenant_id: string }): void {
  if (runTerminalCounter === undefined) {
    runTerminalCounter = getMeter().createCounter(METRIC.runSuccessRate, {
      description: "Run 종결 수(outcome 별 — 백엔드가 성공률 산출)",
    });
  }
  runTerminalCounter.add(1, { tenant_id: attrs.tenant_id, outcome });
}

/**
 * cache_hit_rate(§E) — ActionPlanCache 조회를 hit/miss(result attr)로 카운트한다(백엔드가 hit/total 로 적중률 산출).
 * attrs는 저카디널리티(tenant_id/result)만 — step/url 등 고카디널리티 키 금지.
 */
export function recordCacheLookup(hit: boolean, attrs: { tenant_id: string }): void {
  if (cacheLookupCounter === undefined) {
    cacheLookupCounter = getMeter().createCounter(METRIC.cacheHitRate, {
      description: "ActionPlanCache 조회 수(hit/miss — 백엔드가 적중률 산출)",
    });
  }
  cacheLookupCounter.add(1, { tenant_id: attrs.tenant_id, result: hit ? "hit" : "miss" });
}

/** challenge_rate(§E) — challenge 자동 감지(suspend) 수를 카운트한다(백엔드가 challenge/run 으로 발생률 산출). */
export function recordChallenge(attrs: { tenant_id: string }): void {
  if (challengeCounter === undefined) {
    challengeCounter = getMeter().createCounter(METRIC.challengeRate, {
      description: "challenge 자동 감지 수(백엔드가 발생률 산출)",
    });
  }
  challengeCounter.add(1, { tenant_id: attrs.tenant_id });
}

/** site_block_rate(§E) — SITE_PROFILE_BLOCKED(red 미승인) 런타임 거부 수를 카운트한다(백엔드가 발생률 산출). */
export function recordSiteBlock(attrs: { tenant_id: string }): void {
  if (siteBlockCounter === undefined) {
    siteBlockCounter = getMeter().createCounter(METRIC.siteBlockRate, {
      description: "SITE_PROFILE_BLOCKED 런타임 거부 수(백엔드가 발생률 산출)",
    });
  }
  siteBlockCounter.add(1, { tenant_id: attrs.tenant_id });
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
      // recordException/status.message 는 redaction 미적용 exporter 로 나가므로 URL 쿼리/프래그먼트 비밀을 마스킹
      //   (navigate 원 Playwright 메시지의 토큰 누출 차단 — errText 로그 경계와 대칭).
      const message = redactUrlSecrets(err instanceof Error ? err.message : String(err));
      span.recordException(err instanceof Error ? { name: err.name, message, stack: err.stack } : message);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}
