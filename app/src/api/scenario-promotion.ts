/**
 * PbD(Programming by Demonstration) 승격 — click-only 결정형화 (③ 슬라이스1, pure transform).
 *
 * 성공 run 의 해소된 ActionPlan(click) 을 시나리오 IR 의 LLM `act` 노드에 결정형 `act.args.click_selector` 로
 * 베이킹한다. 실행기는 click_selector 선언 시 **LLM 을 전혀 경유하지 않고**(셀렉터 환각 차단) 그 셀렉터를
 * settle 후 클릭한다(stagehand-dom-executor). 이로써 item⑤ 승인 게이트 뒤의 비가역 click 을 결정형화해
 * A.2(승인 후 LLM 오대상)를 근원 차단한다.
 *
 * 범위(click-only): fill/select 는 실행기에 결정형 셀렉터 arg 가 없어(value_ref 는 값만 결정형, 셀렉터는 LLM
 * 해소 유지) 승격 대상이 아니다 — `skipped` 로 명시 보고한다(조용히 흘리지 않는다, "조용한 false 금지").
 *
 * 본 모듈은 순수 변환(DB/IO 없음)이다. 캡처 plan 의 DB 조회(run→{node_id→ActionPlan})와 승격 시나리오 버전
 * 저장은 후속 슬라이스(②/③)에서 본 함수를 호출한다.
 */
import type { ActionPlan } from "../executor/action-plan-cache";

export interface PromotionSkip {
  readonly nodeId: string;
  readonly reason: string;
}

export interface PromotionResult {
  /** 승격된 IR(깊은 복제 — 입력 IR 은 변형하지 않는다). */
  readonly ir: Record<string, unknown>;
  /** click_selector 가 베이킹된 노드 id 목록. */
  readonly promotedNodeIds: readonly string[];
  /** 캡처 plan 이 있으나 승격하지 않은 노드(이유 명시). */
  readonly skipped: readonly PromotionSkip[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** node.what 에서 결정형화 대상 act(action==="act", 기존 click_selector 없음) 의 인덱스. 없으면 -1. */
function firstPromotableActIndex(what: readonly unknown[]): number {
  return what.findIndex((step) => {
    if (!isRecord(step) || step.action !== "act") return false;
    const args = isRecord(step.args) ? step.args : undefined;
    return args === undefined || typeof args.click_selector !== "string";
  });
}

/**
 * click ActionPlan 을 시나리오 IR 의 LLM act 노드에 결정형 act.args.click_selector 로 베이킹한다.
 * @param ir 시나리오 IR(nodes 맵 포함). 변형하지 않는다(깊은 복제 반환).
 * @param capturedPlans node_id → 성공 run 에서 해소된 ActionPlan.
 */
export function promoteActsToDeterministic(
  ir: Record<string, unknown>,
  capturedPlans: Readonly<Record<string, ActionPlan>>,
): PromotionResult {
  const clone = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
  const promotedNodeIds: string[] = [];
  const skipped: PromotionSkip[] = [];
  const nodes = isRecord(clone.nodes) ? clone.nodes : undefined;

  for (const [nodeId, plan] of Object.entries(capturedPlans)) {
    if (nodes === undefined || !isRecord(nodes[nodeId])) {
      skipped.push({ nodeId, reason: "node_not_found" });
      continue;
    }
    if (plan.operation !== "click") {
      // fill/select: 실행기 결정형 셀렉터 arg 부재 → 승격 불가(LLM 셀렉터 해소 유지). 명시 보고.
      skipped.push({ nodeId, reason: `${plan.operation}_not_click_deterministic` });
      continue;
    }
    const node = nodes[nodeId] as Record<string, unknown>;
    const what = Array.isArray(node.what) ? node.what : undefined;
    if (what === undefined) {
      skipped.push({ nodeId, reason: "node_what_missing" });
      continue;
    }
    const actIndex = firstPromotableActIndex(what);
    if (actIndex === -1) {
      // act 가 없거나 이미 결정형(click_selector) — 베이킹할 LLM act 없음.
      skipped.push({ nodeId, reason: "no_promotable_act" });
      continue;
    }
    const step = what[actIndex] as Record<string, unknown>;
    const args = isRecord(step.args) ? step.args : {};
    step.args = { ...args, click_selector: plan.selector };
    promotedNodeIds.push(nodeId);
  }

  return { ir: clone, promotedNodeIds, skipped };
}
