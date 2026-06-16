// 상태값 → 배지 색. state-machine/api-surface 어휘 정합(취소됨=muted, 실패=red 등).
const GREEN = new Set(["completed", "successful", "delivered", "resolved", "approved", "closed", "green", "not_required", "redacted"]);
const RED = new Set(["failed_system", "failed_business", "abandoned", "dead_letter", "DEAD_LETTER", "dead_lettered", "red", "open", "blocked"]);
const AMBER = new Set(["retry", "suspending", "suspended", "aborting", "resume_requested", "resuming", "half_open", "amber", "escalated", "expired", "pending", "failed"]);
const BLUE = new Set(["running", "processing", "queued", "claimed", "completing", "in_progress", "assigned", "open"]);

function tone(status: string): "green" | "red" | "amber" | "blue" | "muted" {
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

export function StatusBadge({ status }: { status: string }): JSX.Element {
  return <span className={`badge ${tone(status)}`}>{STATUS_LABELS[status] ?? status}</span>;
}
