import { describe, expect, test } from "vitest";

import { formatDeadline, formatDurationMs, formatRunDuration, formatShortDateTime } from "../src/util/time";

describe("time display utilities", () => {
  test("deadline combines Korean local time and remaining duration", () => {
    const now = Date.parse("2026-07-02T06:00:00.000Z");

    expect(formatDeadline("2026-07-02T09:00:00.000Z", now)).toEqual({
      text: "오늘 18:00 · 3시간 남음",
      overdue: false,
      tone: "default",
    });
  });

  test("overdue deadlines use past wording and red tone", () => {
    const now = Date.parse("2026-07-04T09:00:00.000Z");
    const deadline = formatDeadline("2026-07-02T09:00:00.000Z", now);

    expect(deadline.overdue).toBe(true);
    expect(deadline.tone).toBe("red");
    expect(deadline.text).toContain("2일 지남");
  });

  test("short date-time uses display timezone instead of UTC slicing", () => {
    expect(formatShortDateTime("2026-06-25T00:00:00.000Z")).toContain("09:00");
  });
});

// F5 — run 소요 시간: 관측된 두 타임스탬프가 모두 있을 때만 산출(진행 중 경과 추정 금지).
describe("formatRunDuration", () => {
  const t0 = "2026-07-01T00:00:00.000Z";
  const at = (ms: number): string => new Date(Date.parse(t0) + ms).toISOString();

  test("둘 중 하나라도 없으면 null (경과 추정 금지)", () => {
    expect(formatRunDuration(null, null)).toBeNull();
    expect(formatRunDuration(t0, null)).toBeNull();
    expect(formatRunDuration(t0, undefined)).toBeNull();
    expect(formatRunDuration(null, t0)).toBeNull();
    expect(formatRunDuration(undefined, t0)).toBeNull();
  });

  test("파싱 불가/역전 타임스탬프는 null (소요 단정 금지)", () => {
    expect(formatRunDuration("not-a-date", t0)).toBeNull();
    expect(formatRunDuration(t0, "not-a-date")).toBeNull();
    expect(formatRunDuration(at(1000), t0)).toBeNull();
  });

  test("1초 미만", () => {
    expect(formatRunDuration(t0, t0)).toBe("1초 미만");
    expect(formatRunDuration(t0, at(999))).toBe("1초 미만");
  });

  test("초 단위 (59초 경계)", () => {
    expect(formatRunDuration(t0, at(1_000))).toBe("1초");
    expect(formatRunDuration(t0, at(59_000))).toBe("59초");
  });

  test("분+초 단위", () => {
    expect(formatRunDuration(t0, at(60_000))).toBe("1분");
    expect(formatRunDuration(t0, at(75_000))).toBe("1분 15초");
    expect(formatRunDuration(t0, at(59 * 60_000 + 59_000))).toBe("59분 59초");
  });

  test("시간 단위 — 초는 생략(분 단위 정밀도)", () => {
    expect(formatRunDuration(t0, at(3_600_000))).toBe("1시간");
    expect(formatRunDuration(t0, at(3_600_000 + 30_000))).toBe("1시간");
    expect(formatRunDuration(t0, at(2 * 3_600_000 + 5 * 60_000))).toBe("2시간 5분");
  });
});

// formatRunDuration이 재사용하는 ms→한국어 단위 코어(경계 직접 검증).
describe("formatDurationMs", () => {
  test("무효 입력은 null (소요 단정 금지)", () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(undefined)).toBeNull();
    expect(formatDurationMs(-1)).toBeNull();
    expect(formatDurationMs(Number.NaN)).toBeNull();
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("0/1초 미만", () => {
    expect(formatDurationMs(0)).toBe("1초 미만");
    expect(formatDurationMs(999)).toBe("1초 미만");
  });

  test("초/분+초 경계", () => {
    expect(formatDurationMs(1_000)).toBe("1초");
    expect(formatDurationMs(59_000)).toBe("59초");
    expect(formatDurationMs(75_000)).toBe("1분 15초");
  });

  test("시간+분 (초 생략)", () => {
    expect(formatDurationMs(3_600_000)).toBe("1시간");
    expect(formatDurationMs(2 * 3_600_000 + 5 * 60_000)).toBe("2시간 5분");
  });
});
