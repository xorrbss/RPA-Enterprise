import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ROLE_LABELS } from "../api/permissions";
import type { AuditLogExportParams, AuditOutcome } from "../api/types";
import { ErrorState, Loading } from "../components/states";
import { mergeParams, useHashParam } from "../router";

const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  allow: "허용",
  deny: "거부",
  blocked: "차단",
  error: "오류",
};

const ACTION_LABEL: Record<string, string> = {
  "artifact.read": "증빙 조회",
  "approval.decide": "결재 처리",
  "human_task.assign": "확인 업무 배정",
  "human_task.resolve": "확인 업무 완료",
  "run.abort": "자동화 중단",
  "run.create": "자동화 실행 시작",
  "scenario.promote": "운영 버전 지정",
  "site.approve": "업무 사이트 승인",
};

function outcomeTone(outcome: AuditOutcome): string {
  if (outcome === "allow") return "green";
  if (outcome === "deny" || outcome === "blocked") return "red";
  return "amber";
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? "기록된 업무";
}

function actionFilterText(value: string | null): string {
  if (value === null) return "";
  return ACTION_LABEL[value] ?? value;
}

function actionFilterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const match = Object.entries(ACTION_LABEL).find(
    ([raw, label]) => raw === trimmed || label === trimmed,
  );
  return match?.[0] ?? trimmed;
}

function permissionScopeText(roles: readonly string[]): string {
  const labels = roles.map((role) => ROLE_LABELS[role] ?? role);
  return labels.length > 0 ? labels.join(", ") : "권한 범위 미확인";
}

function actorLabel(value: string | null): string {
  return value === null ? "담당자 미확인" : "처리자 확인됨";
}

function traceLabel(): string {
  return "요청 추적 가능";
}

function hashStateLabel(value: string | null): string {
  return value === null ? "첫 감사 기록" : "이전 기록과 연결됨";
}

