import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { mergeParams } from "../../router";
import { SlideOver } from "../../components/SlideOver";
import { StepTrace } from "../../components/StepTrace";
import { GenerationArtifactsPanel } from "../../components/GenerationArtifactsPanel";
import { RunModeBadge, StatusBadge } from "../../components/badges";
import { ErrorState, Loading } from "../../components/states";
import { formatDateTime } from "../../util/time";
import type { RunDetail, ScenarioGenerationResult } from "../../api/types";
import { HUMAN_TASK_TERMINAL, SUSPENDED } from "./constants";
import { PromoteFromRunPanel } from "./PromoteFromRunPanel";
import { RerunControls } from "./RerunControls";
import { RunArtifactsList } from "./RunArtifactsList";
import { TestRunStatusPanel } from "./TestRunStatusPanel";

// 실행 상세 — getRun(RLS 스코프) + run_steps 단계 트레이스(GET /v1/runs/{id}/steps, api-surface §1).
export function RunDetailPanel({
  runId,
  detail,
  generation,
  focusArtifacts,
  onClose,
}: {
  runId: string;
  detail: UseQueryResult<RunDetail>;
  generation: UseQueryResult<ScenarioGenerationResult | null>;
  focusArtifacts: boolean;
  onClose: () => void;
}): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const humanTask = useQuery({
    queryKey: ["human-task-by-run", runId],
    queryFn: () => api.listHumanTasks({ run_id: runId, terminal: "false", limit: 10 }),
    enabled: detail.data !== undefined && SUSPENDED.has(detail.data.status),
  });
  const pendingTask = humanTask.data?.items.find(
    (task) => !HUMAN_TASK_TERMINAL.has(task.state),
  );
  const linkedGenerationId =
    generation.data?.run_id === runId ? generation.data.generation_id : null;
  const scenarioId =
    detail.data?.scenario_id ??
    (generation.data?.run_id === runId ? generation.data.scenario_id : null) ??
    null;
  const canPromoteFromRun = can("scenario.promote");
  const canScheduleRuns = can("trigger.manage");
  const canRerun = can("run.rerun");
  const promoteFromRunInFlight = useRef(false);
  const stepTraceFocusRef = useRef<HTMLDivElement | null>(null);
  const promoteFromRun = useMutation({
    mutationFn: async () => {
      if (scenarioId === null)
        throw new Error("자동화 연결 정보가 없어 반영할 수 없습니다.");
      return api.promoteScenarioFromRun(
        scenarioId,
        runId,
        `promote-from-run:${scenarioId}:${runId}`,
      );
    },
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      void qc.invalidateQueries({
        queryKey: ["scenario-versions", next.scenario_id],
      });
    },
  });
  useEffect(() => {
    promoteFromRunInFlight.current = false;
    promoteFromRun.reset();
  }, [runId, scenarioId]);
  const requestPromoteFromRun = (): void => {
    if (scenarioId === null || promoteFromRunInFlight.current || promoteFromRun.isPending || promoteFromRun.data !== undefined) return;
    promoteFromRunInFlight.current = true;
    promoteFromRun.mutate(undefined, {
      onSettled: () => {
        promoteFromRunInFlight.current = false;
      },
    });
  };
  const focusArtifactsRegion = (): void => {
    mergeParams({ focus: "artifacts" });
    focusAriaRegion("실행 결과·증빙");
  };
  const focusStepTrace = (): void => {
    focusTarget(stepTraceFocusRef.current);
  };
  const focusRerunControls = (): void => {
    focusAriaRegion("실패 실행 재실행");
  };

  return (
    <SlideOver title="실행 상세" subtitle="실행 추적 번호는 상세 분석에서만 사용합니다." onClose={onClose}>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState
          message="실행을 불러오지 못했습니다."
          onRetry={() => void detail.refetch()}
        />
      ) : detail.data !== undefined ? (
        <>
          <TestRunStatusPanel
            runId={runId}
            status={detail.data.status}
            runMode={detail.data.run_mode}
            attempts={detail.data.attempts}
            scenarioId={scenarioId}
            reason={detail.data.failure_reason ?? null}
            canScheduleRuns={canScheduleRuns}
            canRerun={canRerun}
            humanTaskLoading={humanTask.isLoading}
            pendingHumanTaskId={pendingTask?.human_task_id ?? null}
            onFocusArtifacts={focusArtifactsRegion}
            onFocusStepTrace={focusStepTrace}
            onFocusRerunControls={focusRerunControls}
          />
          <RerunControls detail={detail.data} />
          <GenerationRunContext runId={runId} generation={generation} />
          <PromoteFromRunPanel
            status={detail.data.status}
            scenarioId={scenarioId}
            allowed={canPromoteFromRun}
            mutation={promoteFromRun}
            onPromote={requestPromoteFromRun}
          />
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "6px 16px",
              margin: 0,
            }}
          >
            <dt className="subtle">자동화</dt>
            <dd style={{ margin: 0 }}>
              {detail.data.scenario_name ?? "—"}
            </dd>
            <dt className="subtle">상태</dt>
            <dd style={{ margin: 0 }}>
              <StatusBadge status={detail.data.status} />
            </dd>
            <dt className="subtle">실행 구분</dt>
            <dd style={{ margin: 0 }}>
              <RunModeBadge runMode={detail.data.run_mode} />
            </dd>
            <dt className="subtle">실행 처리자</dt>
            <dd style={{ margin: 0 }}>
              {detail.data.worker_id ?? "— (미할당)"}
            </dd>
            <dt className="subtle">시도 횟수</dt>
            <dd style={{ margin: 0 }}>{detail.data.attempts}</dd>
            <dt className="subtle">기준 시각</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(detail.data.as_of)}</dd>
          </dl>
        </>
      ) : null}
      {linkedGenerationId !== null && (
        <GenerationArtifactsPanel
          generationId={linkedGenerationId}
          title="자연어 생성 산출물"
        />
      )}
      <div
        ref={stepTraceFocusRef}
        role="region"
        aria-label="단계 트레이스 확인 위치"
        tabIndex={-1}
      >
        <StepTrace runId={runId} />
      </div>
      <RunArtifactsList
        runId={runId}
        focusOnMount={focusArtifacts}
        runStatus={detail.data?.status}
        evidencePolicy={
          generation.data?.run_id === runId
            ? generation.data.evidence_policy
            : undefined
        }
      />
    </SlideOver>
  );
}

