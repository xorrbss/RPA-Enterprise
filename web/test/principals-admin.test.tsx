import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 담당자 디렉터리 관리(admin=principal.manage) — Security 뷰의 등록/수정/삭제 패널.
function renderApp(client: ApiClient): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}
function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}
const PRINCIPALS = [
  { principal_id: "a1000000-0000-0000-0000-000000000001", sub: "auth0|alice", display_name: "앨리스", email: "alice@ex.com", source: "manual" as const },
  { principal_id: "a1000000-0000-0000-0000-000000000002", sub: "auth0|bob", display_name: "밥", email: null, source: "jwt" as const },
];

describe("담당자 디렉터리 관리(admin)", () => {
  test("admin은 디렉터리 패널을 보고 수동 등록할 수 있다", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const createPrincipal = vi.fn(async (body: { sub: string; display_name: string; email?: string | null }) => ({
      principal_id: "new", sub: body.sub, display_name: body.display_name, email: body.email ?? null, source: "manual" as const,
    }));
    renderApp(fakeClient({ listPrincipals: async () => ({ items: PRINCIPALS, next_cursor: null }), createPrincipal }));
    location.hash = "#security";

    // 디렉터리 목록(이름·식별자) 렌더.
    expect(await screen.findByText("담당자 디렉터리")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("앨리스")).toBeInTheDocument());
    expect(screen.queryByText("auth0|bob")).toBeNull();
    expect(screen.getByText("계정 연결됨")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "계정" })).toBeInTheDocument();
    expect(screen.getByText("수동 등록")).toBeInTheDocument();
    expect(screen.getByText("로그인 자동 등록")).toBeInTheDocument();

    // 등록 폼 열고 계정 참조/이름 입력 → 등록 호출.
    fireEvent.click(screen.getByRole("button", { name: "+ 담당자 등록" }));
    fireEvent.change(screen.getByPlaceholderText("예: hong.gildong 또는 user@example.com"), { target: { value: "auth0|carol" } });
    fireEvent.change(screen.getByPlaceholderText("예: 홍길동"), { target: { value: "캐롤" } });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));
    await waitFor(() => expect(createPrincipal).toHaveBeenCalledTimes(1));
    expect(createPrincipal.mock.calls[0]?.[0]).toMatchObject({ sub: "auth0|carol", display_name: "캐롤" });
  });

  test("non-admin(operator)은 관리 패널이 보이지 않는다", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    location.hash = "";
    renderApp(fakeClient({ listPrincipals: async () => ({ items: PRINCIPALS, next_cursor: null }) }));
    location.hash = "#security";
    // 사이트 패널은 보이되, 담당자 디렉터리 관리 패널은 숨김(principal.manage 미보유).
    await screen.findByText("사이트 접근 정책");
    expect(screen.queryByText("담당자 디렉터리")).toBeNull();
  });
});
