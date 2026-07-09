import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { navigate, mergeParams } from "../router";
import { StatusBadge, kindLabel } from "../components/badges";
import { Loading, ErrorState, EmptyState } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { ScenarioItem } from "../api/types";
// E1: 확인 큐 로직은 create/review-queue 공용 훅으로 이관(만들기 홈 스트립과 공유) — R4 은퇴 전까지 이 뷰도 소비.
import { isSimpleGate, taskTitle, useMyReviewQueue } from "./create/review-queue";

export function MyWorkView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();

  const queue = useMyReviewQueue();
  const assignedTasksQuery = queue.assigned;
  const unassignedTasksQuery = queue.unassigned;
  const myTasks = queue.tasks;
  const scenariosQuery = useQuery({
    queryKey: ["my-work", "scenarios"],
    queryFn: () => api.listScenarios({ limit: 8 }),
  });
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
