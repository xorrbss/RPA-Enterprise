import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AutomationIdeaSource, ProcessMiningImportItem, ProcessMiningImportSourceType } from "../../api/types";
import { useApiClient } from "../../api/context";
import { ErrorState } from "../../components/states";
import { importStatusTone, PROCESS_IMPORT_SOURCE_LABEL, PROCESS_IMPORT_SOURCE_TYPES, PROCESS_IMPORT_STATUS_LABEL } from "./labels";
import {
  idempotencyKey,
  processImportValidationMessage,
  processMiningImportDefaults,
  schemaMappingForSource,
  type ProcessMiningImportFormState,
} from "./forms";

export function ImportsPanel({
  processImportItems,
  isError,
  onRetry,
  canManageIdeas,
  setSource,
  setSelectedImportId,
}: {
  processImportItems: readonly ProcessMiningImportItem[];
  isError: boolean;
  onRetry: () => void;
  canManageIdeas: boolean;
  setSource: (value: AutomationIdeaSource) => void;
  setSelectedImportId: (value: string) => void;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [processImportInput, setProcessImportInput] = useState<ProcessMiningImportFormState>(() => processMiningImportDefaults());

  const createProcessImport = useMutation({
    mutationFn: () =>
      api.createProcessMiningImport(
        {
          source_type: processImportInput.source_type,
          source_system: processImportInput.source_system.trim(),
          source_owner_ref: processImportInput.source_owner_ref.trim(),
          schema_version: processImportInput.schema_version.trim(),
          import_evidence_ref: processImportInput.import_evidence_ref.trim(),
          lineage_ref: processImportInput.lineage_ref.trim(),
          row_count: Number(processImportInput.row_count),
          candidate_count: Number(processImportInput.candidate_count),
          anonymization_mode: "aggregated_alias",
          schema_mapping: schemaMappingForSource(processImportInput.source_type),
          import_summary: processImportInput.import_summary.trim(),
        },
        idempotencyKey("process-mining-import"),
      ),
    onSuccess: async (item) => {
      setSelectedImportId(item.import_id);
      await queryClient.invalidateQueries({ queryKey: ["process-mining-imports"] });
    },
  });

  const importInvalidReason = processImportValidationMessage(processImportInput);

  return (
    <section className="panel coe-imports" aria-label="프로세스·태스크 마이닝 가져오기">
      <div className="panel-head">
        <h2>가져오기 계보</h2>
        <span className="badge blue">출처 {processImportItems.length}개</span>
      </div>
      <div className="form-grid coe-form">
        <label className="field">
          <span>가져오기 유형</span>
          <select
            value={processImportInput.source_type}
            onChange={(event) =>
              setProcessImportInput({ ...processImportInput, source_type: event.target.value as ProcessMiningImportSourceType })}
          >
            {PROCESS_IMPORT_SOURCE_TYPES.map((value) => (
              <option key={value} value={value}>{PROCESS_IMPORT_SOURCE_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>원본 시스템</span>
          <input value={processImportInput.source_system} onChange={(event) => setProcessImportInput({ ...processImportInput, source_system: event.target.value })} />
        </label>
        <label className="field">
          <span>원본 담당자</span>
          <input value={processImportInput.source_owner_ref} onChange={(event) => setProcessImportInput({ ...processImportInput, source_owner_ref: event.target.value })} />
        </label>
        <label className="field">
          <span>스키마 버전</span>
          <input value={processImportInput.schema_version} onChange={(event) => setProcessImportInput({ ...processImportInput, schema_version: event.target.value })} />
        </label>
        <label className="field">
          <span>증빙 참조</span>
          <input value={processImportInput.import_evidence_ref} onChange={(event) => setProcessImportInput({ ...processImportInput, import_evidence_ref: event.target.value })} />
        </label>
        <label className="field">
          <span>계보 참조</span>
          <input value={processImportInput.lineage_ref} onChange={(event) => setProcessImportInput({ ...processImportInput, lineage_ref: event.target.value })} />
        </label>
        <label className="field">
          <span>행 수</span>
          <input type="number" min={1} value={processImportInput.row_count} onChange={(event) => setProcessImportInput({ ...processImportInput, row_count: event.target.value })} />
        </label>
        <label className="field">
          <span>후보 수</span>
          <input type="number" min={0} value={processImportInput.candidate_count} onChange={(event) => setProcessImportInput({ ...processImportInput, candidate_count: event.target.value })} />
        </label>
        <label className="field coe-description">
          <span>요약</span>
          <textarea value={processImportInput.import_summary} onChange={(event) => setProcessImportInput({ ...processImportInput, import_summary: event.target.value })} rows={2} />
        </label>
      </div>
      <div className="inline-actions coe-actions">
        <button
          className="btn"
          type="button"
          onClick={() => importInvalidReason === null && createProcessImport.mutate()}
          disabled={!canManageIdeas || importInvalidReason !== null || createProcessImport.isPending}
        >
          {createProcessImport.isPending ? "등록 중" : "가져오기 등록"}
        </button>
        {importInvalidReason !== null && <span className="badge red" role="alert">{importInvalidReason}</span>}
        {createProcessImport.isError && <span className="badge red">가져오기 거부됨</span>}
      </div>
      {isError ? (
        <ErrorState message="가져오기 계보를 불러오지 못했습니다." onRetry={onRetry} />
      ) : (
        <div className="coe-priority-list" aria-label="가져오기 계보 목록">
          {processImportItems.length === 0 ? (
            <p className="subtle">등록된 가져오기 계보가 없습니다.</p>
          ) : (
            processImportItems.slice(0, 4).map((item) => (
              <button
                key={item.import_id}
                className="coe-priority-item"
                type="button"
                onClick={() => {
                  setSource(item.source_type === "process_mining" || item.source_type === "task_mining" ? item.source_type : "imported");
                  setSelectedImportId(item.import_id);
                }}
              >
                <span className={`badge ${importStatusTone(item.status)}`}>{PROCESS_IMPORT_STATUS_LABEL[item.status]}</span>
                <span>
                  <strong>{item.source_system}</strong>
                  <small>{PROCESS_IMPORT_SOURCE_LABEL[item.source_type]} · {item.source_owner_ref} · {item.schema_version}</small>
                </span>
                <span className="mono">{item.candidate_count}/{item.row_count}</span>
              </button>
            ))
          )}
        </div>
      )}
    </section>
  );
}
