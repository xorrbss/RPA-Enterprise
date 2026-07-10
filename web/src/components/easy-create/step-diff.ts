// F2: 말로 고치기 변경 표시 — 이전/새 draft_ir 를 node_id 기준으로 비교한다(설계 §2.2).
//
// 규칙:
// - 양쪽 존재 + JSON 동일 → 무표시 / 상이 → changed / 새쪽에만 → added / 이전에만 → removed.
// - removed 는 카드가 없으므로 개수만 요약한다(카드 목록 위 정직 표기).
// - 플래너가 node_id 를 전부 새로 만들면 added+removed 로 보인다 — 그대로 보여주고,
//   교집합 0(양쪽 비어있지 않음)이면 fullReplacement 로 안내 문장을 띄운다.
//   "변경 없음"을 추정으로 표기하지 않는다(날조 금지, §8-③).
// - 키 순서 차이를 변경으로 오인하지 않도록 키 정렬 직렬화로 비교한다.

export type StepChangeMark = "added" | "changed";

export interface StepDiff {
  readonly marks: ReadonlyMap<string, StepChangeMark>;
  readonly removedCount: number;
  readonly fullReplacement: boolean;
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nodesOf(ir: unknown): Rec {
  return isRec(ir) && isRec(ir.nodes) ? ir.nodes : {};
}

// 결정적 직렬화(키 정렬) — undefined 값은 JSON 관례대로 객체 키에서 제외.
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isRec(v)) {
    const body = Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function diffDraftIr(previous: unknown, next: unknown): StepDiff {
  const prevNodes = nodesOf(previous);
  const nextNodes = nodesOf(next);
  const marks = new Map<string, StepChangeMark>();
  let shared = 0;
  for (const id of Object.keys(nextNodes)) {
    if (!(id in prevNodes)) {
      marks.set(id, "added");
    } else {
      shared += 1;
      if (stableJson(prevNodes[id]) !== stableJson(nextNodes[id])) marks.set(id, "changed");
    }
  }
  const removedCount = Object.keys(prevNodes).filter((id) => !(id in nextNodes)).length;
  const fullReplacement =
    Object.keys(prevNodes).length > 0 && Object.keys(nextNodes).length > 0 && shared === 0;
  return { marks, removedCount, fullReplacement };
}
