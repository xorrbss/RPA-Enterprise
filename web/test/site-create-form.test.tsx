import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { SiteCreateForm } from "../src/components/SiteCreateForm";
import { fakeClient } from "./fake-client";

type SiteCreateBody = Parameters<ApiClient["createSite"]>[0];

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderForm(client: ApiClient): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <SiteCreateForm embedded title="Site setup" triggerLabel="Add site" />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function fillRequiredFields(): void {
  fireEvent.click(screen.getByRole("button", { name: "Add site" }));
  fireEvent.change(screen.getByLabelText("이름"), { target: { value: "하이웍스" } });
  fireEvent.change(screen.getByLabelText("사이트 주소"), { target: { value: "https://login.office.hiworks.com" } });
}

function siteCreateResult(body: SiteCreateBody) {
  return {
    site_profile_id: "site-new",
    name: body.name,
    url_pattern: body.url_pattern,
    risk: body.risk ?? "green",
    approved: true,
    default_browser_identity_id: "browser-new",
    default_network_policy_id: "network-new",
  };
}

describe("SiteCreateForm page_state_selectors JSON", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("잘못된 JSON은 사이트 생성 요청 전에 차단한다", () => {
    const calls: Array<Parameters<ApiClient["createSite"]>[0]> = [];
    renderForm(
      fakeClient({
        createSite: async (body) => {
          calls.push(body);
          return siteCreateResult(body);
        },
      }),
    );

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("page_state_selectors JSON"), { target: { value: "{\"flags\":" } });

    expect(screen.getByRole("alert")).toHaveTextContent("page_state_selectors JSON 문법을 확인하세요.");
    expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "등록" }));
    expect(calls).toHaveLength(0);
  });

  test("유효한 JSON은 page_state_selectors로 create payload에 포함한다", async () => {
    const selectors = {
      loginUrl: "https://login.office.hiworks.com",
      authenticatedWhen: { selector: ".user-menu" },
      flags: {
        reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
      },
    };
    const calls: Array<Parameters<ApiClient["createSite"]>[0]> = [];
    renderForm(
      fakeClient({
        createSite: async (body) => {
          calls.push(body);
          return siteCreateResult(body);
        },
      }),
    );

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("page_state_selectors JSON"), {
      target: { value: JSON.stringify(selectors, null, 2) },
    });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: "하이웍스",
      url_pattern: "https://login.office.hiworks.com",
      risk: "green",
      page_state_selectors: selectors,
    });
  });

  test("최소 유효 JSON(flags 객체)은 page_state_selectors로 전송한다", async () => {
    const selectors = { flags: {} };
    const calls: Array<Parameters<ApiClient["createSite"]>[0]> = [];
    renderForm(
      fakeClient({
        createSite: async (body) => {
          calls.push(body);
          return siteCreateResult(body);
        },
      }),
    );

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("page_state_selectors JSON"), {
      target: { value: JSON.stringify(selectors) },
    });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.page_state_selectors).toEqual(selectors);
  });

  test("로그인 주소가 있으면 생성 성공 후 세션 등록 딥링크를 보여준다", async () => {
    renderForm(
      fakeClient({
        createSite: async (body) => siteCreateResult(body),
      }),
    );

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("로그인 주소 (선택)"), { target: { value: "https://login.office.hiworks.com" } });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));

    const next = await screen.findByRole("link", { name: "다음: 로그인 세션 등록" });
    expect(next).toHaveAttribute("href", "#security?section=sites&site=site-new");
    expect(screen.getByText("사이트 등록됨 · 다음: 로그인 세션 등록")).toBeInTheDocument();
  });

  test("selector 입력은 CSS 예시와 한글/앞뒤 공백 경고를 표시한다", () => {
    renderForm(fakeClient());

    fillRequiredFields();
    expect(screen.getByPlaceholderText("예: .user-menu")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("예: .review-item")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("로그인 완료 확인 조건 (선택)"), { target: { value: "사용자 메뉴" } });
    expect(screen.getByText(/한글 설명처럼 보입니다/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("로그인 완료 확인 조건 (선택)"), { target: { value: " .user-menu " } });
    expect(screen.getByText(/앞뒤 공백이 포함/)).toBeInTheDocument();
  });
});
