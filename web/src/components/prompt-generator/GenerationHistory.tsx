import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { navigate } from "../../router";
import { errorLabel } from "../badges";
import type { ScenarioGenerationResult } from "../../api/types";
import { EvidenceStorageChip } from "./shared";
import {
  blockerSummary,
  evidenceReviewActionLabel,
  formatGenerationTime,
  generationStatusLabel,
  generationStatusTone,
  historyActionLabel,
  historyMatchesSearch,
  plannerLabel,
  scenarioNameMap,
} from "./helpers";

// 최근 생성 이력 — 자체 상태(필터·검색·커서 페이지) + 쿼리를 소유하는 응집 단위. 상위는 선택 콜백/선택 ID 만 주입한다.
export function GenerationHistory({
  selectedGenerationId,
  onSelect,
}: {
  selectedGenerationId: string | null;
  onSelect: (item: ScenarioGenerationResult) => void;
}): JSX.Element {
  const api = useApiClient();
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];
  const history = useQuery({
    queryKey: ["scenario-generations", "recent", blockedOnly ? "blocked" : "all", cursor ?? "p0"],
    queryFn: () =>
      api.listScenarioGenerations({
        limit: 8,
        ...(blockedOnly ? { status: "blocked" as const } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    refetchInterval: 15_000,
  });
  const scenariosForHistory = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api.listScenarios({ limit: 50 }),
    refetchInterval: 10_000,
  });
  const scenarioNameById = useMemo(() => scenarioNameMap(scenariosForHistory.data?.items ?? []), [scenariosForHistory.data?.items]);

  const items = history.data?.items ?? [];
  const loading = history.isLoading;
  const error = history.error === null ? null : errorLabel(history.error);
  const hasPrev = cursorStack.length > 0;
  const hasNext = (history.data?.next_cursor ?? null) !== null;
  const filteredItems = items.filter((item) => historyMatchesSearch(item, search, scenarioNameById));

  return (
    <div className="generation-history">
      <div className="generation-history-head">
        <h3>최근 생성 · 다음 액션</h3>
        <div className="segmented small" role="group" aria-label="생성 이력 필터">
          <button className={!blockedOnly ? "active" : ""} type="button" onClick={() => { setBlockedOnly(false); setCursorStack([]); }}>
            전체
          </button>
          <button className={blockedOnly ? "active" : ""} type="button" onClick={() => { setBlockedOnly(true); setCursorStack([]); }}>
            차단
          </button>
        </div>
        <label className="generation-history-search">
          <input
            aria-label="생성 검색"
            value={search}
            onChange={(event) => { setSearch(event.currentTarget.value); setCursorStack([]); }}
            placeholder="이름·상태·AI 모델 검색"
            type="search"
          />
        </label>
        <button className="linklike" type="button" onClick={() => void history.refetch()}>
          새로고침
        </button>
      </div>
      {loading && <p className="muted">불러오는 중</p>}
      {error !== null && <p className="form-alert red">{error}</p>}
      {!loading && items.length === 0 && <p className="muted">최근 생성이 없습니다.</p>}
      {!loading && items.length > 0 && filteredItems.length === 0 && <p className="muted">현재 페이지에서 일치하는 생성이 없습니다.</p>}
      {filteredItems.length > 0 && (
        <div className="generation-history-list">
          {filteredItems.map((item) => {
            const diagnostic = blockerSummary(item.blockers);
            const isSelected = item.generation_id === selectedGenerationId;
            const runId = item.run_id;
            const scenarioName = item.scenario_id === null ? undefined : scenarioNameById.get(item.scenario_id);
            return (
              <div className="generation-history-row" key={item.generation_id} aria-current={isSelected ? "true" : undefined}>
                <span className={`badge ${generationStatusTone(item.status)}`}>{generationStatusLabel(item.status)}</span>
                {scenarioName !== undefined ? (
                  <span className="subtle">자동화: {scenarioName}</span>
                ) : (
                  <span className="subtle">요청 내용 보호됨</span>
                )}
                <span className="subtle">{formatGenerationTime(item.created_at)}</span>
                <span className="subtle">{plannerLabel(item.planner)}</span>
                {item.model !== undefined && item.model !== null && <span className="subtle">{item.model}</span>}
                {diagnostic !== null && (
                  <span className="subtle">검토 필요 사유: {diagnostic}</span>
                )}
                {item.status === "saved" && item.run_id === null && <span className="subtle">실행 연결 없음</span>}
                {runId !== null && <EvidenceStorageChip policy={item.evidence_policy} />}
                <span className="subtle">다음</span>
                {runId !== null ? (
                  <button className="linklike" type="button" onClick={() => navigate("runTrace", { run: runId, generation: item.generation_id, focus: "artifacts" })}>
                    {evidenceReviewActionLabel(item.evidence_policy)}
                  </button>
                ) : (
                  <button className="linklike" type="button" onClick={() => onSelect(item)}>
                    {historyActionLabel(item)}
                  </button>
                )}
                {item.status === "saved" && item.run_id === null && item.scenario_id !== null && (
                  <>
                    <button className="linklike" type="button" onClick={() => navigate("automationOps", { scenario: item.scenario_id! })}>
                      운영 예약
                    </button>
                    <button className="linklike" type="button" onClick={() => navigate("coePipeline", { scenario: item.scenario_id! })}>
                      CoE 연결
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(hasPrev || hasNext) && (
        <div className="generation-history-pager">
          <button className="btn" type="button" onClick={() => setCursorStack((stack) => stack.slice(0, -1))} disabled={!hasPrev}>
            이전
          </button>
          <span className="subtle">{cursorStack.length + 1} 페이지</span>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const nextCursor = history.data?.next_cursor ?? null;
              if (nextCursor !== null) setCursorStack((stack) => [...stack, nextCursor]);
            }}
            disabled={!hasNext}
          >
            다음
          </button>
        </div>
      )}
    </div>
  );
}
