import { describe, expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ApiError } from "../src/api/types";
import { desktopStateForError, EmptyState, ErrorState } from "../src/components/states";

describe("desktop-empty-states", () => {
  test("empty states use PC workflow titles instead of silent blank panels", () => {
    render(<EmptyState title="첫 실행 전" message="자동화를 만든 뒤 첫 실행을 시작하세요." />);

    expect(screen.getByRole("status")).toHaveTextContent("첫 실행 전");
    expect(screen.getByText("자동화를 만든 뒤 첫 실행을 시작하세요.")).toBeInTheDocument();
  });

  test("API, permission, setup, and operation errors classify into operator-facing buckets", () => {
    expect(desktopStateForError(new ApiError(404, "HTTP_404", { code: "HTTP_404", message: "missing route" })).title).toBe("API 연결 필요");
    expect(desktopStateForError(new ApiError(403, "AUTHZ_FORBIDDEN", { code: "AUTHZ_FORBIDDEN", message: "denied" })).title).toBe("권한 확인 필요");
    expect(desktopStateForError(new ApiError(422, "IR_SCHEMA_INVALID", { code: "IR_SCHEMA_INVALID", message: "bad setup" })).title).toBe("설정 필요");
    expect(desktopStateForError(new ApiError(500, "INTERNAL_ERROR", { code: "INTERNAL_ERROR", message: "boom" })).title).toBe("운영 실패");
  });

  test("raw technical codes stay in the admin/support details disclosure", () => {
    const classified = desktopStateForError(new ApiError(404, "HTTP_404", { code: "HTTP_404", message: "missing route" }));
    render(<ErrorState title={classified.title} message={classified.message} details={classified.details} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("API 연결 필요");
    expect(alert).toHaveTextContent("admin/support details");
    expect(within(alert).getByText(/HTTP_404/)).toBeInTheDocument();
  });
});
