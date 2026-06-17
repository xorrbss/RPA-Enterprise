import { beforeEach, describe, expect, test } from "vitest";

import { mergeParams, viewFromHash } from "../src/router";

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

// F3: 뷰가 location.hash를 직접 대입하던 같은-뷰 드릴다운을 하나로 모은 단일 진입점.
// hashWith(병합·테스트됨) + navigate 중복-억제 가드의 조합 — 다른 파라미터를 잃지 않게 보존(단방향 의존).
describe("mergeParams — 현재 뷰 유지 + 쿼리 파라미터 병합/제거", () => {
  beforeEach(() => {
    location.hash = "";
  });

  test("현 뷰 유지 + 파라미터 추가", () => {
    location.hash = "#runTrace";
    mergeParams({ run: "x" });
    expect(location.hash).toBe("#runTrace?run=x");
  });

  test("드리프트 가드(핵심): 기존 파라미터 보존하며 병합", () => {
    location.hash = "#runTrace?status=running";
    mergeParams({ run: "x" });
    expect(location.hash).toBe("#runTrace?status=running&run=x");
  });

  test("값 null → 해당 키만 삭제, 나머지 보존", () => {
    location.hash = "#runTrace?status=running&run=x";
    mergeParams({ run: null });
    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("중복 억제: 결과가 같으면 재대입 없음 → hashchange 미발생(navigate 가드 공유)", () => {
    location.hash = "#workitems?wi=a";
    // jsdom은 location.hash에 '같은 값' 재대입 시 hashchange를 발생시키지 않는다 → 가드가 동작하면 이벤트 0건.
    let fired = 0;
    const onChange = (): void => { fired += 1; };
    window.addEventListener("hashchange", onChange);
    try {
      mergeParams({ wi: "a" }); // 동일 결과 → 가드가 재대입 생략
    } finally {
      window.removeEventListener("hashchange", onChange);
    }
    expect(location.hash).toBe("#workitems?wi=a"); // 결과 보존
    expect(fired).toBe(0); // 재대입 없음 → 변경 이벤트 미발생
  });
});
