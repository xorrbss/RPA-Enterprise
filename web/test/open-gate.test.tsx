import { describe, expect, test, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient()}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("open gate view", () => {
  beforeEach(() => {
    location.hash = "#openGate";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "admin"]));
  });

  test("uses business-facing labels and keeps raw contract values collapsed", async () => {
    renderApp();

    expect(await screen.findByText("제품 오픈 점검")).toBeInTheDocument();
    expect(screen.getByText(/요청 조건, 오류 안내, 권한 확인, 감사 근거/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "출시 점검 항목" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "권한 확인" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "화면 요청 조건" })).toBeInTheDocument();
    expect(screen.getAllByText("실행 취소").length).toBeGreaterThan(0);
    expect(screen.getAllByText("중복 실행 방지").length).toBeGreaterThan(0);
    expect(screen.getAllByText("반영됨").length).toBeGreaterThan(0);
    expect(screen.getAllByText("권한 보호됨").length).toBeGreaterThan(0);
    expect(screen.getByText("외부 증거 필요")).toBeInTheDocument();
    expect(screen.queryByText("검토 중")).toBeNull();
    expect(screen.queryByText("위험 검토")).toBeNull();

    expect(screen.queryByText("계약 이름")).toBeNull();
    expect(screen.queryByText("필수 header/key")).toBeNull();
    expect(screen.getAllByText("요청 보호값").length).toBeGreaterThan(0);

    const summaries = screen.getAllByText("검증 근거 보기");
    expect(summaries.length).toBeGreaterThan(0);
    const details = summaries[0]!.closest("details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });
});
