import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
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
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("Scenario studio pagination", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("scenario list follows next_cursor instead of showing only the first page", async () => {
    const calls: Array<{ cursor?: string; limit?: number }> = [];
    renderApp(
      fakeClient({
        listScenarios: async (params) => {
          calls.push(params ?? {});
          if (params?.cursor === "scenario-cursor-2") {
            return {
              items: [{ scenario_id: "sc-page-2", name: "second page scenario", version: 1, latest_version_id: "ver-page-2" }],
              next_cursor: null,
            };
          }
          return {
            items: [{ scenario_id: "sc-page-1", name: "first page scenario", version: 1, latest_version_id: "ver-page-1" }],
            next_cursor: "scenario-cursor-2",
          };
        },
      }),
    );
    location.hash = "#scenarioStudio";

    expect(await screen.findByText("first page scenario")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다음" }));

    await waitFor(() => expect(calls.some((c) => c.cursor === "scenario-cursor-2")).toBe(true));
    expect(await screen.findByText("second page scenario")).toBeInTheDocument();
  });

  test("자동화 목록이 식별값(scenario_id)을 노출한다 — 자동화 검사 화면이 가리키는 출처", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-7e3f0011", name: "주문 수집", version: 1, latest_version_id: "ver-1" }],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#scenarioStudio";

    const idCell = await screen.findByText("sc-7e3f0011");
    expect(idCell.tagName).toBe("CODE"); // 선택·복사 가능한 식별값
  });

  test("version history shows governance stage and sends opaque evidence ref", async () => {
    const calls: Array<{ version: number; body: Parameters<ApiClient["setScenarioVersionGovernanceStage"]>[2] }> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-governance", name: "governed scenario", version: 2, latest_version_id: "ver-2" }],
          next_cursor: null,
        }),
        listScenarioVersions: async () => ({
          items: [
            {
              version_id: "ver-2",
              version: 2,
              promotion_status: "draft",
              certification: {
                status: "uncertified",
                governance_stage: "pilot",
                governance_reason: "pilot cohort ready",
                governance_evidence_ref: "ticket:GOV-122",
                governance_metadata: null,
                governance_updated_by: "reviewer-a",
                governance_updated_at: "2026-06-24T00:00:00.000Z",
                certified_by: null,
                certified_at: null,
                expires_at: null,
                reason: null,
                revoked_by: null,
                revoked_at: null,
                revoke_reason: null,
                valid_for_prod: false,
              },
              created_at: "2026-06-24T00:00:00.000Z",
              promoted_at: null,
            },
          ],
          next_cursor: null,
        }),
        setScenarioVersionGovernanceStage: async (_scenarioId, version, body) => {
          calls.push({ version, body });
          return {
            version_id: "ver-2",
            version,
            promotion_status: "draft",
            certification: {
              status: "revoked",
              governance_stage: body.stage,
              governance_reason: body.reason,
              governance_evidence_ref: body.evidence_ref,
              governance_metadata: body.metadata ?? null,
              governance_updated_by: "operator-a",
              governance_updated_at: "2026-06-25T00:00:00.000Z",
              certified_by: null,
              certified_at: null,
              expires_at: null,
              reason: null,
              revoked_by: "operator-a",
              revoked_at: "2026-06-25T00:00:00.000Z",
              revoke_reason: body.reason,
              valid_for_prod: false,
            },
            created_at: "2026-06-24T00:00:00.000Z",
            promoted_at: null,
          };
        },
      }),
    );
    location.hash = "#scenarioStudio";

    expect(await screen.findByText("governed scenario")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이력" }));

    expect(await screen.findByText("파일럿 운영", { selector: "span.badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "사용 중단 표시" }));
    expect(screen.getByPlaceholderText("예: 결재 GOV-123 또는 감사 문서 링크")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("변경 사유"), { target: { value: "retire pilot" } });
    fireEvent.change(screen.getByLabelText("근거 링크/문서"), { target: { value: "ticket:GOV-123" } });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      version: 2,
      body: { stage: "deprecated", reason: "retire pilot", evidence_ref: "ticket:GOV-123" },
    });
  });
});
