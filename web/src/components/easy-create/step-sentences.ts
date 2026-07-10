// IR → 사람 말 단계 문장 렌더 규칙 (쉬운 제작 상세 설계 §5 확정표의 구현, E2).
//
// 원칙:
// - 문장을 만들 수 없는 요소는 종류 라벨 + 원문 폴백(fallback:true)으로 정직하게 표시한다 — 날조 금지.
// - `on` 분기 조건(IREL 원문)은 요약하지 않는다 — detail 로 접어 원문 그대로(조용한 왜곡 금지).
// - 순회는 start→next 주 경로 우선, on 은 priority 최상 target 을 주 경로로 잇는다. loop 는 body 1회 전개.
// - 방문 dedupe + 상한 200(interpreter.graph_max_steps, ops-defaults §interpreter) — 주 경로에 안 잡힌
//   노드는 "기타 경로" 그룹으로 뒤에 나열한다(누락 은폐 금지).

export interface FlowNote {
  readonly kind: "branch" | "loop" | "terminal" | "fallback" | "next";
  readonly label: string;
  readonly detail?: string;
}

import { urlRefLabel } from "../../api/scenario-params";

export interface StepSentence {
  readonly nodeId: string;
  readonly order: number;
  readonly sentence: string;
  readonly detail?: string;
  readonly flow?: FlowNote;
  readonly verify?: readonly string[];
  readonly fallback: boolean;
  readonly offMainPath: boolean;
}

const GRAPH_MAX_STEPS = 200;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// §5 action 문장표 — 필드는 ir.schema.json what[] 실측(instruction/url_ref/schema_ref/args/cmd_ref/assignee_role).
function actionSentence(what: Rec): { sentence: string; detail?: string; fallback: boolean } {
  const action = str(what.action);
  const instruction = str(what.instruction);
  switch (action) {
    case "navigate": {
      // url_ref 는 심볼릭 키(E§12-① 확정) — 알려진 키는 urlRefLabel 로 업무 라벨 해석, 미매핑은 키 원문 폴백.
      const ref = str(what.url_ref);
      return { sentence: "페이지로 이동합니다", detail: ref !== null ? `주소: ${urlRefLabel(ref)}` : undefined, fallback: false };
    }
    case "act":
      return instruction !== null
        ? { sentence: instruction, fallback: false }
        : { sentence: "화면을 조작합니다", fallback: true };
    case "observe":
      return { sentence: instruction !== null ? `화면을 확인합니다 — ${instruction}` : "화면을 확인합니다", fallback: false };
    case "extract": {
      const schema = str(what.schema_ref);
      return {
        sentence: instruction ?? "데이터를 읽습니다",
        detail: schema !== null ? `결과 형식: ${schema}` : undefined,
        fallback: instruction === null,
      };
    }
    case "download":
      return { sentence: "파일을 내려받습니다", detail: argsSummary(what.args), fallback: false };
    case "upload":
      return { sentence: "파일을 올립니다", detail: argsSummary(what.args), fallback: false };
    case "api_call": {
      const method = isRec(what.args) ? str(what.args.method) : null;
      return { sentence: `${method ?? "API"} 요청을 보냅니다`, detail: str(what.url_ref) !== null ? `주소: ${urlRefLabel(String(what.url_ref))}` : undefined, fallback: false };
    }
    case "file":
      return { sentence: "파일을 처리합니다", detail: argsSummary(what.args), fallback: false };
    case "human_task": {
      const role = str(what.assignee_role);
      return { sentence: "사람의 확인을 요청합니다", detail: role !== null ? `담당: ${role}` : undefined, fallback: false };
    }
    case "shell": {
      // 서명 레지스트리 키만 — 명령 본문 렌더 금지(security-contracts).
      const cmd = str(what.cmd_ref);
      return { sentence: "등록된 명령을 실행합니다", detail: cmd !== null ? `명령 키: ${cmd}` : undefined, fallback: false };
    }
    default:
      return { sentence: `${action ?? "알 수 없는 동작"} (원문 확인 필요)`, detail: JSON.stringify(what), fallback: true };
  }
}

