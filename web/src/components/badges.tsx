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

export function StatusBadge({ status }: { status: string }): JSX.Element {
  return <span className={`badge ${tone(status)}`}>{status}</span>;
}
