import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { navigate } from "../router";
import type { ScenarioItem } from "../api/types";

// 테스트 실행(playground) — 저장된 자동화의 실행 계획(IR → 단계·흐름)을 정적으로 미리본 뒤, 그대로 실제 실행을
// 시작할 수 있다(RunScenarioButton = createRun, run.create 게이팅). 실제 브라우저 작업은 worker/Chrome가
// 연결된 환경에서 수행되고(architecture §9 D3), 진행 상황은 '실행 기록' 뷰에서 확인한다.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ACTION_LABEL: Record<string, string> = {
  observe: "관찰",
  act: "조작",
  extract: "추출",
  navigate: "이동",
  download: "다운로드",
  upload: "업로드",
  api_call: "API 호출",
  file: "파일",
  human_task: "사람 확인",
  shell: "셸",
};
const TERMINAL_LABEL: Record<string, string> = {
  success: "성공",
  success_empty: "성공(데이터 없음)",
  fail_business: "업무 실패",
  fail_system: "시스템 실패",
};

function actionText(a: unknown): string {
  if (!isRecord(a)) return "?";
  const name = typeof a.action === "string" ? a.action : "?";
  const label = ACTION_LABEL[name] ?? name;
  const ref = a.schema_ref ?? a.url_ref ?? a.cmd_ref;
  return typeof ref === "string" ? `${label}(${ref})` : label;
}

function flowText(node: Record<string, unknown>): string {
  if (typeof node.terminal === "string") return `종료: ${TERMINAL_LABEL[node.terminal] ?? node.terminal}`;
  if (typeof node.next === "string") return `다음 → ${node.next}`;
  if (Array.isArray(node.on)) {
    const rules = node.on.map((r) => (isRecord(r) ? `${String(r.when)} → ${String(r.target)}` : "?")).join(" · ");
    return `조건 분기: ${rules}`;
  }
  if (isRecord(node.loop)) return `반복: 본문 ${String(node.loop.body_target)} · 탈출 ${String(node.loop.exit_target)}`;
  if (node.fallback_chain !== undefined) return "폴백 체인";
  return "—";
}

// start부터 도달 순서로, 미도달 노드는 뒤에 붙인다.
function orderedNodeIds(start: string, nodes: Record<string, unknown>): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !isRecord(nodes[id])) return;
    seen.add(id);
    order.push(id);
    const n = nodes[id] as Record<string, unknown>;
    if (typeof n.next === "string") visit(n.next);
    if (Array.isArray(n.on)) for (const r of n.on) if (isRecord(r) && typeof r.target === "string") visit(r.target);
    if (isRecord(n.loop)) {
      if (typeof n.loop.body_target === "string") visit(n.loop.body_target);
      if (typeof n.loop.exit_target === "string") visit(n.loop.exit_target);
    }
  };
  visit(start);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) order.push(id);
  return order;
}

function Plan({ ir }: { ir: unknown }): JSX.Element {
  if (!isRecord(ir) || !isRecord(ir.nodes) || typeof ir.start !== "string") {
    return <EmptyState message="실행 계획을 표시할 IR이 없습니다." />;
  }
  const nodes = ir.nodes;
  const order = orderedNodeIds(ir.start, nodes);
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {order.map((id, i) => {
        const node = isRecord(nodes[id]) ? (nodes[id] as Record<string, unknown>) : {};
        const what = Array.isArray(node.what) ? node.what : [];
        return (
          <li key={id} className="panel" style={{ padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ minWidth: 64 }}>
              {i + 1}. {id === ir.start ? `${id}★` : id}
            </strong>
            <span>{what.length > 0 ? what.map(actionText).join(", ") : <span className="subtle">동작 없음(흐름만)</span>}</span>
            <span className="badge" style={{ marginLeft: "auto" }}>
              {flowText(node)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function PlaygroundView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const list = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 10_000 });
  const [sel, setSel] = useState<string>("");
  const detail = useQuery({ queryKey: ["scenario-detail", sel], queryFn: () => api.getScenario(sel), enabled: sel !== "" });

  const items: readonly ScenarioItem[] = list.data?.items ?? [];
  const selected = items.find((s) => s.scenario_id === sel);

  return (
    <div>
      <p className="badge" style={{ display: "block", marginBottom: 12, whiteSpace: "normal" }}>
        실행 계획(단계·흐름)을 미리 본 뒤 그대로 실제 실행을 시작할 수 있습니다. 실제 브라우저 작업은 worker/Chrome가 연결된 환경에서 수행되며, 진행 상황은 ‘실행 기록’에서 확인합니다.
      </p>
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState message="시나리오 목록을 불러오지 못했습니다." onRetry={() => void list.refetch()} />
      ) : (
        <>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span className="subtle">자동화 선택</span>
            <br />
            <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ padding: "6px 8px", fontSize: 14, minWidth: 280 }}>
              <option value="">— 자동화를 선택하세요 —</option>
              {items.map((s) => (
                <option key={s.scenario_id} value={s.scenario_id}>
                  {s.name} (v{s.version})
                </option>
              ))}
            </select>
          </label>
          {sel === "" ? (
            <EmptyState message="자동화를 선택하면 실행 계획이 표시됩니다." />
          ) : (
            <>
              {selected !== undefined && (
                <div style={{ position: "relative", display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  {can("run.create") && <RunScenarioButton scenario={selected} />}
                  <button className="btn" type="button" onClick={() => navigate("runTrace")}>실행 기록 보기</button>
                  {can("run.create") && <span className="subtle">실행 시작 시 실제 run이 등록되고 그 실행의 진행 화면으로 바로 이동합니다.</span>}
                </div>
              )}
              {detail.isLoading ? (
                <Loading />
              ) : detail.isError ? (
                <ErrorState message="시나리오를 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
              ) : (
                <Plan ir={detail.data?.ir} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
