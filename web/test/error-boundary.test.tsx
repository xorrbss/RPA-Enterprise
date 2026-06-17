import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { ErrorBoundary } from "../src/components/ErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("렌더 폭발");
}

// jest-dom 매처 비의존(queryBy + toBeNull, 순수 vitest)으로 설정 차이에 견고.
describe("ErrorBoundary", () => {
  test("자식 렌더 예외를 잡아 백지 대신 오류 상태(role=alert) 표시", () => {
    // React가 경계로 잡힌 예외를 console.error로 출력 — 노이즈만 억제(검증과 무관).
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText("화면을 표시하지 못했습니다")).not.toBeNull();
    expect(screen.queryByText("렌더 폭발")).not.toBeNull();
    spy.mockRestore();
  });

  test("정상 자식은 그대로 렌더(경계 비개입)", () => {
    render(
      <ErrorBoundary>
        <div>정상 콘텐츠</div>
      </ErrorBoundary>,
    );
    expect(screen.queryByText("정상 콘텐츠")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
