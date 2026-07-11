import { ApiError } from "../api/types";

// 상태값 → 배지 색. state-machine/api-surface 어휘 정합(취소됨=muted, 실패=red 등).
const GREEN = new Set(["completed", "successful", "delivered", "resolved", "approved", "closed", "green", "not_required", "redacted"]);
// "open"은 도메인별 의미가 달라 RED 미포함(아래 BLUE) — circuit open만 kind로 RED 분리(RQ-026).
const RED = new Set(["failed_system", "failed_business", "abandoned", "dead_letter", "DEAD_LETTER", "dead_lettered", "red", "blocked"]);
const AMBER = new Set(["retry", "suspending", "suspended", "aborting", "resume_requested", "resuming", "half_open", "amber", "escalated", "expired", "pending", "failed"]);
const BLUE = new Set(["running", "processing", "queued", "claimed", "completing", "in_progress", "assigned", "open"]);

export type Tone = "green" | "red" | "amber" | "blue" | "muted";
// kind: 같은 enum 문자열이 도메인별로 다른 tone일 때 호출부가 분리(RQ-026). 현재는 circuit만.
// export: 색 결정 단일 출처 — 상태 패널 등 .badge 색을 재사용하는 호출부가 직접 복제하지 않게 한다(DRY).
export function tone(status: string, kind?: "circuit"): Tone {
  // circuit_status "open" = 서킷 차단(경보) → red. 그 외 "open"(HumanTask 열림)은 BLUE(중립-활성)로 떨어진다.
  if (kind === "circuit" && status === "open") return "red";
  if (GREEN.has(status)) return "green";
  if (RED.has(status)) return "red";
  if (AMBER.has(status)) return "amber";
  if (BLUE.has(status)) return "blue";
  return "muted"; // cancelled("취소됨") 등 — 실패와 분리(중립)
}

// enum → 비기술 한국어 라벨(운영자 대면). 출처: state-machine-types(Run/Workitem/HumanTask) +
// filters.ts 닫힌 enum + 목업(rpa_enterprise_console.html) 카피. StatusBadge로 흐르는 값만 매핑하고,
// 미매핑은 raw로 폴백(조용한 공백 금지). 색(tone)은 별도로 이미 정상.
const STATUS_LABELS: Record<string, string> = {
  // RunState
  queued: "대기", claimed: "점유", running: "실행 중", suspending: "보류 중",
  suspended: "사람 확인 대기", resume_requested: "이어하기 요청", resuming: "이어하는 중",
  completing: "마무리 중", completed: "완료", aborting: "취소 중", cancelled: "취소됨",
  failed_business: "업무 실패", failed_system: "시스템 실패",
  // WorkitemState (run과 공유 키 제외)
  new: "신규", processing: "처리 중", successful: "성공", retry: "재시도", abandoned: "포기",
  // HumanTaskState (cancelled 공유)
  open: "열림", assigned: "할당됨", in_progress: "진행 중", resolved: "해소됨",
  expired: "만료", escalated: "상위 이관",
  // 사이트 위험도(SITE_RISKS)
  green: "낮음", amber: "중간", red: "높음",
  // 사이트 승인(approval_status)
  pending: "검토 대기", approved: "승인됨", rejected: "거부됨",
  // 운영 알림 전달 상태
  sending: "발송 중", sent: "발송됨", delivered: "전달됨", failed: "실패", dead_letter: "실패 보관",
  // 서킷(circuit_status: closed/open/half_open — open은 위 '열림' 공유)
  closed: "정상", half_open: "점검 중",
};

// circuit_status는 enum 문자열("open")을 HumanTask 등과 공유하지만 의미가 정반대다 — 서킷 "open"은 회로 '차단'
// (열림 아님). tone과 동일하게 kind로 라벨을 분리(RQ-026 연장): circuit open=차단. closed/half_open(정상/점검 중)은
// STATUS_LABELS 공유.
const CIRCUIT_LABELS: Record<string, string> = { open: "차단" };
// enum → 비기술 한국어 라벨(StatusBadge·필터 드롭다운 공용 접근자). kind 지정 시 도메인별 라벨 우선. 미매핑은 raw 폴백.
// T4: 대소문자 변형(DLQ의 "DEAD_LETTER" 등)은 소문자 정규화로 라벨을 찾는다 — tone(RED set)은 양쪽 케이스를 이미
// 알지만 라벨 지도는 소문자 키만 있어 raw 원문이 화면에 노출됐다(감사 P2). 미매핑만 raw 폴백(조용한 공백 금지 유지).
export function statusLabel(status: string, kind?: "circuit"): string {
  if (kind === "circuit") return CIRCUIT_LABELS[status] ?? STATUS_LABELS[status] ?? status;
  return STATUS_LABELS[status] ?? STATUS_LABELS[status.toLowerCase()] ?? status;
}

