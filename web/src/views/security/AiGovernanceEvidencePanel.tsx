import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { useListView } from "../../api/useListView";
import type {
  AiGovernanceEvidence,
  AiGovernanceEvidenceListParams,
  AiGovernanceEvidenceStatus,
  AiGovernanceEvidenceType,
} from "../../api/types";
import { FilterSelect } from "../../components/FilterSelect";
import { AiGovernanceEvidenceRecorder } from "./AiGovernanceEvidenceRecorder";
import { EvidenceTable, EvidenceTile } from "./AiGovernanceEvidenceTable";
import {
  EVIDENCE_STATUSES,
  EVIDENCE_TYPES,
  buildEvidenceRequest,
  evidenceStatusLabel,
  evidenceTypeLabel,
  governanceEvidenceKey,
  stringFilterValue,
  summarizeEvidence,
  type EvidenceRecordDraft,
} from "./ai-governance-evidence-shared";

export function AiGovernanceEvidencePanel(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const queryClient = useQueryClient();
  const [subjectDraft, setSubjectDraft] = useState("");
  const [lastRecordedId, setLastRecordedId] = useState<string | null>(null);
  const lv = useListView<AiGovernanceEvidence>(
    ["ai-governance-evidence"],
    (params) => api.listAiGovernanceEvidence(params as AiGovernanceEvidenceListParams),
    { limit: 25, refetchInterval: 30_000 },
  );
  const items = lv.query.data?.items ?? [];
  const summary = useMemo(() => summarizeEvidence(items), [items]);
  // 준비도가 대조하는 요구 증빙(대상 참조는 테넌트 모델에서 파생) — 기록기가 정확한 값을 제시하도록 읽는다.
  // 기록 권한이 없으면 조회하지 않는다(읽기 전용 표면에서 불필요한 403 방지).
  const canManage = can("ai_governance.manage");
  const readiness = useQuery({
    queryKey: ["production-readiness"],
    queryFn: () => api.getProductionReadiness(),
    enabled: canManage,
  });
  const recordMutation = useMutation({
    mutationFn: (draft: EvidenceRecordDraft) => api.recordAiGovernanceEvidence(buildEvidenceRequest(draft), governanceEvidenceKey(draft)),
    onSuccess: (item) => {
      setLastRecordedId(item.evidence_id);
      void queryClient.invalidateQueries({ queryKey: ["ai-governance-evidence"] });
      // 기록이 요구를 충족했는지 즉시 반영(요구 목록·게이트 상태).
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
    },
  });

  function setFilter(key: keyof AiGovernanceEvidenceListParams, value: string | undefined): void {
    lv.setFilter({ ...lv.filter, [key]: value });
  }

  function applySubjectFilter(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFilter("subject_ref", subjectDraft.trim().length > 0 ? subjectDraft.trim() : undefined);
  }

  return (
    <section className="panel" aria-label="AI 거버넌스 증빙">
      <div className="panel-head">
        <div>
          <h2>AI 거버넌스 증빙</h2>
        </div>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <FilterSelect
            label="종류"
            value={stringFilterValue(lv.filter.evidence_type)}
            options={EVIDENCE_TYPES}
            labelFor={(value) => evidenceTypeLabel(value as AiGovernanceEvidenceType)}
            onChange={(value) => setFilter("evidence_type", value)}
          />
          <FilterSelect
            label="상태"
            value={stringFilterValue(lv.filter.status)}
            options={EVIDENCE_STATUSES}
            labelFor={(value) => evidenceStatusLabel(value as AiGovernanceEvidenceStatus)}
            onChange={(value) => setFilter("status", value)}
          />
          <form onSubmit={applySubjectFilter} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <label className="subtle" htmlFor="ai-governance-subject-filter">
              대상
            </label>
            <input
              id="ai-governance-subject-filter"
              value={subjectDraft}
              onChange={(event) => setSubjectDraft(event.target.value)}
              placeholder="model:codex-prod-primary"
              style={{
                minWidth: 220,
                border: "1px solid var(--line-strong)",
                borderRadius: 8,
                background: "var(--surface)",
                color: "var(--text)",
                font: "inherit",
                padding: "5px 8px",
              }}
            />
            <button className="btn" type="submit">적용</button>
          </form>
        </span>
      </div>
      <div className="panel-body">
        <div className="ops-health-grid" style={{ paddingTop: 16 }}>
          <EvidenceTile title="증빙 건수" value={String(summary.total)} detail="현재 필터 페이지" tone="blue" />
          <EvidenceTile title="유효" value={String(summary.valid)} detail="감사 연동 승인" tone={summary.valid > 0 ? "green" : "muted"} />
          <EvidenceTile title="보류" value={String(summary.deferred)} detail="증빙 보완 대기" tone={summary.deferred > 0 ? "amber" : "muted"} />
          <EvidenceTile title="실패" value={String(summary.failed)} detail="통제 점검 실패" tone={summary.failed > 0 ? "red" : "muted"} />
        </div>
        <EvidenceTable queryState={lv.query} items={items} />
        {lv.pager.hasPrev || lv.pager.hasNext ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", alignItems: "center" }}>
            <button className="btn" type="button" onClick={lv.pager.onPrev} disabled={!lv.pager.hasPrev}>이전</button>
            <span className="subtle">{lv.pager.pageIndex + 1}페이지</span>
            <button className="btn" type="button" onClick={lv.pager.onNext} disabled={!lv.pager.hasNext}>다음</button>
          </div>
        ) : null}
        {canManage ? (
          <AiGovernanceEvidenceRecorder
            isRecording={recordMutation.isPending}
            error={recordMutation.error}
            lastRecordedId={lastRecordedId}
            requirements={readiness.data?.signals.ai_governance.requirements}
            onSubmit={(draft) => recordMutation.mutate(draft)}
          />
        ) : (
          <p className="subtle" style={{ borderTop: "1px solid var(--line)", margin: "0 16px 16px", paddingTop: 12 }}>
            AI 거버넌스 증빙 기록은 관리자 권한이 필요합니다.
          </p>
        )}
      </div>
    </section>
  );
}
