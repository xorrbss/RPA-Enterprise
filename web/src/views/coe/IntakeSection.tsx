import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type {
  AutomationIdeaItem,
  AutomationIdeaPriority,
  AutomationIdeaSource,
  ProcessMiningImportItem,
} from "../../api/types";
import { useApiClient } from "../../api/context";
import { navigate } from "../../router";
import { PRIORITIES, PRIORITY_LABEL, PROCESS_IMPORT_SOURCE_LABEL, SOURCES, SOURCE_LABEL } from "./labels";
import { idempotencyKey, ideaSourceRequiresImport } from "./forms";

export function IntakeSection({
  source,
  setSource,
  eligibleImports,
  selectedSourceImport,
  setSelectedImportId,
  canManageIdeas,
  onCreated,
}: {
  source: AutomationIdeaSource;
  setSource: (value: AutomationIdeaSource) => void;
  eligibleImports: readonly ProcessMiningImportItem[];
  selectedSourceImport: ProcessMiningImportItem | null;
  setSelectedImportId: (value: string) => void;
  canManageIdeas: boolean;
  onCreated: (idea: AutomationIdeaItem) => Promise<void>;
}): JSX.Element {
  const api = useApiClient();
  // T8: 예시 값 프리필 제거 — 실데이터와 예시를 구분할 수 없었다(감사 P2). 예시는 placeholder로만 보인다.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [department, setDepartment] = useState("");
  const [priority, setPriority] = useState<AutomationIdeaPriority>("high");
  const [score, setScore] = useState("");
  const [sourceItemRef, setSourceItemRef] = useState("");

  const createIdea = useMutation({
    mutationFn: () =>
      api.createAutomationIdea(
        {
          title,
          description,
          business_owner: owner,
          department,
          source,
          priority,
          score: Number(score),
          ...(selectedSourceImport !== null && ideaSourceRequiresImport(source)
            ? {
              source_import_id: selectedSourceImport.import_id,
              source_item_ref: sourceItemRef.trim(),
              source_lineage: {
                source_system: selectedSourceImport.source_system,
                source_owner_ref: selectedSourceImport.source_owner_ref,
                schema_version: selectedSourceImport.schema_version,
                import_evidence_ref: selectedSourceImport.import_evidence_ref,
                lineage_ref: selectedSourceImport.lineage_ref,
              },
            }
            : {}),
        },
        idempotencyKey("automation-idea"),
      ),
    onSuccess: (idea) => onCreated(idea),
  });

  const requiresImportLineage = ideaSourceRequiresImport(source);
  const canCreateIdea = canManageIdeas
    && !createIdea.isPending
    && (!requiresImportLineage || (selectedSourceImport !== null && sourceItemRef.trim().length > 0));

  return (
    <section className="panel coe-intake" aria-label="자동화 후보 접수">
      <div className="panel-head">
        <h2>자동화 후보 접수</h2>
        <span className="badge blue">CoE 파이프라인</span>
      </div>
      <div className="form-grid coe-form">
        <label className="field">
          <span>업무명</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 거래처 포털 지급 상태 확인" />
        </label>
        <label className="field">
          <span>업무 담당자</span>
          <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="예: 재무운영팀" />
        </label>
        <label className="field">
          <span>부서</span>
          <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="예: 재무" />
        </label>
        <label className="field">
          <span>발굴 출처</span>
          <select value={source} onChange={(event) => setSource(event.target.value as AutomationIdeaSource)}>
            {SOURCES.map((value) => <option key={value} value={value}>{SOURCE_LABEL[value]}</option>)}
          </select>
        </label>
        {requiresImportLineage && (
          <>
            <label className="field">
              <span>가져오기 원본</span>
              <select value={selectedSourceImport?.import_id ?? ""} onChange={(event) => setSelectedImportId(event.target.value)}>
                {eligibleImports.length === 0 ? (
                  <option value="">사용 가능한 가져오기 없음</option>
                ) : (
                  eligibleImports.map((item) => (
                    <option key={item.import_id} value={item.import_id}>
                      {PROCESS_IMPORT_SOURCE_LABEL[item.source_type]} · {item.source_system} · {item.schema_version}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="field">
              <span>원본 항목 참조</span>
              <input value={sourceItemRef} onChange={(event) => setSourceItemRef(event.target.value)} placeholder="예: candidate:vendor-status" />
            </label>
          </>
        )}
        <label className="field">
          <span>우선순위</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value as AutomationIdeaPriority)}>
            {PRIORITIES.map((value) => <option key={value} value={value}>{PRIORITY_LABEL[value]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>우선순위 점수</span>
          <input type="number" min={0} max={100} value={score} onChange={(event) => setScore(event.target.value)} />
        </label>
        <label className="field coe-description">
          <span>설명</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="예: 거래처 포털에서 지급 상태를 확인하고 예외만 재무 운영팀에 전달합니다." />
        </label>
      </div>
      <div className="inline-actions coe-actions">
        <button className="btn primary" type="button" onClick={() => createIdea.mutate()} disabled={!canCreateIdea}>
          {createIdea.isPending ? "등록 중" : "후보 등록"}
        </button>
        {requiresImportLineage && selectedSourceImport === null && <span className="badge amber">가져오기 계보 필요</span>}
        <button className="btn" type="button" onClick={() => navigate("scenarioStudio")}>자동화 설계안 만들기</button>
        <button className="btn" type="button" onClick={() => navigate("automationOps")}>운영 예약 만들기</button>
        {createIdea.isError && <span className="badge red">등록 실패</span>}
      </div>
    </section>
  );
}