export function StatusBadge({ status, kind }: { status: string; kind?: "circuit" }): JSX.Element {
  return <span className={`badge ${tone(status, kind)}`}>{statusLabel(status, kind)}</span>;
}

export function runModeLabel(runMode: string | null | undefined): string {
  return runMode === "test" ? "시험 실행" : "운영 실행";
}

export function RunModeBadge({ runMode }: { readonly runMode: string | null | undefined }): JSX.Element {
  return <span className={`badge ${runMode === "test" ? "amber" : "blue"}`}>{runModeLabel(runMode)}</span>;
}

// 동작(IR action verb) → 비기술 한국어. 출처: ts/core-types IRActionType(닫힌 enum). 미매핑은 raw 폴백(조용한 공백 금지).
const ACTION_LABELS: Record<string, string> = {
  act: "화면 조작", observe: "화면 확인", extract: "데이터 추출", navigate: "페이지 이동",
  download: "파일 받기", upload: "파일 올리기", api_call: "API 호출", file: "파일 처리",
  human_task: "사람 확인 요청", shell: "명령 실행",
};
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

// 캐시 모드 → 한국어. 출처: ts/core-types StepResult.cache.mode(닫힌 enum). ActionPlanCache 재사용/탐색을 운영자어로.
const CACHE_LABELS: Record<string, string> = {
  hit: "캐시 재사용", miss: "신규 탐색", bypass: "캐시 미사용",
  suspect: "캐시 의심", stale: "캐시 만료", quarantined: "캐시 격리",
};
export function cacheLabel(mode: string): string {
  return CACHE_LABELS[mode] ?? mode;
}

// 스트림 종료 사유(stagehand_calls.stream_status = LLM finishReason) → 한국어. 출처: gateway finishReason
// (stop/length/tool_call/content_filter) + 런타임 관측값(done=정상, error/aborted=중단). 미매핑은 raw 폴백.
const STREAM_STATUS_LABELS: Record<string, string> = {
  stop: "정상 완료", done: "정상 완료", tool_call: "도구 호출",
  length: "길이 한도로 잘림", content_filter: "콘텐츠 필터 차단", error: "스트림 오류", aborted: "스트림 중단",
};
export function streamStatusLabel(status: string): string {
  return STREAM_STATUS_LABELS[status] ?? status;
}
// 정상 종료(stop/done/tool_call)가 아닌 stream_status = 관찰된 비정상 종료 신호(잘림/필터/오류). 자동 복구 가독성에 노출.
export function isStreamWarning(status: string | null): boolean {
  return status !== null && status !== "stop" && status !== "done" && status !== "tool_call";
}

// 사람 확인 종류 → 한국어. 출처: filters HUMANTASK_KINDS. 미매핑은 raw 폴백.
const KIND_LABELS: Record<string, string> = {
  approval: "승인 요청", validation: "문서 검증", exception: "예외 확인", captcha: "보안문자 입력", mfa: "추가 인증",
};
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

// IR terminal 노드 종류 → 비기술 한국어. 출처: schema/ir.schema.json terminal.enum(닫힌 레지스트리). 미매핑은 raw 폴백(조용한 공백 금지).
const TERMINAL_LABELS: Record<string, string> = {
  success: "성공", success_empty: "성공(데이터 없음)",
  fail_business: "업무 실패", fail_system: "시스템 실패",
};
export function terminalLabel(t: string): string { return TERMINAL_LABELS[t] ?? t; }

