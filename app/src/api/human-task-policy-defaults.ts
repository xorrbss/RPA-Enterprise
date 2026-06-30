import { HUMAN_TASK_DEFAULT_TIMEOUT_MS } from "../runtime/human-task-timeout-policy";

export const HUMAN_TASK_POLICY_DEFAULTS = {
  source: "ops-defaults.md#human_task.default_timeout",
  default_timeout_ms: HUMAN_TASK_DEFAULT_TIMEOUT_MS,
  on_timeout: "fail",
  allowed_kinds: ["approval", "validation", "exception", "captcha", "mfa"],
} as const;

