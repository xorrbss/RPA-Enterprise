import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RenderResult } from "@testing-library/react";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { ConnectorCatalogItem, ConnectorProfileCreateRequest, TemplateCatalogItem } from "../src/api/types";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(client: ApiClient = fakeClient()): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function mockScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

function connector(id: string, name: string): ConnectorCatalogItem {
  return {
    catalog_id: `catalog-${id}`,
    connector_id: id,
    name,
    kind: "browser",
    category: "ERP",
    status: "candidate",
    priority: "P1",
    summary: `${name} summary`,
    best_for: ["review"],
    supported_actions: ["navigate", "extract"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: ["example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "browser template pack",
    security_notes: ["Uses stored browser session references only."],
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  };
}

function template(id: string, connectorId: string, name: string): TemplateCatalogItem {
  return {
    catalog_id: `template-catalog-${id}`,
    template_id: id,
    connector_id: connectorId,
    name,
    kind: "browser_workflow",
    status: "available",
    priority: "P1",
    summary: `${name} summary`,
    best_for: ["review"],
    required_params: ["start_url"],
    required_secret_refs: [],
    produced_ir_pattern: "browser_extract_table",
    success_criteria: "visible result captured",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  };
}

describe("connector catalog view", () => {
  beforeEach(() => {
    location.hash = "#connectorCatalog";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  });

  test.each([
    ["#connectorCatalog?focus=templates", "템플릿 목록"],
    ["#connectorCatalog?focus=connectors", "커넥터 목록"],
  ])("%s focuses and scrolls the requested catalog section", async (hash, sectionLabel) => {
    location.hash = hash;
    const scrollIntoView = mockScrollIntoView();
    renderApp();

    const section = await screen.findByRole("region", { name: sectionLabel });

    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  test("lists connector and template metadata without secret values", async () => {
    renderApp();

    expect((await screen.findAllByText("SAP Web / ERP Portal")).length).toBeGreaterThan(0);
    expect(await screen.findByText("SAP list extract")).toBeInTheDocument();
    expect(screen.getByText("브라우저 템플릿 팩")).toBeInTheDocument();
    const apiTemplateRow = (await screen.findByText("HTTP status check")).closest("tr") as HTMLTableRowElement;
    expect(within(apiTemplateRow).getByRole("button", { name: "관리자 활성화 필요" })).toBeDisabled();
    expect(within(apiTemplateRow).getByText("관리자 활성화 후 초안을 만들 수 있습니다.")).toBeInTheDocument();
    const managedIdpRow = (await screen.findByText("Managed IdP SCIM")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(managedIdpRow).getByRole("button"));
    expect(await screen.findByText("SCIM provider registration")).toBeInTheDocument();
    const idpTemplateRow = (await screen.findByText("SCIM group-role import")).closest("tr") as HTMLTableRowElement;
    expect(within(idpTemplateRow).getByRole("button", { name: "관리자 활성화 필요" })).toBeDisabled();
    expect(screen.getAllByText(/signature_secret_ref/).length).toBeGreaterThan(0);
    const documentRow = (await screen.findByText("Document IDP (Browser Artifacts)")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(documentRow).getByRole("button"));
    expect(await screen.findByText(/내장 문서 추출 후보/)).toBeInTheDocument();
    expect(screen.getAllByText("보안 연결 1개").length).toBeGreaterThan(0);
    expect(screen.queryByText("secret://sites/sap-web/session")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/secret:\/\//)).not.toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
    expect(screen.queryByText("password")).not.toBeInTheDocument();
  });

  test("shows connector profiles and submits SecretRef-only profile setup", async () => {
    const createdProfiles: Array<{ body: ConnectorProfileCreateRequest; key: string }> = [];
    const baseClient = fakeClient();
    renderApp(fakeClient({
      createConnectorProfile: async (body, key) => {
        createdProfiles.push({ body, key });
        return baseClient.createConnectorProfile(body, key);
      },
    }));

    const apiRow = (await screen.findByText("HTTP API")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(apiRow).getByRole("button"));

    expect(await screen.findByText("Finance API")).toBeInTheDocument();
    expect(screen.getByText("team:finance-platform")).toBeInTheDocument();
    expect(screen.queryByText("secret://tenant-a/connector/http-api/bearer")).not.toBeInTheDocument();

    const form = document.querySelector(".connector-profile-form") as HTMLFormElement;
    fireEvent.change(within(form).getByPlaceholderText("HTTP API 스테이징"), { target: { value: "Ops API" } });
    fireEvent.change(within(form).getByPlaceholderText("secret://tenant/connector/name/key"), {
      target: { value: "secret://tenant-a/connector/http-api/ops" },
    });
    fireEvent.change(within(form).getByPlaceholderText("api.vendor.example"), { target: { value: "ops.vendor.example" } });
    fireEvent.change(within(form).getByPlaceholderText("team:business-owner"), { target: { value: "team:ops-platform" } });
    fireEvent.change(within(form).getByPlaceholderText("team:rpa-ops"), { target: { value: "team:rpa-ops" } });
    fireEvent.click(within(form).getByRole("button"));

    await waitFor(() => expect(createdProfiles).toHaveLength(1));
    expect(createdProfiles[0]?.body).toMatchObject({
      connector_id: "http-api",
      profile_name: "Ops API",
      environment: "staging",
      secret_refs: ["secret://tenant-a/connector/http-api/ops"],
      allowed_hosts: ["ops.vendor.example"],
      owner_ref: "team:ops-platform",
      support_owner_ref: "team:rpa-ops",
    });
    expect(createdProfiles[0]?.key).toMatch(/[0-9a-f-]{36}/i);
  });

  test("shows existing RPA vendors as metadata-only handoff profiles", async () => {
    renderApp();

    const federationRow = (await screen.findByText("Existing RPA handoff profiles")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(federationRow).getByRole("button"));

    expect(await screen.findByText(/not direct vendor API\/OAuth connectors/)).toBeInTheDocument();
    expect(await screen.findByText("UiPath handoff provider profile")).toBeInTheDocument();
    expect(await screen.findByText("Automation Anywhere handoff provider profile")).toBeInTheDocument();
    expect(await screen.findByText("Power Automate handoff provider profile")).toBeInTheDocument();
    expect(await screen.findByText("Blue Prism handoff provider profile")).toBeInTheDocument();
    expect(screen.getAllByText(/owner\/provider/).length).toBeGreaterThan(0);

    const uipathTemplateRow = screen.getByText("UiPath handoff provider profile").closest("tr") as HTMLTableRowElement;
    expect(within(uipathTemplateRow).getByRole("button", { name: "관리자 활성화 필요" })).toBeDisabled();
    expect(screen.queryByText("UiPath direct connector")).not.toBeInTheDocument();
    expect(screen.queryByText("Power Automate direct connector")).not.toBeInTheDocument();
  });

  test("previews what a template can create using catalog fields before drafting", async () => {
    renderApp();

    const initialPreview = await screen.findByLabelText("선택한 템플릿 미리보기");
    expect(within(initialPreview).getByText("SAP list extract 미리보기")).toBeInTheDocument();
    expect(within(initialPreview).getByText("Open SAP web list, apply filters, extract visible table rows, and store redacted evidence.")).toBeInTheDocument();
    expect(within(initialPreview).getByText("monthly vendor reconciliation")).toBeInTheDocument();
    expect(within(initialPreview).getByText(/웹 목록 조회와 표 추출|브라우저 표 추출/)).toBeInTheDocument();

    const documentRow = (await screen.findByText("Document IDP (Browser Artifacts)")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(documentRow).getByRole("button"));
    const documentTemplateRow = (await screen.findByText("Document field validation")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(documentTemplateRow).getByRole("button", { name: "미리보기" }));

    const documentPreview = screen.getByLabelText("선택한 템플릿 미리보기");
    expect(within(documentPreview).getByText("Document field validation 미리보기")).toBeInTheDocument();
    expect(within(documentPreview).getByText("invoice fields, contract metadata, manual correction loop")).toBeInTheDocument();
    expect(within(documentPreview).getByText("Required fields are extracted or a business_form_v1 validation task is opened with artifact references.")).toBeInTheDocument();
    expect(within(documentPreview).getByText(/브라우저 증빙 기반 문서 검증/)).toBeInTheDocument();
  });

  test("shows an error state when the connector catalog cannot load", async () => {
    renderApp(fakeClient({ listConnectors: async () => { throw new Error("network down"); } }));

    expect(await screen.findByRole("alert")).toHaveTextContent("커넥터 카탈로그를 불러오지 못했습니다.");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  test("opens a template as a scenario generator draft prefill", async () => {
    renderApp();

    const templateRow = (await screen.findByText("SAP list extract")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(templateRow).getByRole("button", { name: "초안 만들기" }));

    await waitFor(() => expect(location.hash).toContain("#scenarioStudio"));
    expect(location.hash).toContain("connector_id=sap-web");
    expect(location.hash).toContain("template_id=sap-web-list-extract");
    await waitFor(() => expect(screen.getAllByDisplayValue(/SAP list extract/).length).toBeGreaterThan(0));
    expect(screen.getByDisplayValue("SAP list extract 자동화 초안")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("company_code")).toHaveValue("TODO: [BLOCKED] 회사 코드를 입력하세요"));
    expect(screen.queryByText("승인된 API 프로필")).not.toBeInTheDocument();
    expect(screen.queryByText("응답 스키마")).not.toBeInTheDocument();
  });

  test("opens the selected connector as a scenario generator draft prefill", async () => {
    renderApp();

    const detail = await screen.findByLabelText("선택한 커넥터 상세");
    expect(await within(detail).findByText("SAP Web / ERP Portal")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "이 커넥터로 초안 만들기" }));

    await waitFor(() => expect(location.hash).toContain("#scenarioStudio"));
    expect(location.hash).toContain("connector_id=sap-web");
    expect(location.hash).not.toContain("template_id=");
    await waitFor(() => expect(screen.getByDisplayValue("SAP Web / ERP Portal 자동화 초안")).toBeInTheDocument());
    expect(screen.getByDisplayValue(/지원 동작: 웹 이동, 클릭, 데이터 추출, 다운로드/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/TODO: \[BLOCKED\]/)).toBeInTheDocument();
  });

  test("document template draft uses business-friendly artifact placeholders", async () => {
    renderApp();

    const connectorRow = (await screen.findByText("Document IDP (Browser Artifacts)")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(connectorRow).getByRole("button"));
    const templateRow = (await screen.findByText("Document field validation")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(templateRow).getByRole("button", { name: "초안 만들기" }));

    await waitFor(() => expect(location.hash).toContain("#scenarioStudio"));
    const query = location.hash.slice(location.hash.indexOf("?") + 1);
    const params = new URLSearchParams(query).get("params") ?? "";
    expect(params).toContain("실행 결과에서 증빙을 선택하세요");
    expect(params).toContain("TODO: [BLOCKED] 필드명을 입력하세요");
    expect(params).not.toContain('"source_artifact_id": "artifact_id"');
    expect(params).not.toContain('"invoice_no": "string"');
  });

  test("loads additional connector pages instead of treating the first page as the full catalog", async () => {
    const calls: Array<{ cursor?: string }> = [];
    renderApp(fakeClient({
      listConnectors: async (params) => {
        calls.push({ cursor: params?.cursor });
        if (params?.cursor === "connector-cursor-2") {
          return { items: [connector("erp-b", "ERP B")], next_cursor: null };
        }
        return { items: [connector("erp-a", "ERP A")], next_cursor: "connector-cursor-2" };
      },
      listTemplates: async () => ({ items: [], next_cursor: null }),
    }));

    expect((await screen.findAllByText("ERP A")).length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText("카탈로그 요약")).getByText("1+")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));

    expect(await screen.findByText("ERP B")).toBeInTheDocument();
    expect(calls.some((call) => call.cursor === "connector-cursor-2")).toBe(true);
    expect(within(screen.getByLabelText("카탈로그 요약")).getByText("2")).toBeInTheDocument();
  });

  test("loads additional template pages for the selected connector", async () => {
    const calls: Array<{ cursor?: string; connector_id?: string }> = [];
    renderApp(fakeClient({
      listConnectors: async () => ({ items: [connector("sap-web", "SAP Web / ERP Portal")], next_cursor: null }),
      listTemplates: async (params) => {
        calls.push({ cursor: params?.cursor, connector_id: params?.connector_id });
        if (params?.cursor === "template-cursor-2") {
          return { items: [template("sap-template-b", "sap-web", "SAP template B")], next_cursor: null };
        }
        return { items: [template("sap-template-a", "sap-web", "SAP template A")], next_cursor: "template-cursor-2" };
      },
    }));

    expect((await screen.findAllByText("SAP Web / ERP Portal")).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.connector_id === undefined)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "템플릿 보기" }));

    expect(await screen.findByText("SAP template A")).toBeInTheDocument();
    expect(within(screen.getByLabelText("카탈로그 요약")).getByText("1+")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));

    expect(await screen.findByText("SAP template B")).toBeInTheDocument();
    expect(calls.some((call) => call.cursor === "template-cursor-2" && call.connector_id === "sap-web")).toBe(true);
  });
});