// 에러 코드 → 비기술 한국어. 출처: 계약 ts/error-catalog.ts ERROR_CATALOG[code].userMessage(외부 노출).
// web/tsconfig include는 src/test뿐이라 계약 ts를 직접 import할 수 없어 손-미러 + 완전성 테스트가 드리프트를 막는다.
// 영어 계약 메시지는 S9 언어 정리 범위에서 web 표면용 한국어로 현지화한다. 미매핑 코드는 raw code로 폴백(조용한 공백 금지).
const ERROR_LABELS: Record<string, string> = {
  AI_GOVERNANCE_POLICY_BLOCKED: "AI 운영 정책으로 요청이 차단되었습니다.",
  RUN_NOT_FOUND: "실행을 찾을 수 없습니다.",
  RESOURCE_NOT_FOUND: "대상을 찾을 수 없습니다.",
  RUN_ALREADY_TERMINAL: "이미 종료된 실행입니다.",
  RUN_ABORTED: "실행이 중단되었습니다.",
  SCENARIO_VERSION_CONFLICT: "버전 충돌. 최신본을 다시 불러오세요.",
  POLICY_VERSION_CONFLICT: "정책 버전 충돌. 최신 정책을 다시 불러오세요.",
  IR_SCHEMA_INVALID: "시나리오 정의 오류.",
  IR_EXPRESSION_COMPILE_ERROR: "조건식 오류.",
  IR_EXPRESSION_RUNTIME: "일시 오류.",
  SITE_PROFILE_BLOCKED: "해당 사이트는 승인이 필요합니다.",
  SITE_CIRCUIT_OPEN: "일시적으로 수집이 중단되었습니다.",
  SESSION_LOCKED: "잠시 후 재시도됩니다.",
  SESSION_GENERATION_CONFLICT: "세션 갱신 충돌.",
  SESSION_REGISTRATION_REQUIRED: "로그인 세션 등록이 필요합니다.",
  IR_NO_BRANCH_MATCHED: "페이지 상태에 맞는 다음 단계를 찾지 못했습니다.",
  CHALLENGE_UNRESOLVED: "추가 인증이 필요합니다.",
  RATE_BUDGET_EXCEEDED: "요청 한도 초과. 다음 윈도우에 처리됩니다.",
  BROWSER_LEASE_EXPIRED: "재시도됩니다.",
  BROWSER_CRASH: "재시도됩니다.",
  CDP_DISCONNECTED: "재시도됩니다.",
  NAVIGATION_TIMEOUT: "페이지 응답이 지연되어 재시도됩니다.",
  LLM_BUDGET_EXCEEDED: "처리 한도 초과.",
  LLM_CAPABILITY_MISMATCH: "모델 미지원 작업.",
  LLM_STREAM_TIMEOUT: "응답 지연.",
  LLM_STREAM_IDLE_TIMEOUT: "재시도됩니다.",
  LLM_MALFORMED_OUTPUT: "재시도됩니다.",
  LLM_CONTENT_FILTERED: "처리할 수 없는 콘텐츠.",
  LLM_RATE_LIMITED: "잠시 후 재시도됩니다.",
  LLM_BACKEND_UNAVAILABLE: "재시도됩니다.",
  LLM_CONNECTION_FAILED: "재시도됩니다.",
  EXTRACT_SCHEMA_INVALID: "데이터 형식 오류.",
  VERIFY_FAILED: "재시도됩니다.",
  EMPTY_RESULT_NO_WITNESS: "결과 확인 불가.",
  SECRET_ACCESS_DENIED: "권한이 없습니다.",
  DOMAIN_POLICY_VIOLATION: "허용되지 않은 이동.",
  PROMPT_INJECTION_DETECTED: "비정상 콘텐츠 감지.",
  ARTIFACT_NOT_REDACTED: "준비 중입니다.",
  SHELL_COMMAND_NOT_ALLOWED: "허용되지 않은 명령입니다.",
  UNAUTHENTICATED: "인증이 필요합니다.",
  AUTHZ_FORBIDDEN: "권한이 없습니다.",
  CONNECTOR_PERMISSION_DENIED: "커넥터 권한 위반.",
  CONNECTOR_INCOMPATIBLE: "버전 비호환.",
  CONNECTOR_HOOK_FAILED: "커넥터 설치 오류.",
  SINK_DELIVERY_FAILED: "전달 재시도 중.",
  RAW_PERSIST_FAILED: "재시도됩니다.",
  CONTROL_PLANE_INTERNAL_ERROR: "내부 오류가 발생했습니다.",
  HUMAN_TASK_EXPIRED: "처리 기한 만료.",
  APPROVAL_ALREADY_DECIDED: "이미 처리된 결재입니다.",
  WORKITEM_CHECKOUT_CONFLICT: "재시도됩니다.",
  DEAD_LETTER: "수동 재처리 대기.",
};

