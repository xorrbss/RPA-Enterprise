import type { ListParams } from "./types-common";

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
  | "browser_session";
export type OpsAlertStatus = "open" | "acknowledged";
export type OpsNotificationChannel = "teams" | "slack" | "email" | "webhook";
export type OpsNotificationDeliveryStatus = "sent" | "delivered" | "failed";

export interface OpsAlertDelivery {
  readonly channel: "console";
  readonly status: "delivered";
  readonly delivered_at: string;
  readonly external_delivery: false;
}

export interface OpsAlertAck {
  readonly acknowledged_by: string;
  readonly acknowledged_at: string;
  readonly comment: string | null;
}

export interface OpsAlertItem {
  readonly alert_id: string;
  readonly severity: OpsAlertSeverity;
  readonly source: OpsAlertSource;
  readonly title: string;
  readonly detail: string;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly status: OpsAlertStatus;
  readonly delivery: OpsAlertDelivery;
  readonly ack: OpsAlertAck | null;
  readonly recommended_action: string;
  readonly route: string | null;
  readonly detected_at: string;
  readonly due_at?: string | null;
}

export interface OpsAlertListParams extends ListParams {
  readonly severity?: OpsAlertSeverity;
  readonly source?: OpsAlertSource;
  readonly status?: OpsAlertStatus | "all";
}

export interface OpsNotificationDelivery {
  readonly delivery_id: string;
  readonly alert_id: string;
  readonly detected_at: string;
  readonly source: OpsAlertSource;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly channel: OpsNotificationChannel;
  readonly provider_alias: string;
  readonly status: OpsNotificationDeliveryStatus;
  readonly receipt_id: string | null;
  readonly receipt_at: string;
  readonly endpoint_secret_ref: string;
  readonly credential_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string | null;
  readonly recipient_group_ref: string | null;
  readonly attempt_no: number;
  readonly summary: string;
  readonly error_code: string | null;
  readonly metadata: Record<string, unknown>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

export interface OpsNotificationDeliveryRequest {
  readonly channel: OpsNotificationChannel;
  readonly provider_alias: string;
  readonly status: OpsNotificationDeliveryStatus;
  readonly receipt_id?: string | null;
  readonly receipt_at: string;
  readonly endpoint_secret_ref: string;
  readonly credential_secret_ref?: string | null;
  readonly callback_signature_secret_ref?: string | null;
  readonly route_policy_ref?: string | null;
  readonly recipient_group_ref?: string | null;
  readonly attempt_no?: number;
  readonly summary: string;
  readonly error_code?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly legal_hold?: boolean;
}

// S4b 저장형 자동 알림 라우팅(/v1/ops-alert-routes). source 는 자동 발화 대상 소스만, null=전체 유형.
export type OpsAlertNotificationRouteSource =
  | "run_sla"
  | "human_task_sla"
  | "trigger_fire"
  | "failure_spike"
  | "session_expiry"
  | "artifact_redaction"
  | "security_abort";
export type OpsAlertNotificationRouteSeverity = "warning" | "critical";

export interface OpsAlertNotificationRoute {
  readonly route_id: string;
  readonly source: OpsAlertNotificationRouteSource | null;
  readonly min_severity: OpsAlertNotificationRouteSeverity;
  readonly provider_alias: string;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly enabled: boolean;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_by: string;
  readonly updated_at: string;
}

export interface OpsAlertNotificationRouteCreateRequest {
  readonly source?: OpsAlertNotificationRouteSource | null;
  readonly min_severity: OpsAlertNotificationRouteSeverity;
  readonly provider_alias: string;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref?: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref?: string | null;
  readonly allowed_hosts: readonly string[];
  readonly enabled?: boolean;
}

export interface OpsAlertNotificationRouteUpdateRequest {
  readonly source?: OpsAlertNotificationRouteSource | null;
  readonly min_severity?: OpsAlertNotificationRouteSeverity;
  readonly provider_alias?: string;
  readonly endpoint_secret_ref?: string;
  readonly callback_signature_secret_ref?: string | null;
  readonly route_policy_ref?: string;
  readonly recipient_group_ref?: string | null;
  readonly allowed_hosts?: readonly string[];
  readonly enabled?: boolean;
}

export interface OpsAlertNotificationRouteDeleteResult {
  readonly deleted: boolean;
  readonly route: OpsAlertNotificationRoute;
}

export type OpsNotificationAttemptStatus = "pending" | "sending" | "sent" | "failed" | "dead_letter";

export interface OpsNotificationAttempt {
  readonly attempt_id: string;
  readonly alert_id: string;
  readonly detected_at: string;
  readonly source: OpsAlertSource;
  readonly subject_type: OpsAlertItem["subject_type"];
  readonly subject_id: string | null;
  readonly channel: "webhook";
  readonly provider_alias: string;
  readonly status: OpsNotificationAttemptStatus;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string;
  readonly summary: string;
  readonly error_code: string | null;
  readonly receipt_id: string | null;
  readonly receipt_at: string | null;
  readonly metadata: Record<string, unknown>;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly legal_hold: boolean;
}

export interface OpsNotificationWebhookSendRequest {
  readonly provider_alias?: string;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref?: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref?: string | null;
  readonly allowed_hosts: readonly string[];
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
  readonly legal_hold?: boolean;
}

export type IntegrationHandoffStatus = "accepted" | "deferred" | "completed" | "failed" | "cancelled";
export type IntegrationHandoffReceiptStatus = "accepted" | "completed" | "failed" | "cancelled";
export type IntegrationHandoffDispatchAttemptStatus = "pending" | "sending" | "accepted" | "failed" | "dead_letter";

export interface IntegrationHandoff {
  readonly handoff_id: string;
  readonly provider_alias: string;
  readonly job_ref: string;
  readonly payload_ref: string;
  readonly callback_url_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly external_job_id: string | null;
  readonly status: IntegrationHandoffStatus;
  readonly latest_receipt_id: string | null;
  readonly error_code: string | null;
  readonly requested_by: string;
  readonly request_idempotency_key: string;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly callback_received_at: string | null;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffCreateRequest {
  readonly provider_alias: string;
  readonly job_ref: string;
  readonly payload_ref: string;
  readonly callback_url_secret_ref?: string | null;
  readonly callback_signature_secret_ref?: string | null;
  readonly legal_hold?: boolean;
}

export interface IntegrationHandoffDispatchRequest {
  readonly endpoint_secret_ref: string;
  readonly allowed_hosts: readonly string[];
  readonly max_attempts?: number;
  readonly metadata?: Record<string, unknown>;
  readonly legal_hold?: boolean;
}

export interface IntegrationHandoffDispatchAttempt {
  readonly attempt_id: string;
  readonly handoff_id: string;
  readonly provider_alias: string;
  readonly status: IntegrationHandoffDispatchAttemptStatus;
  readonly endpoint_secret_ref: string;
  readonly allowed_hosts: readonly string[];
  readonly request_idempotency_key: string;
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly external_job_id: string | null;
  readonly receipt_id: string | null;
  readonly error_code: string | null;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffCallbackRequest {
  readonly external_job_id: string;
  readonly status: IntegrationHandoffReceiptStatus;
  readonly receipt_id: string;
  readonly error_code?: string | null;
  readonly legal_hold?: boolean;
}

export interface IntegrationHandoffListParams extends ListParams {
  readonly status?: IntegrationHandoffStatus;
  readonly provider_alias?: string;
}
