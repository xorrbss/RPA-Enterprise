import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useSubject } from "../api/permissions";
import { navigate, mergeParams } from "../router";
import { StatusBadge } from "../components/badges";
import { Loading, ErrorState, EmptyState } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { HumanTaskItem, ScenarioItem } from "../api/types";

const POLL_MS = 5_000;
const TERMINAL = new Set(["resolved", "expired", "cancelled"]);

// 사람 개입 큐 카드의 제목 — payload 의 제목/title 이 있으면 그걸, 없으면 업무 종류로(날조 없이 실 데이터만).
function taskTitle(t: HumanTaskItem): string {
  const p = t.payload;
  if (p !== null && typeof p === "object" && !Array.isArray(p)) {
    const rec = p as Record<string, unknown>;
    for (const k of ["제목", "title", "subject"]) {
      if (typeof rec[k] === "string" && (rec[k] as string).length > 0) return rec[k] as string;
    }
  }
  return kindLabel(t.kind);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "approval": return "승인 요청";
    case "validation": return "문서 검증";
    case "exception": return "예외 확인";
    case "captcha": return "보안문자 입력";
    case "mfa": return "추가 인증";
    default: return "사람 확인";
  }
}

// 인터프리터가 이미 순수 continue 신호(보안문자/추가 인증)와 구조화 검토를 가른다 — 여기선 목록 라벨만 구분.
function isSimpleGate(kind: string): boolean {
  return kind === "captcha" || kind === "mfa";
}

export function MyWorkView(): JSX.Element {
  const api = useApiClient();
  const subject = useSubject();

  // 개입 큐 = 내게 배정된 미종결 사람-확인 업무(내 업무 먼저). sub 부재(미로그인)면 필터 없음.
  const tasksQuery = useQuery({
    queryKey: ["my-work", "human-tasks", subject],
    queryFn: () => api.listHumanTasks(subject !== null && subject.length > 0 ? { assignee: subject } : {}),
    refetchInterval: POLL_MS,
  });
  const scenariosQuery = useQuery({
    queryKey: ["my-work", "scenarios"],
    queryFn: () => api.listScenarios({ limit: 8 }),
  });

  const myTasks = useMemo(
    () => (tasksQuery.data?.items ?? []).filter((t) => !TERMINAL.has(t.state)),
    [tasksQuery.data],
  );
  const scenarios = scenariosQuery.data?.items ?? [];

  return (
    <div className="my-work">
      <section className="panel" aria-label="지금 확인이 필요한 업무" style={{ marginBottom: 16 }}>
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>지금 확인이 필요합니다{myTasks.length > 0 ? ` (${myTasks.length})` : ""}</h2>
          <button className="linklike" type="button" onClick={() => navigate("humanTasks")}>사람 확인 전체 →</button>
        </div>
        <div className="panel-body">
          {tasksQuery.isLoading ? (
            <Loading />
          ) : tasksQuery.isError ? (
            <ErrorState message="확인 대기 업무를 불러오지 못했습니다." onRetry={() => void tasksQuery.refetch()} />
          ) : myTasks.length === 0 ? (
            <EmptyState message="지금 확인할 일이 없습니다. 자동화가 알아서 처리하고 있습니다." />
          ) : (
            <ul className="my-work-queue" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {myTasks.map((t) => (
                <li key={t.human_task_id} className="my-work-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: "1px solid var(--border, #e2e2e2)", borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{taskTitle(t)}</div>
                    <div className="subtle" style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                      <span>{kindLabel(t.kind)}</span>
                      <StatusBadge status={t.state} />
                      {t.assignee !== null ? <span>나에게 배정</span> : <span>미배정</span>}
                    </div>
                  </div>
                  <button className="btn primary" type="button" onClick={() => { navigate("humanTasks"); mergeParams({ ht: t.human_task_id }); }}>
                    {isSimpleGate(t.kind) ? "처리하기" : "검토 열기"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel" aria-label="내 자동화">
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>자동화</h2>
          <button className="btn primary" type="button" onClick={() => navigate("scenarioStudio")}>자동화 만들기</button>
        </div>
        <div className="panel-body">
          <p className="subtle" style={{ marginTop: 0 }}>등록한 자동화는 배경에서 실행되고, 사람이 확인할 일이 생기면 위 목록에 뜹니다.</p>
          {scenariosQuery.isLoading ? (
            <Loading />
          ) : scenariosQuery.isError ? (
            <ErrorState message="자동화 목록을 불러오지 못했습니다." onRetry={() => void scenariosQuery.refetch()} />
          ) : scenarios.length === 0 ? (
            <EmptyState message="아직 만든 자동화가 없습니다. ‘새 자동화 만들기’로 시작하세요." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>자동화</th><th>실행</th><th>실행 기록</th></tr>
                </thead>
                <tbody>
                  {scenarios.map((s: ScenarioItem) => (
                    <tr key={s.scenario_id}>
                      <td>{s.name}</td>
                      <td><RunScenarioButton scenario={s} /></td>
                      <td><button className="linklike" type="button" onClick={() => navigate("runTrace")}>실행 기록 보기 →</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
