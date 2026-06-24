import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

describe("security connections panel", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("커넥터·템플릿·웹훅의 SecretRef를 보안 연결 현황으로 집계한다", async () => {
    renderApp(fakeClient({
      listRunTriggers: async () => ({
        items: [{
          trigger_id: "trg-webhook-001",
          scenario_version_id: "scenario-version-1",
          trigger_type: "webhook",
          status: "enabled",
          cron_expression: null,
          timezone: null,
          webhook_secret_ref: "prod/run-triggers/month-end",
          params: {},
          catchup_policy: "skip_missed",
          max_concurrent_runs: 1,
          next_fire_at: null,
          created_by: "operator-a",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:00.000Z",
        }],
        next_cursor: null,
      }),
    }));

    expect(await screen.findByRole("heading", { name: "보안 연결 사용 현황" })).toBeInTheDocument();
    expect(await screen.findByText("SAP Web 로그인 세션")).toBeInTheDocument();
    expect(screen.getByText("HTTP API 보안 연결")).toBeInTheDocument();
    expect(screen.getByText("외부 이벤트 서명 키")).toBeInTheDocument();
    expect(screen.getByText("외부 이벤트 서명 검증")).toBeInTheDocument();
    expect(screen.getByText("운영 사용 중")).toBeInTheDocument();
    expect(screen.getAllByText("템플릿 요구").length).toBeGreaterThan(0);
  });
});
