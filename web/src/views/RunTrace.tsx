import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { ArtifactLookup, ArtifactRef } from "../components/ArtifactLookup";
import { ArtifactMediaPreview } from "../components/ArtifactMediaPreview";
import { GenerationArtifactsPanel } from "../components/GenerationArtifactsPanel";
import { StepTrace } from "../components/StepTrace";
import { FilterSelect } from "../components/FilterSelect";
import { SlideOver } from "../components/SlideOver";
import {
  StatusBadge,
  statusLabel,
  errorCodeLabel,
  errorLabel,
  tone,
  type Tone,
} from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { RUN_STATES } from "./filters";
import { mergeParams, navigate, useHashIdParam, useHashParam } from "../router";
import type {
  ArtifactDetail,
  RunArtifactItem,
  RunDetail,
  RunItem,
  PromoteFromRunResult,
  ScenarioGenerationEvidence,
  ScenarioGenerationResult,
} from "../api/types";

const POLL_MS = 5_000; // 실행 목록/상세 fallback 재조회 간격.
const TERMINAL = new Set([
  "completed",
  "cancelled",
  "failed_business",
  "failed_system",
]);
const HUMAN_TASK_TERMINAL = new Set(["resolved", "expired", "cancelled"]);
// '사람 확인 대기'가 확실한 비-터미널 status만(state-machine). StatusBadge가 suspended를 '사람 확인 대기'로 라벨링하는 것과 정합.
// suspending은 bookmark 저장 중 전이 상태(R11→suspended / R12→failed_system, 미정착)라 StatusBadge가 '보류 중'으로 라벨링하므로
// 배너의 '대기 중'과 어휘가 충돌 + '대기' 단정이 한 발 앞선다 → 제외(suspended 단일 게이팅 = 배지와 동일 출처 정합).
// resume_requested/resuming도 이미 resolve 진행 중이라 '대기' 단정이 과해 제외(보수적 게이팅).
const SUSPENDED = new Set(["suspended"]);

export function runDetailRefetchInterval(
  status: string | undefined,
): number | false {
  return status !== undefined && TERMINAL.has(status) ? false : POLL_MS;
}

// F3 터미널 '도착' 톤 — 터미널 여부는 TERMINAL Set 단일 출처가 게이팅하고(비-터미널이면 null = 배너 없음),
// 색은 badges.tone()에 위임해 도착 배너 배경과 내부 StatusBadge 색이 한 출처에서 항상 일치하게 한다(DRY·드리프트 방지).
// (completed=green, 실패=red, cancelled=muted; 어휘 체인 abort→cancelled. 비-터미널 null = 조용한 false 금지.)
function arrivalTone(status: string): Tone | null {
  return TERMINAL.has(status) ? tone(status) : null;
}

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

// 실행 상세 — getRun(RLS 스코프) + run_steps 단계 트레이스(GET /v1/runs/{id}/steps, api-surface §1).
function RunDetailPanel({
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

type JsonSummary = {
  label: string;
  count: number;
  keys: string[];
  sample: unknown[];
};

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function summarizeJsonArtifact(detail: ArtifactDetail): JsonSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail.content);
  } catch {
    return null;
  }
  const candidates: Array<[string, unknown]> = Array.isArray(parsed)
    ? [["records", parsed]]
    : isRecord(parsed)
      ? [
          ["records", parsed.records],
          ["rows", parsed.rows],
          ["items", parsed.items],
          ["data", parsed.data],
        ]
      : [];
  const found = candidates.find(([, value]) => Array.isArray(value));
  if (found === undefined) return null;
  const [label, value] = found;
  const rows = value as unknown[];
  const firstRecord = rows.find(isRecord);
  return {
    label,
    count: rows.length,
    keys: firstRecord !== undefined ? Object.keys(firstRecord).slice(0, 8) : [],
    sample: rows.slice(0, 5),
  };
}

function jsonSummaryLabel(label: string): string {
  switch (label) {
    case "records":
    case "rows":
    case "items":
    case "data":
      return "결과";
    default:
      return "결과";
  }
}

function jsonCellLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "복합 값";
  }
}

