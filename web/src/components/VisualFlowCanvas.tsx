import { useMemo, useState } from "react";

type CanvasNodeKind =
  | "navigate"
  | "act"
  | "extract"
  | "condition"
  | "human_task"
  | "api_call"
  | "terminal"
  | "fallback"
  | "loop"
  | "unknown";

interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly title: string;
  readonly detail: string;
  readonly raw: unknown;
}

interface CanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
}

const KIND_LABELS: Record<CanvasNodeKind, string> = {
  navigate: "Navigate",
  act: "Act",
  extract: "Extract",
  condition: "Condition",
  human_task: "Human Task",
  api_call: "API Call",
  terminal: "End",
  fallback: "Fallback",
  loop: "Loop",
  unknown: "Unknown",
};

const PALETTE: readonly { kind: CanvasNodeKind; label: string; hint: string }[] = [
  { kind: "navigate", label: "Navigate", hint: "웹 페이지 이동" },
  { kind: "act", label: "Act", hint: "클릭, 입력, 선택" },
  { kind: "extract", label: "Extract", hint: "표/텍스트 추출" },
  { kind: "condition", label: "Condition", hint: "조건 분기" },
  { kind: "human_task", label: "Human Task", hint: "승인/검토 대기" },
  { kind: "api_call", label: "API Call", hint: "SecretRef 서버 호출" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function titleFromAction(action: Record<string, unknown>): string {
  const actionType = stringValue(action.action) ?? "unknown";
  if (actionType === "navigate") return `Open ${stringValue(action.url_ref) ?? "page"}`;
  if (actionType === "extract") return stringValue(action.schema_ref) ?? "Extract data";
  if (actionType === "api_call") return stringValue(action.url_ref) ?? "Call API";
  if (actionType === "human_task") return "Human review";
  return stringValue(action.instruction) ?? actionType;
}

function detailFromAction(action: Record<string, unknown>): string {
  const actionType = stringValue(action.action) ?? "unknown";
  if (actionType === "api_call" && isRecord(action.args)) {
    const method = stringValue(action.args.method) ?? "GET";
    const auth = isRecord(action.args.auth) ? stringValue(action.args.auth.type) : undefined;
    return `${method} · ${auth ?? "auth not set"}`;
  }
  if (actionType === "navigate") return stringValue(action.url_ref) ?? "url_ref 필요";
  if (actionType === "extract") return stringValue(action.instruction) ?? "추출 지시문 필요";
  return stringValue(action.instruction) ?? "작업 세부 정보 없음";
}

function nodeKind(id: string, node: Record<string, unknown>): CanvasNodeKind {
  if (node.terminal !== undefined) return "terminal";
  if (node.fallback_chain !== undefined) return "fallback";
  if (node.loop !== undefined) return "loop";
  if (node.on !== undefined) return "condition";
  const firstAction = arrayValue(node.what).find(isRecord);
  const action = firstAction !== undefined ? stringValue(firstAction.action) : undefined;
  if (
    action === "navigate" ||
    action === "act" ||
    action === "extract" ||
    action === "human_task" ||
    action === "api_call"
  ) {
    return action;
  }
  if (isRecord(node.next) && node.next.handler === "@human_task") return "human_task";
  return id === "done" ? "terminal" : "unknown";
}

function nodeTitle(id: string, kind: CanvasNodeKind, node: Record<string, unknown>): string {
  const firstAction = arrayValue(node.what).find(isRecord);
  if (firstAction !== undefined) return titleFromAction(firstAction);
  if (kind === "condition") return "조건 분기";
  if (kind === "human_task") return "사람 검토";
  if (kind === "loop") return "반복";
  if (kind === "fallback") return "대체 경로";
  if (kind === "terminal") return String(node.terminal ?? "종료");
  return id;
}

function nodeDetail(kind: CanvasNodeKind, node: Record<string, unknown>): string {
  const firstAction = arrayValue(node.what).find(isRecord);
  if (firstAction !== undefined) return detailFromAction(firstAction);
  if (kind === "condition") {
    const branches = arrayValue(node.on).length;
    return `${branches}개 분기`;
  }
  if (kind === "loop" && isRecord(node.loop)) {
    return stringValue(node.loop.until) ?? "종료 조건 필요";
  }
  if (kind === "human_task" && isRecord(node.next)) {
    return stringValue(node.next.handler) ?? "예약 핸들러";
  }
  return "세부 정보 없음";
}

function targetLabel(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (isRecord(target)) {
    return stringValue(target.return_node);
  }
  return undefined;
}

function graphFromIr(ir: unknown): { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[]; name: string } {
  if (!isRecord(ir) || !isRecord(ir.nodes)) {
    return { nodes: [], edges: [], name: "Untitled" };
  }
  const name = isRecord(ir.meta) ? stringValue(ir.meta.name) ?? "Untitled" : "Untitled";
  const nodes = Object.entries(ir.nodes)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([id, node]) => {
      const kind = nodeKind(id, node);
      return {
        id,
        kind,
        title: nodeTitle(id, kind, node),
        detail: nodeDetail(kind, node),
        raw: node,
      };
    });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: CanvasEdge[] = [];
  for (const [id, rawNode] of Object.entries(ir.nodes)) {
    if (!isRecord(rawNode)) continue;
    const next = targetLabel(rawNode.next);
    if (next !== undefined && nodeIds.has(next)) {
      edges.push({ id: `${id}->${next}`, source: id, target: next, label: "next" });
    }
    for (const branch of arrayValue(rawNode.on)) {
      if (!isRecord(branch)) continue;
      const target = targetLabel(branch.target);
      if (target !== undefined && nodeIds.has(target)) {
        edges.push({
          id: `${id}->${target}:${String(branch.priority ?? "branch")}`,
          source: id,
          target,
          label: stringValue(branch.when) ?? "branch",
        });
      }
    }
    if (isRecord(rawNode.loop)) {
      for (const [label, target] of [
        ["body", rawNode.loop.body_target],
        ["exit", rawNode.loop.exit_target],
      ] as const) {
        const targetId = targetLabel(target);
        if (targetId !== undefined && nodeIds.has(targetId)) {
          edges.push({ id: `${id}->${targetId}:${label}`, source: id, target: targetId, label });
        }
      }
    }
    for (const tier of arrayValue(rawNode.fallback_chain)) {
      if (!isRecord(tier)) continue;
      const target = targetLabel(tier.entry_node);
      if (target !== undefined && nodeIds.has(target)) {
        edges.push({ id: `${id}->${target}:${String(tier.tier ?? "fallback")}`, source: id, target, label: String(tier.tier ?? "fallback") });
      }
    }
  }
  return { nodes, edges, name };
}

export function VisualFlowCanvas({ ir }: { ir: unknown }): JSX.Element {
  const graph = useMemo(() => graphFromIr(ir), [ir]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes[0];

  return (
    <div className="visual-flow-workspace" aria-label="Studio visual flow canvas">
      <div className="visual-flow-palette" aria-label="지원 노드">
        {PALETTE.map((item) => (
          <span className="visual-flow-palette-item" key={item.kind}>
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </span>
        ))}
      </div>
      <div className="visual-flow-main">
        <div className="visual-flow-toolbar">
          <div>
            <strong>{graph.name}</strong>
            <span className="subtle">Canonical IR preview</span>
          </div>
          <span className="badge blue">{graph.nodes.length} nodes</span>
        </div>
        {graph.nodes.length === 0 ? (
          <p className="empty-state">표시할 Studio 노드가 없습니다. IR을 먼저 작성하거나 Recorder 초안을 생성하세요.</p>
        ) : (
          <div className="visual-flow-canvas">
            {graph.nodes.map((node, index) => (
              <button
                className={`visual-flow-node ${node.kind}${selected?.id === node.id ? " active" : ""}`}
                key={node.id}
                type="button"
                onClick={() => setSelectedId(node.id)}
                style={{ gridColumn: `${(index % 3) + 1}`, gridRow: `${Math.floor(index / 3) + 1}` }}
              >
                <span className="badge muted">{KIND_LABELS[node.kind]}</span>
                <strong>{node.title}</strong>
                <small>{node.detail}</small>
                <code>{node.id}</code>
              </button>
            ))}
          </div>
        )}
        {graph.edges.length > 0 && (
          <ol className="visual-flow-edges" aria-label="흐름 연결">
            {graph.edges.slice(0, 12).map((edge) => (
              <li key={edge.id}>
                <code>{edge.source}</code>
                <span>{edge.label}</span>
                <code>{edge.target}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
      <aside className="visual-flow-properties" aria-label="선택 노드 속성">
        {selected === undefined ? (
          <p className="subtle">노드를 선택하세요.</p>
        ) : (
          <>
            <span className={`badge ${selected.kind === "api_call" || selected.kind === "human_task" ? "amber" : "blue"}`}>
              {KIND_LABELS[selected.kind]}
            </span>
            <h3>{selected.title}</h3>
            <p>{selected.detail}</p>
            <dl>
              <div>
                <dt>ID</dt>
                <dd><code>{selected.id}</code></dd>
              </div>
              <div>
                <dt>상태</dt>
                <dd>
                  {selected.kind === "api_call"
                    ? "SecretRef 서버 호출만 허용"
                    : selected.kind === "human_task"
                      ? "웹 콘솔 HITL로 대기"
                      : "Canonical IR로 컴파일"}
                </dd>
              </div>
            </dl>
            <details className="developer-details">
              <summary>노드 원문 보기</summary>
              <pre>{JSON.stringify(selected.raw, null, 2)}</pre>
            </details>
          </>
        )}
      </aside>
    </div>
  );
}
