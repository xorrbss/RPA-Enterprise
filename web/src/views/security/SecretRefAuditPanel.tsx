import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ROLE_LABELS } from "../../api/permissions";
import type { AuditLogItem, AuditOutcome } from "../../api/types";
import { ReadinessMetric } from "./shared";

interface SecretRefAuditSummary {
  readonly total: number;
  readonly allowed: number;
  readonly deniedOrBlocked: number;
  readonly errors: number;
  readonly latestAt: string | null;
  readonly latestOutcome: AuditOutcome | null;
  readonly actorCount: number;
  readonly hashLinked: number;
}

export function SecretRefAuditPanel(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["secret-ref-audit-summary"],
    queryFn: () => api.listAuditLog({ action: "secret.resolve", limit: 100 }),
    refetchInterval: 30_000,
  });
  const items = query.data?.items ?? [];
  const summary = useMemo(() => summarizeSecretRefAudit(items), [items]);
  const recent = items.slice(0, 5);

  return (
    <section className="panel" aria-label="SecretRef 감사 요약" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>SecretRef 감사 요약</h2>
        <div className="inline-actions">
          <span className={`badge ${summary.deniedOrBlocked > 0 || summary.errors > 0 ? "amber" : "blue"}`}>
            최근 {summary.total}건
          </span>
          <button className="btn" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
            새로고침
          </button>
          <a className="btn" href="#auditExplorer?action=secret.resolve">
            감사 이력
          </a>
        </div>
      </div>
      {query.isLoading ? (
        <p className="subtle security-connection-state">SecretRef 사용 감사 기록을 확인하는 중입니다.</p>
      ) : query.isError ? (
        <p className="form-alert red" role="alert">SecretRef 감사 요약을 불러오지 못했습니다.</p>
      ) : summary.total === 0 ? (
        <p className="empty-state">최근 SecretRef 사용 감사 기록이 없습니다.</p>
      ) : (
        <div className="secret-audit">
          <div className="summary-grid">
            <ReadinessMetric label="허용" value={`${summary.allowed}건`} tone="green" />
            <ReadinessMetric label="거부·차단" value={`${summary.deniedOrBlocked}건`} tone={summary.deniedOrBlocked > 0 ? "red" : "green"} />
            <ReadinessMetric label="오류" value={`${summary.errors}건`} tone={summary.errors > 0 ? "red" : "green"} />
            <ReadinessMetric label="마지막 사용" value={summary.latestAt === null ? "-" : formatAuditTime(summary.latestAt)} tone={summary.latestOutcome === "allow" ? "green" : "amber"} />
            <ReadinessMetric label="처리자 범위" value={`${summary.actorCount}명`} tone="blue" />
            <ReadinessMetric label="무결성" value={`${summary.hashLinked}/${summary.total}건`} tone={summary.hashLinked === summary.total ? "green" : "amber"} />
          </div>
          <p className="subtle secret-audit-note">평문 비밀값과 audit payload 본문은 표시하지 않습니다.</p>
          <div className="table-wrap">
            <table className="ops-table audit-table">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">결과</th>
                  <th scope="col">처리자</th>
                  <th scope="col">추적 번호</th>
                  <th scope="col">무결성</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((item) => (
                  <tr key={item.audit_id}>
                    <th scope="row">
                      <span>{formatAuditTime(item.occurred_at)}</span>
                    </th>
                    <td><span className={`badge ${secretAuditOutcomeTone(item.outcome)}`}>{secretAuditOutcomeLabel(item.outcome)}</span></td>
                    <td>
                      <span>{secretAuditActorLabel(item.actor.subject_id)}</span>
                      <span className="subtle">{secretAuditRoleLabel(item.actor.roles)}</span>
                    </td>
                    <td><span title={`요청 추적 번호: ${item.correlation_id}`}>요청 추적 가능</span></td>
                    <td>
                      <span>{item.previous_hash === null ? "첫 감사 기록" : "이전 기록과 연결됨"}</span>
                      <details className="audit-technical-details">
                        <summary>검증값 보기</summary>
                        <dl>
                          <dt>현재 검증값</dt>
                          <dd><code>{item.hash}</code></dd>
                          <dt>이전 검증값</dt>
                          <dd>{item.previous_hash === null ? "첫 기록" : <code>{item.previous_hash}</code>}</dd>
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function secretAuditActorLabel(value: string | null): string {
  return value === null ? "처리자 미확인" : "처리자 확인됨";
}

function secretAuditRoleLabel(roles: readonly string[]): string {
  const labels = roles.map((role) => ROLE_LABELS[role] ?? "등록 외 역할");
  return labels.length > 0 ? labels.join(", ") : "역할 미확인";
}

function summarizeSecretRefAudit(items: readonly AuditLogItem[]): SecretRefAuditSummary {
  const actors = new Set<string>();
  let allowed = 0;
  let deniedOrBlocked = 0;
  let errors = 0;
  let hashLinked = 0;
  let latestAt: string | null = null;
  let latestOutcome: AuditOutcome | null = null;

  for (const item of items) {
    if (item.actor.subject_id !== null) actors.add(item.actor.subject_id);
    if (item.outcome === "allow") allowed += 1;
    if (item.outcome === "deny" || item.outcome === "blocked") deniedOrBlocked += 1;
    if (item.outcome === "error") errors += 1;
    if (item.hash.length > 0) hashLinked += 1;
    if (latestAt === null || new Date(item.occurred_at).getTime() > new Date(latestAt).getTime()) {
      latestAt = item.occurred_at;
      latestOutcome = item.outcome;
    }
  }

  return {
    total: items.length,
    allowed,
    deniedOrBlocked,
    errors,
    latestAt,
    latestOutcome,
    actorCount: actors.size,
    hashLinked,
  };
}

function secretAuditOutcomeTone(outcome: AuditOutcome): string {
  if (outcome === "allow") return "green";
  if (outcome === "deny" || outcome === "blocked") return "red";
  return "amber";
}

function secretAuditOutcomeLabel(outcome: AuditOutcome): string {
  if (outcome === "allow") return "허용";
  if (outcome === "deny") return "거부";
  if (outcome === "blocked") return "차단";
  return "오류";
}

function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}