function JsonSummaryPreview({
  summary,
}: {
  summary: JsonSummary;
}): JSX.Element {
  const records = summary.sample.filter(isRecord);
  const columns = summary.keys.length > 0 ? summary.keys : ["value"];
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {records.length > 0 ? (
        <div className="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((row, index) => (
                <tr key={index}>
                  {columns.map((key) => (
                    <td key={key}>{jsonCellLabel(row[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="summary-list">
          {summary.sample.map((value, index) => (
            <li key={index}>{jsonCellLabel(value)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TextArtifactSummaryPreview({ content }: { content: string }): JSX.Element {
  const trimmed = content.trim();
  const lineCount = trimmed === "" ? 0 : trimmed.split(/\r?\n/).length;
  return (
    <div className="artifact-json-summary" aria-label="결과 요약" style={{ marginTop: 8 }}>
      <span>
        <span className="subtle">형식</span>
        <strong>텍스트 결과</strong>
      </span>
      <span>
        <span className="subtle">크기</span>
        <strong>{trimmed.length.toLocaleString("ko-KR")}자</strong>
      </span>
      <span>
        <span className="subtle">줄 수</span>
        <strong>{lineCount.toLocaleString("ko-KR")}줄</strong>
      </span>
    </div>
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function artifactLabel(id: string): string {
  return `증빙 #${shortId(id)}`;
}

function artifactTypeLabel(type: string): string {
  switch (type) {
    case "extract_result_json":
      return "추출 결과";
    case "screenshot":
    case "screenshot_masked":
      return "화면 증거";
    case "video":
    case "video_masked":
      return "영상 증거";
    case "planner_trace":
      return "생성 진단";
    default:
      return "산출물";
  }
}

function mediaKindLabel(kind: "screenshot" | "video"): string {
  return kind === "video" ? "영상" : "스크린샷";
}

function mediaTypeLabel(mediaType: string | null | undefined): string | null {
  if (mediaType === null || mediaType === undefined || mediaType.length === 0)
    return null;
  const lower = mediaType.toLowerCase();
  if (lower === "image/png") return "PNG 이미지";
  if (lower === "image/jpeg" || lower === "image/jpg") return "JPEG 이미지";
  if (lower === "image/webp") return "WebP 이미지";
  if (lower === "video/webm") return "WebM 영상";
  if (lower === "application/json") return "구조화 결과";
  if (lower.startsWith("image/")) return "이미지";
  if (lower.startsWith("video/")) return "영상";
  if (lower.startsWith("text/")) return "텍스트 문서";
  return "첨부 파일";
}

function redactionStatusLabel(status: string): string {
  switch (status) {
    case "redacted":
    case "not_required":
      return "조회 가능";
    case "pending":
      return "처리 중";
    case "failed":
      return "처리 실패";
    default:
      return "상태 확인 필요";
  }
}

function mediaKind(a: RunArtifactItem): "screenshot" | "video" | null {
  const hints =
    `${a.type} ${a.media_type ?? ""} ${a.filename ?? ""}`.toLowerCase();
  if (hints.includes("video")) return "video";
  if (
    hints.includes("screenshot") ||
    hints.includes("screen_capture") ||
    hints.includes("image_capture") ||
    hints.includes("image/") ||
    /\.(png|jpe?g|webp)\b/.test(hints)
  )
    return "screenshot";
  return null;
}

// 서버가 실제로 단언한 미디어 타입만 반환한다(날조 금지). 미상이면 null — ArtifactMediaPreview 가
//   실제 blob(q.data.type)에서 종류를 해석하므로 추측한 MIME("video/webm" 등)을 만들 필요가 없다.
function previewMediaType(a: RunArtifactItem | undefined): string | null {
  if (a === undefined) return null;
  if (
    typeof a.media_type === "string" &&
    (a.media_type.startsWith("image/") || a.media_type.startsWith("video/"))
  )
    return a.media_type;
  return null;
}

// 미리보기 가능 여부 — 서버 미디어 타입 또는 artifact 종류(screenshot/video)로 판정. 정확한 MIME 단언과는 분리.
function isPreviewableMedia(a: RunArtifactItem | undefined): boolean {
  if (a === undefined) return false;
  if (previewMediaType(a) !== null) return true;
  const kind = mediaKind(a);
  return kind === "video" || kind === "screenshot";
}

function isArtifactReadable(a: RunArtifactItem | undefined): boolean {
  return (
    a?.redaction_status === "redacted" || a?.redaction_status === "not_required"
  );
}

function formatByteSize(bytes: number | null | undefined): string | null {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes < 0
  )
    return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return null;
  return ms < 1000
    ? `${ms} ms`
    : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function mediaMetaLabels(a: RunArtifactItem): string[] {
  return [
    mediaTypeLabel(a.media_type),
    formatByteSize(a.byte_size),
    formatDuration(a.duration_ms),
  ].filter((v): v is string => v !== null && v !== "");
}

function artifactProvenanceLabel(a: RunArtifactItem): string {
  if (typeof a.step_id === "string" && a.step_id.length > 0) {
    return typeof a.attempt === "number"
      ? `자동화 단계 · 시도 ${a.attempt}`
      : "자동화 단계";
  }
  return "실행 전체";
}

function hasStepProvenance(
  a: RunArtifactItem,
): a is RunArtifactItem & { readonly step_id: string } {
  return typeof a.step_id === "string" && a.step_id.length > 0;
}

function artifactSummary(items: readonly RunArtifactItem[]): {
  screenshots: number;
  videos: number;
  pending: number;
} {
  return items.reduce(
    (acc, item) => {
      const kind = mediaKind(item);
      if (isArtifactReadable(item)) {
        if (kind === "screenshot") acc.screenshots += 1;
        if (kind === "video") acc.videos += 1;
      }
      if (item.redaction_status === "pending") acc.pending += 1;
      return acc;
    },
    { screenshots: 0, videos: 0, pending: 0 },
  );
}

function uniqueArtifactItems(
  items: readonly RunArtifactItem[],
): readonly RunArtifactItem[] {
  const seen = new Set<string>();
  const unique: RunArtifactItem[] = [];
  for (const item of items) {
    if (seen.has(item.artifact_id)) continue;
    seen.add(item.artifact_id);
    unique.push(item);
  }
  return unique;
}

function mergeArtifactPages(
  firstPageItems: readonly RunArtifactItem[],
  extraItems: readonly RunArtifactItem[],
): readonly RunArtifactItem[] {
  return uniqueArtifactItems([...firstPageItems, ...extraItems]);
}

function screenshotRequestLabel(
  value: ScenarioGenerationEvidence["screenshot"] | undefined,
): string {
  if (value === "each_step") return "매 단계";
  if (value === "failure") return "실패 시";
  return "요청 없음";
}

function videoRequestLabel(
  value: ScenarioGenerationEvidence["video"] | undefined,
): string {
  if (value === "always") return "전체 실행";
  if (value === "failure") return "실패 시";
  return "요청 없음";
}

function EvidenceStorageReadout({
  policy,
  counts,
  runStatus,
  loaded,
}: {
  policy: ScenarioGenerationEvidence | undefined;
  counts: { screenshots: number; videos: number; pending: number };
  runStatus: string | undefined;
  loaded: boolean;
}): JSX.Element | null {
  if (policy === undefined) return null;
  const terminal = runStatus !== undefined && TERMINAL.has(runStatus);
  const nonTerminal = runStatus !== undefined && !terminal;
  const failed =
    runStatus === "failed_business" || runStatus === "failed_system";
  const missingFailureScreenshot =
    loaded &&
    failed &&
    policy.screenshot === "failure" &&
    counts.screenshots === 0;
  const missingScreenshot =
    loaded &&
    terminal &&
    policy.screenshot === "each_step" &&
    counts.screenshots === 0;
  const missingVideo =
    loaded && terminal && policy.video === "always" && counts.videos === 0;
  const waitingScreenshot =
    loaded &&
    nonTerminal &&
    (policy.screenshot === "each_step" || policy.screenshot === "failure") &&
    counts.screenshots === 0;
  const waitingVideo =
    loaded &&
    nonTerminal &&
    (policy.video === "always" || policy.video === "failure") &&
    counts.videos === 0;

  return (
    <div
      className="inline-facts"
      role="status"
      aria-label="evidence storage"
      style={{ marginTop: 8 }}
    >
      <span className="subtle">
        요청 이미지: {screenshotRequestLabel(policy.screenshot)}
      </span>
      <span className="subtle">
        요청 동영상: {videoRequestLabel(policy.video)}
      </span>
      <span className="badge blue">저장 이미지 {counts.screenshots}</span>
      <span className="badge amber">저장 동영상 {counts.videos}</span>
      {counts.pending > 0 && (
        <span className="badge muted">처리 대기 {counts.pending}</span>
      )}
      {waitingScreenshot && (
        <span className="badge muted">
          {policy.screenshot === "failure"
            ? "실패 시 이미지 저장 대기"
            : "이미지 저장 대기"}
        </span>
      )}
      {waitingVideo && (
        <span className="badge muted">
          {policy.video === "failure"
            ? "실패 시 동영상 저장 대기"
            : "동영상 저장 대기"}
        </span>
      )}
      {missingFailureScreenshot && (
        <span className="badge amber">실패 스크린샷 미표시(처리 중 가능)</span>
      )}
      {missingScreenshot && (
        <span className="badge amber">요청 이미지 미표시(처리 중 가능)</span>
      )}
      {missingVideo && (
        <span className="badge amber">요청 동영상 미표시(처리 중 가능)</span>
      )}
    </div>
  );
}

// 산출물(artifact) 목록 + 결과 미리보기 — 본문 조회는 getArtifact(redaction→RBAC→audit 게이트)를 통한다. 라이브=폴링.
function RunArtifactsList({
  runId,
  focusOnMount,
  runStatus,
  evidencePolicy,
}: {
  runId: string;
  focusOnMount: boolean;
  runStatus: string | undefined;
  evidencePolicy: ScenarioGenerationEvidence | undefined;
}): JSX.Element {
  const api = useApiClient();
  const artifactsRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pagination, setPagination] = useState<{
    runId: string;
    firstPageCursor: string | null;
    nextCursor: string | null;
    extraItems: readonly RunArtifactItem[];
    loadingMore: boolean;
    loadMoreError: string | null;
  }>({
    runId,
    firstPageCursor: null,
    nextCursor: null,
    extraItems: [],
    loadingMore: false,
    loadMoreError: null,
  });
  const hashArtifactId = useHashParam("artifact");
  const q = useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => api.listRunArtifacts(runId, { limit: 100 }),
    refetchInterval: POLL_MS,
  });
  const firstPageItems: readonly RunArtifactItem[] = q.data?.items ?? [];
  const firstPageCursor = q.data?.next_cursor ?? null;
  const paginationMatchesFirstPage =
    pagination.runId === runId &&
    pagination.firstPageCursor === firstPageCursor;
  const extraItems = paginationMatchesFirstPage ? pagination.extraItems : [];
  const nextCursor = paginationMatchesFirstPage
    ? pagination.nextCursor
    : firstPageCursor;
  const loadingMore = paginationMatchesFirstPage
    ? pagination.loadingMore
    : false;
  const loadMoreError = paginationMatchesFirstPage
    ? pagination.loadMoreError
    : null;
  const items: readonly RunArtifactItem[] = mergeArtifactPages(
    firstPageItems,
    extraItems,
  );
  const hasMoreArtifacts = nextCursor !== null;
  const preferred =
    items.find((a) => isArtifactReadable(a) && isPreviewableMedia(a)) ??
    items.find(
      (a) =>
        isArtifactReadable(a) && /json|extract|output|result/i.test(a.type),
    ) ??
    items.find(isArtifactReadable) ??
    items[0];
  const hashSelectedId =
    hashArtifactId !== null &&
    items.some((a) => a.artifact_id === hashArtifactId)
      ? hashArtifactId
      : null;
  const stateSelectedId =
    selectedId !== null && items.some((a) => a.artifact_id === selectedId)
      ? selectedId
      : null;
  const effectiveSelectedId =
    hashSelectedId ?? stateSelectedId ?? preferred?.artifact_id ?? null;
  const selectedItem = items.find((a) => a.artifact_id === effectiveSelectedId);
  const selectedIsReadable = isArtifactReadable(selectedItem);
  const selectedIsMedia = isPreviewableMedia(selectedItem);
  const selectedMediaType = previewMediaType(selectedItem);
  const counts = artifactSummary(items);
  useEffect(() => {
    setPagination((current) => {
      if (
        current.runId === runId &&
        current.firstPageCursor === firstPageCursor
      )
        return current;
      return {
        runId,
        firstPageCursor,
        nextCursor: firstPageCursor,
        extraItems: [],
        loadingMore: false,
        loadMoreError: null,
      };
    });
  }, [firstPageCursor, runId]);
  useEffect(() => {
    if (hashSelectedId !== null && selectedId !== hashSelectedId) {
      setSelectedId(hashSelectedId);
    }
  }, [hashSelectedId, selectedId]);
  useEffect(() => {
    if (focusOnMount) artifactsRef.current?.focus();
  }, [focusOnMount]);
  const detail = useQuery({
    queryKey: ["artifact-detail", effectiveSelectedId],
    queryFn: () => api.getArtifact(effectiveSelectedId as string),
    enabled:
      effectiveSelectedId !== null && selectedIsReadable && !selectedIsMedia,
  });
  const summary =
    detail.data !== undefined ? summarizeJsonArtifact(detail.data) : null;
  async function loadMoreArtifacts(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    const cursor = nextCursor;
    setPagination((current) => {
      if (
        current.runId === runId &&
        current.firstPageCursor === firstPageCursor
      ) {
        return { ...current, loadingMore: true, loadMoreError: null };
      }
      return {
        runId,
        firstPageCursor,
        nextCursor: cursor,
        extraItems: [],
        loadingMore: true,
        loadMoreError: null,
      };
    });
    try {
      const page = await api.listRunArtifacts(runId, { limit: 100, cursor });
      setPagination((current) => {
        if (
          current.runId !== runId ||
          current.firstPageCursor !== firstPageCursor
        )
          return current;
        const firstPageIds = new Set(
          firstPageItems.map((item) => item.artifact_id),
        );
        const nextExtraItems = uniqueArtifactItems([
          ...current.extraItems,
          ...page.items,
        ]).filter((item) => !firstPageIds.has(item.artifact_id));
        return {
          ...current,
          nextCursor: page.next_cursor,
          extraItems: nextExtraItems,
          loadingMore: false,
          loadMoreError: null,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      setPagination((current) =>
        current.runId === runId && current.firstPageCursor === firstPageCursor
          ? { ...current, loadingMore: false, loadMoreError: message }
          : current,
      );
    }
  }
  return (
    <div
      ref={artifactsRef}
      role="region"
      aria-label="실행 결과·증빙"
      tabIndex={focusOnMount ? -1 : undefined}
      style={{ marginTop: 14 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>실행 결과·증빙</strong>
        {items.length > 0 && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
            aria-label="증빙 요약"
          >
            <span className="subtle">
              증빙 {items.length}
              {hasMoreArtifacts ? "+건" : "건"}
            </span>
            <span className="badge blue">스크린샷 {counts.screenshots}</span>
            <span className="badge amber">동영상 {counts.videos}</span>
            {hasMoreArtifacts && <span className="badge muted">더 있음</span>}
            {counts.pending > 0 && (
              <span className="badge muted">처리 대기 {counts.pending}</span>
            )}
          </span>
        )}
      </div>
      <EvidenceStorageReadout
        policy={evidencePolicy}
        counts={counts}
        runStatus={runStatus}
        loaded={!q.isLoading && !q.isError}
      />
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState
          message="증빙 목록을 불러오지 못했습니다."
          onRetry={() => void q.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="subtle" style={{ margin: "8px 0 0" }}>
          표시할 증빙이 없습니다. 이미지나 동영상 증거는 아직 처리 중일 수
          있습니다.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>증빙</th>
                  <th>단계/시도</th>
                  <th>종류</th>
                  <th>파일명</th>
                  <th>파일 정보</th>
                  <th>처리 상태</th>
                  <th>보존 만료</th>
                  <th>보존 잠금</th>
                  <th>결과 보기</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => {
                  const kind = mediaKind(a);
                  const labels = mediaMetaLabels(a);
                  const isReadable = isArtifactReadable(a);
                  return (
                    <tr
                      key={a.artifact_id}
                      data-current={
                        a.artifact_id === effectiveSelectedId
                          ? "true"
                          : undefined
                      }
                    >
                      <td>
                        <span title="원문 증빙 번호">
                          {artifactLabel(a.artifact_id)}
                        </span>
                        <details className="developer-details">
                          <summary>증빙 번호 보기</summary>
                          <ArtifactRef id={a.artifact_id} />
                        </details>
                      </td>
                      <td>
                        {hasStepProvenance(a) ? (
                          <button
                            className="linklike"
                            type="button"
                            onClick={() =>
                              mergeParams({
                                step: a.step_id,
                                attempt:
                                  typeof a.attempt === "number"
                                    ? String(a.attempt)
                                    : null,
                              })
                            }
                          >
                            <span title={a.step_id}>{artifactProvenanceLabel(a)}</span>
                          </button>
                        ) : (
                          <span className="subtle">
                            {artifactProvenanceLabel(a)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span title={a.type}>
                            {artifactTypeLabel(a.type)}
                          </span>
                          {kind !== null && (
                            <span
                              className={`badge ${kind === "video" ? "amber" : "blue"}`}
                            >
                              {mediaKindLabel(kind)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td>{a.filename ?? "—"}</td>
                      <td>
                        {labels.length > 0 ? (
                          <span className="subtle">{labels.join(" · ")}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            className={`badge ${isReadable ? "green" : "amber"}`}
                            title="마스킹 처리 상태"
                          >
                            {redactionStatusLabel(a.redaction_status)}
                          </span>
                          {!isReadable && (
                            <span className="subtle">처리 대기</span>
                          )}
                        </span>
                      </td>
                      <td>{a.retention_until ?? "—"}</td>
                      <td>{a.legal_hold ? "예" : "—"}</td>
                      <td>
                        <button
                          className="btn"
                          type="button"
                          disabled={!isReadable}
                          title={
                            !isReadable
                              ? "처리가 완료되면 미리볼 수 있습니다."
                              : undefined
                          }
                          onClick={() => {
                            setSelectedId(a.artifact_id);
                            mergeParams({
                              artifact: a.artifact_id,
                              focus: "artifacts",
                            });
                          }}
                        >
                          {a.artifact_id === effectiveSelectedId
                            ? "선택됨"
                            : "미리보기"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(hasMoreArtifacts || loadingMore || loadMoreError !== null) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                className="btn"
                type="button"
                disabled={loadingMore || nextCursor === null}
                onClick={() => void loadMoreArtifacts()}
              >
                {loadingMore ? "불러오는 중" : "더 보기"}
              </button>
              {hasMoreArtifacts && (
                <span className="subtle">다음 증빙이 더 있습니다.</span>
              )}
              {loadMoreError !== null && (
                <span className="badge amber" role="status">
                  다음 페이지 로드 실패: {loadMoreError}
                </span>
              )}
            </div>
          )}
          {effectiveSelectedId !== null && (
            <div
              style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <strong style={{ fontSize: 13 }}>결과 미리보기</strong>
                <span className="subtle">
                  선택한 증빙 참조 번호 {shortId(effectiveSelectedId)}
                </span>
                {summary !== null && (
                  <span className="badge green">
                    {jsonSummaryLabel(summary.label)} {summary.count}건
                  </span>
                )}
                {summary !== null && summary.keys.length > 0 && (
                  <span className="subtle">
                    표시 항목 {summary.keys.join(", ")}
                  </span>
                )}
              </div>
              {selectedItem !== undefined && !selectedIsReadable ? (
                <p
                  className="subtle"
                  role="status"
                  style={{ margin: "8px 0 0" }}
                >
                  처리가 완료되면 미리볼 수 있습니다.
                </p>
              ) : detail.isLoading ? (
                <Loading />
              ) : detail.isError ? (
                <ErrorState
                  message="증빙 결과를 불러오지 못했습니다."
                  onRetry={() => void detail.refetch()}
                />
              ) : selectedItem !== undefined && selectedIsMedia ? (
                <ArtifactMediaPreview
                  artifactId={selectedItem.artifact_id}
                  mediaType={selectedMediaType}
                  filename={selectedItem.filename}
                />
              ) : detail.data !== undefined ? (
                summary !== null ? (
                  <JsonSummaryPreview summary={summary} />
                ) : (
                  <TextArtifactSummaryPreview content={detail.data.content} />
                )
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
