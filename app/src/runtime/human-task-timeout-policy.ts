// ops-defaults.md #human_task.default_timeout=30m. Used when @human_task/challenge omit an explicit timeout.
export const HUMAN_TASK_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Keep user-authored timeout bounded so a malformed IR cannot create effectively infinite or immediate tasks.
export const HUMAN_TASK_MIN_TIMEOUT_MS = 1_000;
export const HUMAN_TASK_MAX_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

export function parseHumanTaskTimeoutMs(value: string): number | null {
  const match = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2]?.toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 60 * 60_000
            : unit === "d"
              ? 24 * 60 * 60_000
              : 0;
  const ms = amount * factor;
  if (!Number.isSafeInteger(ms) || ms < HUMAN_TASK_MIN_TIMEOUT_MS || ms > HUMAN_TASK_MAX_TIMEOUT_MS) return null;
  return ms;
}

export function assertHumanTaskTimeoutMs(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < HUMAN_TASK_MIN_TIMEOUT_MS ||
    value > HUMAN_TASK_MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `${label} must be an integer between ${HUMAN_TASK_MIN_TIMEOUT_MS} and ${HUMAN_TASK_MAX_TIMEOUT_MS} milliseconds`,
    );
  }
}
