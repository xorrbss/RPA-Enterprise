import type { OpsNotificationDelivery } from "./ops-alerts-deliveries";
import type { ProductionReadinessEvidence } from "./production-readiness-evidence";
import { gate, type ProductionReadinessGate } from "./production-readiness-gates";

const EXTERNAL_ALERT_DELIVERY_FRESHNESS_DAYS = 90;

export function externalAlertDeliveryGate(
  evidence: ProductionReadinessEvidence | null,
  latestDelivery: OpsNotificationDelivery | null,
): ProductionReadinessGate {
  const ownerGateInput = {
    gateId: "external_alert_delivery",
    label: "External alert delivery",
    missingReason: "external_delivery_evidence_missing",
    missingDetail: "Console alerts are available, but controlled production needs an owner-attested external delivery drill receipt.",
    missingEvidence: ["ops_alert.delivery.external_delivery=false", "external_delivery_drill=evidence_required"],
    missingAction: "Record a successful external alert delivery drill receipt without endpoint URLs, tokens, or webhook secrets.",
    failedReason: "external_delivery_drill_failed",
    expiredReason: "external_delivery_evidence_expired",
    passDetail: "External alert delivery drill evidence is valid and unexpired.",
    evidence,
  };
  const ownerGate = ownerEvidenceGate(ownerGateInput);
  if (ownerGate.status === "blocked") return ownerGate;

  if (latestDelivery !== null) {
    if (latestDelivery.status === "failed") {
      return gate(
        "external_alert_delivery",
        "External alert delivery",
        "blocked",
        "external_delivery_receipt_failed",
        latestDelivery.summary,
        notificationDeliveryEvidenceLines(latestDelivery),
        "Resolve the failed external delivery and record a newer delivered provider receipt.",
      );
    }
    const maxAgeMs = EXTERNAL_ALERT_DELIVERY_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    if (latestDelivery.status === "delivered" && Date.parse(latestDelivery.receipt_at) > Date.now() - maxAgeMs) {
      return gate(
        "external_alert_delivery",
        "External alert delivery",
        "pass",
        null,
        "External alert delivery has a fresh provider delivered receipt.",
        notificationDeliveryEvidenceLines(latestDelivery),
        null,
      );
    }
    if (ownerGate.status === "pass") return ownerGate;
    return gate(
      "external_alert_delivery",
      "External alert delivery",
      "deferred",
      latestDelivery.status === "sent" ? "external_delivery_receipt_not_delivered" : "external_delivery_receipt_expired",
      "The latest external delivery receipt is not a fresh delivered provider receipt.",
      notificationDeliveryEvidenceLines(latestDelivery),
      "Record a newer delivered provider receipt or attach owner-approved external delivery evidence.",
    );
  }
  return ownerGate;
}

export function managedBackupRestoreDrillGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "managed_backup_restore_drill",
    label: "Managed backup restore drill",
    missingReason: "owner_controlled_pitr_evidence_missing",
    missingDetail: "Repo-local restore drills exist, but owner-controlled managed backup/PITR restore evidence is external to this deployment.",
    missingEvidence: ["local_restore_drill=available", "managed_backup_pitr=evidence_required", "rto_rpo_targets=evidence_required"],
    missingAction: "Record owner-controlled backup/PITR restore drill evidence with RTO/RPO timestamps before production open.",
    failedReason: "managed_backup_restore_drill_failed",
    expiredReason: "managed_backup_restore_evidence_expired",
    passDetail: "Owner-controlled managed backup/PITR restore drill evidence is valid and unexpired.",
    evidence,
  });
}

export function sloOncallSignoffGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "slo_oncall_signoff",
    label: "SLO/on-call sign-off",
    missingReason: "slo_oncall_signoff_missing",
    missingDetail: "Controlled production needs owner-attested SLO targets, severity policy, and on-call/RACI coverage evidence.",
    missingEvidence: ["slo_dashboard=evidence_required", "on_call_raci=evidence_required", "support_hours=evidence_required"],
    missingAction: "Record metadata-only SLO dashboard and on-call/RACI sign-off evidence before production open.",
    failedReason: "slo_oncall_signoff_failed",
    expiredReason: "slo_oncall_signoff_expired",
    passDetail: "SLO dashboard and on-call/RACI sign-off evidence is valid and unexpired.",
    evidence,
  });
}

export function observabilityTelemetryWiringGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "observability_telemetry_wiring",
    label: "Observability telemetry wiring",
    missingReason: "observability_telemetry_evidence_missing",
    missingDetail: "Controlled production needs owner-attested OTLP/Prometheus exporter, collector, dashboard, and alert-route evidence.",
    missingEvidence: ["telemetry_exporter=evidence_required", "collector_ref=evidence_required", "dashboard_alert_route=evidence_required"],
    missingAction: "Record metadata-only telemetry wiring evidence for exporter, collector, dashboard, and alert route before production open.",
    failedReason: "observability_telemetry_wiring_failed",
    expiredReason: "observability_telemetry_evidence_expired",
    passDetail: "Observability exporter, collector, dashboard, and alert-route evidence is valid and unexpired.",
    evidence,
  });
}

export function supportTrainingCompletionGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "support_training_completion",
    label: "Support and training completion",
    missingReason: "support_training_completion_missing",
    missingDetail: "Controlled production needs owner-attested support model and role training completion evidence.",
    missingEvidence: ["support_model=evidence_required", "training_completion=evidence_required", "coverage_percent=evidence_required"],
    missingAction: "Record metadata-only support model and role training completion evidence before production open.",
    failedReason: "support_training_completion_failed",
    expiredReason: "support_training_completion_expired",
    passDetail: "Support model and training completion evidence is valid and unexpired.",
    evidence,
  });
}

function ownerEvidenceGate(input: {
  readonly gateId: string;
  readonly label: string;
  readonly missingReason: string;
  readonly missingDetail: string;
  readonly missingEvidence: readonly string[];
  readonly missingAction: string;
  readonly failedReason: string;
  readonly expiredReason: string;
  readonly passDetail: string;
  readonly evidence: ProductionReadinessEvidence | null;
}): ProductionReadinessGate {
  if (input.evidence === null) {
    return gate(
      input.gateId,
      input.label,
      "deferred",
      input.missingReason,
      input.missingDetail,
      input.missingEvidence,
      input.missingAction,
    );
  }
  if (input.evidence.status === "failed") {
    return gate(
      input.gateId,
      input.label,
      "blocked",
      input.failedReason,
      input.evidence.summary,
      evidenceLines(input.evidence),
      "Resolve the failed drill and record a new valid evidence item before production open.",
    );
  }
  if (input.evidence.expires_at === null || Date.parse(input.evidence.expires_at) <= Date.now()) {
    return gate(
      input.gateId,
      input.label,
      "deferred",
      input.expiredReason,
      "The latest owner evidence is expired or missing an expiry boundary.",
      evidenceLines(input.evidence),
      "Run the drill again and record fresh unexpired evidence.",
    );
  }
  return gate(
    input.gateId,
    input.label,
    "pass",
    null,
    input.passDetail,
    evidenceLines(input.evidence),
    null,
  );
}

function evidenceLines(evidence: ProductionReadinessEvidence): readonly string[] {
  const lines = [
    `evidence_id=${evidence.evidence_id}`,
    `status=${evidence.status}`,
    `evidence_at=${evidence.evidence_at}`,
    `expires_at=${evidence.expires_at ?? "none"}`,
  ];
  if (evidence.evidence_ref !== null) lines.push(`evidence_ref=${evidence.evidence_ref}`);
  for (const [key, value] of Object.entries(evidence.metadata).slice(0, 5)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}=${String(value)}`);
    }
  }
  return lines;
}

function notificationDeliveryEvidenceLines(delivery: OpsNotificationDelivery): readonly string[] {
  const lines = [
    `delivery_id=${delivery.delivery_id}`,
    `alert_id=${delivery.alert_id}`,
    `channel=${delivery.channel}`,
    `provider_alias=${delivery.provider_alias}`,
    `status=${delivery.status}`,
    `receipt_at=${delivery.receipt_at}`,
    `attempt_no=${delivery.attempt_no}`,
  ];
  if (delivery.recipient_group_ref !== null) lines.push(`recipient_group_ref=${delivery.recipient_group_ref}`);
  if (delivery.receipt_id !== null) lines.push(`receipt_id=${delivery.receipt_id}`);
  if (delivery.error_code !== null) lines.push(`error_code=${delivery.error_code}`);
  for (const [key, value] of Object.entries(delivery.metadata).slice(0, 3)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}=${String(value)}`);
    }
  }
  return lines;
}
