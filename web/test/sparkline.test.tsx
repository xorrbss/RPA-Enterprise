import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";

import { Sparkline } from "../src/components/Sparkline";

// 경량 SVG 스파크라인 — null 갭(데이터 없는 날을 0으로 단정 금지)·고립점 가시성·접근성(role/aria) 검증.
describe("Sparkline", () => {
  test("연속 non-null → 선(path) 1개 + 점(circle) per 값 + role=img/aria-label", () => {
    const { container, getByRole } = render(
      <Sparkline points={[{ value: 0.5, label: "d1" }, { value: 0.8, label: "d2" }]} ariaLabel="성공률 추세" domainMax={1} />,
    );
    const svg = getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe("성공률 추세");
    expect(container.querySelectorAll("path").length).toBe(1);
    expect(container.querySelector("path")?.getAttribute("d")).toMatch(/^M /);
    expect(container.querySelectorAll("circle").length).toBe(2);
  });

  test("null 은 선을 끊는다 — 두 구간 → path 2개", () => {
    const { container } = render(
      <Sparkline
        points={[
          { value: 1, label: "a" },
          { value: 2, label: "b" },
          { value: null, label: "c" },
          { value: 3, label: "d" },
          { value: 4, label: "e" },
        ]}
        ariaLabel="x"
      />,
    );
    expect(container.querySelectorAll("path").length).toBe(2);
    expect(container.querySelectorAll("circle").length).toBe(4); // non-null 점 4개
  });

  test("고립된 non-null 점(양옆 null) → 선 없이 dot 으로 표시(숨기지 않음)", () => {
    const { container } = render(
      <Sparkline points={[{ value: 1, label: "a" }, { value: null, label: "b" }, { value: 2, label: "c" }]} ariaLabel="x" />,
    );
    expect(container.querySelectorAll("path").length).toBe(0); // 2점 미만 구간은 선 없음
    expect(container.querySelectorAll("circle").length).toBe(2); // 고립점도 dot 으로 보임
  });

  test("전부 null → 점선 바닥선, path/circle 없음(0 단정 금지)", () => {
    const { container } = render(
      <Sparkline points={[{ value: null, label: "a" }, { value: null, label: "b" }]} ariaLabel="데이터 없음" />,
    );
    expect(container.querySelectorAll("path").length).toBe(0);
    expect(container.querySelectorAll("circle").length).toBe(0);
    const line = container.querySelector("line");
    expect(line).not.toBeNull();
    expect(line?.getAttribute("stroke-dasharray")).toBe("2 2");
  });
});
