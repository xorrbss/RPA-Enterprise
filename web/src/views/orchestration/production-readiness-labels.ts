import type {
  ProductionReadinessEvidenceStatus,
  ProductionReadinessGate,
  ProductionReadinessGateStatus,
  ProductionReadinessStatus,
} from "../../api/types";
import { formatDateTime } from "./format";
import type { SupportTrainingEvidenceRecordDraft } from "./production-readiness-types";

export function readinessTone(status: ProductionReadinessStatus | undefined): "green" | "amber" | "red" | "muted" {
  if (status === "ready") return "green";
  if (status === "warning") return "amber";
  if (status === "blocked") return "red";
  return "muted";
}

export function readinessLabel(status: ProductionReadinessStatus | undefined, isLoading: boolean): string {
  if (status === "ready") return "준비 완료";
  if (status === "warning") return "증빙 필요";
  if (status === "blocked") return "차단";
  return isLoading ? "확인 중" : "알 수 없음";
}

export function gateTone(status: ProductionReadinessGateStatus): "green" | "amber" | "red" | "muted" {
  if (status === "pass") return "green";
  if (status === "blocked") return "red";
  if (status === "warning" || status === "deferred") return "amber";
  return "muted";
}

export function gateStatusLabel(status: ProductionReadinessGate["status"]): string {
  if (status === "pass") return "통과";
  if (status === "blocked") return "차단";
  if (status === "warning") return "주의";
  return "유예";
}

export function readinessGateLabel(gate: ProductionReadinessGate): string {
  if (gate.gate_id === "database_migrations") return "DB 변경 적용";
  if (gate.gate_id === "browser_pool_ha") return "브라우저 워커 이중화";
  if (gate.gate_id === "audit_chain_evidence") return "감사 체인 증빙";
  if (gate.gate_id === "external_alert_delivery") return "외부 알림 전달";
  if (gate.gate_id === "managed_backup_restore_drill") return "백업 복구 리허설";
  if (gate.gate_id === "slo_oncall_signoff") return "SLO·당직 승인";
  if (gate.gate_id === "support_training_completion") return "지원·교육 완료";
  if (gate.gate_id === "observability_telemetry_wiring") return "관측성 연결";
  return gate.label;
}

export function readinessGateMessage(gate: ProductionReadinessGate): string {
  if (gate.reason_code === "external_delivery_contract_not_open") return "외부 채널 전달 증빙을 추가해야 합니다.";
  if (gate.reason_code === "owner_controlled_pitr_evidence_missing") return "백업/PITR 복구 리허설 증빙을 추가해야 합니다.";
  if (gate.reason_code === "slo_oncall_signoff_missing") return "SLO와 당직 승인 증빙을 추가해야 합니다.";
  if (gate.reason_code === "support_training_completion_missing") return "지원 모델과 교육 완료 증빙을 추가해야 합니다.";
  if (gate.reason_code === "observability_telemetry_evidence_missing") return "수집기, 대시보드, 알림 경로 증빙을 추가해야 합니다.";
  if (gate.status !== "pass") return gate.detail;
  if (gate.gate_id === "database_migrations") return "필수 DB 변경이 적용되어 있습니다.";
  if (gate.gate_id === "browser_pool_ha") return "브라우저 워커가 이중화되어 있습니다.";
  if (gate.gate_id === "audit_chain_evidence") return "최근 감사 검증 증빙이 정상입니다.";
  return gate.detail;
}

export function auditVerifierStatusLabel(status: unknown): string {
  if (status === "valid") return "정상";
  if (status === "invalid") return "오류";
  if (status === "missing") return "증빙 없음";
  return typeof status === "string" && status.trim().length > 0 ? status : "-";
}

export function evidenceStatusTone(status: ProductionReadinessEvidenceStatus): "green" | "red" {
  return status === "valid" ? "green" : "red";
}

export function evidenceStatusLabel(status: ProductionReadinessEvidenceStatus): string {
  return status === "valid" ? "유효" : "실패";
}

export function evidenceSummaryText(summary: string): string {
  if (summary === "Provider delivered the controlled-prod alert drill.") return "제공자 알림 전달 리허설이 완료되었습니다.";
  if (summary === "Managed backup PITR restore completed within controlled-prod target.") return "관리형 백업/PITR 복구 리허설이 목표 시간 안에 완료되었습니다.";
  if (summary === "SLO dashboard, severity policy, and on-call/RACI sign-off approved.") return "SLO 대시보드, 심각도 정책, 당직/RACI 승인이 완료되었습니다.";
  if (summary === "Support model and training completion evidence approved.") return "지원 모델과 교육 완료 증빙이 승인되었습니다.";
  if (summary === "OTLP collector, dashboard, and alert route evidence approved.") return "관측성 수집기·대시보드·알림 경로 증빙이 승인되었습니다.";
  return summary;
}

export function evidenceRefText(value: string | null): string {
  return value === null || value.trim().length === 0 ? "증빙 참조 없음" : value;
}

export function deliveryStatusText(value: unknown): string {
  if (value === "delivered") return "전달됨";
  if (value === "sent") return "전송됨";
  if (value === "queued") return "대기";
  if (value === "failed") return "실패";
  return metadataText(value);
}

export function expiresText(expiresAt: string | null): string {
  return expiresAt === null ? "만료일 미설정" : `만료 ${formatDateTime(expiresAt)}`;
}

export function metadataText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "예" : "아니오";
  return typeof value === "string" && value.trim().length > 0 ? value : "미입력";
}

export function metadataPercentText(value: unknown): string {
  const text = metadataText(value);
  return text === "미입력" ? text : `${text}%`;
}

export function supportTrainingEvidenceIdempotencyKey(draft: SupportTrainingEvidenceRecordDraft): string {
  const stableEvidenceRef = stableIdempotencyPart(draft.evidenceRef);
  const stableCompletionRef = stableIdempotencyPart(draft.trainingCompletionRef);
  return `readiness-support-training-${stableEvidenceRef}-${stableCompletionRef}-${Date.now()}`;
}

function stableIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}
