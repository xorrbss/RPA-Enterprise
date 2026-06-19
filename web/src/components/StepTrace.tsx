import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { useApiClient } from "../api/context";
import { StatusBadge, actionLabel, cacheLabel, isStreamWarning, streamStatusLabel } from "./badges";
import { ErrorState, Loading } from "./states";
import { ArtifactRef } from "./ArtifactLookup";
import { hhmmss } from "../util/time";
import type { StagehandCallSummary, StepSummary } from "../api/types";

const POLL_MS = 5_000; // 라이브 = outbox tail 폴링(v1)

// 증빙 칩 목록(카드/표 공용). 클릭 시 위 '산출물 조회' 자동 입력(A3, 현재 해시 파라미터 보존).
function ArtifactRefs({ ids }: { ids: readonly string[] }): JSX.Element {
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {ids.map((id) => <ArtifactRef key={id} id={id} />)}
    </span>
  );
}

// 비용 표기 — cost는 정밀도 보존을 위해 문자열(types). 단일 호출은 원본 문자열 그대로(가공/창작 금지),
// 다건은 합산하되 6자리 반올림이 0이면 '<0.000001'로 표기(0이 아닌 값을 $0.000000로 거짓표기하지 않는다).
function formatCost(calls: readonly StagehandCallSummary[]): string | null {
  const costs = calls.map((c) => c.cost).filter((c): c is string => c !== null);
  if (costs.length === 0) return null;
  if (costs.length === 1) return `$${costs[0]}`;
  const sum = costs.reduce((a, c) => a + Number(c), 0);
  if (sum === 0) return "$0";
  const rounded = Number(sum.toFixed(6));
  return rounded === 0 ? "$<0.000001" : `$${rounded}`;
}

// 단계 트레이스 — "자동화가 어떻게 판단·실행했고, 깨졌을 때 스스로 다시 시도했는지"를 보이는 서사.
// 모든 표시는 들어오는 신호(StepSummary + StagehandCallSummary)만 사용한다 — 확신도/판단근거 같은
// 데이터에 없는 값은 절대 지어내지 않는다(없으면 보이는 신호 조합으로만 구성).
export function StepTrace({ runId }: { runId: string }): JSX.Element {
  const api = useApiClient();
  const q = useQuery({
    queryKey: ["run-steps", runId],
    queryFn: () => api.listRunSteps(runId, { limit: 100 }),
    refetchInterval: POLL_MS,
  });
  const [view, setView] = useState<"cards" | "table">("cards");
  const items: readonly StepSummary[] = q.data?.items ?? [];
  // 절단 정직성(Dashboard.pageCount와 동일 규율): limit:100 페치라 100단계 초과 run은 next_cursor가 남는다.
  // 이때 페이지 길이를 총계처럼 보이지 않게 `N+` 하한으로 표기한다(조용한 false 금지). 비절단이면 정확한 N.
  const truncated = (q.data?.next_cursor ?? null) !== null;
  // 상대 길이 바 기준 = 최대 소요시간(0 division 방지).
  const maxDuration = Math.max(1, ...items.map((s) => s.duration_ms ?? 0));
  // 현재 실행 중인 단계(F1) — run_steps.status CHECK에서 비-터미널은 'started' 단 하나(migration_core_entities.sql:260-261).
  // run_steps는 (step_id, attempt)당 1행이고 재시도 시 동일 step_id가 여러 행으로 반환된다(reads.ts). 따라서 step_id만으로
  // 비교하면 이미 종료된 이전 attempt 행까지 '현재'로 거짓 강조된다 — 행-고유 복합키 `${step_id}:${attempt}`(카드/표 React key와 동일)로 매칭.
  // status==='started'인 마지막 행의 복합키, 없으면 null(전부 종료됨 → 거짓 현재단계를 만들지 않음, 조용한 false 금지).
  const live = items.filter((s) => s.status === "started").at(-1);
  const currentKey = live ? `${live.step_id}:${live.attempt}` : null;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>단계 트레이스</strong>
        {items.length > 0 && <span className="subtle">관찰된 {items.length}{truncated ? "+" : ""}개 단계</span>}
        <span style={{ flex: 1 }} />
        <TraceFreshness isFetching={q.isFetching} dataUpdatedAt={q.dataUpdatedAt} />
        {items.length > 0 && (
          <div role="group" aria-label="단계 보기 방식" style={{ display: "inline-flex", gap: 6 }}>
            <button className="btn" type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")}>카드</button>
            <button className="btn" type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>표</button>
          </div>
        )}
      </div>
      {items.length > 0 && <SelfHealSummary items={items} />}
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState message="단계 트레이스를 불러오지 못했습니다." onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <p className="subtle" style={{ margin: "8px 0 0" }}>
          기록된 단계가 없습니다. 실행이 아직 시작 전이거나 단계 기록이 없는 외부/초기 경로일 수 있습니다.
        </p>
      ) : view === "cards" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {items.map((s, i) => <StepCard key={`${s.step_id}:${s.attempt}`} step={s} index={i} maxDuration={maxDuration} isCurrent={`${s.step_id}:${s.attempt}` === currentKey} />)}
        </div>
      ) : (
        <StepTable items={items} maxDuration={maxDuration} currentKey={currentKey} />
      )}
    </div>
  );
}

