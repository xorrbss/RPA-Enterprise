import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { mergeParams, navigate } from "../../router";
import { SlideOver } from "../../components/SlideOver";
import { StepTrace } from "../../components/StepTrace";
import { GenerationArtifactsPanel } from "../../components/GenerationArtifactsPanel";
import { RunModeBadge, StatusBadge, errorCodeLabel, errorOperatorActionLabel } from "../../components/badges";
import { ErrorState, Loading } from "../../components/states";
import { formatDateTime } from "../../util/time";
import type { RunDetail, ScenarioGenerationResult } from "../../api/types";
import { HUMAN_TASK_TERMINAL, SUSPENDED, arrivalTone } from "./constants";
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
          <ArrivalBanner
            status={detail.data.status}
            attempts={detail.data.attempts}
            reason={detail.data.failure_reason ?? null}
          />
          <TestRunStatusPanel
            runId={runId}
            status={detail.data.status}
            runMode={detail.data.run_mode}
            scenarioId={scenarioId}
            reason={detail.data.failure_reason ?? null}
            canScheduleRuns={canScheduleRuns}
            canRerun={canRerun}
            onFocusArtifacts={focusArtifactsRegion}
            onFocusStepTrace={focusStepTrace}
            onFocusRerunControls={focusRerunControls}
          />
          <RerunControls detail={detail.data} />
          <SessionHintBanner runId={runId} status={detail.data.status} />
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
          {SUSPENDED.has(detail.data.status) && (
            <p
              className="badge amber"
              role="status"
              style={{
                display: "block",
                margin: "8px 0 0",
                whiteSpace: "normal",
              }}
            >
              이 실행은 사람 확인 대기 중입니다 —{" "}
              <button
                className="linklike"
                type="button"
                disabled={humanTask.isLoading}
                onClick={() => {
                  if (pendingTask !== undefined)
                    navigate("humanTasks", { ht: pendingTask.human_task_id });
                  else navigate("humanTasks", { run_id: runId });
                }}
              >
                {humanTask.isLoading
                  ? "사람 확인 업무 찾는 중"
                  : pendingTask !== undefined
                    ? "연결된 사람 확인 업무 처리하기"
                    : "사람 확인 인박스에서 처리하기"}{" "}
                <span aria-hidden="true">→</span>
              </button>
            </p>
          )}
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

// F3 터미널 '도착 순간' 배너 — 실행이 완료/실패/취소로 종료되었음을 분명히 알린다(구매 모먼트의 '도착').
// 도착 판정=detail.status(실 필드)만. 시도횟수=detail.attempts(실 필드). 실패 사유(reason)는 RunDetail에 없으므로
// 만들지 않고 단계 트레이스의 exception.code(이미 진실원천)로 유도한다. 비-터미널이면 배너 없음(조용한 false 금지).
function ArrivalBanner({
  status,
  attempts,
  reason,
}: {
  status: string;
  attempts: number;
  reason: { code: string; message: string } | null;
}): JSX.Element | null {
  const bannerTone = arrivalTone(status); // arrivalTone이 badges.tone()에 위임(색 단일 출처)
  if (bannerTone === null) return null;
  const failed = bannerTone === "red";
  return (
    <div className={`arrival-banner badge ${bannerTone}`} role="status">
      <StatusBadge status={status} />
      <span>
        실행이 종료되었습니다{attempts > 1 ? ` · 시도 ${attempts}회` : ""}.
      </span>
      {failed && reason !== null && (
        <span>
          {errorCodeLabel(reason.code, { terminal: true })}
          {reason.message !== "" && (
            <span className="subtle"> · {reason.message}</span>
          )}
          {/* U3-1: 계약 operatorAction 한국어 미러 배선 — 원인만 보이고 '다음에 뭘 해야 하는지'가 없던 갭.
              미매핑 코드는 접근자가 raw code 폴백이라, 매핑된 경우에만 조치 줄을 그린다(raw 노출 금지). */}
          {errorOperatorActionLabel(reason.code) !== reason.code && (
            <span className="subtle"> · 권장 조치: {errorOperatorActionLabel(reason.code)}</span>
          )}
        </span>
      )}
      {failed && reason === null && (
        <span className="subtle">
          자세한 원인은 아래 단계 트레이스를 확인하세요.
        </span>
      )}
    </div>
  );
}

// 세션 재등록 유도 힌트 — 로그인 필요 사이트의 세션 만료로 보이는 실패에 한해 안내(단정 금지: '…만료됐을 수 있어요').
// 신호: 터미널 실패 + '페이지 이동(navigate)' 단계 실패(= 보호된 페이지에 못 들어간 증상). URL/사이트는 RunDetail에
// 없으므로(웹 한계) 조건부 문구로 안내하고 보안·개인정보로 유도한다(사이트별 딥링크는 backend precheck 후속에서).
// run-steps 쿼리키는 StepTrace와 동일 → react-query가 캐시를 공유(중복 페치 없음).
function SessionHintBanner({
  runId,
  status,
}: {
  runId: string;
  status: string;
}): JSX.Element | null {
  const api = useApiClient();
  const failed = status === "failed_system" || status === "failed_business";
  const q = useQuery({
    queryKey: ["run-steps", runId],
    queryFn: () => api.listRunSteps(runId, { limit: 100 }),
    enabled: failed,
  });
  if (!failed) return null;
  const navFailed = (q.data?.items ?? []).some(
    (s) =>
      s.action === "navigate" &&
      (s.status === "failed_system" || s.exception !== null),
  );
  if (!navFailed) return null;
  return (
    <div
      className="badge amber"
      role="status"
      aria-label="세션 등록 안내"
      style={{ display: "block", margin: "8px 0 0", whiteSpace: "normal" }}
    >
      <strong>페이지 열기 단계에서 멈춰 실패했습니다.</strong> 로그인이 필요한
      사이트라면 등록된 세션이 만료됐을 수 있어요 — 세션을 다시 등록한 뒤 다시
      실행해 보세요.{" "}
      <button
        className="linklike"
        type="button"
        onClick={() => navigate("security", { section: "sites" })}
      >
        세션 등록하러 가기 <span aria-hidden="true">→</span>
      </button>
    </div>
  );
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
