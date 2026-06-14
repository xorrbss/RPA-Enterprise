/**
 * D2.6 단위 테스트 — OTel 이름 계약 + span 부모관계/공통속성(impl-bundle §E).
 *
 * 외부 의존 없음(InMemory exporter). 검증:
 *  - 고정 span 이름이 §E 집합과 정확히 일치
 *  - 고정 메트릭 이름이 §E 집합과 정확히 일치
 *  - withSpan 중첩 시 부모관계(executor.execute ⊂ run.claim) 성립
 *  - 공통속성(tenant_id/run_id/correlation_id) + span별 속성 기록
 */
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { bootstrapTracing } from "../src/observability/bootstrap";
import { SPAN, METRIC, withSpan } from "../src/observability/telemetry";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// §E 권위 이름 — 본 테스트가 계약 ↔ 코드 정합을 강제한다.
const CONTRACT_SPANS = [
  "run.claim",
  "browser.lease.acquire",
  "session.restore",
  "page_state.resolve",
  "executor.execute",
  "action_plan_cache.lookup",
  "llm_gateway.call",
  "verify.run",
  "artifact.capture",
  "pipeline.raw_persist",
  "sink.deliver",
];
const CONTRACT_METRICS = [
  "run_success_rate",
  "cache_hit_rate",
  "self_heal_rate",
  "vlm_fallback_rate",
  "challenge_rate",
  "site_block_rate",
  "workitem_sla_violation",
  "queue_depth",
  "llm_ttfb_ms",
  "llm_cost",
];

check(
  "SPAN names == §E contract set",
  JSON.stringify([...Object.values(SPAN)].sort()) === JSON.stringify([...CONTRACT_SPANS].sort()),
  JSON.stringify(Object.values(SPAN)),
);
check(
  "METRIC names == §E contract set",
  JSON.stringify([...Object.values(METRIC)].sort()) === JSON.stringify([...CONTRACT_METRICS].sort()),
  JSON.stringify(Object.values(METRIC)),
);

const exporter = new InMemorySpanExporter();
bootstrapTracing(exporter);

const common = { tenant_id: "t1", run_id: "r1", correlation_id: "c1" } as const;

async function main(): Promise<void> {
  await withSpan(SPAN.runClaim, common, {}, async () => {
    await withSpan(SPAN.executorExecute, common, { node_id: "n1", action: "act", executor: "dom" }, async () => {
      // no-op 실행 단위
    });
  });

  const spans = exporter.getFinishedSpans();
  const parent = spans.find((s) => s.name === "run.claim");
  const child = spans.find((s) => s.name === "executor.execute");
  check("run.claim span recorded", parent !== undefined);
  check("executor.execute span recorded", child !== undefined);
  check(
    "executor.execute is child of run.claim",
    child !== undefined && parent !== undefined && child.parentSpanId === parent.spanContext().spanId,
    `childParent=${child?.parentSpanId} parent=${parent?.spanContext().spanId}`,
  );
  check("common attrs on span", child?.attributes.tenant_id === "t1" && child?.attributes.correlation_id === "c1");
  check(
    "span-specific attrs (node_id/action/executor)",
    child?.attributes.node_id === "n1" && child?.attributes.action === "act" && child?.attributes.executor === "dom",
  );

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D2 telemetry unit green");
}

main().catch((err) => {
  console.error("FAIL: telemetry unit threw:", err);
  process.exit(1);
});
