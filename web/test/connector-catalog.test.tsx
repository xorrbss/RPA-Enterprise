import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { ConnectorCatalogItem, TemplateCatalogItem } from "../src/api/types";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(client: ApiClient = fakeClient()): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
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

  test("lists connector and template metadata without secret values", async () => {
    renderApp();

    expect((await screen.findAllByText("SAP Web / ERP Portal")).length).toBeGreaterThan(0);
    expect(await screen.findByText("SAP list extract")).toBeInTheDocument();
    expect(screen.getByText("브라우저 템플릿 팩")).toBeInTheDocument();
    const apiTemplateRow = (await screen.findByText("HTTP status check")).closest("tr") as HTMLTableRowElement;
    expect(within(apiTemplateRow).getByRole("button", { name: "관리자 활성화 필요" })).toBeDisabled();
    expect(within(apiTemplateRow).getByText("관리자 활성화 후 초안을 만들 수 있습니다.")).toBeInTheDocument();
    const documentRow = (await screen.findByText("Document IDP (Browser Artifacts)")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(documentRow).getByRole("button"));
    expect(await screen.findByText(/내장 문서 추출 후보/)).toBeInTheDocument();
    expect(screen.getAllByText("보안 연결 1개").length).toBeGreaterThan(0);
    expect(screen.queryByText("secret://sites/sap-web/session")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/secret:\/\//)).not.toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
    expect(screen.queryByText("password")).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByDisplayValue(/"company_code": "1000"/)).toBeInTheDocument());
    expect(screen.queryByText("승인된 API 프로필")).not.toBeInTheDocument();
    expect(screen.queryByText("응답 스키마")).not.toBeInTheDocument();
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
    expect(params).toContain('"송장번호": "텍스트"');
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
