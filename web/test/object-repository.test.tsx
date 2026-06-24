import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { SiteElementCreateBody, SiteElementItem, SiteElementListParams } from "../src/api/types";
import { fakeClient } from "./fake-client";

function tokenWithRoles(roles: string[]): string {
  const payload = btoa(JSON.stringify({ sub: "11111111-0000-4000-8000-000000000001", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.sig`;
}

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

describe("object repository view", () => {
  beforeEach(() => {
    location.hash = "#objectRepository";
    localStorage.setItem("rpa.token", tokenWithRoles(["operator"]));
  });

  test("lists site-scoped reusable selectors and creates a new element", async () => {
    let created: SiteElementCreateBody | null = null;
    let probed: { siteId: string; elementId: string; body: unknown } | null = null;
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-1",
            default_network_policy_id: "np-1",
          },
        ],
        next_cursor: null,
      }),
      createSiteElement: async (siteId, body) => {
        created = body;
        return {
          element_id: "93000000-0000-4000-8000-000000000099",
          site_profile_id: siteId,
          element_key: body.element_key,
          label: body.label,
          selector: body.selector,
          element_type: body.element_type ?? "button",
          stability: body.stability ?? "stable",
          source: body.source ?? "manual",
          sample_url: body.sample_url ?? null,
          notes: body.notes ?? null,
          usage_count: 0,
          last_verified_at: null,
          updated_by: "operator",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:00.000Z",
        };
      },
      probeSiteElement: async (siteId, elementId, body) => {
        probed = { siteId, elementId, body };
        const element = {
          element_id: elementId,
          site_profile_id: siteId,
          element_key: "SubmitButton",
          label: "?쒖텧 踰꾪듉",
          selector: "button[type=submit]",
          element_type: "button" as const,
          stability: "stable" as const,
          source: "manual" as const,
          sample_url: "https://portal.example.com/form",
          notes: "寃곗옱 ?쒖텧 ?뚮줈?곗뿉??怨듭쑀",
          usage_count: 3,
          last_verified_at: "2026-06-23T00:00:00.000Z",
          updated_by: "operator",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:01.000Z",
        };
        return {
          element_id: elementId,
          site_profile_id: siteId,
          selector: element.selector,
          sample_url: element.sample_url,
          probe_status: "matched",
          match_count: 2,
          reason_code: null,
          checked_at: "2026-06-23T00:00:01.000Z",
          element,
        };
      },
    });
    renderApp(client);

    expect(await screen.findByText("사이트별 화면 요소 저장소")).toBeInTheDocument();
    expect(await screen.findByText("업무 식별명 등록됨")).toBeInTheDocument();
    expect(screen.getByDisplayValue("button[type=submit]")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "찾기 검증" }));
    await waitFor(() => expect(probed).toMatchObject({
      siteId: "30000000-0000-4000-8000-000000000001",
      elementId: "93000000-0000-4000-8000-000000000001",
    }));

    fireEvent.click(screen.getByRole("button", { name: "새 요소 입력" }));
    fireEvent.change(screen.getByLabelText("업무 식별명"), { target: { value: "SearchInput" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "검색 입력" } });
    fireEvent.change(screen.getByLabelText("화면에서 찾는 조건"), { target: { value: "input[name=q]" } });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(await screen.findByText("화면 요소를 등록했습니다.")).toBeInTheDocument();
    expect(created).toMatchObject({ element_key: "SearchInput", label: "검색 입력", selector: "input[name=q]" });
  });

  test("surfaces high-usage unstable selectors as maintenance priority", async () => {
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-1",
            default_network_policy_id: "np-1",
          },
        ],
        next_cursor: null,
      }),
      listSiteElements: async () => ({
        items: [
          {
            element_id: "93000000-0000-4000-8000-000000000011",
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            element_key: "SubmitButton",
            label: "제출 버튼",
            selector: "button[type=submit]",
            element_type: "button",
            stability: "stable",
            source: "manual",
            sample_url: "https://portal.example.com/form",
            notes: null,
            usage_count: 3,
            last_verified_at: "2026-06-23T00:00:00.000Z",
            updated_by: "operator",
            created_at: "2026-06-23T00:00:00.000Z",
            updated_at: "2026-06-23T00:00:00.000Z",
          },
          {
            element_id: "93000000-0000-4000-8000-000000000012",
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            element_key: "PaymentButton",
            label: "결제 버튼",
            selector: "button.pay-now",
            element_type: "button",
            stability: "broken",
            source: "manual",
            sample_url: "https://portal.example.com/pay",
            notes: null,
            usage_count: 12,
            last_verified_at: null,
            updated_by: "operator",
            created_at: "2026-06-23T00:00:00.000Z",
            updated_at: "2026-06-23T00:00:00.000Z",
          },
          {
            element_id: "93000000-0000-4000-8000-000000000013",
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            element_key: "CustomerInput",
            label: "고객 입력",
            selector: "input[name=customer]",
            element_type: "input",
            stability: "review_needed",
            source: "manual",
            sample_url: "https://portal.example.com/customer",
            notes: null,
            usage_count: 5,
            last_verified_at: null,
            updated_by: "operator",
            created_at: "2026-06-23T00:00:00.000Z",
            updated_at: "2026-06-23T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      }),
    });
    renderApp(client);

    const summary = await screen.findByRole("region", { name: "저장소 유지보수 요약" });
    expect(summary).toHaveTextContent("등록 요소");
    expect(summary).toHaveTextContent("3");
    expect(summary).toHaveTextContent("점검 필요");
    expect(summary).toHaveTextContent("2");
    expect(summary).toHaveTextContent("누적 사용");
    expect(summary).toHaveTextContent("20");

    const priority = await screen.findByRole("region", { name: "우선 점검 요소" });
    const priorityButtons = within(priority).getAllByRole("button");
    expect(priorityButtons[0]).toHaveTextContent("결제 버튼");
    expect(priorityButtons[0]).toHaveTextContent("12회 · 재점검 필요");
    expect(priorityButtons[1]).toHaveTextContent("고객 입력");
    expect(priorityButtons[1]).toHaveTextContent("5회 · 검토 필요");

    fireEvent.click(within(priority).getByRole("button", { name: /결제 버튼/ }));
    expect(screen.getByDisplayValue("button.pay-now")).toBeInTheDocument();
  });

  test("filter changes keep the fallback selected element synchronized", async () => {
    const stableElement: SiteElementItem = {
      element_id: "93000000-0000-4000-8000-000000000031",
      site_profile_id: "30000000-0000-4000-8000-000000000001",
      element_key: "SubmitButton",
      label: "제출 버튼",
      selector: "button[type=submit]",
      element_type: "button",
      stability: "stable",
      source: "manual",
      sample_url: "https://portal.example.com/form",
      notes: null,
      usage_count: 3,
      last_verified_at: null,
      updated_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    };
    const brokenElement: SiteElementItem = {
      element_id: "93000000-0000-4000-8000-000000000032",
      site_profile_id: "30000000-0000-4000-8000-000000000001",
      element_key: "PaymentButton",
      label: "결제 버튼",
      selector: "button.pay-now",
      element_type: "button",
      stability: "broken",
      source: "manual",
      sample_url: "https://portal.example.com/pay",
      notes: null,
      usage_count: 12,
      last_verified_at: null,
      updated_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    };
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-1",
            default_network_policy_id: "np-1",
          },
        ],
        next_cursor: null,
      }),
      listSiteElements: async (_siteId: string, params?: SiteElementListParams) => ({
        items: params?.stability === "broken" ? [brokenElement] : [stableElement, brokenElement],
        next_cursor: null,
      }),
    });
    renderApp(client);

    expect(await screen.findByDisplayValue("button[type=submit]")).toBeInTheDocument();
    const toolbar = await screen.findByRole("region", { name: "화면 요소 저장소 필터" });
    const stateFilter = within(toolbar).getByLabelText("상태");

    fireEvent.change(stateFilter, { target: { value: "broken" } });
    await waitFor(() => expect(screen.getByDisplayValue("button.pay-now")).toBeInTheDocument());

    fireEvent.change(stateFilter, { target: { value: "all" } });
    await waitFor(() => expect(screen.getByDisplayValue("button.pay-now")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("button[type=submit]")).toBeNull();
  });

  test("bulk probes the current element list and summarizes maintenance results", async () => {
    const probed: Array<{ elementId: string; body: unknown }> = [];
    const elements = [
      {
        element_id: "93000000-0000-4000-8000-000000000021",
        site_profile_id: "30000000-0000-4000-8000-000000000001",
        element_key: "SubmitButton",
        label: "제출 버튼",
        selector: "button[type=submit]",
        element_type: "button" as const,
        stability: "review_needed" as const,
        source: "manual" as const,
        sample_url: "https://portal.example.com/form",
        notes: null,
        usage_count: 7,
        last_verified_at: null,
        updated_by: "operator",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
      {
        element_id: "93000000-0000-4000-8000-000000000022",
        site_profile_id: "30000000-0000-4000-8000-000000000001",
        element_key: "PayButton",
        label: "결제 버튼",
        selector: "button.pay-now",
        element_type: "button" as const,
        stability: "broken" as const,
        source: "manual" as const,
        sample_url: "https://portal.example.com/pay",
        notes: null,
        usage_count: 12,
        last_verified_at: null,
        updated_by: "operator",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
    ];
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-1",
            default_network_policy_id: "np-1",
          },
        ],
        next_cursor: null,
      }),
      listSiteElements: async () => ({ items: elements, next_cursor: null }),
      probeSiteElement: async (siteId, elementId, body) => {
        probed.push({ elementId, body });
        const element = elements.find((item) => item.element_id === elementId) ?? elements[0]!;
        const matched = elementId.endsWith("21");
        return {
          element_id: elementId,
          site_profile_id: siteId,
          selector: element.selector,
          sample_url: element.sample_url,
          probe_status: matched ? "matched" : "not_found",
          match_count: matched ? 1 : 0,
          reason_code: matched ? null : "SELECTOR_NOT_FOUND",
          checked_at: "2026-06-23T00:00:01.000Z",
          element: { ...element, stability: matched ? "stable" : "review_needed", last_verified_at: "2026-06-23T00:00:01.000Z" },
        };
      },
    });
    renderApp(client);

    const bulk = await screen.findByRole("region", { name: "현재 목록 재검증" });
    fireEvent.click(within(bulk).getByRole("button", { name: "현재 목록 재검증" }));

    await waitFor(() => expect(probed).toHaveLength(2));
    expect(probed).toEqual([
      { elementId: "93000000-0000-4000-8000-000000000021", body: { sample_url: "https://portal.example.com/form" } },
      { elementId: "93000000-0000-4000-8000-000000000022", body: { sample_url: "https://portal.example.com/pay" } },
    ]);
    expect(await screen.findByText("현재 목록 2건 재검증 완료 · 검증됨 1건")).toBeInTheDocument();
    expect(screen.getByText("확인 필요 1건")).toBeInTheDocument();
    expect(screen.getByText("결제 버튼 · 찾을 수 없음 · 해당 화면에서 요소를 찾지 못했습니다.")).toBeInTheDocument();
  });

  test("shows explicit guidance when browser probe provider is not connected", async () => {
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-1",
            default_network_policy_id: "np-1",
          },
        ],
        next_cursor: null,
      }),
      probeSiteElement: async (siteId, elementId) => {
        const element = {
          element_id: elementId,
          site_profile_id: siteId,
          element_key: "SubmitButton",
          label: "제출 버튼",
          selector: "button[type=submit]",
          element_type: "button" as const,
          stability: "review_needed" as const,
          source: "manual" as const,
          sample_url: "https://portal.example.com/form",
          notes: null,
          usage_count: 3,
          last_verified_at: null,
          updated_by: "operator",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:01.000Z",
        };
        return {
          element_id: elementId,
          site_profile_id: siteId,
          selector: element.selector,
          sample_url: element.sample_url,
          probe_status: "not_run",
          match_count: null,
          reason_code: "SELECTOR_PROBE_PROVIDER_UNAVAILABLE",
          checked_at: "2026-06-23T00:00:01.000Z",
          element,
        };
      },
    });
    renderApp(client);

    expect(await screen.findByText("사이트별 화면 요소 저장소")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("button[type=submit]")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "찾기 검증" }));

    const message = await screen.findByText("찾기 검증 결과: 브라우저 검증 연결이 필요합니다.");
    expect(message).toHaveClass("badge", "amber");
    expect(screen.getByText("검증 연결 대기")).toBeInTheDocument();
    expect(screen.getAllByText("브라우저 검증 연결이 필요합니다.").length).toBeGreaterThanOrEqual(1);
  });
});
