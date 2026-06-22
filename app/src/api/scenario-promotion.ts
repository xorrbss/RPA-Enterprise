/**
 * PbD(Programming by Demonstration) 승격 — click-only 결정형화 (③ 슬라이스1, pure transform).
 *
 * 성공 run 의 해소된 ActionPlan(click) 을 시나리오 IR 의 LLM `act` 노드에 결정형 `act.args.click_selector` 로
 * 베이킹한다. 실행기는 click_selector 선언 시 **LLM 을 전혀 경유하지 않고**(셀렉터 환각 차단) 그 셀렉터를
 * settle 후 클릭한다(stagehand-dom-executor). 이로써 item⑤ 승인 게이트 뒤의 비가역 click 을 결정형화해
 * A.2(승인 후 LLM 오대상)를 근원 차단한다.
 *
 * 범위(slice 2c): click → act.args.click_selector, fill → act.args.fill_selector(값 출처 vars/value_ref 보유 노드만 —
 * 실행기 fill_selector 가 값 출처를 요구, slice 2a), **select → act.args.select_selector + select_value**(드롭다운
 * 셀렉터·옵션 둘 다 베이킹, slice 2c). 값 출처 없는 LLM 리터럴 fill 은 셀렉터를 앵커할 값이 없어 미승격 — `skipped`
 * 로 명시 보고한다(조용히 흘리지 않는다, "조용한 false 금지").
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
 * node.what 에서 값 출처(vars[secret] 비빈 배열 또는 args.value_ref 문자열)를 가진 첫 act 의 인덱스 — 결정형 fill 대상.
 * 값 출처가 있어야 fill_selector(결정형 셀렉터)가 채울 값을 앵커할 수 있다(실행기 강제). 없으면 -1.
 */
function firstActWithFillValueSource(what: readonly unknown[]): number {
  return what.findIndex((step) => {
    if (!isRecord(step) || step.action !== "act") return false;
    const hasVars = Array.isArray(step.vars) && step.vars.some((v) => typeof v === "string" && v.length > 0);
    const args = isRecord(step.args) ? step.args : undefined;
    const hasValueRef = args !== undefined && typeof args.value_ref === "string" && args.value_ref.length > 0;
    return hasVars || hasValueRef;
  });
}

/** node.what 에서 기존 select_selector 가 없는 첫 act 의 인덱스(= 결정형 select 베이킹 대상). 없으면 -1. */
function firstPromotableSelectActIndex(what: readonly unknown[]): number {
  return what.findIndex((step) => {
    if (!isRecord(step) || step.action !== "act") return false;
    const args = isRecord(step.args) ? step.args : undefined;
    return args === undefined || typeof args.select_selector !== "string";
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
    const node = nodes[nodeId] as Record<string, unknown>;
    const what = Array.isArray(node.what) ? node.what : undefined;
    if (what === undefined) {
      skipped.push({ nodeId, reason: "node_what_missing" });
      continue;
    }
    if (plan.operation === "click") {
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
    } else if (plan.operation === "fill") {
      // fill 결정형 셀렉터 베이킹(slice 2b): 값 출처(vars[secret] 또는 args.value_ref)를 가진 act 에 fill_selector 를
      //   추가한다 — 값 출처는 보존하고 셀렉터만 결정형화(실행기 fill_selector 는 값 출처가 필수, slice 2a). LLM 이 리터럴
      //   value 로 채운 fill(값 출처 없음)은 fill_selector 가 값을 앵커할 수 없어 승격 불가 — 명시 skip(조용한 false 금지).
      const actIndex = firstActWithFillValueSource(what);
      if (actIndex === -1) {
        skipped.push({ nodeId, reason: "fill_no_value_source" });
        continue;
      }
      const step = what[actIndex] as Record<string, unknown>;
      const args = isRecord(step.args) ? step.args : {};
      if (typeof args.fill_selector === "string") {
        skipped.push({ nodeId, reason: "fill_already_deterministic" });
        continue;
      }
      step.args = { ...args, fill_selector: plan.selector };
      promotedNodeIds.push(nodeId);
    } else if (plan.operation === "select") {
      // select 결정형 승격(slice 2c): 드롭다운 셀렉터+옵션 값 둘 다 act.args(select_selector/select_value)에 베이킹한다.
      //   select 옵션은 보통 고정 선택(데모한 값)이라 fill 의 동적 값과 달리 값 출처 메커니즘이 불필요(plan 이 value 보유).
      //   ⚠ 데이터-의존 select(예: "이번 달")는 고정값 베이킹이 부적절 — 승격은 draft 를 만들고 운영자 검토 게이트가 거른다.
      const actIndex = firstPromotableSelectActIndex(what);
      if (actIndex === -1) {
        skipped.push({ nodeId, reason: "no_promotable_act" });
        continue;
      }
      const step = what[actIndex] as Record<string, unknown>;
      const args = isRecord(step.args) ? step.args : {};
      step.args = { ...args, select_selector: plan.selector, select_value: plan.value };
      promotedNodeIds.push(nodeId);
    } else {
      // ActionPlan union 은 click|fill|select 로 닫혀 있다(exhaustive). 미래 operation 추가 시 컴파일 타임에 여기서 잡힌다.
      const exhaustive: never = plan;
      void exhaustive;
      skipped.push({ nodeId, reason: "unsupported_operation" });
    }
  }

  return { ir: clone, promotedNodeIds, skipped };
}
