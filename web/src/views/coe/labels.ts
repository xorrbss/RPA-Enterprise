import type {
  AutomationAdoptionEvidenceStatus,
  AutomationAdoptionEvidenceType,
  AutomationIdeaPriority,
  AutomationIdeaSource,
  AutomationIdeaStage,
  ProcessMiningImportSourceType,
  ProcessMiningImportStatus,
  RoiViability,
  RunTriggerItem,
  ScenarioItem,
} from "../../api/types";

export const STAGES: readonly AutomationIdeaStage[] = ["intake", "assess", "approved", "build", "operate", "rejected", "archived"];
export const PRIORITIES: readonly AutomationIdeaPriority[] = ["low", "medium", "high", "critical"];
export const SOURCES: readonly AutomationIdeaSource[] = ["manual", "process_mining", "task_mining", "imported"];
export const PROCESS_IMPORT_SOURCE_TYPES: readonly ProcessMiningImportSourceType[] = ["process_mining", "task_mining", "monitoring_export", "api_import"];
export const ADOPTION_EVIDENCE_TYPES: readonly AutomationAdoptionEvidenceType[] = [
  "pilot_charter_signoff",
  "raci_signoff",
  "training_completion",
  "support_model_signoff",
];

export const STAGE_LABEL: Record<AutomationIdeaStage, string> = {
  intake: "접수",
  assess: "ROI 검토",
  approved: "승인 완료",
  build: "구축 진행",
  operate: "운영 중",
  rejected: "반려",
  archived: "보관",
};

export const PRIORITY_LABEL: Record<AutomationIdeaPriority, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  critical: "긴급",
};

export const SOURCE_LABEL: Record<AutomationIdeaSource, string> = {
  manual: "업무 담당자 접수",
  process_mining: "프로세스 분석 발굴",
  task_mining: "작업 분석 발굴",
  imported: "외부 후보 등록",
};

export const PROCESS_IMPORT_SOURCE_LABEL: Record<ProcessMiningImportSourceType, string> = {
  process_mining: "프로세스 마이닝 내보내기",
  task_mining: "태스크 마이닝 내보내기",
  monitoring_export: "모니터링 내보내기",
  api_import: "API 가져오기 결과",
};

export const PROCESS_IMPORT_STATUS_LABEL: Record<ProcessMiningImportStatus, string> = {
  received: "접수됨",
  processed: "처리됨",
  blocked: "차단됨",
};

export const TRIGGER_STATUS_LABEL: Record<RunTriggerItem["status"], string> = {
  enabled: "운영 중",
  paused: "일시 중지",
  archived: "보관됨",
};

export const ADOPTION_EVIDENCE_TYPE_LABEL: Record<AutomationAdoptionEvidenceType, string> = {
  pilot_charter_signoff: "파일럿 차터",
  raci_signoff: "RACI 승인",
  training_completion: "교육 완료",
  support_model_signoff: "지원 체계",
};

export const ADOPTION_EVIDENCE_STATUS_LABEL: Record<AutomationAdoptionEvidenceStatus, string> = {
  valid: "유효",
  failed: "실패",
  deferred: "보류",
};

export const ROI_VIABILITY_LABEL: Record<RoiViability, string> = {
  viable: "타당",
  not_viable: "부적합",
};

export function viabilityLabel(viability: RoiViability | null): string {
  return viability === null ? "-" : ROI_VIABILITY_LABEL[viability];
}

export function nextStages(stage: AutomationIdeaStage): readonly AutomationIdeaStage[] {
  if (stage === "intake") return ["assess", "archived"];
  if (stage === "assess") return ["approved", "rejected", "archived"];
  if (stage === "approved") return ["build", "archived"];
  if (stage === "build") return ["operate", "archived"];
  if (stage === "operate" || stage === "rejected") return ["archived"];
  return [];
}

export function stageTone(stage: AutomationIdeaStage): string {
  if (stage === "operate" || stage === "approved") return "green";
  if (stage === "build") return "blue";
  if (stage === "rejected" || stage === "archived") return "muted";
  return "amber";
}

export function adoptionEvidenceStatusTone(status: AutomationAdoptionEvidenceStatus): string {
  if (status === "valid") return "green";
  if (status === "failed") return "red";
  return "amber";
}

export function importStatusTone(status: ProcessMiningImportStatus): string {
  if (status === "blocked") return "red";
  if (status === "processed") return "green";
  return "blue";
}

export function currency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value);
}

export function numberLabel(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value)}${unit}`;
}

export function percentLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

export function triggerLinkLabel(trigger: RunTriggerItem, scenarioByVersionId: ReadonlyMap<string, ScenarioItem>): string {
  const schedule = trigger.trigger_type === "webhook" ? "업무 이벤트 수신 시 실행" : "정기 실행 예약";
  const scenario = scenarioByVersionId.get(trigger.scenario_version_id);
  const scenarioLabel = scenario === undefined ? "대상 자동화 확인 필요" : `${scenario.name} 자동화`;
  return `${schedule} · ${TRIGGER_STATUS_LABEL[trigger.status]} · ${scenarioLabel}`;
}

export function scenarioOptionLabel(scenario: ScenarioItem): string {
  return `${scenario.name} · ${scenario.version}차 자동화안`;
}
