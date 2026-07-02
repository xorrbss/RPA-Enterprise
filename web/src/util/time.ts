// 시각 포매터 — Freshness(전역 라이브 표시)와 StepTrace(트레이스-로컬 갱신)에서 공유(DRY).
// HH:MM:SS 로컬 시각만 — 추정/창작 없이 관찰된 타임스탬프(예: react-query dataUpdatedAt)를 사람이 읽는 형태로.
export function hhmmss(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const DISPLAY_TIME_ZONE = "Asia/Seoul";
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: DISPLAY_TIME_ZONE,
});
const SHORT_DATE_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
});
const DAY_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
});
const TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
});

export interface DeadlineLabel {
  readonly text: string;
  readonly overdue: boolean;
  readonly tone: "default" | "red";
}

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return DATE_TIME_FORMAT.format(date);
}

export function formatShortDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return SHORT_DATE_TIME_FORMAT.format(date);
}

export function formatDeadline(value: string | null | undefined, now = Date.now()): DeadlineLabel {
  if (value === null || value === undefined) {
    return { text: "-", overdue: false, tone: "default" };
  }
  const date = new Date(value);
  const dueMs = date.getTime();
  if (Number.isNaN(dueMs)) return { text: value, overdue: false, tone: "default" };
  const diffMs = dueMs - now;
  const absolute = formatDeadlineAbsolute(date, new Date(now));
  const relative = diffMs < 0 ? `${formatRelativeDuration(-diffMs, "past")} 지남` : `${formatRelativeDuration(diffMs, "future")} 남음`;
  return {
    text: `${absolute} · ${relative}`,
    overdue: diffMs < 0,
    tone: diffMs < 0 ? "red" : "default",
  };
}

function formatDeadlineAbsolute(date: Date, now: Date): string {
  const dayKey = DAY_KEY_FORMAT.format(date);
  const todayKey = DAY_KEY_FORMAT.format(now);
  const time = TIME_FORMAT.format(date);
  if (dayKey === todayKey) return `오늘 ${time}`;

  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (dayKey === DAY_KEY_FORMAT.format(tomorrow)) return `내일 ${time}`;

  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayKey === DAY_KEY_FORMAT.format(yesterday)) return `어제 ${time}`;

  return formatShortDateTime(date.toISOString());
}

function formatRelativeDuration(ms: number, direction: "future" | "past"): string {
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (ms < minuteMs) return direction === "future" ? "1분 이내" : "방금";
  if (ms < hourMs) return `${Math.max(1, Math.round(ms / minuteMs))}분`;
  if (ms < dayMs) return `${Math.max(1, Math.round(ms / hourMs))}시간`;
  return `${Math.max(1, Math.round(ms / dayMs))}일`;
}
