import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { FailureReason, RunMode, StepSummary } from "../../api/types";
import { actionLabel, errorCodeLabel, errorOperatorActionLabel, StatusBadge } from "../../components/badges";
import { navigate } from "../../router";
import { formatDateTime } from "../../util/time";
import { SUSPENDED } from "./constants";

const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "run_queued",
  "claimed",
  "running",
  "suspending",
  "resume_requested",
  "resuming",
  "aborting",
  "completing",
]);

const SITE_RECOVERY_CODES = new Set([
  "DOMAIN_POLICY_VIOLATION",
  "NAVIGATION_TIMEOUT",
  "SESSION_GENERATION_CONFLICT",
  "SESSION_LOCKED",
  "SESSION_REGISTRATION_REQUIRED",
  "SITE_PROFILE_BLOCKED",
]);

export function TestRunStatusPanel({
  runId,
  status,
  runMode,
  attempts,
  scenarioId,
  reason,
  canScheduleRuns,
  canRerun,
  humanTaskLoading,
  pendingHumanTaskId,
  onFocusArtifacts,
  onFocusStepTrace,
  onFocusRerunControls,
}: {
  runId: string;
  status: string;
  runMode: RunMode | undefined;
  attempts: number;
  scenarioId: string | null;
  reason: FailureReason | null;
  canScheduleRuns: boolean;
  canRerun: boolean;
  humanTaskLoading: boolean;
  pendingHumanTaskId: string | null;
  onFocusArtifacts: () => void;
  onFocusStepTrace: () => void;
  onFocusRerunControls: () => void;
}): JSX.Element {
  const api = useApiClient();
  const stepSignals = useQuery({
    queryKey: ["run-steps", runId],
    queryFn: () => api.listRunSteps(runId, { limit: 100 }),
  });
  const steps = stepSignals.data?.items ?? [];
  const failed = isFailedRunStatus(status);
  const suspended = SUSPENDED.has(status);
  const navFailed = steps.some(
    (step) =>
      step.action === "navigate" &&
      (step.status === "failed_system" ||
        step.status === "failed_business" ||
        step.exception !== null),
  );
  const siteRecovery = navFailed || (reason !== null && SITE_RECOVERY_CODES.has(reason.code));
  const summary = runStatusSummary(status, runMode, attempts, reason, siteRecovery);
  const visibleSteps = steps.slice(-4);
  const openHumanTask = (): void => {
    if (pendingHumanTaskId !== null) navigate("humanTasks", { ht: pendingHumanTaskId });
    else navigate("humanTasks", { run_id: runId });
  };

  return (
    <section className={`test-run-status-panel ${summary.tone}`} aria-label="테스트 실행 상태">
      <div className="test-run-status-head">
        <div>
          <span className={`badge ${summary.tone}`}>{summary.kicker}</span>
          <h3>{summary.title}</h3>
          <p className="subtle">{summary.detail}</p>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="test-run-status-actions" role="region" aria-label="실행 다음 행동">
        <div>
          <strong>{summary.actionTitle}</strong>
          <p className="subtle">{summary.actionDetail}</p>
        </div>
        <span className="inline-actions">
          {status === "completed" ? (
            <>
              <button className="btn primary" type="button" onClick={onFocusArtifacts}>
                {runMode === "test" ? "테스트 증빙 확인" : "증빙·산출물 확인"}
              </button>
              {canScheduleRuns && (
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    navigate("automationOps", scenarioId !== null ? { scenario: scenarioId } : undefined)
                  }
                >
                  운영 예약·트리거 설정
                </button>
              )}
            </>
          ) : suspended ? (
            <>
              <button className="btn primary" type="button" disabled={humanTaskLoading} onClick={openHumanTask}>
                {humanTaskLoading
                  ? "사람 확인 업무 찾는 중"
                  : pendingHumanTaskId !== null
                    ? "연결된 사람 확인 업무 처리하기"
                    : "사람 확인 인박스에서 처리하기"}
              </button>
              <button className="btn" type="button" onClick={onFocusStepTrace}>
                단계 트레이스 확인
              </button>
            </>
          ) : failed && siteRecovery ? (
            <>
              <button className="btn primary" type="button" onClick={() => navigate("security", { section: "sites" })}>
                사이트·세션 설정 확인
              </button>
              <button className="btn" type="button" onClick={onFocusStepTrace}>
                단계 트레이스 확인
              </button>
            </>
          ) : failed ? (
            <>
              <button className="btn primary" type="button" onClick={canRerun ? onFocusRerunControls : onFocusStepTrace}>
                {canRerun ? "재실행 컨트롤 확인" : "단계 트레이스 확인"}
              </button>
              {canRerun && (
                <button className="btn" type="button" onClick={onFocusStepTrace}>
                  단계 트레이스 확인
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn primary" type="button" onClick={onFocusStepTrace}>
                단계 트레이스 확인
              </button>
              <button className="btn" type="button" onClick={onFocusArtifacts}>
                증빙 저장 상태 확인
              </button>
            </>
          )}
        </span>
      </div>

      <div className="test-run-status-steps" aria-label="최근 단계 요약">
        <div className="test-run-status-steps-head">
          <strong>최근 단계</strong>
          <span className="subtle">{stepSignals.isLoading ? "확인 중" : `${steps.length}개 확인`}</span>
        </div>
        {visibleSteps.length === 0 ? (
          <p className="test-run-status-empty">단계 기록 대기</p>
        ) : (
          <ol>
            {visibleSteps.map((step) => (
              <li key={`${step.step_id}:${step.attempt}`}>
                <span className={`badge ${stepTone(step)}`}>{stepStatusLabel(step)}</span>
                <span className="test-run-step-copy">
                  <strong>{actionLabel(step.action)}</strong>
                  <span className="subtle">
                    {step.node_id} · {stepTimeLabel(step)}
                    {step.duration_ms !== null ? ` · ${step.duration_ms}ms` : ""}
                  </span>
                </span>
                {step.exception !== null && (
                  <span className="badge red">{diagnosticErrorLabel(step.exception.code, { terminal: true })}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function isFailedRunStatus(status: string): boolean {
  return status === "failed_business" || status === "failed_system";
}

function runStatusSummary(
  status: string,
  runMode: RunMode | undefined,
  attempts: number,
  reason: FailureReason | null,
  siteRecovery: boolean,
): {
  tone: "green" | "red" | "amber" | "blue" | "muted";
  kicker: string;
  title: string;
  detail: string;
  actionTitle: string;
  actionDetail: string;
} {
  const testLabel = runMode === "test" ? "테스트" : "실행";
  if (status === "completed") {
    return {
      tone: "green",
      kicker: `${testLabel} 완료`,
      title: runMode === "test" ? "테스트 성공" : "실행 성공",
      detail: `실행이 종료되었습니다${terminalAttemptText(attempts)}. 산출물과 metadata-only 증빙을 먼저 확인하세요.`,
      actionTitle: "증빙 확인",
      actionDetail: "검증된 실행 결과를 확인한 뒤 운영 예약이나 봇 승격으로 이어갈 수 있습니다.",
    };
  }
  if (status === "cancelled") {
    return {
      tone: "muted",
      kicker: `${testLabel} 취소됨`,
      title: runMode === "test" ? "테스트 취소됨" : "실행 취소됨",
      detail: `실행이 취소되어 종료되었습니다${terminalAttemptText(attempts)}. 취소는 실패로 분류하지 않고 종료 기록만 확인합니다.`,
      actionTitle: "취소된 실행",
      actionDetail: "필요하면 단계 트레이스와 증빙 저장 상태에서 취소 직전 기록을 확인하세요.",
    };
  }
  if (isFailedRunStatus(status)) {
    return {
      tone: "red",
      kicker: `${testLabel} 실패`,
      title: runMode === "test" ? "테스트 실패" : "실행 실패",
      detail:
        reason !== null
          ? `실행이 종료되었습니다${terminalAttemptText(attempts)}. ${failureReasonDetail(reason)}`
          : `실행이 종료되었습니다${terminalAttemptText(attempts)}. 자세한 원인은 아래 단계 트레이스를 확인하세요.`,
      actionTitle: siteRecovery ? "사이트·세션 복구" : "실패 복구",
      actionDetail: siteRecovery
        ? "페이지 이동이나 세션 관련 실패 신호가 있습니다. 로그인이 필요한 사이트라면 등록된 세션이 만료됐을 수 있어요."
        : "기술 원문보다 먼저 재실행 또는 단계 확인으로 복구 경로를 잡습니다.",
    };
  }
  if (SUSPENDED.has(status)) {
    return {
      tone: "amber",
      kicker: "사람 확인",
      title: "사람 확인 대기",
      detail: "사람 확인 업무가 처리되어야 실행을 이어갈 수 있습니다.",
      actionTitle: "대기 중인 확인 처리",
      actionDetail: "연결된 사람 확인 업무를 처리한 뒤 실행 흐름을 다시 확인하세요.",
    };
  }
  if (ACTIVE_RUN_STATUSES.has(status)) {
    return {
      tone: "blue",
      kicker: `${testLabel} 진행`,
      title: activeRunHeading(status, runMode),
      detail: "현재 관찰된 상태 기준으로 단계 진행과 증빙 저장 여부를 확인합니다.",
      actionTitle: "진행 상태 보기",
      actionDetail: "단계 트레이스와 증빙 저장 상태를 같은 화면에서 확인할 수 있습니다.",
    };
  }
  return {
    tone: "muted",
    kicker: "상태 확인",
    title: "실행 상태 확인 필요",
    detail: "이 상태는 완료나 실패로 단정하지 않고 상세 기록을 확인해야 합니다.",
    actionTitle: "상세 확인",
    actionDetail: "단계 트레이스와 증빙 저장 상태를 확인하세요.",
  };
}

function activeRunHeading(status: string, runMode: RunMode | undefined): string {
  const prefix = runMode === "test" ? "테스트" : "";
  switch (status) {
    case "queued":
    case "run_queued":
      return runMode === "test" ? "테스트 대기 중" : "실행 대기 중";
    case "claimed":
    case "running":
    case "resuming":
      return `${prefix} 실행 중`.trim();
    case "suspending":
    case "resume_requested":
      return "사람 확인 전환 중";
    case "aborting":
      return "중단 처리 중";
    case "completing":
      return "완료 정리 중";
    default:
      return runMode === "test" ? "테스트 상태 확인" : "실행 상태 확인";
  }
}

function terminalAttemptText(attempts: number): string {
  return attempts > 1 ? ` · 시도 ${attempts}회` : "";
}

function failureReasonDetail(reason: FailureReason): string {
  const label = diagnosticErrorLabel(reason.code, { terminal: true });
  const message = reason.message.trim();
  const operatorAction = errorOperatorActionLabel(reason.code);
  return [
    label,
    message !== "" ? message : null,
    operatorAction !== reason.code ? `권장 조치: ${operatorAction}` : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

function diagnosticErrorLabel(code: string, opts?: { terminal?: boolean }): string {
  const label = errorCodeLabel(code, opts);
  if (label !== code) return label;
  return `오류 원인 확인 필요 · 진단 코드 ${code}`;
}

function stepTone(step: StepSummary): "green" | "red" | "amber" | "blue" | "muted" {
  if (step.exception !== null) return "red";
  switch (step.status) {
    case "success":
    case "completed":
      return "green";
    case "failed_system":
    case "failed_business":
      return "red";
    case "skipped":
    case "cancelled":
      return "muted";
    case "running":
    case "started":
      return "blue";
    default:
      return "amber";
  }
}

function stepStatusLabel(step: StepSummary): string {
  if (step.exception !== null) return "실패";
  switch (step.status) {
    case "success":
    case "completed":
      return "성공";
    case "failed_system":
      return "시스템 실패";
    case "failed_business":
      return "업무 실패";
    case "skipped":
      return "스킵";
    case "running":
    case "started":
      return "진행 중";
    case "cancelled":
      return "취소됨";
    default:
      return "확인 필요";
  }
}

function stepTimeLabel(step: StepSummary): string {
  const timestamp = step.ended_at ?? step.started_at;
  return timestamp === null ? "시각 대기" : formatDateTime(timestamp);
}
