import type {
  IntegrationHandoff,
  OpsAlertItem,
  OpsNotificationWebhookSendRequest,
  RunItem,
  WebAttendedRunRequestCreate,
} from "../../api/types";
import type { OpsWebhookSendDraft } from "./OpsAlertCenter";
import type { OpsAlertRouteDraft } from "./OpsAlertRoutePanel";
import type {
  IntegrationHandoffCreateDraft,
  IntegrationHandoffDispatchDraft,
} from "./IntegrationHandoffPanel";
import type { WebAttendedRunCreateDraft } from "./WebAttendedPanel";
import type {
  BackupEvidenceRecordDraft,
  ExternalAlertEvidenceRecordDraft,
  ObservabilityEvidenceRecordDraft,
  SloEvidenceRecordDraft,
} from "./ProductionReadinessPanel";

export function opsAlertAckIdempotencyKey(alert: OpsAlertItem): string {
  const stableAlertId = alert.alert_id.replace(/[^a-zA-Z0-9._:-]/g, "_");
  const stableDetectedAt = alert.detected_at.replace(/[^a-zA-Z0-9._:-]/g, "_");
  return `ops-alert-ack-${stableAlertId}-${stableDetectedAt}-${Date.now()}`;
}

export function externalAlertEvidenceIdempotencyKey(draft: ExternalAlertEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  const stableReceiptId = draft.receiptId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-alert-${stableEvidenceRef}-${stableReceiptId}-${Date.now()}`;
}

export function webhookSendRequestBody(draft: OpsWebhookSendDraft): OpsNotificationWebhookSendRequest {
  const body: {
    endpoint_secret_ref: string;
    callback_signature_secret_ref?: string | null;
    route_policy_ref: string;
    recipient_group_ref?: string | null;
    allowed_hosts: readonly string[];
    metadata: Record<string, unknown>;
    legal_hold: boolean;
    provider_alias?: string;
    summary?: string;
  } = {
    endpoint_secret_ref: draft.endpointSecretRef,
    route_policy_ref: draft.routePolicyRef,
    recipient_group_ref: draft.recipientGroupRef,
    allowed_hosts: draft.allowedHosts,
    metadata: { requested_from: "admin_console" },
    legal_hold: draft.legalHold,
  };
  if (draft.callbackSignatureSecretRef !== null) body.callback_signature_secret_ref = draft.callbackSignatureSecretRef;
  if (draft.providerAlias !== null) body.provider_alias = draft.providerAlias;
  if (draft.summary !== null) body.summary = draft.summary;
  return body;
}

export function opsAlertWebhookIdempotencyKey(alert: OpsAlertItem, draft: OpsWebhookSendDraft): string {
  return [
    "ops-alert-webhook",
    stableIdempotencyPart(alert.alert_id),
    stableIdempotencyPart(alert.detected_at),
    stableIdempotencyPart(draft.endpointSecretRef),
    Date.now(),
  ].join("-");
}

export function alertRouteCreateIdempotencyKey(draft: OpsAlertRouteDraft): string {
  return [
    "ops-alert-route-create",
    stableIdempotencyPart(draft.providerAlias),
    stableIdempotencyPart(draft.endpointSecretRef),
    Date.now(),
  ].join("-");
}

function stableIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}

export function webAttendedRequestBody(draft: WebAttendedRunCreateDraft): WebAttendedRunRequestCreate {
  return {
    scenario_version_id: draft.scenarioVersionId.trim(),
    params: parseJsonObject(draft.paramsJson),
    model: draft.model,
    priority: draft.priority,
    human_task_id: draft.humanTaskId,
    consent: {
      summary: draft.consentSummary.trim(),
      evidence_ref: draft.consentEvidenceRef,
      input_refs: parseCsvRefs(draft.inputRefsCsv),
    },
    metadata: { requested_from: "admin_console" },
    legal_hold: draft.legalHold,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("params_json_object_required");
  }
  return parsed as Record<string, unknown>;
}

function parseCsvRefs(value: string): readonly string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const ref = item.trim();
    if (ref.length > 0 && !seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

export function webAttendedIdempotencyKey(draft: WebAttendedRunCreateDraft): string {
  return [
    "web-attended",
    stableIdempotencyPart(draft.scenarioVersionId),
    stableIdempotencyPart(draft.consentEvidenceRef ?? draft.consentSummary),
    Date.now(),
  ].join("-");
}

export function runResumeIdempotencyKey(run: RunItem): string {
  return [
    "web-attended-resume",
    stableIdempotencyPart(run.run_id),
    stableIdempotencyPart(run.updated_at ?? run.as_of ?? "unknown"),
    Date.now(),
  ].join("-");
}

export function sloEvidenceIdempotencyKey(draft: SloEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-slo-${stableEvidenceRef}-${Date.now()}`;
}

export function backupEvidenceIdempotencyKey(draft: BackupEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-backup-${stableEvidenceRef}-${Date.now()}`;
}

export function observabilityEvidenceIdempotencyKey(draft: ObservabilityEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  const stableCollectorRef = draft.collectorRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-observability-${stableEvidenceRef}-${stableCollectorRef}-${Date.now()}`;
}

export function integrationHandoffIdempotencyKey(draft: IntegrationHandoffCreateDraft): string {
  return [
    "integration-handoff",
    stableIdempotencyPart(draft.providerAlias),
    stableIdempotencyPart(draft.jobRef),
    stableIdempotencyPart(draft.payloadRef),
    Date.now(),
  ].join("-");
}

export function integrationHandoffDispatchIdempotencyKey(
  handoff: IntegrationHandoff,
  draft: IntegrationHandoffDispatchDraft,
): string {
  return [
    "integration-handoff-dispatch",
    stableIdempotencyPart(handoff.handoff_id),
    stableIdempotencyPart(draft.endpointSecretRef),
    stableIdempotencyPart(draft.allowedHosts.join(".")),
    Date.now(),
  ].join("-");
}
