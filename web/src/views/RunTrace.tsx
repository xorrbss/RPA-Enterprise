import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { DashboardEnvironmentState, environmentErrorKind, type DashboardEnvironmentError } from "../components/DashboardEnvironmentState";
import { ActionButton } from "../components/ActionButton";
import { ArtifactLookup } from "../components/ArtifactLookup";
import { FilterSelect } from "../components/FilterSelect";
import { RunModeBadge, StatusBadge, statusLabel, errorCodeLabel, runModeLabel } from "../components/badges";
import { RUN_STATES } from "./filters";
import { mergeParams, useHashIdParam, useHashParam } from "../router";
import { formatDateTime } from "../util/time";
import type { RunItem, RunMode, RunPriority, ScenarioGenerationResult } from "../api/types";
import { POLL_MS, TERMINAL, runDetailRefetchInterval } from "./runtrace/constants";
import { RunDetailPanel } from "./runtrace/RunDetailPanel";

export { runDetailRefetchInterval } from "./runtrace/constants";

const RUN_MODE_OPTIONS: readonly RunMode[] = ["prod", "test"];

export function RunTraceView(): JSX.Element {
  const api = useApiClient();
  // 딥링크 시드 — `#runTrace?status=<RunState>`(대시보드 카드)·`#runTrace?scenario=<id>`(MyWork '실행 기록 보기')로
  // 진입 시 필터를 시드 → 진입점의 모집단과 목록이 일치.
  const statusParam = useHashParam("status");
  const scenarioParam = useHashIdParam("scenario");
  const runModeParam = useHashParam("run_mode");
  const statusFilter =
    statusParam !== null &&
    (RUN_STATES as readonly string[]).includes(statusParam)
      ? statusParam
      : undefined;
  const scenarioFilter = scenarioParam ?? undefined;
  const runModeFilter = isRunMode(runModeParam) ? runModeParam : undefined;
  const initialFilter = buildRunFilter(statusFilter, scenarioFilter, runModeFilter);
  const lv = useListView<RunItem>(["runs"], (p) => api.listRuns(p), {
    refetchInterval: POLL_MS,
    initialFilter,
  });
  // 자동화 필터 옵션 — 이름으로 고르게 한다(식별성). 첫 페이지(50)만: 그 밖의 자동화는 딥링크로 여전히 필터 가능.
  const scenariosForFilter = useQuery({
    queryKey: ["scenarios-for-run-filter"],
    queryFn: () => api.listScenarios({ limit: 50 }),
  });
  const scenarioNameById = new Map(
    (scenariosForFilter.data?.items ?? []).map((s) => [s.scenario_id, s.name]),
  );
  const scenarioOptions = [...scenarioNameById.keys()];
  if (scenarioFilter !== undefined && !scenarioNameById.has(scenarioFilter)) {
    scenarioOptions.push(scenarioFilter);
  }
  const currentStatusFilter =
    typeof lv.filter.status === "string" ? lv.filter.status : undefined;
  const currentScenarioFilter =
    typeof lv.filter.scenario_id === "string" ? lv.filter.scenario_id : undefined;
  const currentRunModeFilter =
    isRunMode(lv.filter.run_mode) ? lv.filter.run_mode : undefined;
  useEffect(() => {
    if (statusFilter === currentStatusFilter && scenarioFilter === currentScenarioFilter && runModeFilter === currentRunModeFilter) return;
    lv.setFilter(buildRunFilter(statusFilter, scenarioFilter, runModeFilter) ?? {});
  }, [currentStatusFilter, statusFilter, currentScenarioFilter, scenarioFilter, currentRunModeFilter, runModeFilter]);
  const changeStatusFilter = (value: string | undefined): void => {
    lv.setFilter(buildRunFilter(value, currentScenarioFilter, currentRunModeFilter) ?? {});
    mergeParams({ status: value ?? null });
  };
  const changeScenarioFilter = (value: string | undefined): void => {
    lv.setFilter(buildRunFilter(currentStatusFilter, value, currentRunModeFilter) ?? {});
    mergeParams({ scenario: value ?? null });
  };
  const changeRunModeFilter = (value: string | undefined): void => {
    const next = isRunMode(value) ? value : undefined;
    lv.setFilter(buildRunFilter(currentStatusFilter, currentScenarioFilter, next) ?? {});
    mergeParams({ run_mode: next ?? null });
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
  const pageErrors: DashboardEnvironmentError[] = [];
  if (lv.query.isError) pageErrors.push({ label: "실행 기록", error: lv.query.error, onRetry: () => void lv.query.refetch() });
  if (scenariosForFilter.isError) pageErrors.push({ label: "자동화 필터", error: scenariosForFilter.error, onRetry: () => void scenariosForFilter.refetch() });
  const pageErrorKind = environmentErrorKind(pageErrors);

  return (
    <div>
      <DashboardEnvironmentState errors={pageErrors} />
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
        collapsedErrorKind={pageErrorKind}
        actions={
          <>
            <FilterSelect
              label="자동화"
              value={currentScenarioFilter}
              options={scenarioOptions}
              labelFor={(id) => scenarioNameById.get(id) ?? id.slice(0, 8)}
              onChange={changeScenarioFilter}
            />
            <FilterSelect
              label="상태"
              value={lv.filter.status}
              options={RUN_STATES}
              labelFor={statusLabel}
              onChange={changeStatusFilter}
            />
            <FilterSelect
              label="실행 구분"
              value={currentRunModeFilter}
              options={RUN_MODE_OPTIONS}
              labelFor={runModeLabel}
              onChange={changeRunModeFilter}
            />
          </>
        }
        rowKey={(r) => r.run_id}
        emptyMessage="조건에 맞는 실행 기록이 없습니다."
        columns={[
          {
            // 식별은 업무 언어(자동화 이름)로 — 원시 추적 번호는 운영자 표면에 노출하지 않는 기존 정책 유지
            // (툴팁·상세 분석에서만). 같은 자동화의 실행끼리는 기준 시각 열로 구분한다.
            header: "자동화",
            render: (r) => (
              <span title={`실행 추적 번호: ${r.run_id}`}>
                {r.scenario_name !== undefined ? (
                  <strong>{r.scenario_name}</strong>
                ) : (
                  <span className="subtle">자동화 확인 필요</span>
                )}
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
          {
            header: "구분",
            render: (r) => <RunModeBadge runMode={r.run_mode} />,
          },
          { header: "기준 시각", render: (r) => formatDateTime(r.as_of) },
          { header: "우선순위", render: (r) => <RunPriorityControl run={r} /> },
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
                {isFailedRunStatus(r.status) && (
                  <>
                    <ActionButton
                      label="같은 입력 재실행"
                      action="run.rerun"
                      confirmText="선택한 실패 실행을 같은 입력으로 다시 실행할까요?"
                      successText="재실행을 대기열에 등록했습니다."
                      run={(key) => api.rerunRun(r.run_id, { mode: "same_input" }, key)}
                      invalidateKeys={[["runs"]]}
                    />
                    <ActionButton
                      label="수정 입력 재실행"
                      action="run.rerun"
                      confirmText="수정한 입력으로 실패 실행을 다시 실행할까요?"
                      inputLabel="수정 입력(JSON object)"
                      successText="수정 입력 재실행을 대기열에 등록했습니다."
                      run={(key, input) =>
                        api.rerunRun(
                          r.run_id,
                          {
                            mode: "edited_input",
                            params: parseEditedRerunParams(input),
                            reason: "operator edited input",
                          },
                          key,
                        )
                      }
                      invalidateKeys={[["runs"]]}
                    />
                  </>
                )}
                {r.status === "running" && (
                  <ActionButton
                    label="일시정지"
                    action="run.pause"
                    confirmText="선택한 실행을 다음 안전 지점에서 일시정지할까요?"
                    successText="실행 일시정지를 요청했습니다."
                    run={(key) => api.pauseRun(r.run_id, key, "operator pause from RunTrace")}
                    invalidateKeys={[["runs"]]}
                  />
                )}
                {isResumableRunStatus(r.status) && (
                  <ActionButton
                    label={r.status === "resume_requested" ? "재개 재시도" : "재개"}
                    action="run.resume"
                    confirmText={
                      r.status === "resume_requested"
                        ? "선택한 실행의 재개 작업을 다시 큐에 넣을까요?"
                        : "선택한 중단 실행을 재개할까요? 미해결 사람 확인 작업이 있으면 서버에서 거부됩니다."
                    }
                    successText="실행 재개를 요청했습니다."
                    run={(key) => api.resumeRun(r.run_id, key, "operator resume from RunTrace")}
                    invalidateKeys={[["runs"]]}
                  />
                )}
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

function RunPriorityControl(props: { readonly run: RunItem }): JSX.Element {
  const api = useApiClient();
  const current = props.run.priority ?? "medium";
  const [priority, setPriority] = useState<RunPriority>(current);

  useEffect(() => {
    setPriority(current);
  }, [current, props.run.run_id]);

  if (props.run.status !== "queued") {
    return <span className="badge blue">{priorityLabel(current)}</span>;
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select
        aria-label="실행 우선순위"
        value={priority}
        onChange={(event) => setPriority(event.target.value as RunPriority)}
      >
        <option value="low">낮음</option>
        <option value="medium">보통</option>
        <option value="high">높음</option>
        <option value="critical">긴급</option>
      </select>
      <ActionButton
        label="변경"
        action="run.prioritize"
        confirmText={`선택한 실행의 우선순위를 ${priorityLabel(priority)}(으)로 변경할까요?`}
        successText="실행 우선순위를 변경했습니다."
        run={(key) =>
          api.prioritizeRun(
            props.run.run_id,
            { priority, reason: "operator priority change" },
            key,
          )
        }
        invalidateKeys={[["runs"]]}
      />
    </span>
  );
}

function buildRunFilter(
  status: string | undefined,
  scenarioId: string | undefined,
  runMode: RunMode | undefined,
): Record<string, string> | undefined {
  const filter: Record<string, string> = {};
  if (status !== undefined) filter.status = status;
  if (scenarioId !== undefined) filter.scenario_id = scenarioId;
  if (runMode !== undefined) filter.run_mode = runMode;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function isRunMode(value: unknown): value is RunMode {
  return value === "prod" || value === "test";
}

function priorityLabel(priority: RunPriority): string {
  if (priority === "low") return "낮음";
  if (priority === "high") return "높음";
  if (priority === "critical") return "긴급";
  return "보통";
}

function isFailedRunStatus(status: string): boolean {
  return status === "failed_business" || status === "failed_system";
}

function isResumableRunStatus(status: string): boolean {
  return status === "suspended" || status === "resume_requested";
}

function parseEditedRerunParams(input: string | undefined): Record<string, unknown> {
  if (input === undefined || input.trim() === "") {
    throw new Error("수정 입력 JSON을 입력하세요.");
  }
  const parsed = JSON.parse(input) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("수정 입력은 JSON object여야 합니다.");
  }
  return parsed as Record<string, unknown>;
}
