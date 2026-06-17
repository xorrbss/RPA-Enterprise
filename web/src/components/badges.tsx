// 상태값 → 배지 색. state-machine/api-surface 어휘 정합(취소됨=muted, 실패=red 등).
const GREEN = new Set(["completed", "successful", "delivered", "resolved", "approved", "closed", "green", "not_required", "redacted"]);
// "open"은 도메인별 의미가 달라 RED 미포함(아래 BLUE) — circuit open만 kind로 RED 분리(RQ-026).
const RED = new Set(["failed_system", "failed_business", "abandoned", "dead_letter", "DEAD_LETTER", "dead_lettered", "red", "blocked"]);
const AMBER = new Set(["retry", "suspending", "suspended", "aborting", "resume_requested", "resuming", "half_open", "amber", "escalated", "expired", "pending", "failed"]);
const BLUE = new Set(["running", "processing", "queued", "claimed", "completing", "in_progress", "assigned", "open"]);

// kind: 같은 enum 문자열이 도메인별로 다른 tone일 때 호출부가 분리(RQ-026). 현재는 circuit만.
function tone(status: string, kind?: "circuit"): "green" | "red" | "amber" | "blue" | "muted" {
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

export function StatusBadge({ status, kind }: { status: string; kind?: "circuit" }): JSX.Element {
  return <span className={`badge ${tone(status, kind)}`}>{STATUS_LABELS[status] ?? status}</span>;
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
