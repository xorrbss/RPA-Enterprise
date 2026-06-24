import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { actionLabel, terminalLabel } from "../components/badges";
import { mergeParams, navigate, useHashParam } from "../router";
import type { ScenarioItem } from "../api/types";
import { urlRefLabel } from "../api/scenario-params";

// 테스트 실행(playground) — 저장된 자동화의 실행 계획(IR → 단계·흐름)을 정적으로 미리본 뒤, 그대로 실제 실행을
// 시작할 수 있다(RunScenarioButton = createRun, run.create 게이팅). 실제 브라우저 작업은 worker/Chrome가
// 연결된 환경에서 수행되고(architecture §9 D3), 진행 상황은 '실행 기록' 뷰에서 확인한다.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// IR action verb 라벨은 badges.actionLabel(계약 IRActionType 미러) 단일 출처를 쓴다 — '테스트 실행'(Plan)과
// '실행 기록'(StepTrace)에서 같은 단계가 다른 이름으로 보이던 어휘 드리프트 제거(미매핑은 raw 폴백 동일).
// terminal 라벨도 동일하게 badges.terminalLabel(계약 terminal.enum 미러) 단일 출처를 쓴다(지역 맵 드리프트 제거).

function actionText(a: unknown): string {
  if (!isRecord(a)) return "?";
  const name = typeof a.action === "string" ? a.action : "?";
  const label = actionLabel(name);
  if (typeof a.url_ref === "string") return `${label} · ${urlRefLabel(a.url_ref)}`;
  if (typeof a.schema_ref === "string") return `${label} · 출력 형식 ${a.schema_ref}`;
  if (typeof a.cmd_ref === "string") return `${label} · 관리 명령 ${a.cmd_ref}`;
  return label;
}

function flowText(node: Record<string, unknown>): string {
  if (typeof node.terminal === "string") return `종료: ${terminalLabel(node.terminal)}`;
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
    return <EmptyState message="실행 계획을 표시할 자동화 정의가 없습니다." />;
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
  const scenarioParam = useHashParam("scenario");
  const list = useListView<ScenarioItem>(
    ["scenarios", "playground"],
    (params) => api.listScenarios(params),
    { limit: 50, refetchInterval: 10_000 },
  );
  const [sel, setSel] = useState<string>(() => scenarioParam ?? "");
  const detail = useQuery({ queryKey: ["scenario-detail", sel], queryFn: () => api.getScenario(sel), enabled: sel !== "" });

  const items: readonly ScenarioItem[] = list.query.data?.items ?? [];
  const selected = items.find((s) => s.scenario_id === sel);

  useEffect(() => {
    if (scenarioParam !== null && scenarioParam !== sel) setSel(scenarioParam);
  }, [scenarioParam, sel]);

  function selectScenario(next: string): void {
    setSel(next);
    mergeParams({ scenario: next.length > 0 ? next : null });
  }

  return (
    <div>
      <p className="badge" style={{ display: "block", marginBottom: 12, whiteSpace: "normal" }}>
        실행 계획(단계·흐름)을 미리 본 뒤 그대로 실제 실행을 시작할 수 있습니다. 실제 브라우저 작업은 worker/Chrome가 연결된 환경에서 수행되며, 진행 상황은 ‘실행 기록’에서 확인합니다.
      </p>
      {can("scenario.create") && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <button className="btn primary" type="button" onClick={() => navigate("scenarioStudio", { creator: "ai" })}>
            자연어로 자동화 만들기
          </button>
          <span className="subtle">저장 후 실행까지 이어지는 자동화 생성 화면으로 이동합니다.</span>
        </div>
      )}
      {list.query.isLoading ? (
        <Loading />
      ) : list.query.isError ? (
        <ErrorState message="자동화 목록을 불러오지 못했습니다." onRetry={() => void list.query.refetch()} />
      ) : (
        <>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span className="subtle">자동화 선택</span>
            <br />
            <select value={sel} onChange={(e) => selectScenario(e.target.value)} style={{ padding: "6px 8px", fontSize: 14, minWidth: 280 }}>
              <option value="">— 자동화를 선택하세요 —</option>
              {items.map((s) => (
                <option key={s.scenario_id} value={s.scenario_id}>
                  {s.name} (변경 {s.version})
                </option>
              ))}
            </select>
            <span className="subtle" style={{ display: "block", marginTop: 6 }}>
              현재 {list.pager.pageIndex + 1}페이지 {items.length}
              {(list.query.data?.next_cursor ?? null) !== null ? "+" : ""}건을 표시합니다.
            </span>
          </label>
          {(list.pager.hasPrev || list.pager.hasNext) && (
            <div className="inline-actions" style={{ marginBottom: 12 }}>
              <button className="btn" type="button" onClick={list.pager.onPrev} disabled={!list.pager.hasPrev}>
                이전
              </button>
              <button className="btn" type="button" onClick={list.pager.onNext} disabled={!list.pager.hasNext}>
                다음
              </button>
              <span className="subtle">찾는 자동화가 없으면 다음 페이지를 확인하세요.</span>
            </div>
          )}
          {sel === "" ? (
            <EmptyState message="자동화를 선택하면 실행 계획이 표시됩니다." />
          ) : (
            <>
              {selected !== undefined ? (
                <div style={{ position: "relative", display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  {can("run.create") && <RunScenarioButton scenario={selected} />}
                  <button className="btn" type="button" onClick={() => navigate("runTrace")}>실행 기록 보기</button>
                  {can("run.create") && <span className="subtle">실행 시작 시 실제 실행이 등록되고 진행 화면으로 바로 이동합니다.</span>}
                </div>
              ) : (
                <p className="subtle" role="status" style={{ margin: "0 0 12px" }}>
                  선택한 자동화의 실행 버튼은 현재 목록 페이지에 있을 때 표시됩니다. 계획은 아래에서 확인할 수 있습니다.
                </p>
              )}
              {detail.isLoading ? (
                <Loading />
              ) : detail.isError ? (
                <ErrorState message="자동화 정보를 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
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
