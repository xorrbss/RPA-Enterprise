import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import type { ProductionReadinessEvidence } from "../../api/types";
import {
  ProductionReadinessPanel,
  type BackupEvidenceRecordDraft,
  type ExternalAlertEvidenceRecordDraft,
  type ObservabilityEvidenceRecordDraft,
  type SloEvidenceRecordDraft,
} from "./ProductionReadinessPanel";
import {
  backupEvidenceIdempotencyKey,
  externalAlertEvidenceIdempotencyKey,
  observabilityEvidenceIdempotencyKey,
  sloEvidenceIdempotencyKey,
} from "./ops-request-helpers";

export function useReadinessSection(): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const can = useCan();

  const productionReadiness = useQuery({ queryKey: ["production-readiness"], queryFn: () => api.getProductionReadiness(), refetchInterval: 15_000 });
  const externalAlertReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "external_alert_delivery"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "external_alert_delivery", limit: 3 }),
    refetchInterval: 60_000,
  });
  const backupReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "managed_backup_restore_drill"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "managed_backup_restore_drill", limit: 3 }),
    refetchInterval: 60_000,
  });
  const sloReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "slo_oncall_signoff"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "slo_oncall_signoff", limit: 3 }),
    refetchInterval: 60_000,
  });
  const observabilityReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "observability_telemetry_wiring"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "observability_telemetry_wiring", limit: 3 }),
    refetchInterval: 60_000,
  });

  const recordSloEvidenceMutation = useMutation({
    mutationFn: (draft: SloEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "slo_oncall_signoff",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        slo_dashboard: draft.sloDashboard,
        severity_model: draft.severityModel,
        oncall_rota: draft.oncallRota,
        raci_ref: draft.raciRef,
        support_hours: draft.supportHours,
      },
      legal_hold: false,
    }, sloEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "slo_oncall_signoff"] });
    },
  });
  const recordExternalAlertEvidenceMutation = useMutation({
    mutationFn: (draft: ExternalAlertEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "external_alert_delivery",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        channel: draft.channel,
        provider_alias: draft.providerAlias,
        receipt_id: draft.receiptId,
        receipt_at: draft.receiptAt,
        delivery_status: "delivered",
      },
      legal_hold: false,
    }, externalAlertEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "external_alert_delivery"] });
    },
  });
  const recordBackupEvidenceMutation = useMutation({
    mutationFn: (draft: BackupEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "managed_backup_restore_drill",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        backup_policy_ref: draft.backupPolicyRef,
        restore_scope: draft.restoreScope,
        restore_completed_at: draft.restoreCompletedAt,
        rto_minutes: draft.rtoMinutes,
        rpo_minutes: draft.rpoMinutes,
      },
      legal_hold: false,
    }, backupEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "managed_backup_restore_drill"] });
    },
  });
  const recordObservabilityEvidenceMutation = useMutation({
    mutationFn: (draft: ObservabilityEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "observability_telemetry_wiring",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        exporter: draft.exporter,
        collector_ref: draft.collectorRef,
        dashboard_ref: draft.dashboardRef,
        alert_route_ref: draft.alertRouteRef,
        sampled_at: draft.sampledAt,
      },
      legal_hold: false,
    }, observabilityEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "observability_telemetry_wiring"] });
    },
  });

  const productionReadinessPanel = (
    <ProductionReadinessPanel
      readiness={productionReadiness.data}
      isLoading={productionReadiness.data === undefined && productionReadiness.isFetching}
      isError={productionReadiness.isError}
      externalAlertEvidence={externalAlertReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
      isExternalAlertEvidenceLoading={externalAlertReadinessEvidence.data === undefined && externalAlertReadinessEvidence.isFetching}
      isExternalAlertEvidenceError={externalAlertReadinessEvidence.isError}
      backupEvidence={backupReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
      isBackupEvidenceLoading={backupReadinessEvidence.data === undefined && backupReadinessEvidence.isFetching}
      isBackupEvidenceError={backupReadinessEvidence.isError}
      sloEvidence={sloReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
      isSloEvidenceLoading={sloReadinessEvidence.data === undefined && sloReadinessEvidence.isFetching}
      isSloEvidenceError={sloReadinessEvidence.isError}
      observabilityEvidence={observabilityReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
      isObservabilityEvidenceLoading={observabilityReadinessEvidence.data === undefined && observabilityReadinessEvidence.isFetching}
      isObservabilityEvidenceError={observabilityReadinessEvidence.isError}
      canRecordBackupEvidence={can("ops_readiness.manage")}
      isRecordingBackupEvidence={recordBackupEvidenceMutation.isPending}
      recordBackupEvidenceError={recordBackupEvidenceMutation.isError}
      onRecordBackupEvidence={(draft) => recordBackupEvidenceMutation.mutate(draft)}
      canRecordExternalAlertEvidence={can("ops_readiness.manage")}
      isRecordingExternalAlertEvidence={recordExternalAlertEvidenceMutation.isPending}
      recordExternalAlertEvidenceError={recordExternalAlertEvidenceMutation.isError}
      onRecordExternalAlertEvidence={(draft) => recordExternalAlertEvidenceMutation.mutate(draft)}
      canRecordSloEvidence={can("ops_readiness.manage")}
      isRecordingSloEvidence={recordSloEvidenceMutation.isPending}
      recordSloEvidenceError={recordSloEvidenceMutation.isError}
      onRecordSloEvidence={(draft) => recordSloEvidenceMutation.mutate(draft)}
      canRecordObservabilityEvidence={can("ops_readiness.manage")}
      isRecordingObservabilityEvidence={recordObservabilityEvidenceMutation.isPending}
      recordObservabilityEvidenceError={recordObservabilityEvidenceMutation.isError}
      onRecordObservabilityEvidence={(draft) => recordObservabilityEvidenceMutation.mutate(draft)}
    />
  );

  return productionReadinessPanel;
}
