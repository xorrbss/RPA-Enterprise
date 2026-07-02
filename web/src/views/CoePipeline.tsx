import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  type AutomationAdoptionEvidenceItem,
  type AutomationAdoptionEvidenceStatus,
  type AutomationAdoptionEvidenceType,
  type AutomationIdeaItem,
  type AutomationIdeaPriority,
  type AutomationIdeaSource,
  type AutomationIdeaStage,
  type ProcessMiningImportItem,
  type ProcessMiningImportSourceType,
  type ProcessMiningImportStatus,
  type RoiActualEvidence,
  type RoiActualSuggestion,
  type RoiEstimate,
  type RunTriggerItem,
  type ScenarioItem,
} from "../api/types";
import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ErrorState } from "../components/states";
import { navigate, useHashParam } from "../router";

const STAGES: readonly AutomationIdeaStage[] = ["intake", "assess", "approved", "build", "operate", "rejected", "archived"];
const PRIORITIES: readonly AutomationIdeaPriority[] = ["low", "medium", "high", "critical"];
const SOURCES: readonly AutomationIdeaSource[] = ["manual", "process_mining", "task_mining", "imported"];
const PROCESS_IMPORT_SOURCE_TYPES: readonly ProcessMiningImportSourceType[] = ["process_mining", "task_mining", "monitoring_export", "api_import"];
const ADOPTION_EVIDENCE_TYPES: readonly AutomationAdoptionEvidenceType[] = [
  "pilot_charter_signoff",
  "raci_signoff",
  "training_completion",
  "support_model_signoff",
];

const STAGE_LABEL: Record<AutomationIdeaStage, string> = {
  intake: "접수",
  assess: "ROI 검토",
  approved: "승인 완료",
  build: "구축 진행",
  operate: "운영 중",
  rejected: "반려",
  archived: "보관",
};

const PRIORITY_LABEL: Record<AutomationIdeaPriority, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  critical: "긴급",
};

const SOURCE_LABEL: Record<AutomationIdeaSource, string> = {
  manual: "업무 담당자 접수",
  process_mining: "프로세스 분석 발굴",
  task_mining: "작업 분석 발굴",
  imported: "외부 후보 등록",
};

const PROCESS_IMPORT_SOURCE_LABEL: Record<ProcessMiningImportSourceType, string> = {
  process_mining: "Process mining export",
  task_mining: "Task mining export",
  monitoring_export: "Monitoring export",
  api_import: "API import result",
};

const PROCESS_IMPORT_STATUS_LABEL: Record<ProcessMiningImportStatus, string> = {
  received: "Received",
  processed: "Processed",
  blocked: "Blocked",
};

const TRIGGER_STATUS_LABEL: Record<RunTriggerItem["status"], string> = {
  enabled: "운영 중",
  paused: "일시 중지",
  archived: "보관됨",
};

const ADOPTION_EVIDENCE_TYPE_LABEL: Record<AutomationAdoptionEvidenceType, string> = {
  pilot_charter_signoff: "Pilot charter",
  raci_signoff: "RACI signoff",
  training_completion: "Training complete",
  support_model_signoff: "Support model",
};

const ADOPTION_EVIDENCE_STATUS_LABEL: Record<AutomationAdoptionEvidenceStatus, string> = {
  valid: "Valid",
  failed: "Failed",
  deferred: "Deferred",
};

function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextStages(stage: AutomationIdeaStage): readonly AutomationIdeaStage[] {
  if (stage === "intake") return ["assess", "archived"];
  if (stage === "assess") return ["approved", "rejected", "archived"];
  if (stage === "approved") return ["build", "archived"];
  if (stage === "build") return ["operate", "archived"];
  if (stage === "operate" || stage === "rejected") return ["archived"];
  return [];
}

function stageTone(stage: AutomationIdeaStage): string {
  if (stage === "operate" || stage === "approved") return "green";
  if (stage === "build") return "blue";
  if (stage === "rejected" || stage === "archived") return "muted";
  return "amber";
}

function adoptionEvidenceStatusTone(status: AutomationAdoptionEvidenceStatus): string {
  if (status === "valid") return "green";
  if (status === "failed") return "red";
  return "amber";
}

function currency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value);
}

