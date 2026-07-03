import type { AutomationIdeaItem, AutomationIdeaStage } from "../../api/types";
import { ErrorState } from "../../components/states";
import { SOURCE_LABEL, STAGES, STAGE_LABEL, stageTone } from "./labels";

export function CandidateFiltersPanel({
  ownerFilter,
  departmentFilter,
  onOwnerFilter,
  onDepartmentFilter,
  onResetFilters,
  loadedIdeaCountLabel,
  rankedIdeas,
  setSelectedId,
}: {
  ownerFilter: string;
  departmentFilter: string;
  onOwnerFilter: (value: string) => void;
  onDepartmentFilter: (value: string) => void;
  onResetFilters: () => void;
  loadedIdeaCountLabel: string;
  rankedIdeas: readonly AutomationIdeaItem[];
  setSelectedId: (value: string) => void;
}): JSX.Element {
  return (
    <section className="panel coe-filters" aria-label="자동화 후보 필터와 우선순위">
      <div className="panel-head">
        <h2>후보 선별</h2>
        <span className="badge muted">현재 필터 {loadedIdeaCountLabel}건</span>
      </div>
      <div className="form-grid coe-filter-grid">
        <label className="field">
          <span>업무 담당자</span>
          <input
            value={ownerFilter}
            onChange={(event) => onOwnerFilter(event.target.value)}
            placeholder="예: 재무운영팀"
            aria-label="업무 담당자 필터"
          />
        </label>
        <label className="field">
          <span>부서</span>
          <input
            value={departmentFilter}
            onChange={(event) => onDepartmentFilter(event.target.value)}
            placeholder="예: 재무"
            aria-label="부서 필터"
          />
        </label>
        <div className="inline-actions coe-filter-actions">
          <button className="btn" type="button" onClick={onResetFilters}>
            필터 초기화
          </button>
        </div>
      </div>
      <div className="coe-priority-list" aria-label="우선 자동화 후보">
        <strong>우선 자동화 후보</strong>
        {rankedIdeas.length === 0 ? (
          <p className="subtle">현재 필터에 맞는 후보가 없습니다.</p>
        ) : (
          rankedIdeas.map((idea, index) => (
            <button key={idea.idea_id} className="coe-priority-item" type="button" onClick={() => setSelectedId(idea.idea_id)}>
              <span className="badge blue">#{index + 1}</span>
              <span>
                <strong>{idea.title}</strong>
                <small>{idea.department} · {idea.business_owner} · {SOURCE_LABEL[idea.source]}</small>
              </span>
              <span className="mono">{idea.score}</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

export function IdeaListPanel({
  stageFilter,
  onStageFilter,
  isError,
  onRetry,
  ideaPageLoading,
  ideaItems,
  selectedIdeaId,
  setSelectedId,
  nextIdeaCursor,
  setIdeaCursor,
  ideaPageFetchingMore,
}: {
  stageFilter: "all" | AutomationIdeaStage;
  onStageFilter: (value: "all" | AutomationIdeaStage) => void;
  isError: boolean;
  onRetry: () => void;
  ideaPageLoading: boolean;
  ideaItems: readonly AutomationIdeaItem[];
  selectedIdeaId: string | null;
  setSelectedId: (value: string) => void;
  nextIdeaCursor: string | null;
  setIdeaCursor: (value: string) => void;
  ideaPageFetchingMore: boolean;
}): JSX.Element {
  const hasMoreIdeas = nextIdeaCursor !== null;
  return (
    <section className="panel" aria-label="자동화 후보 목록">
      <div className="panel-head">
        <h2>후보 목록</h2>
        <select value={stageFilter} onChange={(event) => onStageFilter(event.target.value as "all" | AutomationIdeaStage)} aria-label="승인 단계 필터">
          <option value="all">전체</option>
          {STAGES.map((stage) => <option key={stage} value={stage}>{STAGE_LABEL[stage]}</option>)}
        </select>
      </div>
      {isError ? (
        <ErrorState message="자동화 후보 목록을 불러오지 못했습니다." onRetry={onRetry} />
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">업무</th>
                <th scope="col">승인 단계</th>
                <th scope="col">우선순위 점수</th>
                <th scope="col">선택</th>
              </tr>
            </thead>
            <tbody>
              {ideaPageLoading ? (
                <tr><td colSpan={4}>불러오는 중입니다.</td></tr>
              ) : ideaItems.length === 0 ? (
                <tr><td colSpan={4}>등록된 자동화 후보가 없습니다.</td></tr>
              ) : (
                ideaItems.map((idea) => (
                  <tr key={idea.idea_id} className={idea.idea_id === selectedIdeaId ? "selected-row" : undefined}>
                    <th scope="row">
                      <span>{idea.title}</span>
                      <span className="subtle">{idea.department} · {idea.business_owner} · {SOURCE_LABEL[idea.source]}</span>
                    </th>
                    <td><span className={`badge ${stageTone(idea.stage)}`}>{STAGE_LABEL[idea.stage]}</span></td>
                    <td>{idea.score}</td>
                    <td><button className="linklike" type="button" onClick={() => setSelectedId(idea.idea_id)}>보기</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {hasMoreIdeas && (
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  if (nextIdeaCursor !== null) setIdeaCursor(nextIdeaCursor);
                }}
                disabled={ideaPageFetchingMore}
              >
                {ideaPageFetchingMore ? "불러오는 중" : "더 보기"}
              </button>
              <span className="subtle">KPI와 우선순위는 현재까지 불러온 후보 기준입니다.</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
