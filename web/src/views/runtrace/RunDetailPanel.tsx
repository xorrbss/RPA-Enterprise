import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { navigate } from "../../router";
import { SlideOver } from "../../components/SlideOver";
import { StepTrace } from "../../components/StepTrace";
import { GenerationArtifactsPanel } from "../../components/GenerationArtifactsPanel";
import { StatusBadge, errorCodeLabel, errorLabel } from "../../components/badges";
import { ErrorState, Loading } from "../../components/states";
import type { PromoteFromRunResult, RunDetail, ScenarioGenerationResult } from "../../api/types";
import { HUMAN_TASK_TERMINAL, SUSPENDED, arrivalTone } from "./constants";
import { RunArtifactsList } from "./RunArtifactsList";

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
    queryFn: () => api.listHumanTasks({ run_id: runId, limit: 10 }),
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
  const promoteFromRunInFlight = useRef(false);
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
            <dt className="subtle">상태</dt>
            <dd style={{ margin: 0 }}>
              <StatusBadge status={detail.data.status} />
            </dd>
            <dt className="subtle">실행 처리자</dt>
            <dd style={{ margin: 0 }}>
              {detail.data.worker_id ?? "— (미할당)"}
            </dd>
            <dt className="subtle">시도 횟수</dt>
            <dd style={{ margin: 0 }}>{detail.data.attempts}</dd>
            <dt className="subtle">기준 시각</dt>
            <dd style={{ margin: 0 }}>{detail.data.as_of ?? "—"}</dd>
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
      <StepTrace runId={runId} />
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

function promotionSkipLabel(reason: string): string {
  switch (reason) {
    case "multi_act_node_ambiguous":
      return "한 노드에 여러 동작이 있어 자동 승격하지 않았습니다.";
    case "node_not_found":
      return "원본 노드를 찾지 못했습니다.";
    case "node_what_missing":
      return "노드 동작 정의가 없어 승격하지 않았습니다.";
    case "no_promotable_act":
      return "승격할 수 있는 동작이 없습니다.";
    case "fill_no_value_source":
      return "입력값 출처가 없어 fill 셀렉터를 고정하지 않았습니다.";
    case "fill_already_deterministic":
      return "이미 결정형 입력으로 구성되어 있습니다.";
    case "unsupported_operation":
      return "지원하지 않는 동작 유형입니다.";
    default:
      return reason;
  }
}

function PromoteFromRunPanel({
  status,
  scenarioId,
  allowed,
  mutation,
  onPromote,
}: {
  status: string;
  scenarioId: string | null;
  allowed: boolean;
  onPromote: () => void;
  mutation: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly data: PromoteFromRunResult | undefined;
  };
}): JSX.Element | null {
  if (status !== "completed" || !allowed) return null;
  const result = mutation.data;
  return (
    <div className="pbd-promotion" role="region" aria-label="성공 실행 봇 승격">
      <div>
        <strong>성공 실행을 봇으로 굳히기</strong>
        <p className="subtle">
          이번 실행에서 검증된 클릭·입력·선택 동작을 새 초안 버전에 반영합니다.
        </p>
      </div>
      <button
        className="btn primary"
        type="button"
        onClick={onPromote}
        disabled={scenarioId === null || mutation.isPending || result !== undefined}
      >
        {mutation.isPending
          ? "승격 중"
          : result !== undefined
            ? "이미 초안으로 굳힘"
            : "이 실행을 봇으로 굳히기"}
      </button>
      {scenarioId === null && (
        <span className="badge amber">자동화 연결 정보 없음</span>
      )}
      {mutation.isError && (
        <div className="form-alert red" role="alert">
          {errorLabel(mutation.error)}
        </div>
      )}
      {result !== undefined && (
        <div className="pbd-result" role="status">
          <span className="badge green">초안 변경 {result.version} 생성</span>
          <span className="subtle">
            초안 참조 번호 {result.scenario_version_id.slice(0, 8)}
          </span>
          <span className="subtle">
            자동화 단계 {result.promoted_node_ids.length}개 반영
          </span>
          {result.skipped.length > 0 && (
            <span className="badge amber">
              검토 필요 {result.skipped.length}개
            </span>
          )}
          {(result.promoted_node_ids.length > 0 ||
            result.skipped.length > 0) && (
            <details className="developer-details">
              <summary>반영 기준 보기</summary>
              {result.promoted_node_ids.length > 0 && (
                <p className="subtle" style={{ margin: "8px 0 4px" }}>
                  원문 단계 참조: {result.promoted_node_ids.slice(0, 8).join(", ")}
                  {result.promoted_node_ids.length > 8 ? "..." : ""}
                </p>
              )}
              {result.skipped.length > 0 && (
                <ul className="pbd-skip-list">
                  {result.skipped.slice(0, 4).map((item) => (
                    <li key={`${item.nodeId}:${item.reason}`}>
                      <code>{item.nodeId}</code>{" "}
                      {promotionSkipLabel(item.reason)}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
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
          {errorCodeLabel(reason.code)}
          {reason.message !== "" && (
            <span className="subtle"> · {reason.message}</span>
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
        onClick={() => navigate("security")}
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