function dateLabel(value: string | null): string {
  if (value === null) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function outcomeFromHash(value: string | null): "all" | AuditOutcome {
  if (value === "allow" || value === "deny" || value === "blocked" || value === "error") return value;
  return "all";
}

export function AuditExplorerView(): JSX.Element {
  const api = useApiClient();
  const hashAction = useHashParam("action");
  const hashOutcome = useHashParam("outcome");
  const hashActor = useHashParam("actor");
  const hashCorrelationId = useHashParam("correlation_id");
  const [action, setAction] = useState(() => actionFilterText(hashAction));
  const [outcome, setOutcome] = useState<"all" | AuditOutcome>(() => outcomeFromHash(hashOutcome));
  const [actor, setActor] = useState(hashActor ?? "");
  const [correlationId, setCorrelationId] = useState(hashCorrelationId ?? "");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [exportState, setExportState] = useState<"idle" | "pending" | "success" | "error">("idle");

  const params = useMemo(
    () => {
      const actionValue = actionFilterValue(action);
      return {
        limit: 50,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(actionValue.length > 0 ? { action: actionValue } : {}),
        ...(outcome !== "all" ? { outcome } : {}),
        ...(actor.trim().length > 0 ? { actor: actor.trim() } : {}),
        ...(correlationId.trim().length > 0 ? { correlation_id: correlationId.trim() } : {}),
      };
    },
    [action, actor, correlationId, cursor, outcome],
  );

  const q = useQuery({
    queryKey: ["audit-log", params],
    queryFn: () => api.listAuditLog(params),
    refetchInterval: 15_000,
  });

  const items = q.data?.items ?? [];

  const exportParams = useMemo<AuditLogExportParams>(
    () => {
      const actionValue = actionFilterValue(action);
      return {
        limit: 200,
        format: "csv",
        ...(actionValue.length > 0 ? { action: actionValue } : {}),
        ...(outcome !== "all" ? { outcome } : {}),
        ...(actor.trim().length > 0 ? { actor: actor.trim() } : {}),
        ...(correlationId.trim().length > 0 ? { correlation_id: correlationId.trim() } : {}),
      };
    },
    [action, actor, correlationId, outcome],
  );

  function resetCursor(): void {
    setCursor(undefined);
  }

  function setFilter(next: { action?: string; outcome?: "all" | AuditOutcome; actor?: string; correlationId?: string }): void {
    if (next.action !== undefined) setAction(next.action);
    if (next.outcome !== undefined) setOutcome(next.outcome);
    if (next.actor !== undefined) setActor(next.actor);
    if (next.correlationId !== undefined) setCorrelationId(next.correlationId);
    resetCursor();
    mergeParams({
      ...(next.action !== undefined ? { action: next.action.trim().length > 0 ? next.action.trim() : null } : {}),
      ...(next.outcome !== undefined ? { outcome: next.outcome !== "all" ? next.outcome : null } : {}),
      ...(next.actor !== undefined ? { actor: next.actor.trim().length > 0 ? next.actor.trim() : null } : {}),
      ...(next.correlationId !== undefined ? { correlation_id: next.correlationId.trim().length > 0 ? next.correlationId.trim() : null } : {}),
    });
  }

  async function exportCsv(): Promise<void> {
    setExportState("pending");
    try {
      const csv = await api.exportAuditLogCsv(exportParams);
      downloadCsv(csv, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
      setExportState("success");
    } catch {
      setExportState("error");
    }
  }

  useEffect(() => {
    const next = actionFilterText(hashAction);
    if (next !== action) {
      setAction(next);
      resetCursor();
    }
  }, [hashAction]);

  useEffect(() => {
    const next = outcomeFromHash(hashOutcome);
    if (next !== outcome) {
      setOutcome(next);
      resetCursor();
    }
  }, [hashOutcome]);

  useEffect(() => {
    const next = hashActor ?? "";
    if (next !== actor) {
      setActor(next);
      resetCursor();
    }
  }, [hashActor]);

  useEffect(() => {
    const next = hashCorrelationId ?? "";
    if (next !== correlationId) {
      setCorrelationId(next);
      resetCursor();
    }
  }, [hashCorrelationId]);

  return (
    <div className="audit-view">
      <section className="panel audit-filters" aria-label="감사 기록 필터">
        <div className="panel-head">
          <h2>감사 기록 조회</h2>
          <span className="badge blue">민감정보 숨김</span>
        </div>
        <div className="form-grid audit-filter-grid">
          <label className="field">
            <span>업무</span>
            <input list="audit-action-options" value={action} placeholder="예: 증빙 조회, 실행 시작" onChange={(event) => { setFilter({ action: event.target.value }); }} />
            <datalist id="audit-action-options">
              {Object.values(ACTION_LABEL).map((label) => <option key={label} value={label} />)}
            </datalist>
          </label>
          <label className="field">
            <span>결과</span>
            <select value={outcome} onChange={(event) => { setFilter({ outcome: event.target.value as "all" | AuditOutcome }); }}>
              <option value="all">전체</option>
              <option value="allow">허용</option>
              <option value="deny">거부</option>
              <option value="blocked">차단</option>
              <option value="error">오류</option>
            </select>
          </label>
          <label className="field">
            <span>처리자</span>
            <input value={actor} placeholder="계정 또는 담당자" onChange={(event) => { setFilter({ actor: event.target.value }); }} />
          </label>
          <label className="field">
            <span>추적 번호</span>
            <input value={correlationId} placeholder="예: 요청-123" onChange={(event) => { setFilter({ correlationId: event.target.value }); }} />
          </label>
        </div>
      </section>

      <section className="panel" aria-label="감사 기록 목록">
        <div className="panel-head">
          <h2>업무 감사 이력</h2>
          <div className="inline-actions">
            <button className="btn" type="button" onClick={() => void q.refetch()}>새로고침</button>
            <button className="btn" type="button" disabled={exportState === "pending"} onClick={() => void exportCsv()}>
              {exportState === "pending" ? "준비 중" : "CSV 내보내기(최대 200건)"}
            </button>
            <button className="btn" type="button" disabled={q.data?.next_cursor === null || q.data?.next_cursor === undefined} onClick={() => setCursor(q.data?.next_cursor ?? undefined)}>
              다음
            </button>
          </div>
        </div>
        {exportState === "success" && <p className="notice success" role="status">감사 기록 CSV를 준비했습니다. 현재 필터 기준 최대 200건입니다.</p>}
        {exportState === "error" && <p className="form-alert red" role="alert">감사 기록 CSV를 준비하지 못했습니다.</p>}
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState message="감사 기록을 불러오지 못했습니다." onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <p className="empty-state">조건에 맞는 감사 기록이 없습니다.</p>
        ) : (
          <div className="table-wrap">
            <table className="ops-table audit-table">
              <thead>
                <tr>
                  <th scope="col">순번/시각</th>
                  <th scope="col">업무</th>
                  <th scope="col">결과</th>
                  <th scope="col">처리자</th>
                  <th scope="col">추적 번호</th>
                  <th scope="col">무결성</th>
                  <th scope="col">보존</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.audit_id}>
                    <th scope="row">
                      <span>#{item.sequence_no}</span>
                      <span className="subtle">{dateLabel(item.occurred_at)}</span>
                    </th>
                    <td>
                      <span>{actionLabel(item.action)}</span>
                      <details className="audit-technical-details">
                        <summary>감사 세부 정보 보기</summary>
                        <dl>
                          <dt>원문 이벤트명</dt>
                          <dd>
                            <code>{item.action}</code>
                          </dd>
                          {item.reason !== null && (
                            <>
                              <dt>처리 사유</dt>
                              <dd>{item.reason}</dd>
                            </>
                          )}
                        </dl>
                      </details>
                    </td>
                    <td><span className={`badge ${outcomeTone(item.outcome)}`}>{OUTCOME_LABEL[item.outcome]}</span></td>
                    <td>
                      <span title={item.actor.subject_id === null ? undefined : `처리자 식별값: ${item.actor.subject_id}`}>{actorLabel(item.actor.subject_id)}</span>
                      <span className="subtle">권한 범위 {permissionScopeText(item.actor.roles)}</span>
                    </td>
                    <td><span title={`요청 추적 번호: ${item.correlation_id}`}>{traceLabel()}</span></td>
                    <td>
                      <span>{hashStateLabel(item.hash)}</span>
                      <details className="audit-technical-details">
                        <summary>무결성 세부값 보기</summary>
                        <dl>
                          <dt>현재 검증값</dt>
                          <dd>
                            <code>{item.hash}</code>
                          </dd>
                          <dt>이전 검증값</dt>
                          <dd>
                            {item.previous_hash === null ? (
                              <span>첫 기록</span>
                            ) : (
                              <code>{item.previous_hash}</code>
                            )}
                          </dd>
                        </dl>
                      </details>
                    </td>
                    <td>
                      <span>{dateLabel(item.retention_until)}</span>
                      {item.legal_hold && <span className="badge amber">보존 잠금</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function downloadCsv(csv: string, filename: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