function focusTarget(el: HTMLElement | null): void {
  if (el === null) return;
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "start" });
  }
  el.focus({ preventScroll: true });
}

function focusAriaRegion(label: string): void {
  const target = Array.from(document.querySelectorAll<HTMLElement>("[aria-label]")).find(
    (el) => el.getAttribute("aria-label") === label,
  );
  focusTarget(target ?? null);
}

function GenerationRunContext({
  runId,
  generation,
}: {
  runId: string;
  generation: UseQueryResult<ScenarioGenerationResult | null>;
}): JSX.Element | null {
  if (generation.isLoading) {
    return (
      <div
        className="badge muted"
        role="status"
        aria-label="generation context"
      >
        자연어 생성 컨텍스트 확인 중
      </div>
    );
  }
  if (generation.isError) {
    return (
      <div
        className="badge amber"
        role="status"
        aria-label="generation context"
      >
        자연어 생성 컨텍스트를 불러오지 못했습니다
      </div>
    );
  }
  if (generation.data === undefined || generation.data === null) return null;

  const linked = generation.data.run_id === runId;
  return (
    <div
      className={`badge ${linked ? "blue" : "amber"}`}
      role="status"
      aria-label="generation context"
    >
      <span>생성 요청 추적 번호 {generation.data.generation_id.slice(0, 8)}</span>
      <span title={generation.data.status}>
        {generationStatusLabel(generation.data.status)}
      </span>
      {generation.data.model !== undefined &&
        generation.data.model !== null && <span>{generation.data.model}</span>}
      {!linked && <span>실행 연결 확인 필요</span>}
    </div>
  );
}

function generationStatusLabel(status: string): string {
  switch (status) {
    case "run_queued":
      return "실행 대기 등록";
    case "saved":
      return "저장됨";
    case "blocked":
      return "생성 보류";
    case "failed":
      return "생성 실패";
    default:
      return "상태 확인 필요";
  }
}
