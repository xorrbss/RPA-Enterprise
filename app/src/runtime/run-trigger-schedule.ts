const MAX_LOOKAHEAD_DAYS = 366 * 5;
const MINUTE_MS = 60_000;

type CronFieldName = "minute" | "hour" | "day_of_month" | "month" | "day_of_week";

interface CronFieldSpec {
  readonly name: CronFieldName;
  readonly min: number;
  readonly max: number;
}

interface ParsedCronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

interface ParsedCronExpression {
  readonly minute: ParsedCronField;
  readonly hour: ParsedCronField;
  readonly dayOfMonth: ParsedCronField;
  readonly month: ParsedCronField;
  readonly dayOfWeek: ParsedCronField;
}

interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfWeek: number;
}

const FIELD_SPECS: readonly CronFieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day_of_month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day_of_week", min: 0, max: 7 },
];

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export class CronScheduleError extends Error {
  readonly reason: string;
  readonly field?: CronFieldName;

  constructor(reason: string, field?: CronFieldName) {
    super(`Invalid cron schedule: ${field !== undefined ? `${field}: ` : ""}${reason}`);
    this.name = "CronScheduleError";
    this.reason = reason;
    this.field = field;
  }
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronScheduleError("expected_five_fields");
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) =>
    parseField(field, FIELD_SPECS[index] as CronFieldSpec),
  );

  if (!dayOfMonth.wildcard && !dayOfWeek.wildcard) {
    throw new CronScheduleError("day_of_month_and_day_of_week_both_specific");
  }
  if (!dayOfMonth.wildcard && !month.wildcard && !hasPossibleDayOfMonth(dayOfMonth.values, month.values)) {
    throw new CronScheduleError("impossible_day_of_month", "day_of_month");
  }

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function nextCronFireAfter(expression: string, timezone: string, after: Date): Date {
  if (!Number.isFinite(after.getTime())) {
    throw new CronScheduleError("invalid_after");
  }
  const schedule = parseCronExpression(expression);
  const formatter = formatterFor(timezone);
  const startMs = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const horizonMs = startMs + MAX_LOOKAHEAD_DAYS * 24 * 60 * MINUTE_MS;

  for (let candidateMs = startMs; candidateMs <= horizonMs; candidateMs += MINUTE_MS) {
    const candidate = new Date(candidateMs);
    if (matches(schedule, localParts(formatter, candidate))) {
      return candidate;
    }
  }

  throw new CronScheduleError("no_fire_within_lookahead");
}

function parseField(raw: string, spec: CronFieldSpec): ParsedCronField {
  if (raw.length === 0) {
    throw new CronScheduleError("empty_field", spec.name);
  }

  const values = new Set<number>();
  const parts = raw.split(",");
  for (const part of parts) {
    addPart(values, part, spec);
  }

  const wildcard = values.size === fieldCardinality(spec);
  if (values.size === 0) {
    throw new CronScheduleError("empty_value_set", spec.name);
  }
  return { values, wildcard };
}

function addPart(values: Set<number>, rawPart: string, spec: CronFieldSpec): void {
  const [rangeToken, stepToken, extra] = rawPart.split("/");
  if (extra !== undefined || rangeToken === undefined || rangeToken.length === 0) {
    throw new CronScheduleError("invalid_step_syntax", spec.name);
  }

  const step = stepToken === undefined ? 1 : parseInteger(stepToken, spec, "invalid_step");
  if (step < 1) {
    throw new CronScheduleError("invalid_step", spec.name);
  }

  const { start, end } = parseRange(rangeToken, spec);
  for (let value = start; value <= end; value += step) {
    values.add(normalizeValue(value, spec));
  }
}

function parseRange(token: string, spec: CronFieldSpec): { readonly start: number; readonly end: number } {
  if (token === "*") {
    return { start: spec.min, end: spec.max };
  }

  const [startToken, endToken, extra] = token.split("-");
  if (extra !== undefined || startToken === undefined || startToken.length === 0) {
    throw new CronScheduleError("invalid_range", spec.name);
  }

  const start = parseInteger(startToken, spec, "invalid_number");
  const end = endToken === undefined ? start : parseInteger(endToken, spec, "invalid_number");
  if (start > end) {
    throw new CronScheduleError("descending_range", spec.name);
  }
  return { start, end };
}

function parseInteger(value: string, spec: CronFieldSpec, reason: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CronScheduleError(reason, spec.name);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < spec.min || parsed > spec.max) {
    throw new CronScheduleError(reason, spec.name);
  }
  return parsed;
}

function normalizeValue(value: number, spec: CronFieldSpec): number {
  if (spec.name === "day_of_week" && value === 7) return 0;
  return value;
}

function fieldCardinality(spec: CronFieldSpec): number {
  if (spec.name === "day_of_week") return 7;
  return spec.max - spec.min + 1;
}

function hasPossibleDayOfMonth(days: ReadonlySet<number>, months: ReadonlySet<number>): boolean {
  for (const month of months) {
    const maxDay = month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
    for (const day of days) {
      if (day <= maxDay) return true;
    }
  }
  return false;
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached !== undefined) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatter.format(new Date(0));
    formatterCache.set(timezone, formatter);
    return formatter;
  } catch {
    throw new CronScheduleError("invalid_timezone");
  }
}

function localParts(formatter: Intl.DateTimeFormat, date: Date): LocalDateParts {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  const year = numberPart(parts.year);
  const month = numberPart(parts.month);
  const day = numberPart(parts.day);
  const hour = numberPart(parts.hour) === 24 ? 0 : numberPart(parts.hour);
  const minute = numberPart(parts.minute);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, dayOfWeek };
}

function numberPart(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CronScheduleError("invalid_local_time_part");
  }
  return parsed;
}

function matches(schedule: ParsedCronExpression, parts: LocalDateParts): boolean {
  return schedule.minute.values.has(parts.minute)
    && schedule.hour.values.has(parts.hour)
    && schedule.dayOfMonth.values.has(parts.day)
    && schedule.month.values.has(parts.month)
    && schedule.dayOfWeek.values.has(parts.dayOfWeek);
}