// 트레이스-로컬 갱신 인디케이터(F2) — 전역 Freshness를 복제하지 않고 이 패널의 폴링 사실만 표시한다.
// isFetching=실제 폴링 진행(관찰값), dataUpdatedAt=react-query가 기록한 마지막 성공 fetch 시각(추정 아님).
function TraceFreshness({ isFetching, dataUpdatedAt }: { isFetching: boolean; dataUpdatedAt: number }): JSX.Element {
  return (
    <span className="freshness" role="status" aria-live="polite">
      {isFetching ? (
        <>
          <span className="now-dot" aria-hidden="true" /> 갱신 중…
        </>
      ) : dataUpdatedAt > 0 ? (
        `갱신 ${hhmmss(new Date(dataUpdatedAt))}`
      ) : null}
    </span>
  );
}

// 자동 복구 요약(P0-2 "한눈에") — 단계 기록에서 관찰된 복구 신호만 집계한다(데이터에 없는 값 창작 금지):
//   다시 시도(attempt>0) · 캐시된 계획 재생(hit + LLM 호출 0) · 비정상 응답 종료(stream_status 비-정상).
// 신호가 하나도 없으면 배너를 그리지 않는다(없는 복구를 있는 척하지 않음). 범위 라벨로 출처를 명시한다.
// 주의: 세션 재사용(로그인 스킵)은 run 레벨 seam이라 단계 신호가 없다 — 짧은 트레이스(로그인 단계 부재) 자체가 증거이며
//   여기서 별도 배지로 단정하지 않는다(조용한 false 금지).
function SelfHealSummary({ items }: { items: readonly StepSummary[] }): JSX.Element | null {
  const retries = items.filter((s) => s.attempt > 0).length;
  const cacheReplays = items.filter((s) => s.cache_mode === "hit" && s.stagehand_calls.length === 0).length;
  const streamWarnings = items.filter((s) => s.stagehand_calls.some((c) => isStreamWarning(c.stream_status))).length;
  const signals: string[] = [];
  if (retries > 0) signals.push(`다시 시도 ${retries}개 단계`);
  if (cacheReplays > 0) signals.push(`캐시 계획 재생 ${cacheReplays}개 단계`);
  if (streamWarnings > 0) signals.push(`비정상 응답 종료 ${streamWarnings}건`);
  if (signals.length === 0) return null;
  return (
    <div className="badge amber" role="status" style={{ display: "block", margin: "8px 0 0", whiteSpace: "normal" }}>
      이 실행의 단계 기록에서 관찰된 자동 복구 — {signals.join(" · ")}
    </div>
  );
}

// 단계 카드(서사) — 동작/상태 + 재시도 + AI 판단(모델·토큰·비용) + 예외 + 증빙.
// isCurrent: status==='started'로 도출된 '지금 실행 중'(F1) — 테두리 강조 + '진행 중' 칩.
function StepCard({ step: s, index, maxDuration, isCurrent }: { step: StepSummary; index: number; maxDuration: number; isCurrent: boolean }): JSX.Element {
  return (
    <div className={`step-card${isCurrent ? " current" : ""}`}>
      <div className="step-card-head">
        <span className="subtle" style={{ minWidth: 22 }}>#{index + 1}</span>
        <code>{s.node_id}</code>
        <strong>{actionLabel(s.action)}</strong>
        {isCurrent && (
          <span className="now-chip" title="이 단계가 지금 실행 중입니다.">
            <span className="now-dot" aria-hidden="true" /> 진행 중
          </span>
        )}
        <span style={{ flex: 1 }} />
        {s.attempt > 0 && (
          <span className="retry-chip" title="앞선 시도가 실패해 자동으로 다시 시도했습니다.">
            <RefreshCw size={12} aria-hidden="true" /> 재시도 {s.attempt}회차
          </span>
        )}
        <StatusBadge status={s.status} />
      </div>
      <DurationBar durationMs={s.duration_ms} maxDuration={maxDuration} />
      <AiJudgment calls={s.stagehand_calls} cacheMode={s.cache_mode} />
      {s.exception !== null && (
        <div className="step-line">
          <span className="subtle">예외</span>
          <span className="badge red">{s.exception.code}</span>
          <span className="subtle">{s.exception.class}</span>
        </div>
      )}
      {s.artifact_ids.length > 0 && (
        <div className="step-line">
          <span className="subtle">증빙</span>
          <ArtifactRefs ids={s.artifact_ids} />
        </div>
      )}
    </div>
  );
}