// 터미널(종결) 문맥 전용 라벨(U3-2). ERROR_LABELS의 "재시도됩니다" 계열은 계약 userMessage(in-flight 표면) 미러라,
// 재시도가 모두 소진되어 종결된 실행의 배너/목록에서는 "실행이 종료되었습니다 · 재시도됩니다"라는 자기모순 문장이 되고
// 운영자가 시스템이 알아서 복구할 것으로 오인해 재실행하지 않는다. 종결 문맥에서만 과거형+다음 조치형으로 덮어쓴다.
// (in-flight 표면 — 단계 트레이스의 시도별 예외 등 — 은 계속 ERROR_LABELS 사용.)
const TERMINAL_ERROR_LABELS: Record<string, string> = {
  BROWSER_LEASE_EXPIRED: "브라우저 사용 시간 만료로 실행이 실패했습니다 — 다시 실행이 필요합니다.",
  BROWSER_CRASH: "브라우저 비정상 종료로 실행이 실패했습니다 — 다시 실행이 필요합니다.",
  CDP_DISCONNECTED: "브라우저 연결이 끊겨 실행이 실패했습니다 — 다시 실행이 필요합니다.",
  NAVIGATION_TIMEOUT: "페이지 응답 지연으로 재시도가 모두 실패했습니다 — 다시 실행이 필요합니다.",
  SESSION_LOCKED: "다른 실행이 같은 로그인 세션을 사용 중이어서 완료하지 못했습니다 — 다시 실행이 필요합니다.",
  LLM_STREAM_IDLE_TIMEOUT: "AI 응답 지연으로 재시도가 모두 실패했습니다 — 다시 실행이 필요합니다.",
  LLM_MALFORMED_OUTPUT: "AI 응답 형식 오류로 재시도가 모두 실패했습니다 — 다시 실행이 필요합니다.",
  LLM_RATE_LIMITED: "AI 요청 한도로 재시도가 모두 실패했습니다 — 잠시 후 다시 실행하세요.",
  LLM_BACKEND_UNAVAILABLE: "AI 서비스 연결 실패로 재시도가 모두 소진되었습니다 — 다시 실행이 필요합니다.",
  LLM_CONNECTION_FAILED: "AI 연결 실패로 재시도가 모두 소진되었습니다 — 다시 실행이 필요합니다.",
  VERIFY_FAILED: "결과 검증이 반복 실패해 실행이 종료되었습니다 — 화면 변경 여부를 확인한 뒤 다시 실행하세요.",
  RAW_PERSIST_FAILED: "수집 데이터 저장이 반복 실패했습니다 — 다시 실행이 필요합니다.",
  WORKITEM_CHECKOUT_CONFLICT: "작업 점유 충돌이 해소되지 않아 실행이 종료되었습니다 — 다시 실행이 필요합니다.",
  SINK_DELIVERY_FAILED: "외부 전달이 반복 실패했습니다 — 재처리 대기함을 확인하세요.",
};

// 에러 코드 문자열 → 비기술 한국어(ApiError가 아닌 bare code 호출부용: failure_reason.code / exception.code).
// 미매핑은 raw code 폴백(조용한 공백 금지) — errorLabel의 ApiError 분기와 동일 규칙·동일 ERROR_LABELS 출처.
// terminal=true: 종결된 실행 표면(도착 배너·목록 failure_reason 배지) 전용 — 미래형 재시도 문구를 과거형으로 교체.
export function errorCodeLabel(code: string, opts?: { terminal?: boolean }): string {
  if (opts?.terminal === true) return TERMINAL_ERROR_LABELS[code] ?? ERROR_LABELS[code] ?? code;
  return ERROR_LABELS[code] ?? code;
}