function numberLabel(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value)}${unit}`;
}

function percentLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

function triggerLinkLabel(trigger: RunTriggerItem, scenarioByVersionId: ReadonlyMap<string, ScenarioItem>): string {
  const schedule = trigger.trigger_type === "webhook" ? "업무 이벤트 수신 시 실행" : "정기 실행 예약";
  const scenario = scenarioByVersionId.get(trigger.scenario_version_id);
  const scenarioLabel = scenario === undefined ? "대상 자동화 확인 필요" : `${scenario.name} 자동화`;
  return `${schedule} · ${TRIGGER_STATUS_LABEL[trigger.status]} · ${scenarioLabel}`;
}

function scenarioOptionLabel(scenario: ScenarioItem): string {
  return `${scenario.name} · ${scenario.version}차 자동화안`;
}

interface RoiPreview {
  monthly_hours_saved: number | null;
  estimated_monthly_value: number | null;
  platform_monthly_cost: number | null;
  avoided_license_cost: number | null;
  monthly_value: number | null;
  payback_months: number | null;
  viability: RoiEstimate["viability"] | null;
}

interface ApprovalDecision {
  tone: "green" | "amber";
  label: string;
  title: string;
  summary: string;
  items: readonly string[];
}

function roiPreview(input: RoiFormState): RoiPreview {
  const frequency = Number(input.frequency_per_month);
  const minutes = Number(input.minutes_per_case);
  const exceptionRate = Number(input.exception_rate);
  const hourlyCost = Number(input.hourly_cost);
  const effort = Number(input.implementation_effort);
  const platformMonthlyCost = Number(input.platform_monthly_cost);
  const avoidedLicenseCost = Number(input.avoided_license_cost);
  const monthly_hours_saved = (frequency * minutes * (1 - exceptionRate)) / 60;
  const estimated_monthly_value = monthly_hours_saved * hourlyCost;
  const monthly_value = estimated_monthly_value + avoidedLicenseCost - platformMonthlyCost;
  return {
    monthly_hours_saved,
    estimated_monthly_value,
    platform_monthly_cost: platformMonthlyCost,
    avoided_license_cost: avoidedLicenseCost,
    monthly_value,
    payback_months: monthly_value > 0 ? effort / monthly_value : null,
    viability: monthly_value > 0 ? "viable" : "not_viable",
  };
}

function roiValidationMessage(input: RoiFormState): string | null {
  const frequency = Number(input.frequency_per_month);
  if (!Number.isInteger(frequency) || frequency < 0) return "월 처리 건수는 0 이상의 정수여야 합니다.";
  const minutes = Number(input.minutes_per_case);
  if (!Number.isFinite(minutes) || minutes < 0) return "건당 소요 시간은 0 이상이어야 합니다.";
  const exceptionRate = Number(input.exception_rate);
  if (!Number.isFinite(exceptionRate) || exceptionRate < 0 || exceptionRate > 1) return "예외율은 0에서 1 사이여야 합니다.";
  const hourlyCost = Number(input.hourly_cost);
  if (!Number.isFinite(hourlyCost) || hourlyCost < 0) return "시간당 비용은 0 이상이어야 합니다.";
  const effort = Number(input.implementation_effort);
  if (!Number.isFinite(effort) || effort < 0) return "자동화 구축 비용은 0 이상이어야 합니다.";
  const platformMonthlyCost = Number(input.platform_monthly_cost);
  if (!Number.isFinite(platformMonthlyCost) || platformMonthlyCost < 0) return "Platform monthly cost must be 0 or greater.";
  const avoidedLicenseCost = Number(input.avoided_license_cost);
  if (!Number.isFinite(avoidedLicenseCost) || avoidedLicenseCost < 0) return "Avoided license cost must be 0 or greater.";
  return null;
}

function approvalDecision(idea: AutomationIdeaItem | null, roi: RoiEstimate | null | undefined): ApprovalDecision {
  if (idea === null) {
    return {
      tone: "amber",
      label: "선택 필요",
      title: "후보를 선택해 주세요",
      summary: "자동화 후보를 선택하면 ROI와 운영 연결 상태를 기준으로 승인 판단을 보여줍니다.",
      items: ["후보 목록에서 업무를 선택하세요."],
    };
  }

  if (roi === undefined) {
    return {
      tone: "amber",
      label: "확인 중",
      title: "ROI를 확인하고 있습니다",
      summary: "저장된 ROI와 운영 연결 상태를 불러온 뒤 승인 판단을 갱신합니다.",
      items: ["잠시 후 승인 준비 상태를 확인하세요."],
    };
  }

  const items: string[] = [];
  if (roi === null) {
    items.push("ROI를 저장해야 승인 검토를 시작할 수 있습니다.");
  } else {
    items.push(`회수 기간 ${numberLabel(roi.payback_months, "개월")} · 월 절감액 ${currency(roi.estimated_monthly_value)}`);
    items.push(`순 월가치 ${currency(roi.monthly_value)} · 판정 ${roi.viability}`);
    if (roi.viability === "not_viable") items.push("플랫폼 비용이 월 절감액을 초과해 유한한 회수 기간을 산정하지 않습니다.");
    if (roi.payback_months === null) items.push("회수 기간을 산정할 수 없어 CoE 검토가 필요합니다.");
    if (roi.payback_months !== null && roi.payback_months > 12) items.push("회수 기간이 12개월을 넘어 우선순위 재검토가 필요합니다.");
    if (roi.confidence === "low") items.push("추정 신뢰도가 낮아 처리 건수나 샘플 근거를 보강해야 합니다.");
  }
  if (idea.scenario_id === null) items.push("자동화 설계안을 연결해야 구축 착수 여부를 판단할 수 있습니다.");
  if (idea.run_trigger_id === null) items.push("운영 예약을 연결해야 실제 운영 전환 범위를 확인할 수 있습니다.");

  const needsWork = roi === null
    || roi.payback_months === null
    || roi.viability === "not_viable"
    || (roi.payback_months !== null && roi.payback_months > 12)
    || roi.confidence === "low"
    || idea.scenario_id === null
    || idea.run_trigger_id === null;

  if (!needsWork) {
    return {
      tone: "green",
      label: "승인 추천",
      title: "CoE 승인 요건을 충족합니다",
      summary: "저장된 ROI, 자동화 설계안, 운영 예약이 모두 준비되어 구축 단계로 넘길 수 있습니다.",
      items,
    };
  }

  return {
    tone: "amber",
    label: "보완 필요",
    title: "승인 전에 보완할 항목이 있습니다",
    summary: "ROI 근거와 실행 연결 상태를 먼저 정리하면 승인 회의에서 바로 판단할 수 있습니다.",
    items,
  };
}

interface RoiFormState {
  frequency_per_month: string;
  minutes_per_case: string;
  exception_rate: string;
  hourly_cost: string;
  implementation_effort: string;
  platform_monthly_cost: string;
  avoided_license_cost: string;
  confidence: "low" | "medium" | "high";
}

interface RoiActualFormState {
  period_start: string;
  period_end: string;
  actual_transaction_count: string;
  actual_failure_rate: string;
  human_intervention_minutes: string;
  reprocessing_minutes: string;
  evidence_ref: string;
  summary: string;
}

interface AdoptionEvidenceFormState {
  evidence_type: AutomationAdoptionEvidenceType;
  status: AutomationAdoptionEvidenceStatus;
  evidence_ref: string;
  summary: string;
}

interface ProcessMiningImportFormState {
  source_type: ProcessMiningImportSourceType;
  source_system: string;
  source_owner_ref: string;
  schema_version: string;
  import_evidence_ref: string;
  lineage_ref: string;
  row_count: string;
  candidate_count: string;
  import_summary: string;
}

async function readRoi(api: ReturnType<typeof useApiClient>, ideaId: string): Promise<RoiEstimate | null> {
  try {
    return await api.getRoiEstimate(ideaId);
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) return null;
    throw err;
  }
}

function currentMonthActualDefaults(): RoiActualFormState {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    period_start: dateOnly(start),
    period_end: dateOnly(now),
    actual_transaction_count: "0",
    actual_failure_rate: "0",
    human_intervention_minutes: "0",
    reprocessing_minutes: "0",
    evidence_ref: "ticket:ROI-ACTUAL",
    summary: "Pilot actuals reconciled from run, review, and reprocessing evidence.",
  };
}

function adoptionEvidenceDefaults(): AdoptionEvidenceFormState {
  return {
    evidence_type: "pilot_charter_signoff",
    status: "valid",
    evidence_ref: "ticket:PILOT-123",
    summary: "Pilot readiness evidence reviewed by the CoE owner.",
  };
}

function processMiningImportDefaults(): ProcessMiningImportFormState {
  return {
    source_type: "process_mining",
    source_system: "celonis-export",
    source_owner_ref: "group:process-owner",
    schema_version: "2026-06",
    import_evidence_ref: "artifact:pm-import-1",
    lineage_ref: "lineage:pm-import-1",
    row_count: "120",
    candidate_count: "4",
    import_summary: "Aggregated process mining export from customer-owned monitoring.",
  };
}

function dateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roiActualValidationMessage(input: RoiActualFormState): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.period_end)) return "실제값 기간을 날짜 형식으로 입력해야 합니다.";
  if (input.period_end < input.period_start) return "실제값 종료일은 시작일 이후여야 합니다.";
  const actualCount = Number(input.actual_transaction_count);
  if (!Number.isInteger(actualCount) || actualCount < 0) return "실제 처리 건수는 0 이상의 정수여야 합니다.";
  const failureRate = Number(input.actual_failure_rate);
  if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) return "실제 실패율은 0에서 1 사이여야 합니다.";
  const intervention = Number(input.human_intervention_minutes);
  if (!Number.isFinite(intervention) || intervention < 0) return "사람 개입 시간은 0 이상이어야 합니다.";
  const reprocessing = Number(input.reprocessing_minutes);
  if (!Number.isFinite(reprocessing) || reprocessing < 0) return "재처리 시간은 0 이상이어야 합니다.";
  if (input.evidence_ref.trim().length === 0) return "실제값 근거 참조가 필요합니다.";
  if (input.summary.trim().length === 0) return "실제값 요약이 필요합니다.";
  return null;
}

function adoptionEvidenceValidationMessage(input: AdoptionEvidenceFormState): string | null {
  if (input.evidence_ref.trim().length === 0) return "Pilot evidence ref is required.";
  if (input.summary.trim().length === 0) return "Pilot evidence summary is required.";
  return null;
}

function processImportValidationMessage(input: ProcessMiningImportFormState): string | null {
  if (input.source_system.trim().length === 0) return "Source system is required.";
  if (input.source_owner_ref.trim().length === 0) return "Source owner is required.";
  if (input.schema_version.trim().length === 0) return "Schema version is required.";
  if (input.import_evidence_ref.trim().length === 0) return "Import evidence ref is required.";
  if (input.lineage_ref.trim().length === 0) return "Lineage ref is required.";
  const rowCount = Number(input.row_count);
  if (!Number.isInteger(rowCount) || rowCount < 1) return "Row count must be at least 1.";
  const candidateCount = Number(input.candidate_count);
  if (!Number.isInteger(candidateCount) || candidateCount < 0 || candidateCount > rowCount) return "Candidate count must be 0 through row count.";
  if (input.import_summary.trim().length === 0) return "Import summary is required.";
  return null;
}

function schemaMappingForSource(sourceType: ProcessMiningImportSourceType): Readonly<Record<string, unknown>> {
  if (sourceType === "task_mining") {
    return { task_name: "task_alias", application_alias: "application_alias", timestamp: "event_at" };
  }
  return { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" };
}

function ideaSourceRequiresImport(source: AutomationIdeaSource): boolean {
  return source === "process_mining" || source === "task_mining" || source === "imported";
}

function importMatchesIdeaSource(source: AutomationIdeaSource, item: ProcessMiningImportItem): boolean {
  if (source === "process_mining") return item.source_type === "process_mining";
  if (source === "task_mining") return item.source_type === "task_mining";
  if (source === "imported") return item.source_type === "monitoring_export" || item.source_type === "api_import";
  return false;
}

function importStatusTone(status: ProcessMiningImportStatus): string {
  if (status === "blocked") return "red";
  if (status === "processed") return "green";
  return "blue";
}

function appendUniqueIdeas(
  current: readonly AutomationIdeaItem[],
  incoming: readonly AutomationIdeaItem[],
): AutomationIdeaItem[] {
  const seen = new Set(current.map((item) => item.idea_id));
  const merged = [...current];
  for (const item of incoming) {
    if (seen.has(item.idea_id)) continue;
    seen.add(item.idea_id);
    merged.push(item);
  }
  return merged;
}

export function CoePipelineView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const queryClient = useQueryClient();
  const scenarioParam = useHashParam("scenario");
  const [stageFilter, setStageFilter] = useState<"all" | AutomationIdeaStage>("all");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ideaCursor, setIdeaCursor] = useState<string | null>(null);
  const [nextIdeaCursor, setNextIdeaCursor] = useState<string | null>(null);
  const [ideaItems, setIdeaItems] = useState<AutomationIdeaItem[]>([]);
  const [title, setTitle] = useState("거래처 포털 지급 상태 확인");
  const [description, setDescription] = useState("거래처 포털에서 지급 상태를 확인하고 예외만 재무 운영팀에 전달합니다.");
  const [owner, setOwner] = useState("재무운영팀");
  const [department, setDepartment] = useState("재무");
  const [source, setSource] = useState<AutomationIdeaSource>("manual");
  const [priority, setPriority] = useState<AutomationIdeaPriority>("high");
  const [score, setScore] = useState("82");
  const [processImportInput, setProcessImportInput] = useState<ProcessMiningImportFormState>(() => processMiningImportDefaults());
  const [selectedImportId, setSelectedImportId] = useState("");
  const [sourceItemRef, setSourceItemRef] = useState("candidate:vendor-status");
  const [scenarioId, setScenarioId] = useState("");
  const [appliedScenarioParam, setAppliedScenarioParam] = useState<string | null>(null);
  const [triggerId, setTriggerId] = useState("");
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
  const [roiActualInput, setRoiActualInput] = useState<RoiActualFormState>(() => currentMonthActualDefaults());
  // 제안 배지의 근거 — non-null 이면 현재 건수/실패율 값의 출처가 운영 실행 통계 제안이라는 뜻. 사람이 해당
  // 값·기간을 손대거나 다른 아이디어를 고르면 해제(그때부터는 수기 확정값). 저장 metadata 귀속에도 쓰인다.
  const [roiActualSuggestion, setRoiActualSuggestion] = useState<RoiActualSuggestion | null>(null);
  const [adoptionEvidenceInput, setAdoptionEvidenceInput] = useState<AdoptionEvidenceFormState>(() => adoptionEvidenceDefaults());

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
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }) });
  const triggers = useQuery({ queryKey: ["run-triggers"], queryFn: () => api.listRunTriggers({ limit: 50 }) });
  const scenarioItems = scenarios.data?.items ?? [];
  const triggerItems = triggers.data?.items ?? [];
  const scenarioByVersionId = useMemo(
    () => new Map(scenarioItems.map((scenario) => [scenario.latest_version_id, scenario])),
    [scenarioItems],
  );

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
  const linkedScenario = useMemo(
    () => scenarioItems.find((scenario) => scenario.scenario_id === scenarioId) ?? null,
    [scenarioId, scenarioItems],
  );
  const linkedTrigger = useMemo(
    () => triggerItems.find((trigger) => trigger.trigger_id === triggerId) ?? null,
    [triggerId, triggerItems],
  );
  const linkMismatch = linkedScenario !== null && linkedTrigger !== null && linkedScenario.latest_version_id !== linkedTrigger.scenario_version_id;

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

  // 다른 아이디어로 전환하면 제안 근거는 무효 — 폼 값은 유지되더라도 '제안값' 배지/귀속은 해제한다.
  useEffect(() => {
    setRoiActualSuggestion((current) => (current !== null && current.automation_idea_id !== selectedId ? null : current));
  }, [selectedId]);

  useEffect(() => {
    if (selected !== null) {
      setScenarioId((current) => {
        if (appliedScenarioParam !== null && current === appliedScenarioParam) {
          return current;
        }
        return selected.scenario_id ?? "";
      });
      setTriggerId(selected.run_trigger_id ?? "");
    }
  }, [appliedScenarioParam, selected]);

  useEffect(() => {
    if (scenarioParam === null) {
      if (appliedScenarioParam !== null) setAppliedScenarioParam(null);
      return;
    }
    if (appliedScenarioParam === scenarioParam) return;
    if (scenarioItems.some((scenario) => scenario.scenario_id === scenarioParam)) {
      setScenarioId(scenarioParam);
      setAppliedScenarioParam(scenarioParam);
    }
  }, [appliedScenarioParam, scenarioItems, scenarioParam]);

  const roi = useQuery({
    queryKey: ["automation-ideas", selected?.idea_id, "roi"],
    queryFn: () => (selected === null ? Promise.resolve(null) : readRoi(api, selected.idea_id)),
    enabled: selected !== null,
  });

  const roiActuals = useQuery({
    queryKey: ["automation-ideas", selected?.idea_id, "roi-actuals"],
    queryFn: () => (
      selected === null
        ? Promise.resolve({ items: [] as RoiActualEvidence[], next_cursor: null })
        : api.listRoiActualEvidence(selected.idea_id, { limit: 5 })
    ),
    enabled: selected !== null,
  });

  const adoptionEvidence = useQuery({
    queryKey: ["automation-ideas", selected?.idea_id, "adoption-evidence"],
    queryFn: () => (
      selected === null
        ? Promise.resolve({ items: [] as AutomationAdoptionEvidenceItem[], next_cursor: null })
        : api.listAutomationAdoptionEvidence(selected.idea_id, { limit: 6 })
    ),
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
    onSuccess: async (idea) => {
      setIdeaCursor(null);
      setNextIdeaCursor(null);
      setIdeaItems([]);
      setSelectedId(idea.idea_id);
      await queryClient.invalidateQueries({ queryKey: ["automation-ideas"] });
    },
  });

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

  const transitionIdea = useMutation({
    mutationFn: ({ idea, stage }: { idea: AutomationIdeaItem; stage: AutomationIdeaStage }) =>
      api.transitionAutomationIdea(idea.idea_id, stage, idempotencyKey("automation-idea-stage")),
    onSuccess: async (idea) => {
      setSelectedId(idea.idea_id);
      await queryClient.invalidateQueries({ queryKey: ["automation-ideas"] });
    },
  });

  const updateLinks = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.updateAutomationIdea(
        idea.idea_id,
        { scenario_id: scenarioId.length > 0 ? scenarioId : null, run_trigger_id: triggerId.length > 0 ? triggerId : null },
        idempotencyKey("automation-idea-links"),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-ideas"] }),
  });

  const saveRoi = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.upsertRoiEstimate(
        idea.idea_id,
        {
          frequency_per_month: Number(roiInput.frequency_per_month),
          minutes_per_case: Number(roiInput.minutes_per_case),
          exception_rate: Number(roiInput.exception_rate),
          hourly_cost: Number(roiInput.hourly_cost),
          implementation_effort: Number(roiInput.implementation_effort),
          platform_monthly_cost: Number(roiInput.platform_monthly_cost),
          avoided_license_cost: Number(roiInput.avoided_license_cost),
          confidence: roiInput.confidence,
        },
        idempotencyKey("roi-estimate"),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-ideas", selected?.idea_id, "roi"] }),
  });

  // 제안값 불러오기 — read-only 조회. 성공 시 건수/실패율만 프리필(개입/재처리 시간은 run 통계로 도출 불가 — 날조 금지).
  const loadRoiSuggestion = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.getRoiActualSuggestion(idea.idea_id, {
        period_start: roiActualInput.period_start,
        period_end: roiActualInput.period_end,
      }),
    onSuccess: (suggestion) => {
      setRoiActualSuggestion(suggestion);
      if (suggestion.suggested_actual_transaction_count === null || suggestion.suggested_actual_failure_rate === null) return;
      const count = suggestion.suggested_actual_transaction_count;
      const rate = suggestion.suggested_actual_failure_rate;
      setRoiActualInput((current) => ({
        ...current,
        actual_transaction_count: String(count),
        actual_failure_rate: String(rate),
      }));
    },
  });

  const saveRoiActual = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.recordRoiActualEvidence(
        idea.idea_id,
        {
          period_start: roiActualInput.period_start,
          period_end: roiActualInput.period_end,
          actual_transaction_count: Number(roiActualInput.actual_transaction_count),
          actual_failure_rate: Number(roiActualInput.actual_failure_rate),
          human_intervention_minutes: Number(roiActualInput.human_intervention_minutes),
          reprocessing_minutes: Number(roiActualInput.reprocessing_minutes),
          evidence_ref: roiActualInput.evidence_ref.trim(),
          summary: roiActualInput.summary.trim(),
          // 자동값은 제안일 뿐 — 저장(사람 확정)이 증거다. 프리필을 손대지 않고 확정하면 출처를 정직하게 남기고,
          // 사람이 값을 고쳤으면(제안 해제) 수기 확정으로 귀속한다. 감사 귀속(recorded_by)은 서버가 확정자를 기록.
          metadata: {
            measurement_method:
              roiActualSuggestion !== null && roiActualSuggestion.suggested_actual_transaction_count !== null
                ? "prod_run_stats_prefill_operator_confirmed"
                : "manual_pilot_reconciliation",
          },
        },
        idempotencyKey("roi-actual"),
      ),
    onSuccess: () => {
      setRoiActualSuggestion(null);
      return queryClient.invalidateQueries({ queryKey: ["automation-ideas", selected?.idea_id, "roi-actuals"] });
    },
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
  const importInvalidReason = processImportValidationMessage(processImportInput);
  const requiresImportLineage = ideaSourceRequiresImport(source);
  const canCreateIdea = canManageIdeas
    && !createIdea.isPending
    && (!requiresImportLineage || (selectedSourceImport !== null && sourceItemRef.trim().length > 0));

  const roiInvalidReason = roiValidationMessage(roiInput);
  const canSaveRoi = canManageIdeas && selected !== null && roiInvalidReason === null && !saveRoi.isPending;
  const roiActualInvalidReason = roiActualValidationMessage(roiActualInput);
  const canSaveRoiActual = canManageIdeas && selected !== null && roiActualInvalidReason === null && !saveRoiActual.isPending;
  const roiActualItems = roiActuals.data?.items ?? [];
  const adoptionEvidenceInvalidReason = adoptionEvidenceValidationMessage(adoptionEvidenceInput);
  const canSaveAdoptionEvidence = canManageIdeas && selected !== null && adoptionEvidenceInvalidReason === null && !saveAdoptionEvidence.isPending;
  const adoptionEvidenceItems = adoptionEvidence.data?.items ?? [];
  const validAdoptionEvidenceCount = new Set(
    adoptionEvidenceItems.filter((item) => item.status === "valid").map((item) => item.evidence_type),
  ).size;
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
          <span className="metric-hint subtle">선택 후보 기준</span>
        </div>
      </div>

      <section className="panel coe-intake" aria-label="자동화 후보 접수">
        <div className="panel-head">
          <h2>자동화 후보 접수</h2>
          <span className="badge blue">CoE 파이프라인</span>
        </div>
        <div className="form-grid coe-form">
          <label className="field">
            <span>업무명</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="field">
            <span>업무 담당자</span>
            <input value={owner} onChange={(event) => setOwner(event.target.value)} />
          </label>
          <label className="field">
            <span>부서</span>
            <input value={department} onChange={(event) => setDepartment(event.target.value)} />
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
                <span>Source import</span>
                <select value={selectedSourceImport?.import_id ?? ""} onChange={(event) => setSelectedImportId(event.target.value)}>
                  {eligibleImports.length === 0 ? (
                    <option value="">No usable import</option>
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
                <span>Source item ref</span>
                <input value={sourceItemRef} onChange={(event) => setSourceItemRef(event.target.value)} />
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
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </label>
        </div>
        <div className="inline-actions coe-actions">
          <button className="btn primary" type="button" onClick={() => createIdea.mutate()} disabled={!canCreateIdea}>
            {createIdea.isPending ? "등록 중" : "후보 등록"}
          </button>
          {requiresImportLineage && selectedSourceImport === null && <span className="badge amber">Import lineage required</span>}
          <button className="btn" type="button" onClick={() => navigate("scenarioStudio")}>자동화 설계안 만들기</button>
          <button className="btn" type="button" onClick={() => navigate("automationOps")}>운영 예약 만들기</button>
          {createIdea.isError && <span className="badge red">등록 실패</span>}
        </div>
      </section>

      <section className="panel coe-imports" aria-label="Process and task mining imports">
        <div className="panel-head">
          <h2>Import lineage</h2>
          <span className="badge blue">{processImportItems.length} sources</span>
        </div>
        <div className="form-grid coe-form">
          <label className="field">
            <span>Import type</span>
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
            <span>Source system</span>
            <input value={processImportInput.source_system} onChange={(event) => setProcessImportInput({ ...processImportInput, source_system: event.target.value })} />
          </label>
          <label className="field">
            <span>Source owner</span>
            <input value={processImportInput.source_owner_ref} onChange={(event) => setProcessImportInput({ ...processImportInput, source_owner_ref: event.target.value })} />
          </label>
          <label className="field">
            <span>Schema version</span>
            <input value={processImportInput.schema_version} onChange={(event) => setProcessImportInput({ ...processImportInput, schema_version: event.target.value })} />
          </label>
          <label className="field">
            <span>Evidence ref</span>
            <input value={processImportInput.import_evidence_ref} onChange={(event) => setProcessImportInput({ ...processImportInput, import_evidence_ref: event.target.value })} />
          </label>
          <label className="field">
            <span>Lineage ref</span>
            <input value={processImportInput.lineage_ref} onChange={(event) => setProcessImportInput({ ...processImportInput, lineage_ref: event.target.value })} />
          </label>
          <label className="field">
            <span>Rows</span>
            <input type="number" min={1} value={processImportInput.row_count} onChange={(event) => setProcessImportInput({ ...processImportInput, row_count: event.target.value })} />
          </label>
          <label className="field">
            <span>Candidates</span>
            <input type="number" min={0} value={processImportInput.candidate_count} onChange={(event) => setProcessImportInput({ ...processImportInput, candidate_count: event.target.value })} />
          </label>
          <label className="field coe-description">
            <span>Summary</span>
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
            {createProcessImport.isPending ? "Registering" : "Register import"}
          </button>
          {importInvalidReason !== null && <span className="badge red" role="alert">{importInvalidReason}</span>}
          {createProcessImport.isError && <span className="badge red">Import rejected</span>}
        </div>
        {processImports.isError ? (
          <ErrorState message="Import lineage could not be loaded." onRetry={() => void processImports.refetch()} />
        ) : (
          <div className="coe-priority-list" aria-label="Import lineage list">
            {processImportItems.length === 0 ? (
              <p className="subtle">No import lineage registered.</p>
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

      <section className="panel coe-filters" aria-label="자동화 후보 필터와 우선순위">
        <div className="panel-head">
          <h2>후보 선별</h2>
          <span className="badge muted">현재 필터 {loadedIdeaCountLabel}건</span>
        </div>
        <div className="form-grid coe-filter-grid">
          <label className="field">
            <span>업무 담당자</span>
            <input
              value={ownerFilter}
              onChange={(event) => applyOwnerFilter(event.target.value)}
              placeholder="예: 재무운영팀"
              aria-label="업무 담당자 필터"
            />
          </label>
          <label className="field">
            <span>부서</span>
            <input
              value={departmentFilter}
              onChange={(event) => applyDepartmentFilter(event.target.value)}
              placeholder="예: 재무"
              aria-label="부서 필터"
            />
          </label>
          <div className="inline-actions coe-filter-actions">
            <button className="btn" type="button" onClick={() => { resetIdeaPaging(); setOwnerFilter(""); setDepartmentFilter(""); setStageFilter("all"); }}>
              필터 초기화
            </button>
          </div>
        </div>
        <div className="coe-priority-list" aria-label="우선 자동화 후보">
          <strong>우선 자동화 후보</strong>
          {rankedIdeas.length === 0 ? (
            <p className="subtle">현재 필터에 맞는 후보가 없습니다.</p>
          ) : (
            rankedIdeas.map((idea, index) => (
              <button key={idea.idea_id} className="coe-priority-item" type="button" onClick={() => setSelectedId(idea.idea_id)}>
                <span className="badge blue">#{index + 1}</span>
                <span>
                  <strong>{idea.title}</strong>
                  <small>{idea.department} · {idea.business_owner} · {SOURCE_LABEL[idea.source]}</small>
                </span>
                <span className="mono">{idea.score}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <div className="coe-layout">
        <section className="panel" aria-label="자동화 후보 목록">
          <div className="panel-head">
            <h2>후보 목록</h2>
            <select value={stageFilter} onChange={(event) => applyStageFilter(event.target.value as "all" | AutomationIdeaStage)} aria-label="승인 단계 필터">
              <option value="all">전체</option>
              {STAGES.map((stage) => <option key={stage} value={stage}>{STAGE_LABEL[stage]}</option>)}
            </select>
          </div>
          {ideas.isError ? (
            <ErrorState message="자동화 후보 목록을 불러오지 못했습니다." onRetry={() => void ideas.refetch()} />
          ) : (
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th scope="col">업무</th>
                    <th scope="col">승인 단계</th>
                    <th scope="col">우선순위 점수</th>
                    <th scope="col">선택</th>
                  </tr>
                </thead>
                <tbody>
                  {ideaPageLoading ? (
                    <tr><td colSpan={4}>불러오는 중입니다.</td></tr>
                  ) : ideaItems.length === 0 ? (
                    <tr><td colSpan={4}>등록된 자동화 후보가 없습니다.</td></tr>
                  ) : (
                    ideaItems.map((idea) => (
                      <tr key={idea.idea_id} className={idea.idea_id === selected?.idea_id ? "selected-row" : undefined}>
                        <th scope="row">
                          <span>{idea.title}</span>
                          <span className="subtle">{idea.department} · {idea.business_owner} · {SOURCE_LABEL[idea.source]}</span>
                        </th>
                        <td><span className={`badge ${stageTone(idea.stage)}`}>{STAGE_LABEL[idea.stage]}</span></td>
                        <td>{idea.score}</td>
                        <td><button className="linklike" type="button" onClick={() => setSelectedId(idea.idea_id)}>보기</button></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {hasMoreIdeas && (
                <div className="inline-actions" style={{ marginTop: 12 }}>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      if (nextIdeaCursor !== null) setIdeaCursor(nextIdeaCursor);
                    }}
                    disabled={ideaPageFetchingMore}
                  >
                    {ideaPageFetchingMore ? "불러오는 중" : "더 보기"}
                  </button>
                  <span className="subtle">KPI와 우선순위는 현재까지 불러온 후보 기준입니다.</span>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel coe-detail" aria-label="자동화 후보 상세">
          <div className="panel-head">
            <h2>평가와 승인 진행</h2>
            {selected !== null && <span className={`badge ${stageTone(selected.stage)}`}>{STAGE_LABEL[selected.stage]}</span>}
          </div>
          {selected === null ? (
            <p className="empty-state">후보를 선택해 주세요.</p>
          ) : (
            <div className="coe-detail-body">
              <div>
                <h3>{selected.title}</h3>
                <p>{selected.description}</p>
                <div className="inline-facts">
                  <span className="badge blue">{PRIORITY_LABEL[selected.priority]}</span>
                  <span className="badge muted">{SOURCE_LABEL[selected.source]}</span>
                  {selected.source_import_id !== null && <span className="badge green">Import lineage</span>}
                  {selected.source_item_ref !== null && <span className="badge muted">{selected.source_item_ref}</span>}
                  <span className="badge muted">우선순위 점수 {selected.score}</span>
                  <span className="badge muted">{selected.department}</span>
                </div>
              </div>
              <div className="coe-readiness" aria-label="승인 준비 상태">
                <strong>승인 준비 상태</strong>
                <span className={`badge ${roi.data !== null && roi.data !== undefined ? "green" : "amber"}`}>
                  {roi.data !== null && roi.data !== undefined ? "ROI 저장됨" : "ROI 필요"}
                </span>
                <span className={`badge ${selected.scenario_id !== null ? "green" : "amber"}`}>
                  {selected.scenario_id !== null ? "자동화 설계안 연결됨" : "자동화 설계안 필요"}
                </span>
                <span className={`badge ${selected.run_trigger_id !== null ? "green" : "amber"}`}>
                  {selected.run_trigger_id !== null ? "운영 예약 연결됨" : "운영 예약 필요"}
                </span>
              </div>
              <div className={`coe-decision ${decision.tone}`} aria-label="CoE 승인 판단">
                <div>
                  <span className={`badge ${decision.tone}`}>{decision.label}</span>
                  <h3>{decision.title}</h3>
                  <p>{decision.summary}</p>
                </div>
                <ul>
                  {decision.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
              <div className="stage-rail" aria-label="승인 단계 전환">
                {nextStages(selected.stage).length === 0 ? (
                  <span className="subtle">다음 단계가 없습니다.</span>
                ) : (
                  nextStages(selected.stage).map((stage) => {
                    const requiresApproval = stage === "approved" || stage === "rejected";
                    const allowed = requiresApproval ? canApproveIdeas : canManageIdeas;
                    return (
                      <button
                        key={stage}
                        className="btn"
                        type="button"
                        onClick={() => transitionIdea.mutate({ idea: selected, stage })}
                        disabled={transitionIdea.isPending || !allowed}
                        title={!allowed && requiresApproval ? "승인자 권한이 필요합니다." : undefined}
                      >
                        {STAGE_LABEL[stage]}로 이동
                      </button>
                    );
                  })
                )}
                {!canApproveIdeas && selected.stage === "assess" && (
                  <span className="badge amber">승인·반려는 승인자 권한 필요</span>
                )}
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>자동화 설계안 연결</span>
                  <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>
                    <option value="">연결 안 함</option>
                    {scenarioItems.map((scenario) => (
                      <option key={scenario.scenario_id} value={scenario.scenario_id}>{scenarioOptionLabel(scenario)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>운영 예약 연결</span>
                  <select value={triggerId} onChange={(event) => setTriggerId(event.target.value)}>
                    <option value="">연결 안 함</option>
                    {triggerItems.map((trigger) => (
                      <option key={trigger.trigger_id} value={trigger.trigger_id}>{triggerLinkLabel(trigger, scenarioByVersionId)}</option>
                    ))}
                  </select>
                </label>
              </div>
              {linkMismatch && (
                <p className="form-alert red" role="alert">
                  선택한 운영 예약은 다른 자동화 설계안에 연결되어 있습니다. 같은 업무 자동화안의 예약을 선택하거나 새 운영 예약을 만드세요.
                </p>
              )}
              <div className="inline-actions">
                <button className="btn" type="button" onClick={() => updateLinks.mutate(selected)} disabled={!canManageIdeas || updateLinks.isPending || linkMismatch}>연결 저장</button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => navigate("playground", selected.scenario_id !== null ? { scenario: selected.scenario_id } : undefined)}
                  disabled={selected.scenario_id === null}
                >
                  자동화 설계안 보기
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => navigate("automationOps", selected.run_trigger_id !== null ? { trigger: selected.run_trigger_id } : undefined)}
                  disabled={selected.run_trigger_id === null}
                >
                  운영 예약 보기
                </button>
                {updateLinks.isError && <span className="badge red">연결 실패</span>}
              </div>
              <div className="panel-subsection" aria-label="Pilot readiness evidence">
                <div className="panel-head compact">
                  <h3>Pilot readiness evidence</h3>
                  <span className={`badge ${validAdoptionEvidenceCount === ADOPTION_EVIDENCE_TYPES.length ? "green" : "amber"}`}>
                    {validAdoptionEvidenceCount}/{ADOPTION_EVIDENCE_TYPES.length} valid
                  </span>
                </div>
                <div className="form-grid coe-roi-grid">
                  <label className="field">
                    <span>Evidence type</span>
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
                    <span>Status</span>
                    <select
                      value={adoptionEvidenceInput.status}
                      onChange={(event) =>
                        setAdoptionEvidenceInput({
                          ...adoptionEvidenceInput,
                          status: event.target.value as AutomationAdoptionEvidenceStatus,
                        })}
                    >
                      <option value="valid">Valid</option>
                      <option value="failed">Failed</option>
                      <option value="deferred">Deferred</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Evidence ref</span>
                    <input
                      value={adoptionEvidenceInput.evidence_ref}
                      onChange={(event) => setAdoptionEvidenceInput({ ...adoptionEvidenceInput, evidence_ref: event.target.value })}
                      placeholder="ticket:PILOT-123"
                    />
                  </label>
                  <label className="field wide">
                    <span>Summary</span>
                    <input
                      value={adoptionEvidenceInput.summary}
                      onChange={(event) => setAdoptionEvidenceInput({ ...adoptionEvidenceInput, summary: event.target.value })}
                      placeholder="Owner signoff recorded."
                    />
                  </label>
                </div>
                <div className="coe-roi-summary">
                  <span><strong>{adoptionEvidenceItems.length}</strong><small>records</small></span>
                  <span><strong>{validAdoptionEvidenceCount}</strong><small>valid types</small></span>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => selected !== null && adoptionEvidenceInvalidReason === null && saveAdoptionEvidence.mutate(selected)}
                    disabled={!canSaveAdoptionEvidence}
                  >
                    {saveAdoptionEvidence.isPending ? "Saving" : "Record evidence"}
                  </button>
                  {adoptionEvidenceInvalidReason !== null && <span className="badge red coe-roi-alert" role="alert">{adoptionEvidenceInvalidReason}</span>}
                  {saveAdoptionEvidence.isError && <span className="badge red">Evidence save failed</span>}
                </div>
                {adoptionEvidence.isError && <p className="form-alert red" role="alert">Pilot evidence could not be loaded.</p>}
                {adoptionEvidenceItems.length > 0 && (
                  <div className="mini-table" aria-label="Pilot readiness evidence list">
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
            </div>
          )}
        </section>
      </div>

      <section className="panel coe-roi" aria-label="ROI 계산">
        <div className="panel-head">
          <h2>ROI 산정</h2>
          {roi.data === null && <span className="badge amber">미저장</span>}
          {roi.data !== null && roi.data !== undefined && <span className="badge green">저장됨</span>}
        </div>
        <div className="form-grid coe-roi-grid">
          <label className="field">
            <span>월 처리 건수</span>
            <input type="number" min={0} value={roiInput.frequency_per_month} onChange={(event) => setRoiInput({ ...roiInput, frequency_per_month: event.target.value })} />
          </label>
          <label className="field">
            <span>건당 소요 시간(분)</span>
            <input type="number" min={0} value={roiInput.minutes_per_case} onChange={(event) => setRoiInput({ ...roiInput, minutes_per_case: event.target.value })} />
          </label>
          <label className="field">
            <span>예외율</span>
            <input type="number" min={0} max={1} step={0.01} value={roiInput.exception_rate} onChange={(event) => setRoiInput({ ...roiInput, exception_rate: event.target.value })} />
          </label>
          <label className="field">
            <span>시간당 비용</span>
            <input type="number" min={0} value={roiInput.hourly_cost} onChange={(event) => setRoiInput({ ...roiInput, hourly_cost: event.target.value })} />
          </label>
          <label className="field">
            <span>자동화 구축 예상 비용</span>
            <input type="number" min={0} value={roiInput.implementation_effort} onChange={(event) => setRoiInput({ ...roiInput, implementation_effort: event.target.value })} />
          </label>
          <label className="field">
            <span>월 플랫폼 비용</span>
            <input type="number" min={0} value={roiInput.platform_monthly_cost} onChange={(event) => setRoiInput({ ...roiInput, platform_monthly_cost: event.target.value })} />
          </label>
          <label className="field">
            <span>회피 라이선스 비용</span>
            <input type="number" min={0} value={roiInput.avoided_license_cost} onChange={(event) => setRoiInput({ ...roiInput, avoided_license_cost: event.target.value })} />
          </label>
          <label className="field">
            <span>추정 신뢰도</span>
            <select value={roiInput.confidence} onChange={(event) => setRoiInput({ ...roiInput, confidence: event.target.value as RoiFormState["confidence"] })}>
              <option value="low">낮음</option>
              <option value="medium">보통</option>
              <option value="high">높음</option>
            </select>
          </label>
        </div>
        <div className="coe-roi-summary">
          <span><strong>{numberLabel(preview.monthly_hours_saved, "시간")}</strong><small>월 절감 시간</small></span>
          <span><strong>{currency(preview.estimated_monthly_value)}</strong><small>월 절감액</small></span>
          <span><strong>{currency(preview.platform_monthly_cost)}</strong><small>월 플랫폼 비용</small></span>
          <span><strong>{currency(preview.avoided_license_cost)}</strong><small>회피 비용</small></span>
          <span><strong>{currency(preview.monthly_value)}</strong><small>순 월가치</small></span>
          <span><strong>{numberLabel(preview.payback_months, "개월")}</strong><small>회수 기간</small></span>
          <span><strong>{preview.viability ?? "-"}</strong><small>ROI 판정</small></span>
          <button className="btn primary" type="button" onClick={() => selected !== null && roiInvalidReason === null && saveRoi.mutate(selected)} disabled={!canSaveRoi}>
            {saveRoi.isPending ? "저장 중" : "ROI 저장"}
          </button>
          {roiInvalidReason !== null && <span className="badge red coe-roi-alert" role="alert">{roiInvalidReason}</span>}
          {saveRoi.isError && <span className="badge red">ROI 저장 실패</span>}
        </div>
        <div className="panel-subsection">
          <div className="panel-head compact">
            <h3>파일럿 실제값</h3>
            {roiActualItems.length === 0 ? <span className="badge amber">근거 없음</span> : <span className="badge green">{roiActualItems.length}건</span>}
          </div>
          <div className="coe-roi-suggestion">
            <button
              className="btn"
              type="button"
              onClick={() => selected !== null && loadRoiSuggestion.mutate(selected)}
              disabled={selected === null || selected.scenario_id === null || loadRoiSuggestion.isPending}
            >
              {loadRoiSuggestion.isPending ? "불러오는 중" : "운영 실행 실적 제안값 불러오기"}
            </button>
            {selected !== null && selected.scenario_id === null && (
              <span className="subtle">위 연결 설정에서 자동화를 연결하면 운영 실행 통계로 제안값을 채울 수 있습니다.</span>
            )}
            {roiActualSuggestion !== null && roiActualSuggestion.suggested_actual_transaction_count !== null && (
              <>
                <span className="badge amber">제안값</span>
                <span className="subtle">
                  운영 실행 완료 {roiActualSuggestion.completed_runs}건·실패 {roiActualSuggestion.failed_runs}건 기준 제안 —
                  사람 개입/재처리 시간은 직접 입력하세요. 자동값은 제안일 뿐, 저장 시 본인이 확정한 수치로 기록됩니다.
                </span>
              </>
            )}
            {roiActualSuggestion !== null && roiActualSuggestion.scenario_id !== null && roiActualSuggestion.suggested_actual_transaction_count === null && (
              <span className="subtle">이 기간에 집계할 종결된 운영 실행이 없어 제안값이 없습니다.</span>
            )}
            {loadRoiSuggestion.isError && <span className="badge red">제안값 불러오기 실패</span>}
          </div>
          <div className="form-grid coe-roi-grid">
            <label className="field">
              <span>시작일</span>
              <input
                type="date"
                value={roiActualInput.period_start}
                onChange={(event) => {
                  setRoiActualInput({ ...roiActualInput, period_start: event.target.value });
                  setRoiActualSuggestion(null); // 기간이 바뀌면 기존 제안 근거는 무효
                }}
              />
            </label>
            <label className="field">
              <span>종료일</span>
              <input
                type="date"
                value={roiActualInput.period_end}
                onChange={(event) => {
                  setRoiActualInput({ ...roiActualInput, period_end: event.target.value });
                  setRoiActualSuggestion(null); // 기간이 바뀌면 기존 제안 근거는 무효
                }}
              />
            </label>
            <label className="field">
              <span>실제 처리 건수</span>
              <input
                type="number"
                min={0}
                value={roiActualInput.actual_transaction_count}
                onChange={(event) => {
                  setRoiActualInput({ ...roiActualInput, actual_transaction_count: event.target.value });
                  setRoiActualSuggestion(null); // 사람이 고친 값 — 이후 저장은 수기 확정으로 귀속
                }}
              />
            </label>
            <label className="field">
              <span>실제 실패율</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={roiActualInput.actual_failure_rate}
                onChange={(event) => {
                  setRoiActualInput({ ...roiActualInput, actual_failure_rate: event.target.value });
                  setRoiActualSuggestion(null); // 사람이 고친 값 — 이후 저장은 수기 확정으로 귀속
                }}
              />
            </label>
            <label className="field">
              <span>사람 개입 시간(분)</span>
              <input type="number" min={0} value={roiActualInput.human_intervention_minutes} onChange={(event) => setRoiActualInput({ ...roiActualInput, human_intervention_minutes: event.target.value })} />
            </label>
            <label className="field">
              <span>재처리 시간(분)</span>
              <input type="number" min={0} value={roiActualInput.reprocessing_minutes} onChange={(event) => setRoiActualInput({ ...roiActualInput, reprocessing_minutes: event.target.value })} />
            </label>
            <label className="field">
              <span>근거 참조</span>
              <input value={roiActualInput.evidence_ref} onChange={(event) => setRoiActualInput({ ...roiActualInput, evidence_ref: event.target.value })} />
            </label>
            <label className="field wide">
              <span>요약</span>
              <input value={roiActualInput.summary} onChange={(event) => setRoiActualInput({ ...roiActualInput, summary: event.target.value })} />
            </label>
          </div>
          <div className="coe-roi-summary">
            <span><strong>{roiActualItems[0]?.actual_transaction_count ?? "-"}</strong><small>최근 실제 건수</small></span>
            <span><strong>{percentLabel(roiActualItems[0]?.actual_failure_rate ?? null)}</strong><small>최근 실패율</small></span>
            <span><strong>{numberLabel(roiActualItems[0]?.human_intervention_minutes ?? null, "분")}</strong><small>사람 개입</small></span>
            <span><strong>{numberLabel(roiActualItems[0]?.reprocessing_minutes ?? null, "분")}</strong><small>재처리</small></span>
            <button className="btn" type="button" onClick={() => selected !== null && roiActualInvalidReason === null && saveRoiActual.mutate(selected)} disabled={!canSaveRoiActual}>
              {saveRoiActual.isPending ? "저장 중" : "실제값 저장"}
            </button>
            {roiActualInvalidReason !== null && <span className="badge red coe-roi-alert" role="alert">{roiActualInvalidReason}</span>}
            {saveRoiActual.isError && <span className="badge red">실제값 저장 실패</span>}
          </div>
          {roiActuals.isError && <p className="form-alert red" role="alert">ROI 실제값을 불러오지 못했습니다.</p>}
          {roiActualItems.length > 0 && (
            <div className="mini-table" aria-label="ROI 실제값 근거 목록">
              {roiActualItems.map((item) => (
                <div className="mini-table-row" key={item.roi_actual_id}>
                  <span>{item.period_start} - {item.period_end}</span>
                  <strong>{item.actual_transaction_count}건</strong>
                  <span>{percentLabel(item.actual_failure_rate)}</span>
                  <span>{item.evidence_ref}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
