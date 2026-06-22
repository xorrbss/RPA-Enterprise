/**
 * 단위 — buildRequest 멱등키가 self-heal 세대만 분리하고 worker-retry dedup 은 보존하는지 (감사 GW-SSE-02 회귀).
 *
 * 종전 키 = sha(tenant|run|step|type|promptTemplateVersion|instruction|structuralHash) 로 attempt/selfHealRetry 제외.
 * 같은 페이지(structuralHash 불변) self-heal 재해소가 동일 키 → gateway 멱등 store replay(stale parsed_json) → 자가복구
 * 무력화. 수정: selfHealRetry=true 일 때만 self-heal 세대(attempt)를 키에 섞어 fresh 호출. 비-self-heal(worker-retry)은
 * attempt 무관 안정 키로 dedup 보존.
 *
 * 실행: tsx test/dom-build-request-idempotency.unit.ts
 */
import { buildRequest } from "../src/executor/stagehand-dom-executor-dom";
import type { RunContext } from "../../ts/core-types";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const cfg = { model: "codex", promptTemplateVersion: "v1", budget: { maxInputTokens: 1000, maxOutputTokens: 1000, maxCost: 1 }, scenarioVersionId: "sv1", browserIdentityVersion: 1 } as never;
const act = { type: "act", instruction: "click submit" } as never;

function ctx(over: Partial<RunContext>): RunContext {
  return {
    runId: "r1", tenantId: "t1", nodeId: "open", attempt: 0,
    pageState: { url: { raw: "https://x/p", canonical: "https://x/p", pattern: "https://x/*" }, dom: { structuralHash: "H", visibleTextHash: "v", landmarks: [], frames: [] }, auth: "anonymous", flags: {}, matchedWhere: [] },
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "n", leaseId: "l", assetRefs: {}, abortSignal: new AbortController().signal,
    ...over,
  } as unknown as RunContext;
}
const keyOf = (over: Partial<RunContext>): string => (buildRequest(cfg, "step1", act, ctx(over)) as unknown as { idempotencyKey: string }).idempotencyKey;

const normal0 = keyOf({ attempt: 0 });
const normal5 = keyOf({ attempt: 5 }); // worker-retry: 다른 attempt, self-heal 아님 → 키 안정(dedup)
const heal1 = keyOf({ attempt: 1, selfHealRetry: true });
const heal2 = keyOf({ attempt: 2, selfHealRetry: true });

check("worker-retry(비 self-heal): attempt 무관 키 안정 → dedup 보존", normal0 === normal5, `${normal0.slice(0, 12)} / ${normal5.slice(0, 12)}`);
check("self-heal 키 ≠ 일반 키 → fresh LLM 호출(stale replay 아님)", normal0 !== heal1, `${normal0.slice(0, 12)} / ${heal1.slice(0, 12)}`);
check("self-heal 세대별 키 구분 → 연속 self-heal 이 서로 replay 단락 안 함", heal1 !== heal2, `${heal1.slice(0, 12)} / ${heal2.slice(0, 12)}`);

if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS: buildRequest self-heal 멱등키 분리(GW-SSE-02)");
process.exit(0);
