import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { errorLabel } from "../../components/badges";
import { formatDateTime } from "../../util/time";
import type {
  ScenarioCertification,
  ScenarioGovernanceStage,
  ScenarioGovernanceTransitionStage,
  ScenarioItem,
} from "../../api/types";

export function GovernanceStageBadge(props: { certification?: ScenarioCertification | null }): JSX.Element {
  const stage = governanceStage(props.certification);
  const certification = props.certification;
  const details = [
    certification?.governance_reason ?? null,
    certification?.governance_evidence_ref !== null && certification?.governance_evidence_ref !== undefined
      ? `근거 ${certification.governance_evidence_ref}`
      : null,
    certification?.governance_updated_by !== null && certification?.governance_updated_by !== undefined
      ? `처리자 ${certification.governance_updated_by}`
      : null,
    certification?.governance_updated_at !== null && certification?.governance_updated_at !== undefined
      ? formatDateTime(certification.governance_updated_at)
      : null,
  ].filter((value): value is string => value !== null && value.length > 0);
  return (
    <span className={`badge ${governanceStageTone(stage)}`} title={details.length > 0 ? details.join(" / ") : "운영 검토 단계"}>
      {governanceStageLabel(stage)}
    </span>
  );
}

export function GovernanceStageButton(props: {
  scenario: ScenarioItem;
  version: number;
  targetStage: ScenarioGovernanceTransitionStage;
  currentStage: ScenarioGovernanceStage;
}): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const invalidateKeys = [["scenarios"], ["scenario-versions", props.scenario.scenario_id], ["scenario-releases", props.scenario.scenario_id]] as const;
  const targetLabel = governanceStageTransitionLabel(props.targetStage);
  const mut = useMutation({
    mutationFn: (body: { reason: string; evidence_ref: string }) =>
      api.setScenarioVersionGovernanceStage(
        props.scenario.scenario_id,
        props.version,
        { stage: props.targetStage, reason: body.reason, evidence_ref: body.evidence_ref },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "단계 변경됨" });
      for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  if (!can("scenario.update")) return null;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        className="btn"
        type="button"
        title="운영 검토 단계만 변경합니다. 운영 인증과 배포 승인은 별도입니다."
        disabled={props.currentStage === props.targetStage || mut.isPending}
        onClick={() => {
          setReason("");
          setEvidenceRef("");
          setMsg(null);
          setConfirming(true);
        }}
      >
        {mut.isPending ? "변경 중…" : targetLabel}
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`} role={msg.tone === "green" ? "status" : "alert"}>{msg.text}</span>}
      {confirming && (
        <ConfirmDialog
          title={`${props.scenario.name} v${props.version} 운영 검토 단계: ${governanceStageLabel(props.targetStage)}`}
          confirmDisabled={reason.trim() === "" || evidenceRef.trim() === "" || mut.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            const body = { reason: reason.trim(), evidence_ref: evidenceRef.trim() };
            setConfirming(false);
            mut.mutate(body);
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span className="label">변경 사유</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="label">근거 링크/문서</span>
            <input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="예: 결재 GOV-123 또는 감사 문서 링크" />
          </label>
        </ConfirmDialog>
      )}
    </span>
  );
}

export function governanceStage(certification?: ScenarioCertification | null): ScenarioGovernanceStage {
  return certification?.governance_stage ?? (certification?.status === "certified" && certification.valid_for_prod ? "certified" : "dev");
}

function governanceStageLabel(stage: ScenarioGovernanceStage): string {
  const labels: Record<ScenarioGovernanceStage, string> = {
    dev: "초안 검토 전",
    review: "검토 중",
    pilot: "파일럿 운영",
    certified: "운영 인증",
    deprecated: "사용 중단",
  };
  return labels[stage];
}

function governanceStageTransitionLabel(stage: ScenarioGovernanceTransitionStage): string {
  const labels: Record<ScenarioGovernanceTransitionStage, string> = {
    review: "검토로 보내기",
    pilot: "파일럿으로 지정",
    deprecated: "사용 중단 표시",
  };
  return labels[stage];
}

function governanceStageTone(stage: ScenarioGovernanceStage): "green" | "amber" | "red" | "blue" | "muted" {
  if (stage === "certified") return "green";
  if (stage === "pilot") return "amber";
  if (stage === "review") return "blue";
  if (stage === "deprecated") return "red";
  return "muted";
}
