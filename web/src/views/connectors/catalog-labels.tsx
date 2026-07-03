import type {
  CatalogStatus,
  ConnectorCatalogItem,
  ConnectorCatalogKind,
  ConnectorProfile,
  TemplateCatalogItem,
  TemplateCatalogKind,
} from "../../api/types";
import { urlRefLabel } from "../../api/scenario-params";

export const CONNECTOR_KIND_OPTIONS: readonly ConnectorCatalogKind[] = ["browser", "api", "file", "notification", "data"];
export const TEMPLATE_KIND_OPTIONS: readonly TemplateCatalogKind[] = ["browser_workflow", "api_workflow", "file_workflow", "notification_workflow"];
export const STATUS_OPTIONS: readonly CatalogStatus[] = ["available", "candidate", "requires_admin", "blocked"];

export const KIND_LABEL: Record<ConnectorCatalogKind, string> = {
  browser: "브라우저",
  api: "업무 시스템 연동",
  file: "파일",
  notification: "알림",
  data: "데이터",
};

export const TEMPLATE_KIND_LABEL: Record<TemplateCatalogKind, string> = {
  browser_workflow: "브라우저 업무",
  api_workflow: "업무 시스템 연동",
  file_workflow: "파일 업무",
  notification_workflow: "알림 업무",
};

export const STATUS_LABEL: Record<CatalogStatus, string> = {
  available: "사용 가능",
  candidate: "후보",
  requires_admin: "관리자 활성화 필요",
  blocked: "차단됨",
};

