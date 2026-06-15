// 닫힌 enum 필터 옵션(백엔드 list-query.ts 검증 enum 미러 — 무효값은 백엔드가 422).
export const RUN_STATES = [
  "queued", "claimed", "running", "suspending", "suspended", "resume_requested",
  "resuming", "completing", "completed", "aborting", "cancelled", "failed_business", "failed_system",
] as const;

export const WORKITEM_STATES = ["new", "processing", "successful", "retry", "failed_business", "failed_system", "abandoned"] as const;

export const HUMANTASK_STATES = ["open", "assigned", "in_progress", "resolved", "expired", "cancelled", "escalated"] as const;

export const HUMANTASK_KINDS = ["approval", "validation", "exception", "captcha", "mfa"] as const;

export const SITE_RISKS = ["green", "amber", "red"] as const;
