import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";

import { StatusBadge } from "../src/components/badges";
import { RUN_STATES, WORKITEM_STATES, HUMANTASK_STATES, SITE_RISKS } from "../src/views/filters";

// RQ-012: StatusBadge가 raw enum 대신 비기술 한국어 라벨을 렌더하는가(색 tone은 별도 검증).
describe("StatusBadge 한국어 라벨", () => {
  test.each([
    ["running", "실행 중", "blue"],
    ["completed", "완료", "green"],
    ["cancelled", "취소됨", "muted"],
    ["failed_system", "시스템 실패", "red"],
    ["failed_business", "업무 실패", "red"],
    ["abandoned", "포기", "red"],
    ["escalated", "상위 이관", "amber"],
    ["resolved", "해소됨", "green"],
    ["red", "높음", "red"],
    ["approved", "승인됨", "green"],
    ["half_open", "점검 중", "amber"],
  ])("status=%s → 라벨 %s + tone %s", (status, label, toneClass) => {
    const { container } = render(<StatusBadge status={status} />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe(label);
    expect(el?.className).toContain(toneClass);
  });

  test("미매핑 값은 raw로 폴백(조용한 공백 금지)", () => {
    const { container } = render(<StatusBadge status="totally_unknown" />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe("totally_unknown");
  });

  // RQ-026: "open"이 도메인별로 다른 tone — HumanTask open(열림)=중립(blue), circuit open=경보(red).
  // 이전엔 RED·BLUE 양쪽에 "open"이 있어 RED 우선 → HumanTask 열림이 실패색으로 오인 렌더.
  test("HumanTask open(열림) → blue (실패색 아님)", () => {
    const { container } = render(<StatusBadge status="open" />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe("열림");
    expect(el?.className).toContain("blue");
    expect(el?.className).not.toContain("red");
  });

  test("circuit open → red (kind=circuit 경보)", () => {
    const { container } = render(<StatusBadge status="open" kind="circuit" />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe("열림");
    expect(el?.className).toContain("red");
  });

  // 완전성 가드: StatusBadge로 흐르는 닫힌 enum은 전부 라벨이 있어야 한다(향후 enum 추가 시 실패).
  test.each([
    ...RUN_STATES,
    ...WORKITEM_STATES,
    ...HUMANTASK_STATES,
    ...SITE_RISKS,
  ])("enum %s 라벨 존재(raw로 새지 않음)", (status) => {
    const { container } = render(<StatusBadge status={status} />);
    const text = container.querySelector("span.badge")?.textContent ?? "";
    expect(text).not.toBe(status); // 한국어 라벨로 치환됨
    expect(/[가-힣]/.test(text)).toBe(true);
  });
});
