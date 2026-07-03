/**
 * 운영 알림(ops-alert) 공유 타입 — 계산 소스(compute*)·전달 attempt 영속화·worker 자동 발화·api 표면이
 * 공유하는 leaf 모듈. 의존 방향 단방향(api→runtime) 유지를 위해 api/** 를 import 하지 않는다.
 */
export type OpsAlertSeverity = "critical" | "warning" | "info";
export type OpsAlertSource =
  | "run_sla"
  | "human_task_sla"
  | "trigger_fire"
  | "failure_spike"
  | "dlq"
  | "bot_pool"
  | "scim_secret_rotation"
  | "audit_verifier"
  | "readiness_evidence"
  | "session_expiry"
  | "artifact_redaction"
  | "security_abort";
export type OpsAlertSubjectType =
  | "run"
  | "human_task"
  | "run_trigger"
  | "dlq"
  | "bot_pool"
  | "scim_provider"
  | "audit_verifier"
  | "readiness_evidence"
  | "browser_session"
  | "artifact";

/** 상태 하이드레이션(status/delivery/ack) 전의 계산된 알림 — api OpsAlertItem 이 이를 확장한다. */
export interface ComputedOpsAlert {
  readonly alert_id: string;
  readonly severity: OpsAlertSeverity;
  readonly source: OpsAlertSource;
  readonly title: string;
  readonly detail: string;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly recommended_action: string;
  readonly route: string | null;
  readonly detected_at: string;
  readonly due_at?: string | null;
}

export interface OpsNotificationWebhookSendInput {
  readonly providerAlias: string;
  readonly endpointSecretRef: string;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string;
  readonly recipientGroupRef: string | null;
  readonly allowedHosts: readonly string[];
  readonly summary: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

// runtime ops-alerts 클러스터의 UUID_RE 정본(api/server-shared 와 동일 패턴 — 계층 격리로 별도 보유).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
