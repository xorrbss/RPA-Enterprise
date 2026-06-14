/**
 * OTel 트레이싱 부트스트랩 (D2.6, build-prompt §6: 관측 부트스트랩 D2부터).
 *
 * 전역 TracerProvider를 등록한다. 실 배포는 OTLP exporter를 주입(ops), 테스트는 InMemory를 주입.
 * exporter 선택을 호출측에 위임해 백엔드 의존을 런타임 코어에서 분리한다(impl-bundle §E: 수집은 타팀).
 */
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

export function bootstrapTracing(exporter: SpanExporter): BasicTracerProvider {
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  // async 경계(await)를 넘어 활성 span 컨텍스트가 전파되도록 context manager 등록 — 부모관계 필수.
  provider.register({ contextManager: new AsyncLocalStorageContextManager() });
  return provider;
}
