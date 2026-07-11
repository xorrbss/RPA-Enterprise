import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { ProductionReadiness, ProductionReadinessEvidence } from "../../api/types";
import { formatDateTime } from "./format";
import {
  AiGovernanceRequirementList,
  BackupEvidenceList,
  ExternalAlertEvidenceList,
  ObservabilityEvidenceList,
  SloEvidenceList,
  SupportTrainingEvidenceList,
} from "./production-readiness-evidence-lists";
import {
  auditVerifierStatusLabel,
  gateStatusLabel,
  gateTone,
  readinessGateLabel,
  readinessGateMessage,
  readinessLabel,
  readinessTone,
  supportTrainingEvidenceIdempotencyKey,
} from "./production-readiness-labels";
import {
  ExternalAlertEvidenceRecorder,
  SloEvidenceRecorder,
  SupportTrainingEvidenceRecorder,
} from "./production-readiness-recorders";
import {
  BackupEvidenceRecorder,
  ObservabilityEvidenceRecorder,
} from "./production-readiness-recorders-infra";
import type {
  BackupEvidenceRecordDraft,
  ExternalAlertEvidenceRecordDraft,
  ObservabilityEvidenceRecordDraft,
  SloEvidenceRecordDraft,
  SupportTrainingEvidenceRecordDraft,
} from "./production-readiness-types";

export type {
  BackupEvidenceRecordDraft,
  ExternalAlertEvidenceRecordDraft,
  ObservabilityEvidenceRecordDraft,
  SloEvidenceRecordDraft,
  SupportTrainingEvidenceRecordDraft,
} from "./production-readiness-types";

