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

// 소요 시간(ms) → 한국어 단위 문자열. 관측된 밀리초만 받는다(음수/비유한/미지정은 null — 소요를 단정하지 않는다).
// 1초 미만은 "1초 미만", 이후 초/분/시간 단위(시간 단위부터는 초를 생략해 분 단위 정밀도 유지).
export function formatDurationMs(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return "1초 미만";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  if (hours === 0 && seconds > 0) parts.push(`${seconds}초`);
  // ms >= 1000이면 totalSeconds >= 1이라 시간/분/초 중 최소 하나는 존재한다.
  return parts.join(" ");
}

// run 소요 시간(F5) — 관측된 started_at/ended_at 두 값이 모두 있을 때만 산출한다(둘 중 하나라도 없으면 null;
// 진행 중 run의 경과를 클라이언트 시계로 추정하지 않는다 — 날조 금지). 단위 포매팅은 formatDurationMs 재사용.
export function formatRunDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string | null {
  if (startedAt === null || startedAt === undefined) return null;
  if (endedAt === null || endedAt === undefined) return null;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  // 역전 타임스탬프(ms < 0)는 formatDurationMs가 null로 처리한다(소요 단정 금지).
  return formatDurationMs(endMs - startMs);
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