// 계약 operatorAction → 운영자 조치 안내. 세부 contract/code 식별자는 괄호에 보존하되, 버튼/배지 표면에 raw 영문 액션이
// 그대로 나오지 않도록 한국어로 설명한다. 미매핑은 raw code 폴백(조용한 공백 금지).
const ERROR_OPERATOR_ACTION_LABELS: Record<string, string> = {
  AI_GOVERNANCE_POLICY_BLOCKED: "AI 실행 정책과 모델·프롬프트·평가·비용 근거를 확인하세요(ai_runtime_policies).",
  RUN_NOT_FOUND: "실행 ID(run_id)를 확인하세요.",
  RESOURCE_NOT_FOUND: "대상 ID와 종류를 확인하세요(api-surface.md).",
  RUN_ALREADY_TERMINAL: "상태를 확인한 뒤 새 실행을 시작하세요.",
  RUN_ABORTED: "이미 취소된 실행입니다. 추가 조치는 필요하지 않습니다.",
  SCENARIO_VERSION_CONFLICT: "최신본을 다시 불러온 뒤 저장하세요(If-Match).",
  POLICY_VERSION_CONFLICT: "최신 정책을 다시 불러온 뒤 저장하세요(gateway_policies.version, If-Match).",
  IR_SCHEMA_INVALID: "시나리오 정의 검증 결과(IR schema)를 확인하세요.",
  IR_EXPRESSION_COMPILE_ERROR: "조건식(IREL) 오류 위치를 확인하세요.",
  IR_EXPRESSION_RUNTIME: "선행 단계 건너뜀(skip) 여부를 확인하세요.",
  IR_NO_BRANCH_MATCHED: "분기 조건(on[])과 페이지 상태(PageState flags)를 확인하세요.",
  SITE_PROFILE_BLOCKED: "사이트 위험도 승인 절차를 진행하세요(site risk=red).",
  SITE_CIRCUIT_OPEN: "차단율과 수집 재개 윈도우를 확인하세요.",
  SESSION_LOCKED: "같은 자격 증명의 동시 실행 한도를 확인하세요.",
  SESSION_GENERATION_CONFLICT: "세션을 다시 조회한 뒤 재시도하세요.",
  SESSION_REGISTRATION_REQUIRED: "보안·개인정보에서 로그인 세션을 등록한 뒤 다시 실행하세요.",
  CHALLENGE_UNRESOLVED: "사람 확인 인박스에서 추가 인증을 처리하세요.",
  RATE_BUDGET_EXCEEDED: "일일 예산과 처리 윈도우를 조정하세요.",
  BROWSER_LEASE_EXPIRED: "브라우저 lease 정리 작업 상태를 확인하세요.",
  BROWSER_CRASH: "브라우저 메모리와 재생성 상태를 확인하세요.",
  CDP_DISCONNECTED: "CDP 연결 상태를 확인하세요.",
  NAVIGATION_TIMEOUT: "대상 사이트 응답, 로그인 세션, 네트워크 상태를 확인하세요.",
  LLM_BUDGET_EXCEEDED: "토큰 예산을 늘리거나 시나리오 단계를 줄이세요.",
  LLM_CAPABILITY_MISMATCH: "모델 정책과 지원 기능(capabilities)을 확인하세요.",
  LLM_STREAM_TIMEOUT: "모델 백엔드 상태를 확인하세요.",
  LLM_STREAM_IDLE_TIMEOUT: "대체 모델 동작을 확인하세요.",
  LLM_MALFORMED_OUTPUT: "반복되면 프롬프트와 출력 스키마를 점검하세요.",
  LLM_CONTENT_FILTERED: "입력 내용을 검토하세요.",
  LLM_RATE_LIMITED: "모델 호출 제한입니다. 백오프, 동시성, 예산을 확인하세요.",
  LLM_BACKEND_UNAVAILABLE: "모델 백엔드 상태와 대체 모델을 확인하세요.",
  LLM_CONNECTION_FAILED: "모델 엔드포인트와 네트워크 연결을 확인하세요.",
  EXTRACT_SCHEMA_INVALID: "출력 스키마와 페이지 변경 여부를 확인하세요.",
  VERIFY_FAILED: "검증 기준과 취약한 단계를 확인하세요.",
  EMPTY_RESULT_NO_WITNESS: "빈 결과 허용 근거(empty_result_allowed witness)를 추가하세요.",
  SECRET_ACCESS_DENIED: "RBAC와 Vault 정책을 확인하세요.",
  DOMAIN_POLICY_VIOLATION: "허용 도메인 목록을 점검하세요.",
  PROMPT_INJECTION_DETECTED: "페이지 출처와 공격 가능성을 검토하세요.",
  ARTIFACT_NOT_REDACTED: "민감정보 제거 작업(redaction job) 상태를 확인하세요.",
  SHELL_COMMAND_NOT_ALLOWED: "서명된 명령 등록부에 명령을 등록하세요(security-contracts.md §shell).",
  UNAUTHENTICATED: "유효한 Bearer JWT를 제시하세요(auth-rbac.md §3).",
  AUTHZ_FORBIDDEN: "역할/권한 매트릭스를 확인하세요(auth-rbac.md §2).",
  CONNECTOR_PERMISSION_DENIED: "커넥터 manifest permissions를 확인하세요.",
  CONNECTOR_INCOMPATIBLE: "runtime/IR 버전 호환성을 확인하세요.",
  CONNECTOR_HOOK_FAILED: "커넥터 hook 로그를 확인하고 필요하면 되돌리세요.",
  SINK_DELIVERY_FAILED: "전달 실패 큐(DLQ) 재처리를 확인하세요.",
  RAW_PERSIST_FAILED: "스토리지 상태를 확인하세요.",
  CONTROL_PLANE_INTERNAL_ERROR: "control-plane 오류 로그와 correlation_id를 확인하세요.",
  HUMAN_TASK_EXPIRED: "재처리하거나 상위 이관하세요.",
  APPROVAL_ALREADY_DECIDED: "결재 상태를 확인하세요.",
  WORKITEM_CHECKOUT_CONFLICT: "중복 참조(unique_reference)를 확인하세요.",
  DEAD_LETTER: "실패 보관함(DLQ) 재처리 API를 확인하세요.",
};