export function ProductionReadinessPanel({
  readiness,
  isLoading,
  isError,
  externalAlertEvidence,
  isExternalAlertEvidenceLoading,
  isExternalAlertEvidenceError,
  backupEvidence,
  isBackupEvidenceLoading,
  isBackupEvidenceError,
  sloEvidence,
  isSloEvidenceLoading,
  isSloEvidenceError,
  observabilityEvidence,
  isObservabilityEvidenceLoading,
  isObservabilityEvidenceError,
  canRecordBackupEvidence,
  isRecordingBackupEvidence,
  recordBackupEvidenceError,
  onRecordBackupEvidence,
  canRecordExternalAlertEvidence,
  isRecordingExternalAlertEvidence,
  recordExternalAlertEvidenceError,
  onRecordExternalAlertEvidence,
  canRecordSloEvidence,
  isRecordingSloEvidence,
  recordSloEvidenceError,
  onRecordSloEvidence,
  canRecordObservabilityEvidence,
  isRecordingObservabilityEvidence,
  recordObservabilityEvidenceError,
  onRecordObservabilityEvidence,
}: {
  readiness: ProductionReadiness | undefined;
  isLoading: boolean;
  isError: boolean;
  externalAlertEvidence: readonly ProductionReadinessEvidence[];
  isExternalAlertEvidenceLoading: boolean;
  isExternalAlertEvidenceError: boolean;
  backupEvidence: readonly ProductionReadinessEvidence[];
  isBackupEvidenceLoading: boolean;
  isBackupEvidenceError: boolean;
  sloEvidence: readonly ProductionReadinessEvidence[];
  isSloEvidenceLoading: boolean;
  isSloEvidenceError: boolean;
  observabilityEvidence: readonly ProductionReadinessEvidence[];
  isObservabilityEvidenceLoading: boolean;
  isObservabilityEvidenceError: boolean;
  canRecordBackupEvidence: boolean;
  isRecordingBackupEvidence: boolean;
  recordBackupEvidenceError: boolean;
  onRecordBackupEvidence: (draft: BackupEvidenceRecordDraft) => void;
  canRecordExternalAlertEvidence: boolean;
  isRecordingExternalAlertEvidence: boolean;
  recordExternalAlertEvidenceError: boolean;
  onRecordExternalAlertEvidence: (draft: ExternalAlertEvidenceRecordDraft) => void;
  canRecordSloEvidence: boolean;
  isRecordingSloEvidence: boolean;
  recordSloEvidenceError: boolean;
  onRecordSloEvidence: (draft: SloEvidenceRecordDraft) => void;
  canRecordObservabilityEvidence: boolean;
  isRecordingObservabilityEvidence: boolean;
  recordObservabilityEvidenceError: boolean;
  onRecordObservabilityEvidence: (draft: ObservabilityEvidenceRecordDraft) => void;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const supportTrainingEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "support_training_completion"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "support_training_completion", limit: 3 }),
    refetchInterval: 60_000,
  });
  const recordSupportTrainingEvidenceMutation = useMutation({
    mutationFn: (draft: SupportTrainingEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "support_training_completion",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        support_model_ref: draft.supportModelRef,
        training_completion_ref: draft.trainingCompletionRef,
        trained_role_count: draft.trainedRoleCount,
        trained_user_count: draft.trainedUserCount,
        coverage_percent: draft.coveragePercent,
        completed_at: draft.completedAt,
      },
      legal_hold: false,
    }, supportTrainingEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "support_training_completion"] });
    },
  });
  const canRecordSupportTrainingEvidence =
    canRecordSloEvidence || canRecordObservabilityEvidence || canRecordBackupEvidence || canRecordExternalAlertEvidence;

  if (isError) {
    return (
      <section className="panel production-readiness" aria-label="운영 전환 준비 상태">
        <div className="panel-head">
          <h2>운영 전환 준비 상태</h2>
          <span className="badge red">불러오기 실패</span>
        </div>
        <p className="empty-state">운영 전환 증빙을 불러오지 못했습니다.</p>
      </section>
    );
  }

  const topGates = readiness?.gates.filter((gate) => gate.status !== "pass").slice(0, 5) ?? [];
  const auditVerifier = readiness?.signals?.audit_verifier;
  const latestAuditCompletedAt = auditVerifier?.latest_completed_at ?? null;
  const auditVerifierFresh = auditVerifier?.latest_status === "valid" && auditVerifier.stale === false;
  return (
    <section className="panel production-readiness" aria-label="운영 전환 준비 상태">
      <div className="panel-head">
        <div>
          <h2>운영 전환 준비 상태</h2>
          <p className="subtle">
            {readiness === undefined ? (isLoading ? "증빙 확인 중" : "스냅샷 없음") : formatDateTime(readiness.evaluated_at)}
          </p>
        </div>
        <span className={`badge ${readinessTone(readiness?.status)}`}>{readinessLabel(readiness?.status, isLoading)}</span>
      </div>
      <div className="ops-health-grid">
        <ReadinessTile
          title="실행 차단 요인"
          value={readiness === undefined ? "-" : String(readiness.summary.blocker_count)}
          detail={readiness === undefined ? "증빙 대기" : readiness.summary.blocker_count === 0 ? "차단 없음" : "조치 필요"}
          tone={readiness !== undefined && readiness.summary.blocker_count > 0 ? "red" : "green"}
        />
        <ReadinessTile
          title="외부 증빙"
          value={readiness === undefined ? "-" : String(readiness.summary.deferred_count)}
          detail={readiness === undefined ? "증빙 대기" : readiness.summary.deferred_count === 0 ? "등록됨" : "담당자 증빙 필요"}
          tone={readiness !== undefined && readiness.summary.deferred_count > 0 ? "amber" : "green"}
        />
        <ReadinessTile
          title="브라우저 용량"
          value={readiness === undefined ? "-" : String(readiness.signals.bot_pool.capacity_slots)}
          detail={readiness === undefined ? "실행기 확인 중" : `활성 ${readiness.signals.bot_pool.workers.active}`}
          tone={readiness !== undefined && readiness.signals.bot_pool.workers.active >= 2 ? "green" : "amber"}
        />
        <ReadinessTile
          title="감사 검증"
          value={auditVerifierStatusLabel(auditVerifier?.latest_status)}
          detail={latestAuditCompletedAt !== null ? formatDateTime(latestAuditCompletedAt) : "최신 증빙 없음"}
          tone={auditVerifierFresh ? "green" : "amber"}
        />
      </div>
      <ul className="production-readiness-gates">
        {(topGates.length > 0 ? topGates : readiness?.gates.slice(0, 3) ?? []).map((gate) => (
          <li key={gate.gate_id}>
            <span className={`badge ${gateTone(gate.status)}`}>{gateStatusLabel(gate.status)}</span>
            <div>
              <strong>{readinessGateLabel(gate)}</strong>
              <span className="subtle">{readinessGateMessage(gate)}</span>
            </div>
          </li>
        ))}
      </ul>
      <AiGovernanceRequirementList requirements={readiness?.signals.ai_governance.requirements} />
      <ExternalAlertEvidenceList
        items={externalAlertEvidence}
        isLoading={isExternalAlertEvidenceLoading}
        isError={isExternalAlertEvidenceError}
      />
      <SloEvidenceList
        items={sloEvidence}
        isLoading={isSloEvidenceLoading}
        isError={isSloEvidenceError}
      />
      <SupportTrainingEvidenceList
        items={supportTrainingEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
        isLoading={supportTrainingEvidence.data === undefined && supportTrainingEvidence.isFetching}
        isError={supportTrainingEvidence.isError}
      />
      <ObservabilityEvidenceList
        items={observabilityEvidence}
        isLoading={isObservabilityEvidenceLoading}
        isError={isObservabilityEvidenceError}
      />
      <BackupEvidenceList
        items={backupEvidence}
        isLoading={isBackupEvidenceLoading}
        isError={isBackupEvidenceError}
      />
      {canRecordExternalAlertEvidence ? (
        <ExternalAlertEvidenceRecorder
          isRecording={isRecordingExternalAlertEvidence}
          hasError={recordExternalAlertEvidenceError}
          onSubmit={onRecordExternalAlertEvidence}
        />
      ) : null}
      {canRecordBackupEvidence ? (
        <BackupEvidenceRecorder
          isRecording={isRecordingBackupEvidence}
          hasError={recordBackupEvidenceError}
          onSubmit={onRecordBackupEvidence}
        />
      ) : null}
      {canRecordSloEvidence ? (
        <SloEvidenceRecorder
          isRecording={isRecordingSloEvidence}
          hasError={recordSloEvidenceError}
          onSubmit={onRecordSloEvidence}
        />
      ) : null}
      {canRecordSupportTrainingEvidence ? (
        <SupportTrainingEvidenceRecorder
          isRecording={recordSupportTrainingEvidenceMutation.isPending}
          hasError={recordSupportTrainingEvidenceMutation.isError}
          onSubmit={(draft) => recordSupportTrainingEvidenceMutation.mutate(draft)}
        />
      ) : null}
      {canRecordObservabilityEvidence ? (
        <ObservabilityEvidenceRecorder
          isRecording={isRecordingObservabilityEvidence}
          hasError={recordObservabilityEvidenceError}
          onSubmit={onRecordObservabilityEvidence}
        />
      ) : null}
    </section>
  );
}

function ReadinessTile({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  tone: "green" | "blue" | "amber" | "red" | "muted";
}): JSX.Element {
  return (
    <div className="ops-health-tile">
      <span className="subtle">{title}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{detail}</span>
    </div>
  );
}
