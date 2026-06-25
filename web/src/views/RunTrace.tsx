import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { ArtifactLookup } from "../components/ArtifactLookup";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge, statusLabel, errorCodeLabel } from "../components/badges";
import { RUN_STATES } from "./filters";
import { mergeParams, useHashIdParam, useHashParam } from "../router";
import type { RunItem, ScenarioGenerationResult } from "../api/types";
import { POLL_MS, TERMINAL, runDetailRefetchInterval } from "./runtrace/constants";
import { RunDetailPanel } from "./runtrace/RunDetailPanel";

export { runDetailRefetchInterval } from "./runtrace/constants";

export function RunTraceView(): JSX.Element {
  const api = useApiClient();
  // 딥링크 `#runTrace?status=<RunState>`(예: 대시보드 '실행 중' 카드)로 진입 시 상태 필터를 시드 → 카운트와 목록 모집단 일치.
  const statusParam = useHashParam("status");
  const statusFilter =
    statusParam !== null &&
    (RUN_STATES as readonly string[]).includes(statusParam)
      ? statusParam
      : undefined;
  const initialFilter =
    statusFilter !== undefined ? { status: statusFilter } : undefined;
  const lv = useListView<RunItem>(["runs"], (p) => api.listRuns(p), {
    refetchInterval: POLL_MS,
    initialFilter,
  });
  const currentStatusFilter =
    typeof lv.filter.status === "string" ? lv.filter.status : undefined;
  useEffect(() => {
    if (statusFilter === currentStatusFilter) return;
    lv.setFilter(statusFilter === undefined ? {} : { status: statusFilter });
  }, [currentStatusFilter, statusFilter]);
  const changeStatusFilter = (value: string | undefined): void => {
    lv.setFilter(value === undefined ? {} : { status: value });
    mergeParams({ status: value ?? null });
  };
  // 선택 run을 해시(`#runTrace?run=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(useState 휘발 대체).
  const sel = useHashIdParam("run");
  const focusParam = useHashParam("focus");
  const generationParam = useHashIdParam("generation");
  const focusArtifacts = focusParam === "artifacts";
  const detail = useQuery({
    queryKey: ["run-detail", sel],
    queryFn: () => api.getRun(sel as string),
    enabled: sel !== null,
    refetchInterval: (q) => runDetailRefetchInterval(q.state.data?.status),
  });
  const generation = useQuery<ScenarioGenerationResult | null>({
    queryKey: ["scenario-generation-for-run", sel, generationParam],
    queryFn: async () => {
      if (generationParam !== null)
        return api.getScenarioGeneration(generationParam);
      if (sel === null) return null;
      const linked = await api.listScenarioGenerations({
        run_id: sel,
        limit: 1,
      });
      return linked.items.find((item) => item.run_id === sel) ?? null;
    },
    enabled: sel !== null,
  });

  return (
    <div>
      <ArtifactLookup consumeHashParam={sel === null || !focusArtifacts} />
      {sel !== null && (
        <RunDetailPanel
          runId={sel}
          detail={detail}
          generation={generation}
          focusArtifacts={focusArtifacts}
          onClose={() => {
            mergeParams({
              run: null,
              artifact: null,
              focus: null,
              generation: null,
              step: null,
              attempt: null,
            });
          }}
        />
      )}
      <QueryPanel<RunItem>
        title="실행 기록"
        query={lv.query}
        pager={lv.pager}
        actions={
          <FilterSelect
            label="상태"
            value={lv.filter.status}
            options={RUN_STATES}
            labelFor={statusLabel}
            onChange={changeStatusFilter}
          />
        }
        rowKey={(r) => r.run_id}
        emptyMessage="조건에 맞는 실행 기록이 없습니다."
        columns={[
          {
            header: "실행 추적",
            render: (r) => (
              <span className="subtle" title={`실행 추적 번호: ${r.run_id}`}>
                추적 번호 확인 가능
              </span>
            ),
          },
          {
            header: "상태",
            render: (r) => (
              <span
                style={{
                  display: "inline-flex",
                  gap: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <StatusBadge status={r.status} />
                {r.failure_reason !== null &&
                  r.failure_reason !== undefined && (
                    <span className="badge red">
                      {errorCodeLabel(r.failure_reason.code)}
                    </span>
                  )}
              </span>
            ),
          },
          { header: "기준 시각", render: (r) => r.as_of ?? "—" },
          {
            header: "작업",
            render: (r) => (
              <span
                style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
              >
                <button
                  className="btn"
                  type="button"
                  aria-label="실행 추적 상세 보기"
                  title={`실행 추적 번호: ${r.run_id}`}
                  onClick={() => {
                    mergeParams({
                      run: r.run_id,
                      artifact: null,
                      generation: null,
                      step: null,
                      attempt: null,
                    });
                  }}
                >
                  상세 보기
                </button>
                {!TERMINAL.has(r.status) && (
                  <ActionButton
                    label="취소"
                    action="run.abort"
                    confirmText="선택한 실행을 취소할까요? 취소하면 다시 시작할 수 없습니다."
                    successText="실행이 취소되었습니다."
                    run={(key) => api.abortRun(r.run_id, key)}
                    invalidateKeys={[["runs"]]}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
