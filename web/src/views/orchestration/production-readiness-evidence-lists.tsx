import type { AiGovernanceReadinessRequirement, ProductionReadinessEvidence } from "../../api/types";
import {
  evidenceTypeLabel,
  openRequirements,
  requirementStatusLabel,
  requirementStatusTone,
} from "../security/ai-governance-evidence-shared";
import { formatDateTime } from "./format";
import {
  deliveryStatusText,
  evidenceRefText,
  evidenceStatusLabel,
  evidenceStatusTone,
  evidenceSummaryText,
  expiresText,
  metadataPercentText,
  metadataText,
} from "./production-readiness-labels";

export function BackupEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>백업/PITR 증빙</strong>
        <span className="subtle">증빙 장부를 불러오지 못했습니다.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>백업/PITR 증빙</strong>
        <span className="subtle">담당자 증빙 확인 중</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>백업/PITR 증빙</strong>
        <span className="subtle">복구 리허설 증빙이 아직 없습니다.</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>백업/PITR 증빙</strong>
        <span className="subtle">최근 {items.length}건</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{evidenceSummaryText(item.summary)}</strong>
            <span className="subtle">{evidenceRefText(item.evidence_ref)}</span>
            <span className="subtle">
              정책 {metadataText(item.metadata.backup_policy_ref)} · 범위 {metadataText(item.metadata.restore_scope)}
            </span>
            <span className="subtle">
              목표 복구 시간 {metadataText(item.metadata.rto_minutes)}분 · 목표 복구 시점 {metadataText(item.metadata.rpo_minutes)}분 · 복구 완료 {metadataText(item.metadata.restore_completed_at)}
            </span>
            <span className="subtle">{expiresText(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExternalAlertEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>외부 알림 증빙</strong>
        <span className="subtle">증빙 장부를 불러오지 못했습니다.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>외부 알림 증빙</strong>
        <span className="subtle">제공자 전달 증빙 확인 중</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>외부 알림 증빙</strong>
        <span className="subtle">전달 리허설 증빙이 아직 없습니다.</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>외부 알림 증빙</strong>
        <span className="subtle">최근 {items.length}건</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{evidenceSummaryText(item.summary)}</strong>
            <span className="subtle">{evidenceRefText(item.evidence_ref)}</span>
            <span className="subtle">
              채널 {metadataText(item.metadata.channel)} · 제공자 {metadataText(item.metadata.provider_alias)} · 상태 {deliveryStatusText(item.metadata.delivery_status)}
            </span>
            <span className="subtle">
              접수 번호 {metadataText(item.metadata.receipt_id)} · 접수 시각 {metadataText(item.metadata.receipt_at)}
            </span>
            <span className="subtle">{expiresText(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SloEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>SLO·당직 증빙</strong>
        <span className="subtle">증빙 장부를 불러오지 못했습니다.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>SLO·당직 증빙</strong>
        <span className="subtle">담당자 증빙 확인 중</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>SLO·당직 증빙</strong>
        <span className="subtle">담당자 승인 증빙이 아직 없습니다.</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>SLO·당직 증빙</strong>
        <span className="subtle">최근 {items.length}건</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{evidenceSummaryText(item.summary)}</strong>
            <span className="subtle">{evidenceRefText(item.evidence_ref)}</span>
            <span className="subtle">
              대시보드 {metadataText(item.metadata.slo_dashboard)} · 심각도 {metadataText(item.metadata.severity_model)} · 당직 {metadataText(item.metadata.oncall_rota)}
            </span>
            <span className="subtle">
              RACI {metadataText(item.metadata.raci_ref)} · 지원 시간 {metadataText(item.metadata.support_hours)}
            </span>
            <span className="subtle">{expiresText(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SupportTrainingEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>지원·교육 증빙</strong>
        <span className="subtle">증빙 장부를 불러오지 못했습니다.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>지원·교육 증빙</strong>
        <span className="subtle">지원 준비 증빙 확인 중</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>지원·교육 증빙</strong>
        <span className="subtle">지원 모델 또는 교육 완료 증빙이 아직 없습니다.</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>지원·교육 증빙</strong>
        <span className="subtle">최근 {items.length}건</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{evidenceSummaryText(item.summary)}</strong>
            <span className="subtle">{evidenceRefText(item.evidence_ref)}</span>
            <span className="subtle">
              지원 모델 {metadataText(item.metadata.support_model_ref)} · 교육 완료 {metadataText(item.metadata.training_completion_ref)}
            </span>
            <span className="subtle">
              역할 {metadataText(item.metadata.trained_role_count)}개 · 사용자 {metadataText(item.metadata.trained_user_count)}명 · 이수율 {metadataPercentText(item.metadata.coverage_percent)}
            </span>
            <span className="subtle">완료 시각 {metadataText(item.metadata.completed_at)}</span>
            <span className="subtle">{expiresText(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ObservabilityEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>관측성 증빙</strong>
        <span className="subtle">증빙 장부를 불러오지 못했습니다.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>관측성 증빙</strong>
        <span className="subtle">텔레메트리 증빙 확인 중</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>관측성 증빙</strong>
        <span className="subtle">텔레메트리 연결 증빙이 아직 없습니다.</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>관측성 증빙</strong>
        <span className="subtle">최근 {items.length}건</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{evidenceSummaryText(item.summary)}</strong>
            <span className="subtle">{evidenceRefText(item.evidence_ref)}</span>
            <span className="subtle">
              내보내기 {metadataText(item.metadata.exporter)} · 수집기 {metadataText(item.metadata.collector_ref)}
            </span>
            <span className="subtle">
              대시보드 {metadataText(item.metadata.dashboard_ref)} · 알림 경로 {metadataText(item.metadata.alert_route_ref)}
            </span>
            <span className="subtle">샘플링 {metadataText(item.metadata.sampled_at)}</span>
            <span className="subtle">{expiresText(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * AI 운영 정책 게이트가 대조하는 요구 증빙(대상 참조까지) 노출.
 * 서버 signals에는 있었지만 화면에 없어서, 운영자가 어떤 대상 참조로 증빙을 넣어야 게이트가 닫히는지 알 수 없었다.
 * 요구가 없거나(정책 미설정·AI 미사용) 전부 충족이면 아무것도 그리지 않는다.
 */
export function AiGovernanceRequirementList({
  requirements,
}: {
  requirements: readonly AiGovernanceReadinessRequirement[] | undefined;
}): JSX.Element | null {
  const open = openRequirements(requirements);
  if (open.length === 0) return null;
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>AI 운영 정책 요구 증빙</strong>
        <span className="subtle">{open.length}건 미충족</span>
      </div>
      <p className="subtle" style={{ margin: "0 0 8px" }}>
        보안 &gt; AI 거버넌스 증빙에서 아래 대상 참조 그대로 기록해야 이 게이트가 닫힙니다.
      </p>
      <ul className="production-readiness-evidence-list">
        {open.map((item) => (
          <li key={`${item.evidence_type}:${item.subject_ref}`}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${requirementStatusTone(item.status)}`}>{requirementStatusLabel(item.status)}</span>
              <span className="subtle">{evidenceTypeLabel(item.evidence_type)}</span>
            </div>
            <code>{item.subject_ref}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