export function errorOperatorActionLabel(code: string): string {
  return ERROR_OPERATOR_ACTION_LABELS[code] ?? code;
}

// 서버 details.reason → 운영자 한국어(닫힌 맵). 같은 code(예: IR_SCHEMA_INVALID)가 여러 도메인에서 재사용되므로
// 코드 라벨만 쓰면 원인이 사라진다(AI 증빙 폼에 "시나리오 정의 오류"가 뜨던 문제). reason이 매핑돼 있으면 코드 라벨보다
// 우선한다. 미매핑 reason은 코드 라벨로 폴백(조용한 공백 금지).
const ERROR_REASON_LABELS: Record<string, string> = {
  valid_ai_governance_audit_correlation_required: "유효 증빙에는 감사 추적 ID가 필요합니다.",
  audit_correlation_not_found: "감사 추적 ID를 감사 기록에서 찾을 수 없습니다. 감사 이력 화면의 추적 번호를 사용하세요.",
};

function errorReason(err: ApiError): string | null {
  const reason = err.body?.details?.reason;
  return typeof reason === "string" ? reason : null;
}

// 운영자 표면 에러 메시지 단일 출처(8곳 raw enum 덤프 통일). ApiError면 details.reason 라벨 → web 표면 코드 라벨 순,
// 둘 다 미매핑이면 raw code 폴백(조용한 공백 금지). 비-ApiError는 아래 분기로 처리.
// correlation_id는 실 응답 필드(types.ts ApiErrorBody)가 있을 때만 부가(없는 추적ID 창작 금지).
export function errorLabel(err: unknown): string {
  if (err instanceof ApiError) {
    const reason = errorReason(err);
    const reasonLabel = reason === null ? undefined : ERROR_REASON_LABELS[reason];
    const base = reasonLabel ?? errorCodeLabel(err.code);
    const cid = err.body?.correlation_id;
    return cid !== undefined ? `${base} (추적 ${cid})` : base;
  }
  // fetch 실패는 TypeError('Failed to fetch') — 원시 영문 대신 비기술 한국어로(운영자 레지스터).
  // 그 외 일반 Error는 진단성 위해 message 보존(조용한 공백 금지). Error 아니면 '요청 실패'.
  if (err instanceof TypeError) return "네트워크 연결을 확인해 주세요.";
  return err instanceof Error ? err.message : "요청 실패";
}
