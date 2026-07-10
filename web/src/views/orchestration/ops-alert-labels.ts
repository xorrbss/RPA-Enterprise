import type { OpsAlertItem, OpsNotificationAttempt, OpsNotificationDelivery } from "../../api/types";
import { statusLabel as commonStatusLabel, kindLabel as commonKindLabel } from "../../components/badges";
import { formatDateTime } from "./format";
import type { AlertSourceFilter } from "./trigger-helpers";

// 알림 유형 필터 옵션 — opsAlertSourceLabel 과 동일 어휘(vocab 단일 출처).
export const ALERT_SOURCE_FILTER_OPTIONS: ReadonlyArray<{ readonly value: AlertSourceFilter; readonly label: string }> = [
  { value: "all", label: "전체" },
  { value: "run_sla", label: "실행 SLA" },
  { value: "human_task_sla", label: "사람 작업 SLA" },
  { value: "trigger_fire", label: "트리거 발화" },
  { value: "failure_spike", label: "실패 급증" },
  { value: "session_expiry", label: "로그인 세션 만료" },
  { value: "artifact_redaction", label: "증빙 보호 실패" },
  { value: "security_abort", label: "보안 차단 중단" },
  { value: "dlq", label: "재처리 대기" },
  { value: "bot_pool", label: "봇 풀" },
  { value: "scim_secret_rotation", label: "SCIM 서명 비밀" },
  { value: "readiness_evidence", label: "운영 전환 준비" },
  { value: "audit_verifier", label: "감사 체인" },
];

// 그룹핑·소스 라벨·route 이동은 공용 유틸로 이동(T1/T2·F4) — 알림 센터·대시보드·상단바 벨이 같은 규칙을
// 소비한다. 기존 import 경로 호환 재수출.
export { groupOpsAlerts, navigateAlertRoute, opsAlertSourceLabel, type OpsAlertGroup } from "../../util/ops-alerts";

export function localizeStatusText(value: string): string {
  // 알림 detail 문장 내 raw enum → 운영자 한국어. 상태(run/human-task state·발송 상태)에 더해 사람 확인 종류(kind)도
  // 치환한다: human_task_sla detail 은 `${kind}/${state}` 형식(ops-alerts.ts)이라 state 만 라벨화하면 "exception/열림"
  // 처럼 kind 가 영문으로 남는다. kind enum(approval/validation/exception/captcha/mfa)은 상태 enum 과 겹치지 않아 안전.
  return value
    .replace(
      /\b(queued|claimed|running|suspending|suspended|resume_requested|resuming|completed|cancelled|failed_business|failed_system|pending|sending|sent|delivered|failed|dead_letter|open|acknowledged)\b/g,
      (status) => commonStatusLabel(status),
    )
    .replace(/\b(approval|validation|exception|captcha|mfa)\b/g, (kind) => commonKindLabel(kind));
}

export function notificationStatusLabel(status: OpsNotificationAttempt["status"] | OpsNotificationDelivery["status"]): string {
  switch (status) {
    case "pending": return "발송 대기";
    case "sending": return "발송 중";
    case "sent": return "발송됨";
    case "delivered": return "전달됨";
    case "failed": return "실패";
    case "dead_letter": return "실패 보관";
    default: return commonStatusLabel(status);
  }
}

export function attemptStatusTone(status: OpsNotificationAttempt["status"]): "green" | "amber" | "red" | "blue" {
  if (status === "sent") return "green";
  if (status === "dead_letter") return "red";
  if (status === "failed") return "amber";
  return "blue";
}

export function deliveryStatusTone(status: OpsNotificationDelivery["status"]): "green" | "amber" | "red" {
  if (status === "delivered") return "green";
  if (status === "failed") return "red";
  return "amber";
}

export function alertSeverityTone(severity: OpsAlertItem["severity"]): "red" | "amber" | "blue" {
  if (severity === "critical") return "red";
  if (severity === "warning") return "amber";
  return "blue";
}

export function alertSeverityLabel(severity: OpsAlertItem["severity"]): string {
  if (severity === "critical") return "위험";
  if (severity === "warning") return "주의";
  return "정보";
}

export function opsAlertTiming(alert: OpsAlertItem): string {
  return alert.due_at !== undefined && alert.due_at !== null
    ? `감지 ${formatDateTime(alert.detected_at)} · 기한 ${formatDateTime(alert.due_at)}`
    : `감지 ${formatDateTime(alert.detected_at)}`;
}

export function opsAlertActionLabel(alert: OpsAlertItem): string {
  if (alert.source === "failure_spike") return "실패 기록 보기";
  switch (alert.subject_type) {
    case "run":
      return "실행 보기";
    case "human_task":
      return "사람 작업 보기";
    case "run_trigger":
      return "예약 이력 보기";
    case "dlq":
      return "재처리 대기 보기";
    case "bot_pool":
      return "봇 풀 보기";
    case "scim_provider":
      return "SCIM 설정 보기";
    case "readiness_evidence":
      return "운영 전환 준비";
    case "audit_verifier":
      return "감사 검증 보기";
    case "browser_session":
      return "세션 다시 등록";
    default:
      return "자세히 보기";
  }
}
