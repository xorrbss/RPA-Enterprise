import assert from "node:assert/strict";

import { CronScheduleError, nextCronFireAfter, parseCronExpression } from "../src/runtime/run-trigger-schedule";

function rejects(label: string, expression: string, reason: string): void {
  assert.throws(
    () => parseCronExpression(expression),
    (err) => err instanceof CronScheduleError && err.reason === reason,
    label,
  );
}

assert.equal(
  nextCronFireAfter("0 9 * * *", "Asia/Seoul", new Date("2026-06-23T00:00:00.000Z")).toISOString(),
  "2026-06-24T00:00:00.000Z",
);

assert.equal(
  nextCronFireAfter("*/15 9-10 * * 1-5", "Asia/Seoul", new Date("2026-06-22T00:01:00.000Z")).toISOString(),
  "2026-06-22T00:15:00.000Z",
);

assert.equal(
  nextCronFireAfter("30 8 1 * *", "UTC", new Date("2026-06-01T08:30:00.000Z")).toISOString(),
  "2026-07-01T08:30:00.000Z",
);

assert.equal(
  nextCronFireAfter("0 0 29 2 *", "UTC", new Date("2026-03-01T00:00:00.000Z")).toISOString(),
  "2028-02-29T00:00:00.000Z",
);

rejects("requires five fields", "0 9 * *", "expected_five_fields");
rejects("rejects named fields", "0 9 * JAN *", "invalid_number");
rejects("rejects ambiguous day matching", "0 9 1 * 1", "day_of_month_and_day_of_week_both_specific");
rejects("rejects impossible calendar date", "0 0 30 2 *", "impossible_day_of_month");
rejects("rejects zero step", "*/0 9 * * *", "invalid_step");
rejects("rejects descending ranges", "10-1 9 * * *", "descending_range");

console.log("PASS: run trigger schedule unit green");