function argsSummary(args: unknown): string | undefined {
  if (!isRec(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  return keys
    .slice(0, 3)
    .map((key) => `${key}: ${typeof args[key] === "string" ? String(args[key]) : JSON.stringify(args[key])}`)
    .join(" · ");
}

// §5 verify.criteria 요약 — verify.schema.json 종류 레지스트리 기준.
function verifySummaries(verify: unknown): readonly string[] | undefined {
  if (!isRec(verify) || !Array.isArray(verify.criteria)) return undefined;
  const out: string[] = [];
  for (const c of verify.criteria) {
    if (!isRec(c)) continue;
    const type = str(c.type);
    switch (type) {
      case "url_matches": out.push("확인: 주소"); break;
      case "element_visible": out.push("확인: 화면 요소 표시"); break;
      case "element_absent": out.push("확인: 화면 요소 없음"); break;
      case "text_includes": out.push("확인: 문구"); break;
      case "min_rows": out.push(`확인: 최소 ${typeof c.value === "number" ? c.value : "N"}행`); break;
      case "extract_schema_valid": out.push("확인: 결과 형식"); break;
      case "http_status": out.push("확인: 응답"); break;
      case "value_match": out.push("확인: 값"); break;
      case "receipt_captured": out.push("확인: 접수증"); break;
      case "empty_result_allowed": out.push("확인: 비어 있어도 됨"); break;
      default: out.push(`확인: ${type ?? "원문 확인 필요"}`);
    }
  }
  return out.length > 0 ? out : undefined;
}

const TERMINAL_SENTENCES: Record<string, string> = {
  success: "완료합니다",
  success_empty: "데이터 없이 완료합니다",
  fail_business: "업무 실패로 종료합니다",
  fail_system: "시스템 실패로 종료합니다",
};

// 예약 핸들러 target — 문자열형(@end_no_data 등)과 호출 객체형({handler,input,return_node},
// ir.schema.json §reservedHandlerCall) 모두 같은 문장으로 매칭한다("[object Object]" 렌더 금지, F6).
function reservedTargetLabel(target: unknown): string | null {
  const handler = isRec(target) ? str(target.handler) : typeof target === "string" ? target : null;
  if (handler === "@human_task") return "→ 사람 확인으로";
  if (handler === "@challenge") return "→ 추가 인증 처리로";
  if (handler === "@end_no_data") return "→ 데이터 없으면 종료";
  return null;
}

function flowNote(node: Rec): FlowNote | undefined {
  if (Array.isArray(node.on) && node.on.length > 0) {
    // when(IREL 원문)은 요약 금지 — detail 원문 그대로.
    const detail = node.on
      .filter(isRec)
      .map((branch) => `${String(branch.when ?? "")} → ${reservedTargetLabel(branch.target) ?? String(branch.target ?? "")}`)
      .join("\n");
    return { kind: "branch", label: "조건에 따라 나뉩니다", detail };
  }
  if (isRec(node.loop)) {
    const max = typeof node.loop.max_iterations === "number" ? node.loop.max_iterations : null;
    return { kind: "loop", label: max !== null ? `반복 (최대 ${max}회)` : "반복" };
  }
  if (str(node.terminal) !== null) {
    const terminal = String(node.terminal);
    return { kind: "terminal", label: TERMINAL_SENTENCES[terminal] ?? `종료: ${terminal}` };
  }
  const reservedNext = reservedTargetLabel(node.next);
  if (reservedNext !== null) return { kind: "next", label: reservedNext };
  if (Array.isArray(node.fallback_chain) && node.fallback_chain.length > 0) {
    // fallback_chain 전용 노드(스키마상 유일 flow 키) — 기본 문장 대신 대체 경로 문장(F6, 어휘는 기존 "대체 경로" 계열과 통일).
    return { kind: "fallback", label: `잘 안 되면 대체 경로 ${node.fallback_chain.length}개를 차례로 시도합니다` };
  }
  return undefined;
}

function nodeSentence(nodeId: string, node: Rec, order: number, offMainPath: boolean): StepSentence {
  const what = Array.isArray(node.what) ? node.what.filter(isRec) : [];
  const flow = flowNote(node);
  const verify = verifySummaries(node.verify);
  const hasFallbackChain = Array.isArray(node.fallback_chain) && node.fallback_chain.length > 0;
  if (what.length === 0) {
    // 동작 없는 흐름 노드 — 흐름 설명 자체를 문장으로(원시 "동작 없음(흐름만)" 노출 제거, 감사 P1-7).
    const sentence = flow !== undefined ? flow.label : "다음 단계로 진행합니다";
    return { nodeId, order, sentence, flow, verify, fallback: false, offMainPath };
  }
  const first = actionSentence(what[0] as Rec);
  const rest = what.slice(1).map((w) => actionSentence(w as Rec).sentence);
  return {
    nodeId,
    order,
    sentence: rest.length > 0 ? `${first.sentence} — 이어서 ${rest.join(", ")}` : first.sentence,
    detail: hasFallbackChain
      ? [first.detail, "대체 경로 준비됨"].filter((v): v is string => v !== undefined && v !== null).join(" · ")
      : first.detail,
    flow,
    verify,
    fallback: first.fallback,
    offMainPath,
  };
}

/** 주 경로: start→(on priority 최상 target | loop body 1회 | next) 체인. 미방문 노드는 기타 경로로 뒤에 붙인다. */
export function renderIrSentences(ir: unknown): StepSentence[] {
  if (!isRec(ir) || !isRec(ir.nodes) || str(ir.start) === null) return [];
  const nodes = ir.nodes;
  const visited = new Set<string>();
  const mainOrder: string[] = [];
  let cursor: string | null = String(ir.start);
  while (cursor !== null && !visited.has(cursor) && mainOrder.length < GRAPH_MAX_STEPS) {
    const node = nodes[cursor];
    if (!isRec(node)) break;
    visited.add(cursor);
    mainOrder.push(cursor);
    cursor = nextMainTarget(node, nodes);
  }
  const others = Object.keys(nodes).filter((id) => !visited.has(id)).slice(0, GRAPH_MAX_STEPS - mainOrder.length);
  const sentences: StepSentence[] = [];
  mainOrder.forEach((id, index) => sentences.push(nodeSentence(id, nodes[id] as Rec, index + 1, false)));
  others.forEach((id, index) => {
    const node = nodes[id];
    if (isRec(node)) sentences.push(nodeSentence(id, node, mainOrder.length + index + 1, true));
  });
  return sentences;
}

function nextMainTarget(node: Rec, nodes: Rec): string | null {
  if (Array.isArray(node.on) && node.on.length > 0) {
    const branches = node.on.filter(isRec);
    let best: Rec | null = null;
    for (const branch of branches) {
      const priority = typeof branch.priority === "number" ? branch.priority : Number.POSITIVE_INFINITY;
      const bestPriority = best !== null && typeof best.priority === "number" ? best.priority : Number.POSITIVE_INFINITY;
      if (best === null || priority < bestPriority) best = branch;
    }
    const target = best !== null ? str(best.target) : null;
    return target !== null && isRec(nodes[target]) ? target : null;
  }
  if (isRec(node.loop)) {
    const body = str(node.loop.body_target);
    return body !== null && isRec(nodes[body]) ? body : null;
  }
  const next = str(node.next);
  return next !== null && isRec(nodes[next]) ? next : null;
}
