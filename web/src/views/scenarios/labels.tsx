import { formatDateTime } from "../../util/time";
import type { ScenarioCertification } from "../../api/types";

export function CertificationBadge(props: { certification?: ScenarioCertification | null }): JSX.Element {
  const certification = props.certification;
  if (certification === undefined || certification === null) {
    return <span className="badge amber" title="API 응답에 인증 상태가 없습니다.">인증 미확인</span>;
  }
  if (certification.status === "certified" && certification.valid_for_prod) {
    return (
      <span className="badge green" title={certification.reason ?? "운영 인증됨"}>
        인증됨
      </span>
    );
  }
  if (certification.status === "certified") {
    return (
      <span className="badge amber" title={certification.expires_at !== null ? `만료: ${formatDateTime(certification.expires_at)}` : "운영 인증 유효성 확인 필요"}>
        만료
      </span>
    );
  }
  if (certification.status === "revoked") {
    return <span className="badge red" title={certification.revoke_reason ?? "운영 인증 취소됨"}>취소됨</span>;
  }
  return <span className="badge muted">미인증</span>;
}

export function environmentLabel(environment: string): string {
  const labels: Record<string, string> = {
    dev: "개발",
    staging: "스테이징",
    prod: "운영",
  };
  return labels[environment] ?? environment;
}

export function releaseLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: "초안",
    submitted: "승인 대기",
    approved: "승인됨",
    rejected: "반려됨",
    deployed: "배포됨",
    rolled_back: "롤백됨",
    cancelled: "취소됨",
  };
  return labels[status] ?? status;
}

export function releaseTone(status: string): "green" | "amber" | "red" | "muted" {
  if (status === "deployed" || status === "approved") return "green";
  if (status === "submitted" || status === "draft") return "amber";
  if (status === "rejected") return "red";
  return "muted";
}
