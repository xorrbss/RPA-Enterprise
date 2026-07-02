import type { HumanTaskItem } from "../api/types";

export const HUMAN_TASK_TERMINAL_STATES = new Set(["resolved", "expired", "cancelled"]);

export function isActiveHumanTask(task: HumanTaskItem): boolean {
  return !HUMAN_TASK_TERMINAL_STATES.has(task.state);
}