// AI 판단 — stagehand 호출이 있는 단계만. 모델·토큰·비용·첫응답은 모두 실제 필드. 토큰은 보고된 값만 합산하되,
// 일부만 보고되면(다건 partial-null) 합계를 완전한 총계처럼 보이지 않게 '≥N' 하한으로, 전부 미보고면 '—'로 표기한다
// (조용한 false/unknown 금지). 호출이 없으면 캐시 적중(=AI 계획 재생)과 그 외(=AI 호출 없음)를 구분한다.
function tokenText(values: readonly (number | null)[]): string {
  if (!values.some((v) => v !== null)) return "—"; // 전부 미보고
  const sum = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  return values.every((v) => v !== null) ? String(sum) : `≥${sum}`; // 일부 미보고 → 하한
}
function AiJudgment({ calls, cacheMode }: { calls: readonly StagehandCallSummary[]; cacheMode: string }): JSX.Element {
  if (calls.length === 0) {
    // 캐시 hit = 이전에 AI가 도출한 plan을 LLM 호출 없이 재생(impl-contracts §D) — 'AI 미사용'으로 단정하지 않는다.
    const text = cacheMode === "hit" ? "캐시된 계획 재생 (이번 단계 AI 호출 없음)" : "AI 호출 없음";
    return (
      <div className="step-line">
        <span className="subtle">실행</span>
        <span>{text}</span>
        <span className="badge muted">{cacheLabel(cacheMode)}</span>
      </div>
    );
  }
  const models = [...new Set(calls.map((c) => c.model))].join(", ");
  const anyTok = calls.some((c) => c.input_tokens !== null || c.output_tokens !== null);
  const cost = formatCost(calls);
  const single = calls.length === 1 ? calls[0]! : null;
  // 비정상 응답 종료(잘림/필터/오류) — 관찰된 stream_status 만, 정상 종료는 표기하지 않는다(노이즈 방지·창작 금지).
  const warnings = [...new Set(calls.map((c) => c.stream_status).filter((s): s is string => isStreamWarning(s)))];
  return (
    <div className="step-line">
      <span className="subtle">AI 판단</span>
      <span>{models}{calls.length > 1 ? ` (${calls.length}회 호출)` : ""}</span>
      {anyTok && <span className="subtle">입력 {tokenText(calls.map((c) => c.input_tokens))} · 출력 {tokenText(calls.map((c) => c.output_tokens))} 토큰</span>}
      {cost !== null && <span className="subtle">{cost}</span>}
      {single?.ttfb_ms != null && <span className="subtle">첫응답 {single.ttfb_ms}ms</span>}
      {warnings.map((w) => (
        <span key={w} className="badge amber" title="응답이 정상 종료되지 않았습니다(관찰된 신호).">응답 {streamStatusLabel(w)}</span>
      ))}
      <span className="badge muted">{cacheLabel(cacheMode)}</span>
    </div>
  );
}

// 소요시간 상대 길이 바(B2) — 바는 장식(aria-hidden), 정확한 ms는 텍스트로 함께 노출(조용한 false 금지).
function DurationBar({ durationMs, maxDuration }: { durationMs: number | null; maxDuration: number }): JSX.Element {
  const pct = durationMs !== null ? Math.max(2, Math.round((durationMs / maxDuration) * 100)) : 0;
  return (
    <div className="dur-row">
      <div className="dur-track" aria-hidden="true">
        {durationMs !== null && <div className="dur-fill" style={{ width: `${pct}%` }} />}
      </div>
      <span className="subtle dur-num">{durationMs !== null ? `${durationMs}ms` : "—"}</span>
    </div>
  );
}

// 표 보기(밀집 정보 선호) — 한국어 라벨 + 소요 바 + 클릭 가능한 증빙. currentKey(행-고유 복합키) 행만 data-current(td 배경 강조, F1).
function StepTable({ items, maxDuration, currentKey }: { items: readonly StepSummary[]; maxDuration: number; currentKey: string | null }): JSX.Element {
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table>
        <thead>
          <tr>
            <th>#</th><th>노드</th><th>동작</th><th>상태</th><th>캐시</th><th>소요</th><th>AI(모델·출력토큰)</th><th>증빙</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s, i) => {
            const calls = s.stagehand_calls;
            const outText = tokenText(calls.map((c) => c.output_tokens)); // '—'/'N'/'≥N'
            return (
              <tr key={`${s.step_id}:${s.attempt}`} data-current={`${s.step_id}:${s.attempt}` === currentKey ? "true" : undefined}>
                <td>{i + 1}{s.attempt > 0 ? <span className="subtle"> ·재{s.attempt}</span> : null}</td>
                <td><code>{s.node_id}</code></td>
                <td>{actionLabel(s.action)}</td>
                <td>
                  <StatusBadge status={s.status} />
                  {s.exception !== null && <span className="subtle"> {s.exception.code}</span>}
                </td>
                <td>{cacheLabel(s.cache_mode)}</td>
                <td style={{ minWidth: 120 }}><DurationBar durationMs={s.duration_ms} maxDuration={maxDuration} /></td>
                <td>{calls.length > 0 ? <span className="subtle">{calls[0]!.model}{outText !== "—" ? ` · ${outText}tok` : ""}</span> : "—"}</td>
                <td>{s.artifact_ids.length > 0 ? <ArtifactRefs ids={s.artifact_ids} /> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
