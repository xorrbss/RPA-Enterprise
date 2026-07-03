import type { AiGovernanceEvidence } from "../../api/types";
import { errorLabel } from "../../components/badges";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { formatDateTime } from "../orchestration/format";
import {
  evidenceStatusLabel,
  evidenceStatusTone,
  evidenceTypeLabel,
  metadataSummary,
  refText,
  safeText,
} from "./ai-governance-evidence-shared";

export function EvidenceTable({
  queryState,
  items,
}: {
  queryState: { readonly isLoading: boolean; readonly isError: boolean; readonly error: unknown; readonly refetch: () => unknown };
  items: readonly AiGovernanceEvidence[];
}): JSX.Element {
  if (queryState.isLoading) return <Loading />;
  if (queryState.isError) return <ErrorState message={errorLabel(queryState.error)} onRetry={() => void queryState.refetch()} />;
  if (items.length === 0) return <EmptyState message="현재 필터에 맞는 AI 거버넌스 증빙이 없습니다." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>종류</th>
            <th>상태</th>
            <th>대상</th>
            <th>증빙</th>
            <th>정책·감사</th>
            <th>기록</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.evidence_id}>
              <td>
                <span className="badge blue">{evidenceTypeLabel(item.evidence_type)}</span>
              </td>
              <td>
                <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              </td>
              <td>
                <code>{safeText(item.subject_ref)}</code>
              </td>
              <td>
                <strong style={{ display: "block", overflowWrap: "anywhere" }}>{safeText(item.summary)}</strong>
                <span className="subtle" style={{ display: "block" }}>
                  증빙 {refText(item.evidence_ref)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  {metadataSummary(item)}
                </span>
              </td>
              <td>
                <span className="subtle" style={{ display: "block" }}>
                  정책 {refText(item.policy_decision_ref)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  감사 {refText(item.audit_correlation_id)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  만료 {formatDateTime(item.expires_at)}
                </span>
              </td>
              <td>
                <span className="subtle" style={{ display: "block" }}>
                  {formatDateTime(item.recorded_at)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  처리자 {safeText(item.recorded_by)}
                </span>
                {item.legal_hold ? <span className="badge amber">법적 보존</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvidenceTile({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  tone: "green" | "blue" | "amber" | "red" | "muted";
}): JSX.Element {
  return (
    <div className="ops-health-tile">
      <span className="subtle">{title}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{detail}</span>
    </div>
  );
}
