import { ApiError } from "../api/types";

// 상태값 → 배지 색. state-machine/api-surface 어휘 정합(취소됨=muted, 실패=red 등).
const GREEN = new Set(["completed", "successful", "delivered", "resolved", "approved", "closed", "green", "not_required", "redacted"]);
// "open"은 도메인별 의미가 달라 RED 미포함(아래 BLUE) — circuit open만 kind로 RED 분리(RQ-026).
const RED = new Set(["failed_system", "failed_business", "abandoned", "dead_letter", "DEAD_LETTER", "dead_lettered", "red", "blocked"]);
const AMBER = new Set(["retry", "suspending", "suspended", "aborting", "resume_requested", "resuming", "half_open", "amber", "escalated", "expired", "pending", "failed"]);
const BLUE = new Set(["running", "processing", "queued", "claimed", "completing", "in_progress", "assigned", "open"]);

export type Tone = "green" | "red" | "amber" | "blue" | "muted";
// kind: 같은 enum 문자열이 도메인별로 다른 tone일 때 호출부가 분리(RQ-026). 현재는 circuit만.
// export: 색 결정 단일 출처 — ArrivalBanner 등 .badge 색을 재사용하는 호출부가 직접 복제하지 않게 한다(DRY).
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
  // 서킷(circuit_status: closed/open/half_open — open은 위 '열림' 공유)
  closed: "정상", half_open: "점검 중",
};

// circuit_status는 enum 문자열("open")을 HumanTask 등과 공유하지만 의미가 정반대다 — 서킷 "open"은 회로 '차단'
// (열림 아님). tone과 동일하게 kind로 라벨을 분리(RQ-026 연장): circuit open=차단. closed/half_open(정상/점검 중)은
// STATUS_LABELS 공유.
const CIRCUIT_LABELS: Record<string, string> = { open: "차단" };
// enum → 비기술 한국어 라벨(StatusBadge·필터 드롭다운 공용 접근자). kind 지정 시 도메인별 라벨 우선. 미매핑은 raw 폴백.
export function statusLabel(status: string, kind?: "circuit"): string {
  if (kind === "circuit") return CIRCUIT_LABELS[status] ?? STATUS_LABELS[status] ?? status;
  return STATUS_LABELS[status] ?? status;
}

export function StatusBadge({ status, kind }: { status: string; kind?: "circuit" }): JSX.Element {
  return <span className={`badge ${tone(status, kind)}`}>{statusLabel(status, kind)}</span>;
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
  approval: "승인", validation: "검증", exception: "예외 처리", captcha: "보안문자", mfa: "추가 인증",
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

// 에러 코드 → 비기술 한국어. 출처: 계약 ts/error-catalog.ts ERROR_CATALOG[code].userMessage(73행 주석 '외부 노출(민감정보 없음)')를
// 글자 그대로 미러(STATUS_LABELS가 state-machine enum을 미러하는 것과 동일 정당성). web/tsconfig include는 src/test뿐이라
// 계약 ts를 직접 import할 수 없어 손-미러 + 완전성 테스트(error-label.test.ts)가 드리프트를 막는다(badges 선례).
// 운영자 표면화에 실제로 흐르는 4xx/표면 코드를 매핑. 미매핑 코드는 raw code로 폴백(조용한 공백 금지).
const ERROR_LABELS: Record<string, string> = {
  RUN_NOT_FOUND: "실행을 찾을 수 없습니다.",
  RESOURCE_NOT_FOUND: "대상을 찾을 수 없습니다.",
  RUN_ALREADY_TERMINAL: "이미 종료된 실행입니다.",
  RUN_ABORTED: "실행이 중단되었습니다.",
  SCENARIO_VERSION_CONFLICT: "버전 충돌. 최신본을 다시 불러오세요.",
  POLICY_VERSION_CONFLICT: "정책 버전 충돌. 최신 정책을 다시 불러오세요.",
  IR_SCHEMA_INVALID: "시나리오 정의 오류.",
  IR_EXPRESSION_COMPILE_ERROR: "조건식 오류.",
  SITE_PROFILE_BLOCKED: "해당 사이트는 승인이 필요합니다.",
  SITE_CIRCUIT_OPEN: "일시적으로 수집이 중단되었습니다.",
  SESSION_LOCKED: "잠시 후 재시도됩니다.",
  SESSION_REGISTRATION_REQUIRED: "로그인 세션 등록이 필요합니다.",
  IR_NO_BRANCH_MATCHED: "페이지 상태에 맞는 다음 단계를 찾지 못했습니다.",
  CHALLENGE_UNRESOLVED: "추가 인증이 필요합니다.",
  RATE_BUDGET_EXCEEDED: "요청 한도 초과. 다음 윈도우에 처리됩니다.",
  AUTHZ_FORBIDDEN: "권한이 없습니다.",
  UNAUTHENTICATED: "인증이 필요합니다.",
  SECRET_ACCESS_DENIED: "권한이 없습니다.",
  LLM_CAPABILITY_MISMATCH: "모델 미지원 작업.",
  LLM_BUDGET_EXCEEDED: "처리 한도 초과.",
  HUMAN_TASK_EXPIRED: "처리 기한 만료.",
  WORKITEM_CHECKOUT_CONFLICT: "재시도됩니다.",
  CONTROL_PLANE_INTERNAL_ERROR: "내부 오류가 발생했습니다.",
};

// 에러 코드 문자열 → 비기술 한국어(ApiError가 아닌 bare code 호출부용: failure_reason.code / exception.code).
// 미매핑은 raw code 폴백(조용한 공백 금지) — errorLabel의 ApiError 분기와 동일 규칙·동일 ERROR_LABELS 출처.
export function errorCodeLabel(code: string): string {
  return ERROR_LABELS[code] ?? code;
}

// 운영자 표면 에러 메시지 단일 출처(8곳 raw enum 덤프 통일). ApiError면 계약 userMessage 미러,
// 미매핑이면 raw code 폴백(조용한 공백 금지). 비-ApiError는 아래 분기로 처리.
// correlation_id는 실 응답 필드(types.ts ApiErrorBody)가 있을 때만 부가(없는 추적ID 창작 금지).
export function errorLabel(err: unknown): string {
  if (err instanceof ApiError) {
    const base = errorCodeLabel(err.code);
    const cid = err.body?.correlation_id;
    return cid !== undefined ? `${base} (추적 ${cid})` : base;
  }
  // fetch 실패는 TypeError('Failed to fetch') — 원시 영문 대신 비기술 한국어로(운영자 레지스터).
  // 그 외 일반 Error는 진단성 위해 message 보존(조용한 공백 금지). Error 아니면 '요청 실패'.
  if (err instanceof TypeError) return "네트워크 연결을 확인해 주세요.";
  return err instanceof Error ? err.message : "요청 실패";
}
