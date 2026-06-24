import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, test, beforeEach, vi } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import { ApiError, type ScenarioGenerationResult } from "../src/api/types";
import { fakeClient } from "./fake-client";

const CORRECTION_BUTTON_NAME = "보정값으로 실행";

function installObjectUrlMock(): void {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:test-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
}

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

function openDeveloperDetails(): void {
  fireEvent.click(screen.getByText(/^고급 설정 \(이름/));
  fireEvent.click(screen.getByText(/운영자 세부값/));
}

describe("PromptScenarioGenerator correction run", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem(
      "rpa.token",
      jwt(["viewer", "operator", "reviewer", "approver", "admin"]),
    );
  });

  test("generate model_required recovery lands on runTrace artifacts with evidence counts", async () => {
    installObjectUrlMock();
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
      [];
    const policyChecks: string[] = [];
    const blobCalls: string[] = [];
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        getGatewayPolicy: async (model) => {
          policyChecks.push(model ?? "");
          if (model !== "gpt-4o-mini") {
            throw new ApiError(404, "RESOURCE_NOT_FOUND", {
              code: "RESOURCE_NOT_FOUND",
            });
          }
          return {
            model,
            version: 1,
            capabilities: { jsonMode: true },
            budget: { maxInputTokens: 1000 },
          };
        },
        getScenarioGenerationCapabilities: async () => ({
          planner: {
            default_planner: "deterministic_mvp",
            available: ["deterministic_mvp", "llm_v1"],
          },
          visual_evidence: {
            screenshot: {
              enabled: true,
              policies: ["never", "failure", "each_step"],
              default_policy: "each_step",
            },
            video: {
              enabled: true,
              policies: ["never", "failure", "always"],
              default_policy: "always",
              artifact_type: "video_masked",
              media_type: "video/webm",
            },
          },
        }),
        generateScenario: async (body) => {
          generateCalls.push(body);
          if (generateCalls.length === 1) {
            throw new ApiError(422, "IR_SCHEMA_INVALID", {
              code: "IR_SCHEMA_INVALID",
              details: { reason: "model_required", available: 2 },
            });
          }
          return {
            generation_id: "00000000-0000-0000-0000-0000000000b7",
            mode: body.mode ?? "save_and_run",
            status: "run_queued",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: "00000000-0000-0000-0000-000000000099",
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
            blockers: [],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
        getScenarioGeneration: async (id) => ({
          generation_id: id,
          mode: "save_and_run",
          status: "run_queued",
          prompt_hash: "hash",
          planner: "deterministic_mvp",
          model: "gpt-4o-mini",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          run_id: "00000000-0000-0000-0000-000000000099",
          evidence_policy: { screenshot: "each_step", video: "always" },
          blockers: [],
          created_at: "2026-06-15T00:00:00.000Z",
          created_by: "operator",
          draft_ir: {},
          validation_report: {},
        }),
        listScenarioGenerationArtifacts: async () => ({
          items: [
            {
              artifact_id: "91000000-0000-0000-0000-000000000101",
              type: "screen_capture",
              media_type: "image/png",
              filename: "generation.png",
              byte_size: 512,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-15T00:00:01.000Z",
            },
            {
              artifact_id: "91000000-0000-0000-0000-000000000102",
              type: "video_masked",
              media_type: "video/webm",
              filename: "generation.webm",
              byte_size: 4096,
              duration_ms: 1200,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-15T00:00:02.000Z",
            },
          ],
          next_cursor: null,
        }),
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "92000000-0000-0000-0000-000000000101",
              type: "screen_capture",
              media_type: "image/png",
              filename: "run-step.png",
              byte_size: 1024,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-15T00:00:03.000Z",
            },
            {
              artifact_id: "92000000-0000-0000-0000-000000000102",
              type: "run_video",
              media_type: "video/webm",
              filename: "run.webm",
              byte_size: 4096,
              duration_ms: 1500,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-15T00:00:04.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifactBlob: async (artifactId) => {
          blobCalls.push(artifactId);
          return new Blob([new Uint8Array([1, 2, 3])], {
            type: artifactId.endsWith("102") ? "video/webm" : "image/png",
          });
        },
      }),
    );

    fireEvent.change(await screen.findByLabelText("자연어 요청"), {
      target: { value: "Summarize today's orders" },
    });
    fireEvent.change(screen.getByLabelText("동영상"), {
      target: { value: "always" },
    });
    const submitButton = screen.getByRole("button", { name: "저장 후 실행" });
    fireEvent.click(submitButton);

    await waitFor(() => expect(generateCalls).toHaveLength(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /AI 모델을 지정해야 합니다/,
    );
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("AI 모델"), {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    await waitFor(() => expect(policyChecks).toContain("gpt-4o-mini"));
    expect(await screen.findByText(/확인됨/)).toBeInTheDocument();
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    fireEvent.click(submitButton);

    await waitFor(() => expect(generateCalls).toHaveLength(2));
    expect(generateCalls[1]?.model).toBe("gpt-4o-mini");
    expect(generateCalls[1]?.evidence).toEqual({
      screenshot: "each_step",
      video: "always",
    });
    await waitFor(() =>
      expect(location.hash).toBe(
        "#runTrace?run=00000000-0000-0000-0000-000000000099&generation=00000000-0000-0000-0000-0000000000b7&focus=artifacts",
      ),
    );
    const readout = await screen.findByLabelText("evidence storage");
    expect(readout).toHaveTextContent("요청 이미지: 매 단계");
    expect(readout).toHaveTextContent("요청 동영상: 전체 실행");
    expect(readout).toHaveTextContent("저장 이미지 1");
    expect(readout).toHaveTextContent("저장 동영상 1");
    expect(
      await screen.findByRole("img", { name: "run-step.png" }),
    ).toHaveAttribute("src", "blob:test-preview");
    expect(await screen.findByText("자연어 생성 산출물")).toBeInTheDocument();
    expect(screen.getByText("이미지 1")).toBeInTheDocument();
    expect(screen.getByText("영상 1")).toBeInTheDocument();
    expect(blobCalls).toContain("91000000-0000-0000-0000-000000000101");
    expect(blobCalls).toContain("92000000-0000-0000-0000-000000000101");
  });

  test("blocked generation can run after target and start URL correction", async () => {
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
      [];
    const runCalls: Array<{
      generationId: string;
      body: Parameters<ApiClient["runScenarioGeneration"]>[1];
    }> = [];
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
              default_browser_identity_id:
                "10000000-0000-4000-8000-0000000000a2",
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
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
            blockers: [
              "start_url_required_for_auto_run",
              "target_required_for_auto_run",
            ],
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
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
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

    await waitFor(() =>
      expect(view.container.querySelector("textarea")).not.toBeNull(),
    );
    const promptBox = view.container.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(promptBox, {
      target: { value: "Summarize today's orders" },
    });
    const submitButton = view.container.querySelector(
      ".generator-actions button",
    ) as HTMLButtonElement;
    fireEvent.click(submitButton);
    await waitFor(() => expect(generateCalls).toHaveLength(1));

    const correctionButton = await screen.findByRole("button", {
      name: CORRECTION_BUTTON_NAME,
    });
    expect(correctionButton).toBeDisabled();
    const guide = screen.getByLabelText("실행 전 보정 안내");
    expect(guide).toHaveTextContent("시작 주소");
    expect(guide).toHaveTextContent("실행 대상");
    fireEvent.click(
      within(guide).getByRole("button", { name: "시작 주소 입력" }),
    );
    expect(screen.getByLabelText("시작 주소")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("시작 주소"), {
      target: { value: "https://shop.example/orders" },
    });
    fireEvent.click(within(guide).getByRole("button", { name: "사이트 선택" }));
    expect(screen.getByLabelText("사이트")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("사이트"), {
      target: { value: "10000000-0000-4000-8000-0000000000a1" },
    });
    const targetSummary = screen.getByLabelText("실행 대상 요약");
    expect(targetSummary).toHaveTextContent("기본 로그인 세션 사용");
    expect(targetSummary).toHaveTextContent("사이트 기본 보안 정책 사용");
    expect(targetSummary).not.toHaveTextContent(
      "10000000-0000-4000-8000-0000000000a2",
    );
    expect(targetSummary).not.toHaveTextContent(
      "10000000-0000-4000-8000-0000000000a3",
    );
    openDeveloperDetails();
    expect(screen.getByLabelText("선택된 실행 대상")).toHaveTextContent(
      "shop (https://shop.example)",
    );
    expect(screen.getByLabelText("선택된 실행 대상")).not.toHaveTextContent(
      "10000000-0000-4000-8000-0000000000a2",
    );
    fireEvent.click(screen.getByText("고급/원문 선택값 직접 입력"));
    expect(screen.getByLabelText("로그인 세션 선택값")).toHaveValue(
      "10000000-0000-4000-8000-0000000000a2",
    );
    expect(screen.getByLabelText("보안 정책 선택값")).toHaveValue(
      "10000000-0000-4000-8000-0000000000a3",
    );
    await waitFor(() => expect(correctionButton).not.toBeDisabled());
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

  test("blocked generation can create a site from the recovery guide and queue a correction run", async () => {
    const createdSiteId = "10000000-0000-4000-8000-0000000000d1";
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
      [];
    const createCalls: Array<Parameters<ApiClient["createSite"]>[0]> = [];
    const runCalls: Array<{
      generationId: string;
      body: Parameters<ApiClient["runScenarioGeneration"]>[1];
    }> = [];
    const siteItems = new Map<
      string,
      {
        site_profile_id: string;
        risk: string;
        approval_status: string;
        circuit_status: string;
        name: string;
        url_pattern: string;
        default_browser_identity_id: string | null;
        default_network_policy_id: string | null;
      }
    >();
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({
          items: [...siteItems.values()],
          next_cursor: null,
        }),
        generateScenario: async (body) => {
          generateCalls.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000d3",
            mode: body.mode ?? "save_and_run",
            status: "blocked",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: null,
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
            blockers: [
              "start_url_required_for_auto_run",
              "target_required_for_auto_run",
            ],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
        createSite: async (body) => {
          createCalls.push(body);
          siteItems.set(createdSiteId, {
            site_profile_id: createdSiteId,
            risk: body.risk ?? "green",
            approval_status: "pending",
            circuit_status: "closed",
            name: body.name,
            url_pattern: body.url_pattern,
            default_browser_identity_id: "browser-guided",
            default_network_policy_id: "network-guided",
          });
          return {
            site_profile_id: createdSiteId,
            name: body.name,
            url_pattern: body.url_pattern,
            risk: body.risk ?? "green",
            approved: false,
            default_browser_identity_id: "browser-guided",
            default_network_policy_id: "network-guided",
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
            run_id: "00000000-0000-0000-0000-000000000097",
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
            blockers: [],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
      }),
    );

    fireEvent.change(await screen.findByLabelText("자연어 요청"), {
      target: { value: "새 포털 주문을 실행해줘" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장 후 실행" }));
    await waitFor(() => expect(generateCalls).toHaveLength(1));

    const correctionButton = await screen.findByRole("button", {
      name: CORRECTION_BUTTON_NAME,
    });
    expect(correctionButton).toBeDisabled();
    const guide = screen.getByLabelText("실행 전 보정 안내");
    fireEvent.click(
      within(guide).getByRole("button", { name: "시작 주소 입력" }),
    );
    fireEvent.change(screen.getByLabelText("시작 주소"), {
      target: { value: "https://guided.example/orders" },
    });
    fireEvent.click(
      within(guide).getByRole("button", { name: "새 사이트 등록" }),
    );

    const onboarding = screen.getByText("새 사이트 온보딩").closest("section");
    expect(onboarding).not.toBeNull();
    await waitFor(() =>
      expect(
        within(onboarding as HTMLElement).getByLabelText(
          "사이트 주소",
        ),
      ).toHaveValue("https://guided.example"),
    );
    fireEvent.change(within(onboarding as HTMLElement).getByLabelText("이름"), {
      target: { value: "guided shop" },
    });
    fireEvent.click(
      within(onboarding as HTMLElement).getByRole("button", { name: "등록" }),
    );

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({
      name: "guided shop",
      url_pattern: "https://guided.example",
      risk: "green",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("사이트")).toHaveValue(createdSiteId),
    );
    expect(screen.getByLabelText("실행 대상 요약")).toHaveTextContent(
      "기본 로그인 세션 사용",
    );
    expect(screen.getByLabelText("실행 대상 요약")).toHaveTextContent(
      "사이트 기본 보안 정책 사용",
    );

    await waitFor(() => expect(correctionButton).not.toBeDisabled());
    fireEvent.click(correctionButton);

    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toEqual({
      generationId: "00000000-0000-0000-0000-0000000000d3",
      body: {
        start_url: "https://guided.example/orders",
        target: {
          site_profile_id: createdSiteId,
          browser_identity_id: "browser-guided",
          network_policy_id: "network-guided",
        },
        evidence: { screenshot: "each_step", video: "never" },
      },
    });
    await waitFor(() =>
      expect(location.hash).toBe(
        "#runTrace?run=00000000-0000-0000-0000-000000000097&generation=00000000-0000-0000-0000-0000000000d3&focus=artifacts",
      ),
    );
  });

  test("history selection carries model, evidence, and params into correction run", async () => {
    const runCalls: Array<{
      generationId: string;
      body: Parameters<ApiClient["runScenarioGeneration"]>[1];
    }> = [];
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
      params_context: {
        entry_url: "https://context.example/orders",
        max_pages: 7,
      },
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
            entry_url: {
              type: "string",
              default: "https://schema-default.example",
            },
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
        listScenarioGenerations: async () => ({
          items: [selectedGeneration],
          next_cursor: null,
        }),
        runScenarioGeneration: async (generationId, body) => {
          runCalls.push({ generationId, body });
          return {
            ...selectedGeneration,
            generation_id: generationId,
            status: "run_queued",
            model: body.model ?? null,
            run_id: "00000000-0000-0000-0000-000000000098",
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
            blockers: [],
          };
        },
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "검토 사유·산출물 보기" }),
    );
    expect(await screen.findByLabelText("접속 주소 (시작 주소)")).toHaveValue(
      "https://context.example/orders",
    );
    fireEvent.change(screen.getByLabelText("최대 페이지 수"), {
      target: { value: "9" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME }),
    );

    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toEqual({
      generationId: "00000000-0000-0000-0000-0000000000b5",
      body: {
        start_url: "https://shop.example/orders",
        params: { entry_url: "https://context.example/orders", max_pages: 9 },
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

  test("redacted params blocker requires re-entry before correction run", async () => {
    const runCalls: Array<{
      generationId: string;
      body: Parameters<ApiClient["runScenarioGeneration"]>[1];
    }> = [];
    const selectedGeneration: ScenarioGenerationResult = {
      generation_id: "00000000-0000-0000-0000-0000000000b7",
      mode: "save_and_run",
      status: "blocked",
      prompt_hash: "hash",
      planner: "deterministic_mvp",
      model: null,
      scenario_id: "00000000-0000-0000-0000-0000000000c1",
      scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
      run_id: null,
      evidence_policy: { screenshot: "failure", video: "never" },
      blockers: ["params_context_redacted_value_required"],
      created_at: "2026-06-15T00:00:00.000Z",
      created_by: "operator",
      draft_ir: {},
      validation_report: {},
    };
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listScenarioGenerations: async () => ({
          items: [selectedGeneration],
          next_cursor: null,
        }),
        runScenarioGeneration: async (generationId, body) => {
          runCalls.push({ generationId, body });
          return {
            ...selectedGeneration,
            generation_id: generationId,
            status: "run_queued",
            run_id: "00000000-0000-0000-0000-000000000099",
            blockers: [],
          };
        },
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "검토 사유·산출물 보기" }),
    );
    expect(
      await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "입력값 수정" }));
    fireEvent.change(await screen.findByLabelText("고급/원문 입력값"), {
      target: { value: '{"entry_url":"https://secure.example/orders"}' },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: CORRECTION_BUTTON_NAME }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: CORRECTION_BUTTON_NAME }),
    );

    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toEqual({
      generationId: "00000000-0000-0000-0000-0000000000b7",
      body: {
        params: { entry_url: "https://secure.example/orders" },
        evidence: { screenshot: "failure", video: "never" },
      },
    });
  });

  test.each([
    ["malformed", "{"],
    ["array", "[]"],
    ["scalar", '"entry_url"'],
  ])(
    "invalid execution variables block generate request: %s",
    async (_caseName, paramsInput) => {
      const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
        [];
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

      fireEvent.change(await screen.findByLabelText("자연어 요청"), {
        target: { value: "Summarize today's orders" },
      });
      openDeveloperDetails();
      fireEvent.click(screen.getByText("고급/원문 입력값 보기"));
      fireEvent.change(screen.getByLabelText("고급/원문 입력값"), {
        target: { value: paramsInput },
      });
      fireEvent.click(screen.getByRole("button", { name: "저장 후 실행" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(/실행 입력값/),
      );
      expect(generateCalls).toHaveLength(0);
    },
  );

  test("invalid execution variables block correction run request", async () => {
    const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
      [];
    const runCalls: Array<{
      generationId: string;
      body: Parameters<ApiClient["runScenarioGeneration"]>[1];
    }> = [];
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
            evidence_policy: body.evidence ?? {
              screenshot: "each_step",
              video: "never",
            },
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

    fireEvent.change(await screen.findByLabelText("자연어 요청"), {
      target: { value: "Summarize today's orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장 후 실행" }));
    await waitFor(() => expect(generateCalls).toHaveLength(1));

    openDeveloperDetails();
    fireEvent.click(screen.getByText("고급/원문 입력값 보기"));
    fireEvent.change(screen.getByLabelText("고급/원문 입력값"), {
      target: { value: "42" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/실행 입력값/),
    );
    expect(runCalls).toHaveLength(0);
  });

  test.each([
    ["side_effect_prompt_requires_review"],
    ["pagination_page_limit_exceeded"],
  ])(
    "non-repairable blocker %s does not expose correction run",
    async (blocker) => {
      const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
        [];
      const runCalls: Array<{
        generationId: string;
        body: Parameters<ApiClient["runScenarioGeneration"]>[1];
      }> = [];
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
              evidence_policy: body.evidence ?? {
                screenshot: "each_step",
                video: "never",
              },
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

      await waitFor(() =>
        expect(view.container.querySelector("textarea")).not.toBeNull(),
      );
      const promptBox = view.container.querySelector(
        "textarea",
      ) as HTMLTextAreaElement;
      fireEvent.change(promptBox, {
        target: { value: "Post a refund for today's orders" },
      });
      const submitButton = view.container.querySelector(
        ".generator-actions button",
      ) as HTMLButtonElement;
      fireEvent.click(submitButton);

      await waitFor(() => expect(generateCalls).toHaveLength(1));
      expect(
        screen.queryByRole("button", { name: CORRECTION_BUTTON_NAME }),
      ).toBeNull();
      expect(runCalls).toHaveLength(0);
    },
  );

  test("failed generation history surfaces Korean blocker labels (no raw codes)", async () => {
    location.hash = "#scenarioStudio";
    const failedGeneration: ScenarioGenerationResult = {
      generation_id: "00000000-0000-0000-0000-0000000000f1",
      mode: "save_and_run",
      status: "failed",
      prompt_hash: "hash",
      planner: "deterministic_mvp",
      model: null,
      scenario_id: null,
      scenario_version_id: null,
      run_id: null,
      evidence_policy: { screenshot: "each_step", video: "never" },
      blockers: [
        "scenario_generation_failed",
        "compile_failed",
        "IR_EXPRESSION_COMPILE_ERROR",
        "weird_internal_reason",
      ],
      created_at: "2026-06-15T00:00:00.000Z",
      created_by: "operator",
      draft_ir: {},
      validation_report: {},
    };
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listScenarioGenerations: async () => ({
          items: [failedGeneration],
          next_cursor: null,
        }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "검토 사유 보기" }));

    const blockerList = (
      await screen.findByText(
        "자동화 생성에 실패했습니다. 검토 사유를 확인해 주세요.",
      )
    ).closest("ul") as HTMLElement;
    expect(blockerList).not.toBeNull();
    const items = within(blockerList)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual([
      "자동화 생성에 실패했습니다. 검토 사유를 확인해 주세요.",
      "자동 생성한 자동화 정의를 검증하지 못했습니다. 운영자 검토가 필요합니다.",
      "조건식 오류.",
      "자동 생성에 실패했습니다. 검토 사유를 확인해 주세요.",
    ]);
    for (const raw of [
      "scenario_generation_failed",
      "compile_failed",
      "IR_EXPRESSION_COMPILE_ERROR",
      "weird_internal_reason",
    ]) {
      expect(within(blockerList).queryByText(raw)).toBeNull();
    }
  });

  test.each([
    [
      "site_profile_unresolved_for_start_url",
      "이 시작 주소와 매칭되는 사이트가 없습니다. 사이트를 새로 등록하세요.",
    ],
    [
      "site_profile_ambiguous_for_start_url",
      "이 시작 주소와 매칭되는 사이트가 여러 개입니다. 실행 대상을 직접 선택하세요.",
    ],
    [
      "browser_identity_unresolved_for_start_url",
      "이 사이트에 사용할 로그인 세션이 없습니다. 사이트를 등록하면 함께 생성됩니다.",
    ],
    [
      "network_policy_unresolved_for_start_url",
      "이 시작 주소를 허용하는 보안 정책이 없습니다. 사이트를 등록하면 함께 생성됩니다.",
    ],
    [
      "network_policy_ambiguous_for_start_url",
      "이 시작 주소를 허용하는 보안 정책이 여러 개입니다. 실행 대상을 직접 선택하세요.",
    ],
  ])(
    "inference blocker %s is repairable and shows Korean label (emit-both)",
    async (blocker, label) => {
      const generateCalls: Array<Parameters<ApiClient["generateScenario"]>[0]> =
        [];
      const view = renderApp(
        fakeClient({
          listScenarios: async () => ({ items: [], next_cursor: null }),
          generateScenario: async (body) => {
            generateCalls.push(body);
            return {
              generation_id: "00000000-0000-0000-0000-0000000000b5",
              mode: body.mode ?? "save_and_run",
              status: "blocked",
              prompt_hash: "hash",
              planner: body.planner ?? "deterministic_mvp",
              model: body.model ?? null,
              scenario_id: "00000000-0000-0000-0000-0000000000c1",
              scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
              run_id: null,
              evidence_policy: body.evidence ?? {
                screenshot: "each_step",
                video: "never",
              },
              // emit-both: 백엔드가 generic target_required 와 함께 구체 추론 사유를 방출한다.
              blockers: ["target_required_for_auto_run", blocker],
              created_at: "2026-06-15T00:00:00.000Z",
              created_by: "operator",
              draft_ir: {},
              validation_report: {},
            };
          },
        }),
      );
      location.hash = "#scenarioStudio";

      await waitFor(() =>
        expect(view.container.querySelector("textarea")).not.toBeNull(),
      );
      const promptBox = view.container.querySelector(
        "textarea",
      ) as HTMLTextAreaElement;
      fireEvent.change(promptBox, {
        target: { value: "https://shop.example/orders 에서 주문을 수집해줘" },
      });
      const submitButton = view.container.querySelector(
        ".generator-actions button",
      ) as HTMLButtonElement;
      fireEvent.click(submitButton);
      await waitFor(() => expect(generateCalls).toHaveLength(1));

      // 회귀 가드: fine-grained 코드가 RUN_REPAIRABLE 에 포함되어 emit-both 에서도 복구 흐름이 유지된다.
      expect(
        await screen.findByRole("button", { name: CORRECTION_BUTTON_NAME }),
      ).toBeDisabled();
      expect(
        screen.getByLabelText("실행 전 보정 안내"),
      ).not.toBeNull();
      // 구체 한국어 라벨 표시, raw 영문 코드 누출 없음.
      expect(screen.getByText(label)).not.toBeNull();
      expect(screen.queryByText(blocker)).toBeNull();
    },
  );
});
