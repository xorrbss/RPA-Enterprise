import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AutomationAdoptionEvidenceItem,
  AutomationAdoptionEvidenceStatus,
  AutomationAdoptionEvidenceType,
  AutomationIdeaItem,
} from "../../api/types";
import { useApiClient } from "../../api/context";
import {
  ADOPTION_EVIDENCE_STATUS_LABEL,
  ADOPTION_EVIDENCE_TYPES,
  ADOPTION_EVIDENCE_TYPE_LABEL,
  adoptionEvidenceStatusTone,
} from "./labels";
import {
  adoptionEvidenceDefaults,
  adoptionEvidenceValidationMessage,
  idempotencyKey,
  type AdoptionEvidenceFormState,
} from "./forms";

export function useAdoptionEvidence(selected: AutomationIdeaItem | null, canManageIdeas: boolean) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [adoptionEvidenceInput, setAdoptionEvidenceInput] = useState<AdoptionEvidenceFormState>(() => adoptionEvidenceDefaults());

  const adoptionEvidence = useQuery({
    queryKey: ["automation-ideas", selected?.idea_id, "adoption-evidence"],
    queryFn: () => (
      selected === null
        ? Promise.resolve({ items: [] as AutomationAdoptionEvidenceItem[], next_cursor: null })
        : api.listAutomationAdoptionEvidence(selected.idea_id, { limit: 6 })
    ),
    enabled: selected !== null,
  });

  const saveAdoptionEvidence = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.recordAutomationAdoptionEvidence(
        idea.idea_id,
        {
          evidence_type: adoptionEvidenceInput.evidence_type,
          status: adoptionEvidenceInput.status,
          evidence_at: new Date().toISOString(),
          evidence_ref: adoptionEvidenceInput.evidence_ref.trim(),
          summary: adoptionEvidenceInput.summary.trim(),
          metadata: { source: "coe_pipeline" },
        },
        idempotencyKey("adoption-evidence"),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-ideas", selected?.idea_id, "adoption-evidence"] }),
  });

  const adoptionEvidenceInvalidReason = adoptionEvidenceValidationMessage(adoptionEvidenceInput);
  const canSaveAdoptionEvidence = canManageIdeas && selected !== null && adoptionEvidenceInvalidReason === null && !saveAdoptionEvidence.isPending;
  const adoptionEvidenceItems = adoptionEvidence.data?.items ?? [];
  const validAdoptionEvidenceCount = new Set(
    adoptionEvidenceItems.filter((item) => item.status === "valid").map((item) => item.evidence_type),
  ).size;

  return {
    adoptionEvidence,
    adoptionEvidenceInput,
    setAdoptionEvidenceInput,
    saveAdoptionEvidence,
    adoptionEvidenceInvalidReason,
    canSaveAdoptionEvidence,
    adoptionEvidenceItems,
    validAdoptionEvidenceCount,
  };
}

export function AdoptionEvidencePanel({
  selected,
  evidence,
}: {
  selected: AutomationIdeaItem;
  evidence: ReturnType<typeof useAdoptionEvidence>;
}): JSX.Element {
  const {
    adoptionEvidence,
    adoptionEvidenceInput,
    setAdoptionEvidenceInput,
    saveAdoptionEvidence,
    adoptionEvidenceInvalidReason,
    canSaveAdoptionEvidence,
    adoptionEvidenceItems,
    validAdoptionEvidenceCount,
  } = evidence;
  return (
    <div className="panel-subsection" aria-label="파일럿 준비도 증빙">
      <div className="panel-head compact">
        <h3>파일럿 준비도 증빙</h3>
        <span className={`badge ${validAdoptionEvidenceCount === ADOPTION_EVIDENCE_TYPES.length ? "green" : "amber"}`}>
          유효 {validAdoptionEvidenceCount}/{ADOPTION_EVIDENCE_TYPES.length}
        </span>
      </div>
      <div className="form-grid coe-roi-grid">
        <label className="field">
          <span>증빙 유형</span>
          <select
            value={adoptionEvidenceInput.evidence_type}
            onChange={(event) =>
              setAdoptionEvidenceInput({
                ...adoptionEvidenceInput,
                evidence_type: event.target.value as AutomationAdoptionEvidenceType,
              })}
          >
            {ADOPTION_EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>{ADOPTION_EVIDENCE_TYPE_LABEL[type]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>상태</span>
          <select
            value={adoptionEvidenceInput.status}
            onChange={(event) =>
              setAdoptionEvidenceInput({
                ...adoptionEvidenceInput,
                status: event.target.value as AutomationAdoptionEvidenceStatus,
              })}
          >
            <option value="valid">유효</option>
            <option value="failed">실패</option>
            <option value="deferred">보류</option>
          </select>
        </label>
        <label className="field">
          <span>증빙 참조</span>
          <input
            value={adoptionEvidenceInput.evidence_ref}
            onChange={(event) => setAdoptionEvidenceInput({ ...adoptionEvidenceInput, evidence_ref: event.target.value })}
            placeholder="ticket:PILOT-123"
          />
        </label>
        <label className="field wide">
          <span>요약</span>
          <input
            value={adoptionEvidenceInput.summary}
            onChange={(event) => setAdoptionEvidenceInput({ ...adoptionEvidenceInput, summary: event.target.value })}
            placeholder="담당자 승인 기록됨."
          />
        </label>
      </div>
      <div className="coe-roi-summary">
        <span><strong>{adoptionEvidenceItems.length}</strong><small>기록</small></span>
        <span><strong>{validAdoptionEvidenceCount}</strong><small>유효 유형</small></span>
        <button
          className="btn"
          type="button"
          onClick={() => selected !== null && adoptionEvidenceInvalidReason === null && saveAdoptionEvidence.mutate(selected)}
          disabled={!canSaveAdoptionEvidence}
        >
          {saveAdoptionEvidence.isPending ? "저장 중" : "증빙 기록"}
        </button>
        {adoptionEvidenceInvalidReason !== null && <span className="badge red coe-roi-alert" role="alert">{adoptionEvidenceInvalidReason}</span>}
        {saveAdoptionEvidence.isError && <span className="badge red">증빙 저장 실패</span>}
      </div>
      {adoptionEvidence.isError && <p className="form-alert red" role="alert">파일럿 증빙을 불러오지 못했습니다.</p>}
      {adoptionEvidenceItems.length > 0 && (
        <div className="mini-table" aria-label="파일럿 준비도 증빙 목록">
          {adoptionEvidenceItems.map((item) => (
            <div className="mini-table-row" key={item.evidence_id}>
              <span>{ADOPTION_EVIDENCE_TYPE_LABEL[item.evidence_type]}</span>
              <strong className={`badge ${adoptionEvidenceStatusTone(item.status)}`}>{ADOPTION_EVIDENCE_STATUS_LABEL[item.status]}</strong>
              <span>{item.evidence_ref ?? "-"}</span>
              <span>{item.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
