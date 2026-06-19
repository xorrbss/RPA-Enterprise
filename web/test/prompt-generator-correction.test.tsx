import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, beforeEach } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type { ScenarioGenerationResult } from "../src/api/types";
import { fakeClient } from "./fake-client";

const CORRECTION_BUTTON_NAME = "보정값으로 실행";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(client: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("PromptScenarioGenerator correction run", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  test("blocked generation can run after target and start URL correction", async () => {
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    const runCalls: Array<{ generationId: string; body: Parameters<ApiClient["runScenarioGeneration"]>[1] }> = [];
    const view = renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({
          items: [
            {
              site_profile_id: "10000000-0000-4000-8000-0000000000a1",
              risk: "green",
              approval_status: "approved",
              circuit_status: "closed",
              name: "shop",
              url_pattern: "https://shop.example",
              default_browser_identity_id: "10000000-0000-4000-8000-0000000000a2",
              default_network_policy_id: "10000000-0000-4000-8000-0000000000a3",
            },
          ],
          next_cursor: null,
        }),
        generateScenario: async (body) => {
          generateCalls.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000b3",
            mode: body.mode ?? "save_and_run",
            status: "blocked",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: null,
            evidence_policy: body.evidence ?? { screenshot: "each_step", video: "never" },
            blockers: ["start_url_required_for_auto_run", "target_required_for_auto_run"],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
        runScenarioGeneration: async (generationId, body) => {
          runCalls.push({ generationId, body });
          return {
            generation_id: generationId,
            mode: "save_and_run",
            status: "run_queued",
            prompt_hash: "hash",
            planner: "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: "00000000-0000-0000-0000-000000000099",
            evidence_policy: body.evidence ?? { screenshot: "each_step", video: "never" },
            blockers: [],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
      }),
    );
    location.hash = "#scenarioStudio";

    await waitFor(() => expect(view.container.querySelector("textarea")).not.toBeNull());
    const promptBox = view.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(promptBox, { target: { value: "Summarize today's orders" } });
    const submitButton = view.container.querySelector(".generator-actions button") as HTMLButtonElement;
    fireEvent.click(submitButton);
    await waitFor(() => expect(generateCalls).toHaveLength(1));

    const correctionButton = await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME });
    const inputs = view.container.querySelectorAll("input");
    const selects = view.container.querySelectorAll("select");
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "https://shop.example/orders" } });
    fireEvent.change(selects[2] as HTMLSelectElement, { target: { value: "10000000-0000-4000-8000-0000000000a1" } });
    fireEvent.click(correctionButton);

    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toEqual({
      generationId: "00000000-0000-0000-0000-0000000000b3",
      body: {
        start_url: "https://shop.example/orders",
        target: {
          site_profile_id: "10000000-0000-4000-8000-0000000000a1",
          browser_identity_id: "10000000-0000-4000-8000-0000000000a2",
          network_policy_id: "10000000-0000-4000-8000-0000000000a3",
        },
        evidence: { screenshot: "each_step", video: "never" },
      },
    });
    await waitFor(() =>
      expect(location.hash).toBe(
        "#runTrace?run=00000000-0000-0000-0000-000000000099&generation=00000000-0000-0000-0000-0000000000b3&focus=artifacts",
      ),
    );
  });

  test("history selection carries model, evidence, and params into correction run", async () => {
    const runCalls: Array<{ generationId: string; body: Parameters<ApiClient["runScenarioGeneration"]>[1] }> = [];
    const selectedGeneration: ScenarioGenerationResult = {
      generation_id: "00000000-0000-0000-0000-0000000000b5",
      mode: "save_and_run",
      status: "blocked",
      prompt_hash: "hash",
      planner: "deterministic_mvp",
      model: "gpt-4.1-mini",
      scenario_id: "00000000-0000-0000-0000-0000000000c1",
      scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
      run_id: null,
      evidence_policy: { screenshot: "failure", video: "never" },
      blockers: ["start_url_required_for_auto_run"],
      params_context: { entry_url: "https://context.example/orders", max_pages: 7 },
      created_at: "2026-06-15T00:00:00.000Z",
      created_by: "operator",
      draft_ir: {
        start_url: "https://shop.example/orders",
        target: {
          site_profile_id: "10000000-0000-4000-8000-0000000000a1",
          browser_identity_id: "10000000-0000-4000-8000-0000000000a2",
          network_policy_id: "10000000-0000-4000-8000-0000000000a3",
        },
        params: { entry_url: "https://shop.example/orders", max_pages: 3 },
        params_schema: {
          type: "object",
          properties: {
            entry_url: { type: "string", default: "https://schema-default.example" },
            max_pages: { type: "number", default: 1 },
          },
        },
      },
      validation_report: {},
    };
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listScenarioGenerations: async () => ({ items: [selectedGeneration], next_cursor: null }),
        runScenarioGeneration: async (generationId, body) => {
          runCalls.push({ generationId, body });
          return {
            ...selectedGeneration,
            generation_id: generationId,
            status: "run_queued",
            model: body.model ?? null,
            run_id: "00000000-0000-0000-0000-000000000098",
            evidence_policy: body.evidence ?? { screenshot: "each_step", video: "never" },
            blockers: [],
          };
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "진단·산출물 보기" }));
    fireEvent.click(await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME }));

    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toEqual({
      generationId: "00000000-0000-0000-0000-0000000000b5",
      body: {
        start_url: "https://shop.example/orders",
        params: { entry_url: "https://context.example/orders", max_pages: 7 },
        target: {
          site_profile_id: "10000000-0000-4000-8000-0000000000a1",
          browser_identity_id: "10000000-0000-4000-8000-0000000000a2",
          network_policy_id: "10000000-0000-4000-8000-0000000000a3",
        },
        model: "gpt-4.1-mini",
        evidence: { screenshot: "failure", video: "never" },
      },
    });
  });

  test.each([
    ["malformed", "{"],
    ["array", "[]"],
    ["scalar", "\"entry_url\""],
  ])("invalid params JSON blocks generate request: %s", async (_caseName, paramsInput) => {
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        generateScenario: async (body) => {
          generateCalls.push(body);
          throw new Error("invalid params must not call /generate");
        },
      }),
    );

    fireEvent.change(await screen.findByLabelText("자연어 요청"), { target: { value: "Summarize today's orders" } });
    fireEvent.change(screen.getByLabelText("생성/실행 params JSON"), { target: { value: paramsInput } });
    fireEvent.click(screen.getByRole("button", { name: "저장 후 실행" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/params JSON/));
    expect(generateCalls).toHaveLength(0);
  });

  test("invalid params JSON blocks correction run request", async () => {
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    const runCalls: Array<{ generationId: string; body: Parameters<ApiClient["runScenarioGeneration"]>[1] }> = [];
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        generateScenario: async (body) => {
          generateCalls.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000b6",
            mode: body.mode ?? "save_and_run",
            status: "saved",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: null,
            evidence_policy: body.evidence ?? { screenshot: "each_step", video: "never" },
            blockers: [],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
        runScenarioGeneration: async (generationId, body) => {
          runCalls.push({ generationId, body });
          throw new Error("invalid params must not call /run");
        },
      }),
    );

    fireEvent.change(await screen.findByLabelText("자연어 요청"), { target: { value: "Summarize today's orders" } });
    fireEvent.click(screen.getByRole("button", { name: "저장 후 실행" }));
    await waitFor(() => expect(generateCalls).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("생성/실행 params JSON"), { target: { value: "42" } });
    fireEvent.click(await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/params JSON/));
    expect(runCalls).toHaveLength(0);
  });

  test.each([
    ["side_effect_prompt_requires_review"],
    ["pagination_page_limit_exceeded"],
  ])("non-repairable blocker %s does not expose correction run", async (blocker) => {
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    const runCalls: Array<{ generationId: string; body: Parameters<ApiClient["runScenarioGeneration"]>[1] }> = [];
    const view = renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        generateScenario: async (body) => {
          generateCalls.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000b4",
            mode: body.mode ?? "save_and_run",
            status: "blocked",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: null,
            evidence_policy: body.evidence ?? { screenshot: "each_step", video: "never" },
            blockers: [blocker],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
        runScenarioGeneration: async (generationId, body) => {
          runCalls.push({ generationId, body });
          throw new Error("non-repairable blocker must not call /run");
        },
      }),
    );
    location.hash = "#scenarioStudio";

    await waitFor(() => expect(view.container.querySelector("textarea")).not.toBeNull());
    const promptBox = view.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(promptBox, { target: { value: "Post a refund for today's orders" } });
    const submitButton = view.container.querySelector(".generator-actions button") as HTMLButtonElement;
    fireEvent.click(submitButton);

    await waitFor(() => expect(generateCalls).toHaveLength(1));
    expect(screen.queryByRole("button", { name: CORRECTION_BUTTON_NAME })).toBeNull();
    expect(runCalls).toHaveLength(0);
  });
});