const CATEGORY_LABEL: Record<string, string> = {
  ERP: "ERP",
  Integration: "연동",
  Identity: "아이덴티티",
  Federation: "연합",
  Office: "오피스 파일",
  "Document Automation": "문서 자동화",
  Notification: "알림",
  Data: "데이터",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

const ENV_LABEL: Record<string, string> = { dev: "개발", staging: "스테이징", prod: "운영" };

export function envLabel(environment: string): string {
  return ENV_LABEL[environment] ?? environment;
}

export function statusTone(status: CatalogStatus): string {
  if (status === "available") return "green";
  if (status === "candidate" || status === "requires_admin") return "amber";
  return "red";
}

export function priorityTone(priority: ConnectorCatalogItem["priority"] | TemplateCatalogItem["priority"]): string {
  if (priority === "P0") return "red";
  if (priority === "P1") return "amber";
  if (priority === "P2") return "blue";
  return "muted";
}

export function priorityLabel(priority: ConnectorCatalogItem["priority"] | TemplateCatalogItem["priority"]): string {
  if (priority === "P0") return "최우선";
  if (priority === "P1") return "높음";
  if (priority === "P2") return "보통";
  return "검토";
}

export function listLabel(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

export function splitMetadataLines(value: string): string[] {
  return value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function profileStatusTone(status: ConnectorProfile["status"]): string {
  if (status === "certified" || status === "enabled") return "green";
  if (status === "draft" || status === "security_review") return "amber";
  return "red";
}

export function profileStatusLabel(status: ConnectorProfile["status"]): string {
  if (status === "draft") return "준비 중";
  if (status === "security_review") return "보안 검토";
  if (status === "certified") return "인증됨";
  if (status === "enabled") return "활성";
  if (status === "disabled") return "비활성";
  return "폐기됨";
}

export function appendUniqueConnectors(
  current: readonly ConnectorCatalogItem[],
  incoming: readonly ConnectorCatalogItem[],
): ConnectorCatalogItem[] {
  const seen = new Set(current.map((item) => item.connector_id));
  const merged = [...current];
  for (const item of incoming) {
    if (seen.has(item.connector_id)) continue;
    seen.add(item.connector_id);
    merged.push(item);
  }
  return merged;
}

export function appendUniqueTemplates(
  current: readonly TemplateCatalogItem[],
  incoming: readonly TemplateCatalogItem[],
): TemplateCatalogItem[] {
  const seen = new Set(current.map((item) => item.template_id));
  const merged = [...current];
  for (const item of incoming) {
    if (seen.has(item.template_id)) continue;
    seen.add(item.template_id);
    merged.push(item);
  }
  return merged;
}

const PARAM_LABELS: Record<string, string> = {
  channel: "알림 채널",
  company_code: "회사 코드",
  date_range: "조회 기간",
  document_type: "문서 유형",
  endpoint_profile_id: "승인된 연동 프로필",
  field_schema: "추출 항목",
  message_template: "알림 문구",
  method: "조회/전송 방식",
  request_schema_ref: "응답 확인 기준",
  severity: "중요도",
  source_artifact_id: "원본 증빙",
  status_path: "상태 확인 위치",
};

const IR_PATTERN_LABELS: Record<string, string> = {
  api_call_validate_json: "업무 시스템 응답 검증",
  browser_extract_table: "브라우저 표 추출",
  "navigate -> act(filter) -> loop(extract rows) -> verify(row_count)": "웹 목록 조회와 표 추출",
  "navigate -> extract approval fields -> human_task(validation) when ambiguous": "웹 결재 확인과 예외 검증",
  "navigate -> act(download) -> artifact(receipt) -> verify(download_complete)": "웹 리포트 다운로드와 증빙 저장",
  "browser artifact -> deterministic_text_v1 extract -> human_task(validation) for low confidence": "브라우저 증빙 기반 문서 검증",
  "api_call -> verify(response_schema)": "승인된 업무 시스템 응답 검증",
  "event trigger -> notification dispatch -> audit decision": "운영 이벤트 알림",
};

const IMPLEMENTATION_LABELS: Record<string, string> = {
  blocked_by_executor_capability: "실행 기능 활성화 필요",
  metadata_catalog_only: "카탈로그 메타데이터",
};

const ACTION_LABELS: Record<string, string> = {
  act: "클릭/입력",
  api_call: "승인된 업무 시스템 호출",
  artifact: "증빙 저장",
  click: "클릭",
  download: "다운로드",
  extract: "데이터 추출",
  human_task: "사람 확인",
  navigate: "웹 이동",
  notify: "알림 발송",
  parse_json: "응답 해석",
  query: "데이터 조회",
  request: "요청",
  verify: "결과 확인",
  webhook: "웹훅 수신",
  owner_evidence_review: "오너 증빙 검토",
  handoff_request: "핸드오프 요청",
  dispatch_attempt: "디스패치 시도",
  receipt_record: "접수 기록",
  provider_callback: "제공자 회신",
  scim_provider_register: "SCIM 제공자 등록",
  scim_group_role_import: "SCIM 그룹-역할 가져오기",
  scim_provider_decommission: "SCIM 제공자 폐기",
};

const RBAC_LABELS: Record<string, string> = {
  "artifact.read": "증빙 조회",
  "connector.enable": "연동 활성화",
  "connector.read": "카탈로그 조회",
  "human_task.read": "사람 확인 조회",
  "scenario.create": "자동화 생성",
  "site.read": "사이트 조회",
};

function paramLabel(param: string): string {
  return PARAM_LABELS[param] ?? urlRefLabel(param);
}

export function paramsLabel(values: readonly string[]): string {
  return values.length > 0 ? values.map(paramLabel).join(", ") : "-";
}

export function irPatternLabel(pattern: string): string {
  return IR_PATTERN_LABELS[pattern] ?? pattern;
}

export function implementationLabel(state: string): string {
  if (state.includes("browser template pack")) return "브라우저 템플릿 팩";
  if (state.includes("HTTP API P1")) return "승인된 업무 시스템 연동 검토";
  if (state.includes("browser artifact workflow")) return "브라우저 파일 증빙 업무";
  if (state.includes("built_in_deterministic_text_v1")) return "내장 문서 추출 후보";
  if (state.includes("notification routing")) return "알림 연동 검토";
  if (state.includes("browser-scope decision")) return "브라우저 범위 검토 필요";
  if (state.includes("no approved browser execution surface")) return "브라우저 실행 표면 없음";
  if (state.includes("owner/provider evidence required")) return "오너/제공자 증빙 필요 (후보)";
  if (state.includes("SCIM P1 uses")) return "SCIM P1 구현 (인바운드 서명)";
  if (state.includes("metadata-only integration handoff ledger")) return "메타데이터 전용 핸드오프 원장 (P1)";
  if (state.includes("Implemented: /v1/ops-alerts")) return "운영 알림 웹훅 발송 구현";
  return IMPLEMENTATION_LABELS[state] ?? state;
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function actionsLabel(values: readonly string[]): string {
  return values.length > 0 ? values.map(actionLabel).join(", ") : "-";
}

function rbacLabel(action: string): string {
  return RBAC_LABELS[action] ?? action;
}

export function rbacActionsLabel(values: readonly string[]): string {
  return values.length > 0 ? values.map(rbacLabel).join(", ") : "-";
}

export function securityNoteLabel(note: string): string {
  if (note.includes("Credential values stay behind")) return "비밀 값은 보안 저장소에서만 사용합니다.";
  if (note.includes("Uses stored browser session")) return "저장된 브라우저 로그인 세션 참조만 사용합니다.";
  if (note.includes("Red-site execution")) return "고위험 사이트는 승인 후 실행합니다.";
  if (note.includes("Authorization headers")) return "인증 헤더 값은 템플릿에 저장하지 않습니다.";
  if (note.includes("Bearer tokens resolve")) return "토큰은 보안 경계 안에서만 해소합니다.";
  if (note.includes("security audit decision")) return "활성화·설치 결정은 감사 기록에 남깁니다.";
  if (note.includes("Connector execution requires")) return "연동 실행은 승인된 백엔드 기능 계약이 필요합니다.";
  if (note.includes("Downloaded artifacts")) return "다운로드 증빙은 마스킹·권한 검사를 거쳐 열람합니다.";
  if (note.includes("Document bytes stay inside")) return "문서 원문은 테넌트 경계 밖으로 나가지 않습니다.";
  if (note.includes("Artifact body access")) return "증빙 본문은 마스킹, 권한, 감사 게이트를 거쳐 열람합니다.";
  if (note.includes("Binary OCR/PDF image decoding")) return "이미지 OCR/PDF 처리는 후속 문서 어댑터에서 다룹니다.";
  if (note.includes("Webhook URLs are secrets")) return "웹훅 URL은 비밀 값으로 관리하며 응답이나 감사 본문에 노출하지 않습니다.";
  if (note.includes("explicit backend approval")) return "백엔드 승인과 보안 저장소 설정 후 활성화합니다.";
  return note;
}

export function secretRefs(values: readonly string[]): JSX.Element {
  if (values.length === 0) return <span className="subtle">필요 없음</span>;
  return <span className="subtle" title={`${values.length}개 보안 연결 필요`}>보안 연결 {values.length}개</span>;
}

export function connectorStartUrl(connector: ConnectorCatalogItem | null): string {
  const firstAllowedDomain = connector?.allowed_domains[0];
  if (firstAllowedDomain === undefined || firstAllowedDomain.length === 0) return "https://example.com";
  if (/^https?:\/\//u.test(firstAllowedDomain)) return firstAllowedDomain;
  return `https://${firstAllowedDomain}`;
}

function defaultTemplateParamValue(param: string, connector: ConnectorCatalogItem | null): unknown {
  const key = param.toLowerCase();
  if (key === "entry_url" || key === "start_url" || key === "report_url") return connectorStartUrl(connector);
  if (key === "endpoint_url") return "업무 시스템 주소를 선택하세요";
  if (key === "endpoint_profile_id") return "운영 연동 프로필을 선택하세요";
  if (key === "method") return "조회";
  if (key === "max_pages" || key === "page_limit") return 3;
  if (key === "date_range") return { from: "2026-06-01", to: "2026-06-30" };
  if (key === "company_code") return "1000";
  if (key === "status_path") return "응답의 상태 항목";
  if (key === "request_schema_ref") return "승인된 응답 확인 기준을 선택하세요";
  if (key === "source_artifact_id") return "실행 결과에서 증빙을 선택하세요";
  if (key === "document_type") return "송장";
  if (key === "field_schema") return { 송장번호: "텍스트", 공급사: "텍스트", 금액: "숫자" };
  if (key === "channel") return "RPA 운영 알림";
  if (key === "severity") return "높음";
  if (key === "message_template") return "자동화 실행 실패 알림: 사유를 확인하세요";
  if (key.endsWith("_id")) return "목록에서 값을 선택하세요";
  if (key.includes("name")) return "일일 리포트";
  if (key.includes("filter")) return "열린 건";
  return "";
}

export function defaultTemplateParams(template: TemplateCatalogItem, connector: ConnectorCatalogItem | null): Record<string, unknown> {
  return Object.fromEntries(template.required_params.map((param) => [param, defaultTemplateParamValue(param, connector)]));
}

export function templatePrompt(connector: ConnectorCatalogItem | null, template: TemplateCatalogItem): string {
  const connectorName = connector?.name ?? template.connector_id;
  const notes = [
    `템플릿: ${template.name}`,
    `커넥터: ${connectorName}`,
    `업무 목표: ${template.summary}`,
    `적합 업무: ${listLabel(template.best_for)}`,
    `필요 입력: ${paramsLabel(template.required_params)}`,
    `자동화 방식: ${irPatternLabel(template.produced_ir_pattern)}`,
    `성공 기준: ${template.success_criteria}`,
    `상태: ${STATUS_LABEL[template.status]}, 우선순위: ${priorityLabel(template.priority)}`,
  ];
  return [
    "아래 카탈로그 템플릿을 기반으로 브라우저 기반 RPA 자동화 초안을 만들어줘.",
    ...notes,
    "브라우저 화면 기반 절차로만 구성하고, 비밀 값은 화면에 노출하지 말고 승인된 보안 연결로만 다뤄줘.",
    "브라우저 화면으로 처리하기 어려운 연동은 브라우저 화면 기반 대체 절차와 필요한 운영 검토 포인트를 명확히 표시해줘.",
  ].join("\n");
}

export function templateDraftBlocker(template: TemplateCatalogItem, connector: ConnectorCatalogItem | null): string | null {
  if (template.status === "blocked") return "현재 실행 표면이 없어 사용할 수 없습니다.";
  if (template.status === "requires_admin") return "관리자 활성화 후 초안을 만들 수 있습니다.";
  if (connector?.status === "blocked") return "선택한 커넥터가 차단되어 사용할 수 없습니다.";
  if (connector?.status === "requires_admin") return "커넥터 관리자 활성화 후 초안을 만들 수 있습니다.";
  if (connector?.implementation_state === "blocked_by_executor_capability") return "승인된 실행 기능 계약이 없어 사용할 수 없습니다.";
  if (connector?.implementation_state.includes("no approved browser execution surface") === true) return "브라우저 실행 표면이 없어 사용할 수 없습니다.";
  return null;
}

export function templateDraftButtonLabel(template: TemplateCatalogItem, connector: ConnectorCatalogItem | null): string {
  const blocker = templateDraftBlocker(template, connector);
  if (blocker !== null) return template.status === "blocked" || connector?.status === "blocked" ? "사용 불가" : "관리자 활성화 필요";
  return "초안 만들기";
}

export function templateDraftNote(template: TemplateCatalogItem, connector: ConnectorCatalogItem | null): string {
  const blocker = templateDraftBlocker(template, connector);
  if (blocker !== null) return blocker;
  if (template.status === "blocked") return "현재 실행 표면이 없어 설계 검토용 초안만 생성합니다.";
  if (template.status === "requires_admin") return "관리자 활성화와 운영 기능 확인 후 운영할 수 있습니다.";
  if (template.kind !== "browser_workflow") return "브라우저 캡처 증빙 기반 대안으로 초안을 검토하세요.";
  if (template.status === "candidate") return "후보 템플릿입니다. 저장 전 선택자와 운영 조건을 확인하세요.";
  return "생성 화면에서 입력값을 확인한 뒤 저장하세요.";
}
