import { describe, expect, test } from "vitest";

import { viewFromHash } from "../src/router";

describe("viewFromHash — 딥링크 쿼리 파라미터 지원", () => {
  test("플레인 해시 → 뷰 키", () => {
    expect(viewFromHash("#runTrace")).toBe("runTrace");
    expect(viewFromHash("#dashboard")).toBe("dashboard");
  });

  test("쿼리 파라미터 붙은 해시 → '?' 이전을 뷰 키로(드릴다운 딥링크, 폴백 안 함)", () => {
    expect(viewFromHash("#runTrace?run=11111111-2222-3333-4444-555555555555")).toBe("runTrace");
    expect(viewFromHash("#workitems?foo=bar")).toBe("workitems");
  });

  test("알 수 없는/빈 해시 → dashboard 폴백(조용한 빈화면 금지)", () => {
    expect(viewFromHash("#nope")).toBe("dashboard");
    expect(viewFromHash("")).toBe("dashboard");
    expect(viewFromHash("#?run=x")).toBe("dashboard");
  });
});
