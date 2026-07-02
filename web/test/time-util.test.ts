import { describe, expect, test } from "vitest";

import { formatDeadline, formatShortDateTime } from "../src/util/time";

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
