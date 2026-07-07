import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  test("defaults to sites without rendering the other section panels", async () => {
    location.hash = "#security";
    renderApp();

    expect(await screen.findByRole("heading", { name: "사이트 접근 정책" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "SSO/IdP 준비도" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "보안 연결 사용 현황" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /AI (runtime policy|운영 정책)/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "전용 워커 풀" })).toBeNull();
  });

  test("clicking a section tab updates the security hash", async () => {
    location.hash = "#security";
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /비밀·연결·감사/ }));

    expect(location.hash).toBe("#security?section=secrets");
    expect(await screen.findByRole("heading", { name: "보안 연결 사용 현황" })).toBeInTheDocument();
  });

  test("section tabs are focusable buttons with pressed and current state", async () => {
    location.hash = "#security?section=access";
    renderApp();

    const tabList = await screen.findByRole("list", { name: "보안/개인정보 섹션" });
    const tabs = within(tabList).getAllByRole("button");
    expect(tabs.length).toBeGreaterThanOrEqual(5);

    const accessTab = within(tabList).getByRole("button", { name: /접속·권한/ });
    const sitesTab = within(tabList).getByRole("button", { name: /사이트·브라우저 세션/ });
    expect(accessTab).toHaveAttribute("aria-pressed", "true");
    expect(accessTab).toHaveAttribute("aria-current", "true");
    expect(sitesTab).toHaveAttribute("aria-pressed", "false");
    expect(sitesTab).not.toHaveAttribute("aria-current");

    accessTab.focus();
    expect(document.activeElement).toBe(accessTab);
  });

  test("operator deep link shows only the read-only security summary", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    location.hash = "#security?section=sites&site=site-login";
    renderApp();

    expect(await screen.findByRole("heading", { name: "보안 읽기 전용 요약" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "보안 deep link 권한 안내" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "사이트·브라우저 세션 읽기 전용 섹션 요약" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "사이트 접근 정책" })).toBeNull();
    expect(screen.queryByRole("button", { name: /사이트 등록|세션 등록|운영자 PC 등록|승인/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "보안/개인정보 섹션" })).toBeNull();
  });

  test("viewer credential deep link does not render admin panels or secret refs", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    location.hash = "#security?section=secrets&credential_site=site-a&credential=secret%3A%2F%2Ftenant-a%2Fexecutor";
    renderApp();

    expect(await screen.findByRole("heading", { name: "보안 읽기 전용 요약" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "비밀·연결·감사 읽기 전용 섹션 요약" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "보안 연결 사용 현황" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "SecretRef 감사 요약" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Credential 운영" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/secret:\/\//i);
    expect(document.body.textContent).not.toContain("tenant-a/executor");
  });
});
