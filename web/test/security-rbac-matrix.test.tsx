import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

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
  const payload = btoa(JSON.stringify({ sub: "operator-a", tenant_id: "tenant-a", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("security RBAC matrix panel", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.setItem("rpa.token", jwt(["operator", "legacy_role"]));
  });

  test("현재 토큰 역할과 핵심 액션 허용/차단을 표시한다", async () => {
    renderApp(fakeClient());

    expect(await screen.findByRole("heading", { name: "RBAC 역할 권한 매트릭스" })).toBeInTheDocument();
    expect(screen.getByText("현재 토큰 역할")).toBeInTheDocument();
    expect(screen.getByText("운영자, 미등록 1개")).toBeInTheDocument();
    expect(screen.getByText("토큰에 미등록 역할이 포함되어 있습니다: legacy_role")).toBeInTheDocument();
    expect(screen.getByText("미허용 액션은 백엔드 RBAC에서 차단되며, 이 표는 같은 권한 매트릭스를 화면에 표시합니다.")).toBeInTheDocument();

    const runCreateRow = screen.getByRole("row", { name: /자동화 실행 시작/ });
    expect(within(runCreateRow).getAllByText("허용").length).toBeGreaterThan(0);

    const promoteRow = screen.getByRole("row", { name: /운영 버전 승격/ });
    expect(within(promoteRow).getByText("차단")).toBeInTheDocument();

    const secretRow = screen.getByRole("row", { name: /SecretRef 사용/ });
    expect(within(secretRow).getByText("차단")).toBeInTheDocument();
  });
});
