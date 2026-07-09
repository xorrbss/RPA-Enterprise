import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan, useSubject } from "../api/permissions";
import { navigate, mergeParams } from "../router";
import { StatusBadge, kindLabel } from "../components/badges";
import { Loading, ErrorState, EmptyState } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { HumanTaskItem, ScenarioItem } from "../api/types";
import { isActiveHumanTask } from "./humanTaskFilters";

const POLL_MS = 5_000;

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

// 인터프리터가 이미 순수 continue 신호(보안문자/추가 인증)와 구조화 검토를 가른다 — 여기선 목록 라벨만 구분.
function isSimpleGate(kind: string): boolean {
  return kind === "captcha" || kind === "mfa";
}

export function MyWorkView(): JSX.Element {
  const api = useApiClient();
  const subject = useSubject();
  const can = useCan();

  // 개입 큐 = 내게 배정된 미종결 사람-확인 업무(내 업무 먼저). sub 부재(미로그인)면 필터 없음.
  const assignedTasksQuery = useQuery({
    queryKey: ["my-work", "human-tasks", subject],
    queryFn: () => subject !== null && subject.length > 0 ? api.listHumanTasks({ assignee: subject, terminal: "false" }) : Promise.resolve({ items: [], next_cursor: null }),
    refetchInterval: POLL_MS,
  });
  const unassignedTasksQuery = useQuery({
    queryKey: ["my-work", "human-tasks", "unassigned"],
    queryFn: () => api.listHumanTasks({ unassigned: true, terminal: "false" }),
    refetchInterval: POLL_MS,
  });
  const scenariosQuery = useQuery({
    queryKey: ["my-work", "scenarios"],
    queryFn: () => api.listScenarios({ limit: 8 }),
  });

  const myTasks = useMemo(
    () => {
      const byId = new Map<string, HumanTaskItem>();
      for (const task of [...(assignedTasksQuery.data?.items ?? []), ...(unassignedTasksQuery.data?.items ?? [])]) {
        if (isActiveHumanTask(task)) byId.set(task.human_task_id, task);
      }
      return [...byId.values()];
    },
    [assignedTasksQuery.data, unassignedTasksQuery.data],
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
          {assignedTasksQuery.isLoading || unassignedTasksQuery.isLoading ? (
            <Loading />
          ) : assignedTasksQuery.isError || unassignedTasksQuery.isError ? (
            <ErrorState message="확인 대기 업무를 불러오지 못했습니다." onRetry={() => { void assignedTasksQuery.refetch(); void unassignedTasksQuery.refetch(); }} />
          ) : myTasks.length === 0 ? (
            <EmptyState message="지금 확인할 일이 없습니다. 자동화 상태는 실행 기록에서 확인하세요." />
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
          {can("scenario.create") && (
            <button className="btn primary" type="button" onClick={() => navigate("create")}>자동화 만들기</button>
          )}
        </div>
        <div className="panel-body">
          <p className="subtle" style={{ marginTop: 0 }}>등록한 자동화는 배경에서 실행되고, 사람이 확인할 일이 생기면 위 목록에 뜹니다.</p>
          {scenariosQuery.isLoading ? (
            <Loading />
          ) : scenariosQuery.isError ? (
            <ErrorState message="자동화 목록을 불러오지 못했습니다." onRetry={() => void scenariosQuery.refetch()} />
          ) : scenarios.length === 0 ? (
            // U1-1: 랜딩이 myWork 라 빈 테넌트 첫 사용자가 사이트→세션→첫 자동화 준비 순서를 볼 곳이 없었다
            // (도입 체크리스트는 대시보드에만 렌더). 첫 사용자를 파일럿 준비 상태로 잇는 진입점을 빈 상태에 연결.
            <EmptyState
              title="첫 자동화 준비"
              message={
                can("scenario.create")
                  ? "아직 만든 자동화가 없습니다. 초안을 만들고, 테스트 실행과 증빙 확인까지 이어가세요."
                  : "아직 만든 자동화가 없습니다. 권한 있는 담당자에게 초안 생성을 요청하거나 파일럿 준비 상태를 확인하세요."
              }
              action={
                <div className="inline-actions" style={{ justifyContent: "center" }}>
                  {can("scenario.create") && (
                    <button className="btn primary" type="button" onClick={() => navigate("create")}>
                      자동화 초안 만들기
                    </button>
                  )}
                  <button className="btn" type="button" onClick={() => navigate("adoptionEvidence")}>
                    파일럿 준비 상태 보기
                  </button>
                  {(can("session.capture") || can("site.create") || can("site.update")) && (
                    <button className="btn" type="button" onClick={() => navigate("security", { section: "sites" })}>
                      사이트/세션 준비
                    </button>
                  )}
                </div>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="my-work-automation-table">
                <thead>
                  <tr><th>자동화</th><th>실행</th><th>실행 기록</th></tr>
                </thead>
                <tbody>
                  {scenarios.map((s: ScenarioItem) => (
                    <tr key={s.scenario_id}>
                      <td data-label="자동화">{s.name}</td>
                      <td data-label="실행"><RunScenarioButton scenario={s} /></td>
                      <td data-label="실행 기록"><button className="linklike" type="button" onClick={() => navigate("runTrace", { scenario: s.scenario_id })}>실행 기록 보기 →</button></td>
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
