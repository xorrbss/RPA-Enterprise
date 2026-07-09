import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { AutomationIdeaItem, AutomationIdeaSource, AutomationIdeaStage } from "../api/types";
import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { currency } from "./coe/labels";
import {
  appendUniqueIdeas,
  approvalDecision,
  ideaSourceRequiresImport,
  importMatchesIdeaSource,
  readRoi,
  roiPreview,
  roiValidationMessage,
  type RoiFormState,
} from "./coe/forms";
import { IntakeSection } from "./coe/IntakeSection";
import { ImportsPanel } from "./coe/ImportsPanel";
import { CandidateFiltersPanel, IdeaListPanel } from "./coe/IdeaBoard";
import { DetailSection } from "./coe/DetailSection";
import { RoiSection } from "./coe/RoiSection";

export function CoePipelineView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const queryClient = useQueryClient();
  const [stageFilter, setStageFilter] = useState<"all" | AutomationIdeaStage>("all");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ideaCursor, setIdeaCursor] = useState<string | null>(null);
  const [nextIdeaCursor, setNextIdeaCursor] = useState<string | null>(null);
  const [ideaItems, setIdeaItems] = useState<AutomationIdeaItem[]>([]);
  const [source, setSource] = useState<AutomationIdeaSource>("manual");
  const [selectedImportId, setSelectedImportId] = useState("");
  const [roiInput, setRoiInput] = useState<RoiFormState>({
    frequency_per_month: "120",
    minutes_per_case: "8",
    exception_rate: "0.1",
    hourly_cost: "40000",
    implementation_effort: "3200000",
    platform_monthly_cost: "0",
    avoided_license_cost: "0",
    confidence: "medium",
  });

  const ownerQuery = ownerFilter.trim();
  const departmentQuery = departmentFilter.trim();

  const ideas = useQuery({
    queryKey: ["automation-ideas", stageFilter, ownerQuery, departmentQuery, ideaCursor],
    queryFn: () => api.listAutomationIdeas({
      limit: 50,
      ...(ideaCursor !== null ? { cursor: ideaCursor } : {}),
      ...(stageFilter !== "all" ? { stage: stageFilter } : {}),
      ...(ownerQuery.length > 0 ? { owner: ownerQuery } : {}),
      ...(departmentQuery.length > 0 ? { department: departmentQuery } : {}),
    }),
    refetchInterval: 10_000,
  });
  const processImports = useQuery({
    queryKey: ["process-mining-imports"],
    queryFn: () => api.listProcessMiningImports({ limit: 50 }),
    refetchInterval: 30_000,
  });

  const selected = useMemo(
    () => ideaItems.find((item) => item.idea_id === selectedId) ?? ideaItems[0] ?? null,
    [ideaItems, selectedId],
  );
  const processImportItems = processImports.data?.items ?? [];
  const eligibleImports = useMemo(
    () => processImportItems.filter((item) => item.status !== "blocked" && importMatchesIdeaSource(source, item)),
    [processImportItems, source],
  );
  const selectedSourceImport = useMemo(
    () => eligibleImports.find((item) => item.import_id === selectedImportId) ?? eligibleImports[0] ?? null,
    [eligibleImports, selectedImportId],
  );
  const canManageIdeas = can("automation_idea.manage");
  const canApproveIdeas = can("automation_idea.approve");

  function resetIdeaPaging(): void {
    setIdeaCursor(null);
    setNextIdeaCursor(null);
    setIdeaItems([]);
    setSelectedId(null);
  }

  function applyStageFilter(stage: "all" | AutomationIdeaStage): void {
    resetIdeaPaging();
    setStageFilter(stage);
  }

  function applyOwnerFilter(value: string): void {
    resetIdeaPaging();
    setOwnerFilter(value);
  }

  function applyDepartmentFilter(value: string): void {
    resetIdeaPaging();
    setDepartmentFilter(value);
  }

  useEffect(() => {
    if (ideas.data === undefined) return;
    setNextIdeaCursor(ideas.data.next_cursor);
    setIdeaItems((current) =>
      ideaCursor === null
        ? [...ideas.data.items]
        : appendUniqueIdeas(current, ideas.data.items),
    );
  }, [ideaCursor, ideas.data]);

  useEffect(() => {
    if (!ideaSourceRequiresImport(source)) {
      if (selectedImportId.length > 0) setSelectedImportId("");
      return;
    }
    if (selectedSourceImport !== null && selectedSourceImport.import_id !== selectedImportId) {
      setSelectedImportId(selectedSourceImport.import_id);
    }
  }, [selectedImportId, selectedSourceImport, source]);

  useEffect(() => {
    if (selected === null) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selected.idea_id !== selectedId) setSelectedId(selected.idea_id);
  }, [selected, selectedId]);

  const roi = useQuery({
    queryKey: ["automation-ideas", selected?.idea_id, "roi"],
    queryFn: () => (selected === null ? Promise.resolve(null) : readRoi(api, selected.idea_id)),
    enabled: selected !== null,
  });

  useEffect(() => {
    if (roi.data !== null && roi.data !== undefined) {
      setRoiInput({
        frequency_per_month: String(roi.data.frequency_per_month),
        minutes_per_case: String(roi.data.minutes_per_case),
        exception_rate: String(roi.data.exception_rate),
        hourly_cost: String(roi.data.hourly_cost),
        implementation_effort: String(roi.data.implementation_effort),
        platform_monthly_cost: String(roi.data.platform_monthly_cost),
        avoided_license_cost: String(roi.data.avoided_license_cost),
        confidence: roi.data.confidence,
      });
    }
  }, [roi.data]);

  async function handleIdeaCreated(idea: AutomationIdeaItem): Promise<void> {
    setIdeaCursor(null);
    setNextIdeaCursor(null);
    setIdeaItems([]);
    setSelectedId(idea.idea_id);
    await queryClient.invalidateQueries({ queryKey: ["automation-ideas"] });
  }

  const stageCounts = useMemo(() => {
    const counts: Record<AutomationIdeaStage, number> = {
      intake: 0,
      assess: 0,
      approved: 0,
      build: 0,
      operate: 0,
      rejected: 0,
      archived: 0,
    };
    for (const item of ideaItems) counts[item.stage] += 1;
    return counts;
  }, [ideaItems]);
  const rankedIdeas = useMemo(
    () => [...ideaItems].sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at)).slice(0, 3),
    [ideaItems],
  );
  const hasMoreIdeas = nextIdeaCursor !== null;
  const loadedIdeaCountLabel = `${ideaItems.length}${hasMoreIdeas ? "+" : ""}`;
  const loadedMetricHint = hasMoreIdeas ? "불러온 범위 기준" : "전체 필터 결과";
  const ideaPageLoading = ideas.isLoading && ideaCursor === null;
  const ideaPageFetchingMore = ideas.isFetching && ideaCursor !== null;

  const roiInvalidReason = roiValidationMessage(roiInput);
  const preview = roi.data ?? (
    roiInvalidReason === null
      ? roiPreview(roiInput)
      : {
        monthly_hours_saved: null,
        estimated_monthly_value: null,
        platform_monthly_cost: null,
        avoided_license_cost: null,
        monthly_value: null,
        payback_months: null,
        viability: null,
      }
  );
  const decision = approvalDecision(selected, roi.data);

  return (
    <div className="coe-view">
      <div className="metrics coe-metrics">
        <button className="metric metric-link" type="button" onClick={() => applyStageFilter("all")}>
          <span className="label">자동화 후보</span>
          <span className="value">{loadedIdeaCountLabel}</span>
          <span className="metric-hint subtle">{loadedMetricHint}</span>
        </button>
        <button className="metric metric-link" type="button" onClick={() => applyStageFilter("assess")}>
          <span className="label">평가 대기</span>
          <span className="value">{stageCounts.assess}{hasMoreIdeas ? "+" : ""}</span>
          <span className="metric-hint subtle">ROI 산정 필요</span>
        </button>
        <button className="metric metric-link" type="button" onClick={() => applyStageFilter("approved")}>
          <span className="label">승인 완료</span>
          <span className="value">{stageCounts.approved + stageCounts.build + stageCounts.operate}{hasMoreIdeas ? "+" : ""}</span>
          <span className="metric-hint subtle">구축·운영 진행</span>
        </button>
        <div className="metric" aria-label="예상 월 절감액">
          <span className="label">예상 월 절감액</span>
          <span className="value">{currency(preview.estimated_monthly_value)}</span>
          {/* T8: 후보 0건인데 절감액이 보이던 모순(감사 P2) — 이 값의 실제 출처(ROI 계산 양식 미리보기)를 명시. */}
          <span className="metric-hint subtle">ROI 계산 양식 미리보기 기준</span>
        </div>
      </div>

      <IntakeSection
        source={source}
        setSource={setSource}
        eligibleImports={eligibleImports}
        selectedSourceImport={selectedSourceImport}
        setSelectedImportId={setSelectedImportId}
        canManageIdeas={canManageIdeas}
        onCreated={handleIdeaCreated}
      />

      <ImportsPanel
        processImportItems={processImportItems}
        isError={processImports.isError}
        onRetry={() => void processImports.refetch()}
        canManageIdeas={canManageIdeas}
        setSource={setSource}
        setSelectedImportId={setSelectedImportId}
      />

      <CandidateFiltersPanel
        ownerFilter={ownerFilter}
        departmentFilter={departmentFilter}
        onOwnerFilter={applyOwnerFilter}
        onDepartmentFilter={applyDepartmentFilter}
        onResetFilters={() => { resetIdeaPaging(); setOwnerFilter(""); setDepartmentFilter(""); setStageFilter("all"); }}
        loadedIdeaCountLabel={loadedIdeaCountLabel}
        rankedIdeas={rankedIdeas}
        setSelectedId={setSelectedId}
      />

      <div className="coe-layout">
        <IdeaListPanel
          stageFilter={stageFilter}
          onStageFilter={applyStageFilter}
          isError={ideas.isError}
          onRetry={() => void ideas.refetch()}
          ideaPageLoading={ideaPageLoading}
          ideaItems={ideaItems}
          selectedIdeaId={selected?.idea_id ?? null}
          setSelectedId={setSelectedId}
          nextIdeaCursor={nextIdeaCursor}
          setIdeaCursor={setIdeaCursor}
          ideaPageFetchingMore={ideaPageFetchingMore}
        />

        <DetailSection
          selected={selected}
          decision={decision}
          roiData={roi.data}
          canManageIdeas={canManageIdeas}
          canApproveIdeas={canApproveIdeas}
          setSelectedId={setSelectedId}
        />
      </div>

      <RoiSection
        selected={selected}
        selectedId={selectedId}
        canManageIdeas={canManageIdeas}
        roiData={roi.data}
        roiInput={roiInput}
        setRoiInput={setRoiInput}
        roiInvalidReason={roiInvalidReason}
        preview={preview}
      />
    </div>
  );
}
