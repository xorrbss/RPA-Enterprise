import type { ListParams } from "./types-common";
import type { BotPoolHealth, BotPoolItem, OpsHealth } from "./types-ops";

export type ProductionReadinessStatus = "ready" | "warning" | "blocked";
export type ProductionReadinessGateStatus = "pass" | "warning" | "blocked" | "deferred";
export type ProductionReadinessEvidenceType =
  | "external_alert_delivery"
  | "managed_backup_restore_drill"
  | "slo_oncall_signoff"
  | "observability_telemetry_wiring"
  | "support_training_completion";
export type ProductionReadinessEvidenceStatus = "valid" | "failed";

export interface ProductionReadinessEvidence {
  readonly evidence_id: string;
  readonly evidence_type: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at: string | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

export interface ProductionReadinessEvidenceRequest {
  readonly evidence_type: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at?: string | null;
  readonly summary: string;
  readonly evidence_ref?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly legal_hold?: boolean;
}

export interface ProductionReadinessGate {
  readonly gate_id: string;
  readonly label: string;
  readonly status: ProductionReadinessGateStatus;
  readonly reason_code: string | null;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly required_action: string | null;
}

export interface ProductionReadiness {
  readonly status: ProductionReadinessStatus;
  readonly evaluated_at: string;
  readonly environment: {
    readonly target: "controlled_prod";
    readonly tenant_id: string;
  };
  readonly summary: {
    readonly controlled_prod_ready: boolean;
    readonly status: ProductionReadinessStatus;
    readonly blocker_count: number;
    readonly warning_count: number;
    readonly deferred_count: number;
  };
  readonly gates: readonly ProductionReadinessGate[];
  readonly signals: {
    readonly ops_health: OpsHealth;
    readonly bot_pool: {
      readonly bot_pool_id: string;
      readonly capacity_slots: number;
      readonly workers: BotPoolItem["workers"];
      readonly leases: BotPoolItem["leases"];
      readonly queue: BotPoolItem["queue"];
      readonly health: BotPoolHealth;
    };
    readonly audit_verifier: {
      readonly audit_count: number;
      readonly latest_run_id: string | null;
      readonly latest_status: AuditVerificationStatus | null;
      readonly latest_completed_at: string | null;
      readonly rows_checked: number | null;
      readonly violation_count: number | null;
      readonly stale: boolean;
    };
  };
}

export type AiGovernanceEvidenceType =
  | "model_registry"
  | "prompt_registry"
  | "eval_result"
  | "cost_control"
  | "human_override";
export type AiGovernanceEvidenceStatus = "valid" | "failed" | "deferred";

export interface AiGovernanceEvidence {
  readonly evidence_id: string;
  readonly evidence_type: AiGovernanceEvidenceType;
  readonly subject_ref: string;
  readonly status: AiGovernanceEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at: string | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly policy_decision_ref: string | null;
  readonly audit_correlation_id: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

export interface AiGovernanceEvidenceRequest {
  readonly evidence_type: AiGovernanceEvidenceType;
  readonly subject_ref: string;
  readonly status: AiGovernanceEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at?: string | null;
  readonly summary: string;
  readonly evidence_ref?: string | null;
  readonly policy_decision_ref?: string | null;
  readonly audit_correlation_id?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly legal_hold?: boolean;
}

export interface AiGovernanceEvidenceListParams extends ListParams {
  readonly evidence_type?: AiGovernanceEvidenceType;
  readonly status?: AiGovernanceEvidenceStatus;
  readonly subject_ref?: string;
}

export interface AiGovernanceEvidenceSummaryParams {
  readonly evidence_type?: AiGovernanceEvidenceType;
  readonly status?: AiGovernanceEvidenceStatus;
  readonly subject_ref?: string;
}

export interface AiGovernanceEvidenceSummary {
  readonly total_count: number;
  readonly status_counts: {
    readonly valid: number;
    readonly deferred: number;
    readonly failed: number;
  };
  readonly expired_valid_count: number;
  readonly latest: null | {
    readonly evidence_type: AiGovernanceEvidenceType;
    readonly status: AiGovernanceEvidenceStatus;
    readonly subject_ref: string | null;
    readonly evidence_at: string | null;
    readonly recorded_at: string | null;
  };
  readonly type_status_counts: readonly {
    readonly evidence_type: AiGovernanceEvidenceType;
    readonly total_count: number;
    readonly valid: number;
    readonly deferred: number;
    readonly failed: number;
  }[];
  readonly filters: {
    readonly evidence_type: AiGovernanceEvidenceType | null;
    readonly status: AiGovernanceEvidenceStatus | null;
    readonly subject_ref: string | null;
  };
}

export type AiGovernanceRuntimePolicyMode = "observe" | "warn" | "block";

export interface AiGovernanceRuntimePolicy {
  readonly policy_id: string;
  readonly mode: AiGovernanceRuntimePolicyMode;
  readonly subject_mapping_ref: string;
  readonly grace_until: string | null;
  readonly emergency_override_owner_ref: string;
  readonly audit_action: "ai_governance.enforce";
  readonly policy_decision_ref: string;
  readonly evidence_ref: string | null;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AiGovernanceRuntimePolicyEnvelope {
  readonly configured: boolean;
  readonly policy?: AiGovernanceRuntimePolicy;
}

export interface AiGovernanceRuntimePolicyRequest {
  readonly mode: AiGovernanceRuntimePolicyMode;
  readonly subject_mapping_ref: string;
  readonly grace_until?: string | null;
  readonly emergency_override_owner_ref: string;
  readonly policy_decision_ref: string;
  readonly evidence_ref?: string | null;
}

export type AuditOutcome = "allow" | "deny" | "blocked" | "error";

export interface AuditLogActor {
  readonly subject_id: string | null;
  readonly roles: readonly string[];
}

export interface AuditLogItem {
  readonly audit_id: string;
  readonly sequence_no: number;
  readonly actor: AuditLogActor;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly reason: string | null;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly payload_schema_ref: string;
  readonly retention_until: string | null;
  readonly legal_hold: boolean;
  readonly previous_hash: string | null;
  readonly hash: string;
  readonly created_at: string;
}

export interface AuditLogListParams extends ListParams {
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly actor?: string;
  readonly correlation_id?: string;
  readonly occurred_at_from?: string;
  readonly occurred_at_to?: string;
}

export interface AuditLogSummaryParams {
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly actor?: string;
  readonly correlation_id?: string;
  readonly occurred_at_from?: string;
  readonly occurred_at_to?: string;
}

export interface AuditLogSummary {
  readonly total_count: number;
  readonly outcome_counts: {
    readonly allow: number;
    readonly deny: number;
    readonly blocked: number;
    readonly error: number;
  };
  readonly hash_linked_count: number;
  readonly legal_hold_count: number;
  readonly latest: null | {
    readonly sequence_no: number;
    readonly occurred_at: string | null;
    readonly hash: string | null;
    readonly previous_hash: string | null;
  };
  readonly filters: {
    readonly action: string | null;
    readonly outcome: AuditOutcome | null;
    readonly actor: string | null;
    readonly correlation_id: string | null;
    readonly occurred_at_from: string | null;
    readonly occurred_at_to: string | null;
  };
}

export interface AuditLogExportParams extends AuditLogListParams {
  readonly format?: "csv";
}

export type AuditVerificationStatus = "valid" | "invalid" | "failed";

export interface AuditChainViolation {
  readonly sequenceNo: number;
  readonly id: string;
  readonly kind: "hash_mismatch" | "broken_link" | "sequence_gap" | "genesis_invalid";
  readonly detail: string;
}

export interface AuditVerificationRun {
  readonly verification_run_id: string;
  readonly status: AuditVerificationStatus;
  readonly rows_checked: number;
  readonly violation_count: number;
  readonly violations: readonly AuditChainViolation[];
  readonly checked_from_sequence: number | null;
  readonly checked_to_sequence: number | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly correlation_id: string;
  readonly triggered_by: AuditLogActor;
  readonly trigger_kind: "manual_api" | "maintenance";
  readonly retention_until: string;
  readonly legal_hold: boolean;
}

export interface AuditVerificationRunListParams extends ListParams {
  readonly status?: AuditVerificationStatus;
}

export type OffboardingPurgeRequestStatus = "pending" | "approved" | "rejected" | "cancelled" | "purging" | "purged";

export interface OffboardingPurgeRequestItem {
  readonly request_id: string;
  readonly status: OffboardingPurgeRequestStatus;
  readonly reason: string;
  readonly requested_by: string;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly decided_at: string | null;
  readonly purge_after: string | null;
  readonly purged_at: string | null;
  readonly held_rows: Readonly<Record<string, number>>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface OffboardingPurgeRequestPage {
  readonly items: readonly OffboardingPurgeRequestItem[];
  readonly grace_days: number;
}
