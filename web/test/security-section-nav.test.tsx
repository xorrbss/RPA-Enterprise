import { beforeEach, describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

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

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("security-section-nav", () => {
  beforeEach(() => {
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  test.each([
    ["#security", "사이트·브라우저 세션", "사이트 접근 정책"],
    ["#security?site=site-login", "사이트·브라우저 세션", "사이트 접근 정책"],
    ["#security?principal=principal-a", "접속·권한", "SSO/IdP 준비도"],
    ["#security?focus=credentials", "비밀·연결·감사", "보안 연결 사용 현황"],
    ["#security?credential_site=site-a&credential=secret%3A%2F%2Ftenant-a%2Fexecutor", "비밀·연결·감사", "보안 연결 사용 현황"],
    ["#security?focus=worker-pools", "운영 인프라", "전용 워커 풀"],
  ])("%s maps to the %s section", async (hash, sectionLabel, heading) => {
    location.hash = hash;
    renderApp();

    const activeTab = await screen.findByRole("button", { name: new RegExp(sectionLabel) });
    expect(activeTab).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });
});
