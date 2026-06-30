import { beforeEach, describe, expect, test } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type {
  BrowserRecordingAppendEvent,
  BrowserRecordingEvent,
} from "../src/api/types";
import { fakeClient } from "./fake-client";

function tokenWithRoles(roles: string[]): string {
  const payload = btoa(
    JSON.stringify({ sub: "11111111-0000-4000-8000-000000000001", roles }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

async function startRecordingAndFindActionSelect(): Promise<HTMLElement> {
  const startButton = await screen.findByRole("button", { name: "녹화 시작" });
  await waitFor(() => expect(startButton).toBeEnabled());
  fireEvent.click(startButton);
  const workbench = await screen.findByRole(
    "region",
    { name: "브라우저 녹화 동작 추가" },
    { timeout: 5000 },
  );
  return within(workbench).findByLabelText("녹화 동작", undefined, { timeout: 5000 });
}

function recordingLifecycleFields(
  recordingId: string,
  reviewStatus: "not_started" | "ready_for_studio",
  eventCount = 0,
) {
  return {
    review_status: reviewStatus,
    review_report: reviewStatus === "ready_for_studio"
      ? {
          review_status: "ready_for_studio" as const,
          blockers: [],
          selector_confidence: [
            {
              event_seq: 1,
              node_id: "step_01",
              label: "승인 버튼",
              selector: "button.approve",
              element_key: "ApproveButton",
              source: "object_repository" as const,
              confidence: "high" as const,
              reason_code: "object_repository_stable",
              candidates: [
                { element_key: "ApproveButton", label: "승인 버튼", selector: "button.approve", confidence: "high" as const },
              ],
            },
          ],
          repair_suggestions: [],
          object_repo_changeset: [],
          evidence: { recording_session_id: recordingId, validation_stage_count: 4, event_count: eventCount },
        }
      : null,
    promoted_scenario_id: null,
    promoted_scenario_version: null,
    promoted_studio_project_id: null,
    promoted_studio_graph_version: null,
  };
}

describe("browser recorder panel", () => {
  beforeEach(() => {
    location.hash = "#scenarioStudio";
    localStorage.setItem("rpa.token", tokenWithRoles(["admin"]));
  });

  test("starts a browser recording, appends an event, and shows the automation summary", async () => {
    const appended: BrowserRecordingAppendEvent[] = [];
    let startedName = "";
    let startedUrl = "";
    let completedRecordingId = "";
    let promotedRecordingId = "";
    const events: BrowserRecordingEvent[] = [];
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com/invoices",
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
      listBrowserRecordings: async () => ({ items: [], next_cursor: null }),
      listSiteElements: async () => ({
        items: [
          {
            element_id: "93000000-0000-4000-8000-000000000001",
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            element_key: "ApproveButton",
            label: "승인 버튼",
            selector: "button.approve",
            element_type: "button",
            stability: "stable",
            confidence: "high",
            source: "manual",
            sample_url: "https://portal.example.com/invoices",
            last_probe_result: {},
            notes: null,
            usage_count: 2,
            last_verified_at: null,
            updated_by: "operator",
            created_at: "2026-06-23T00:00:00.000Z",
            updated_at: "2026-06-23T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      }),
      startBrowserRecording: async (siteId, body) => {
        startedName = body.name;
        startedUrl = body.start_url ?? "";
        return {
          recording_session_id: "94000000-0000-4000-8000-000000000001",
          site_profile_id: siteId,
          name: body.name,
          start_url: body.start_url ?? "https://portal.example.com",
          status: "recording",
          event_count: 0,
          draft_ir: null,
          validation_report: null,
          ...recordingLifecycleFields("94000000-0000-4000-8000-000000000001", "not_started"),
          updated_by: "operator",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:00.000Z",
        };
      },
      listBrowserRecordingEvents: async () => ({
        items: events,
        next_cursor: null,
      }),
      appendBrowserRecordingEvents: async (_siteId, recordingId, body) => {
        appended.push(...body.events);
        for (const event of body.events) {
          const seq = events.length + 1;
          events.push({
            event_id: `95000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
            recording_session_id: recordingId,
            seq,
            event_type: event.event_type,
            selector: event.selector ?? null,
            element_key: event.element_key ?? null,
            label: event.label ?? null,
            url: event.url ?? null,
            value_preview: event.value_preview ?? null,
            captured_at: "2026-06-23T00:00:01.000Z",
            created_at: "2026-06-23T00:00:01.000Z",
          });
        }
        return {
          recording_session_id: recordingId,
          appended: body.events.length,
          event_count: events.length,
        };
      },
      completeBrowserRecording: async (siteId, recordingId) => {
        completedRecordingId = recordingId;
        return {
          recording_session_id: recordingId,
          site_profile_id: siteId,
          name: "협력사 송장 상태 확인",
          start_url: "https://portal.example.com",
          status: "completed",
          event_count: events.length,
          draft_ir: {
            meta: {
              name: "협력사 송장 상태 확인",
              version: 1,
              studio_mode: "easy",
            },
            start: "step_01",
            nodes: {
              step_01: {
                what: [{
                  action: "act",
                  instruction: "승인 버튼 클릭",
                  args: { click_selector: "button.approve" },
                }],
                next: "done",
              },
              done: { terminal: "success" },
            },
          },
          validation_report: {
            errors: [],
            warnings: [],
            stages: [
              { stage: "well_formed", status: "pass", reason_code: "canonical_ir_compile_passed", detail: "compile ok" },
              { stage: "runnable", status: "not_run", reason_code: "runtime_readiness_not_run", detail: "probes not run" },
              { stage: "operable", status: "not_run", reason_code: "ops_readiness_not_run", detail: "ops not run" },
              { stage: "prod_ready", status: "not_run", reason_code: "release_gate_not_run", detail: "release not run" },
            ],
          },
          ...recordingLifecycleFields(recordingId, "ready_for_studio", events.length),
          updated_by: "operator",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:02.000Z",
        };
      },
      promoteRecordingToStudio: async (siteId, recordingId) => {
        promotedRecordingId = recordingId;
        return {
          scenario_id: "96000000-0000-4000-8000-000000000001",
          recording_session_id: recordingId,
          site_profile_id: siteId,
          studio_project_id: "97000000-0000-4000-8000-000000000001",
          studio_graph_version_id: "97000000-0000-4000-8000-000000000101",
          studio_graph_version: 1,
          version: 1,
          promotion_status: "draft",
          review_status: "promoted_to_studio",
        };
      },
    });
    renderApp(client);

    expect(
      await screen.findByText("브라우저 녹화로 만들기"),
    ).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("녹화 이름"), {
      target: { value: "협력사 송장 상태 확인" },
    });
    fireEvent.click(screen.getByRole("button", { name: "녹화 시작" }));

    await waitFor(() => expect(startedName).toBe("협력사 송장 상태 확인"));
    expect(startedUrl).toBe("https://portal.example.com/invoices");
    expect(
      await screen.findByText("녹화를 시작했습니다."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("협력사 송장 상태 확인"),
    ).toBeInTheDocument();
    expect(screen.queryByText("2026-06-23T00:00:00.000Z")).toBeNull();
    expect(
      await screen.findByText("내 PC 브라우저 녹화 도우미"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/browser:record-helper/)).toBeNull();
    expect(screen.queryByText(/94000000-0000-4000-8000/)).toBeNull();

    fireEvent.change(await screen.findByLabelText(/저장된 화면 설명/), {
      target: { value: "ApproveButton" },
    });
    expect(screen.getByText(/저장소에서 찾기 조건을 가져왔습니다./)).toBeInTheDocument();
    expect(screen.getAllByText(/버튼 · 안정 · 2회 사용/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByDisplayValue("ApproveButton")).toBeNull();
    expect(screen.getByPlaceholderText("예: 제출 버튼, 승인 확인 영역")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("예: 제출 버튼 또는 고급 선택자")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "임시 목록에 담기" }));
    const queue = await screen.findByLabelText("임시 녹화 동작 목록");
    expect(within(queue).getByText("저장 전에 순서 조정과 삭제가 가능합니다.")).toBeInTheDocument();
    expect(within(queue).getByText("승인 버튼")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("녹화 동작"), { target: { value: "input" } });
    fireEvent.change(screen.getByLabelText("화면에서 찾는 조건"), { target: { value: "input[name=comment]" } });
    fireEvent.change(screen.getByLabelText("표시 이름"), { target: { value: "의견 입력" } });
    fireEvent.change(screen.getByLabelText("입력값 일부 표시"), { target: { value: "확인했습니다" } });
    fireEvent.click(screen.getByRole("button", { name: "임시 목록에 담기" }));
    fireEvent.click(within(queue).getAllByRole("button", { name: "위로" })[1]!);
    fireEvent.click(within(queue).getByRole("button", { name: "2개 동작 추가" }));

    await waitFor(() => expect(appended).toHaveLength(2));
    expect(appended[0]).toMatchObject({ event_type: "input", label: "의견 입력", value_preview: "확인했습니다" });
    expect(appended[1]).toMatchObject({ event_type: "click", element_key: "ApproveButton", label: "승인 버튼" });

    fireEvent.change(screen.getByLabelText("녹화 동작"), { target: { value: "click" } });
    fireEvent.change(await screen.findByLabelText(/저장된 화면 설명/), {
      target: { value: "ApproveButton" },
    });
    fireEvent.click(screen.getByRole("button", { name: "동작 추가" }));

    await waitFor(() =>
      expect(appended[2]).toMatchObject({
        event_type: "click",
        selector: "button.approve",
        element_key: "ApproveButton",
        label: "승인 버튼",
      }),
    );
    expect((await screen.findAllByText("승인 버튼")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "녹화 완료" }));
    await waitFor(() =>
      expect(completedRecordingId).toBe("94000000-0000-4000-8000-000000000001"),
    );
    expect(await screen.findByText("생성된 자동화 확인")).toBeInTheDocument();
    expect(screen.getByText("자동화 검사 통과")).toBeInTheDocument();
    const draftSummary = screen.getByLabelText("자동화 요약");
    expect(draftSummary).toBeInTheDocument();
    expect(within(draftSummary).getByText("녹화 동작")).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "녹화 동작 요약" })).getByText(
        "녹화 동작",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "녹화 동작 요약" })).getByText(
        "승인 버튼 클릭",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/step_01/)).toBeNull();
    expect(screen.getByText(/button\.approve/)).toBeInTheDocument();
    expect(screen.queryByText("원문 초안 보기")).toBeNull();
    expect(screen.getByText("고급 세부 정보 보기")).toBeInTheDocument();
    fireEvent.click(screen.getByText("고급 세부 정보 보기"));
    expect(screen.getByText(/step_01/)).toBeInTheDocument();

    expect(screen.getByText("실행 가능성")).toBeInTheDocument();
    expect(screen.getAllByText("미실행").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "Studio 초안으로 보내기" }));
    await waitFor(() => expect(promotedRecordingId).toBe(completedRecordingId));
    expect(
      await screen.findByText("Studio 초안으로 보냈습니다. v1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Studio 초안 v1")).toBeInTheDocument();
    expect(screen.getAllByText(/v1/).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: "CoE 연결" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "운영 예약" }));
    await waitFor(() =>
      expect(location.hash).toBe(
        "#automationOps?scenario=96000000-0000-4000-8000-000000000001",
      ),
    );
  });

  test("validation report shows operator guidance while keeping technical details collapsed", async () => {
    let completedRecordingId = "";
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com/invoices",
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
      listBrowserRecordings: async () => ({ items: [], next_cursor: null }),
      listSiteElements: async () => ({ items: [], next_cursor: null }),
      startBrowserRecording: async (siteId, body) => ({
        recording_session_id: "94000000-0000-4000-8000-000000000002",
        site_profile_id: siteId,
        name: body.name,
        start_url: body.start_url ?? "https://portal.example.com",
        status: "recording",
        event_count: 1,
        draft_ir: null,
        validation_report: null,
        ...recordingLifecycleFields("94000000-0000-4000-8000-000000000002", "not_started"),
        updated_by: "operator",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }),
      listBrowserRecordingEvents: async () => ({
        items: [],
        next_cursor: null,
      }),
      completeBrowserRecording: async (siteId, recordingId) => {
        completedRecordingId = recordingId;
        return {
          recording_session_id: recordingId,
          site_profile_id: siteId,
          name: "오류 녹화",
          start_url: "https://portal.example.com",
          status: "completed",
          event_count: 1,
          draft_ir: {
            meta: { name: "오류 녹화", version: 1, studio_mode: "easy" },
            start: "step_01",
            nodes: { step_01: { next: "missing_step" } },
          },
          validation_report: {
            errors: [
              {
                rule: "V3",
                message: "target node missing",
                node_id: "step_01",
              },
            ],
            warnings: [],
          },
          review_status: "review_needed",
          review_report: {
            review_status: "review_needed",
            blockers: [
              {
                code: "compile_error",
                severity: "blocker",
                stage: "well_formed",
                node_id: "step_01",
                message: "Static validation error V3",
              },
            ],
            selector_confidence: [],
            repair_suggestions: [],
            object_repo_changeset: [],
            evidence: { recording_session_id: recordingId, validation_stage_count: 0, event_count: 1 },
          },
          promoted_scenario_id: null,
          promoted_scenario_version: null,
          promoted_studio_project_id: null,
          promoted_studio_graph_version: null,
          updated_by: "operator",
          created_at: "2026-06-23T00:00:00.000Z",
          updated_at: "2026-06-23T00:00:02.000Z",
        };
      },
    });
    renderApp(client);

    fireEvent.change(await screen.findByLabelText("녹화 이름"), {
      target: { value: "오류 녹화" },
    });
    fireEvent.click(screen.getByRole("button", { name: "녹화 시작" }));
    fireEvent.click(await screen.findByRole("button", { name: "녹화 완료" }));

    await waitFor(() =>
      expect(completedRecordingId).toBe("94000000-0000-4000-8000-000000000002"),
    );
    expect(await screen.findByText("검사 오류 수정 필요")).toBeInTheDocument();
    expect(
      screen.getByText("다음에 이어질 녹화 동작을 확인하세요."),
    ).toBeInTheDocument();
    expect(screen.getByText(/target node missing/)).not.toBeVisible();
    expect(
      screen.getByText("고급 검사 정보 보기").closest("details"),
    ).not.toHaveAttribute("open");
    expect(
      screen.getByRole("button", { name: "Studio 초안으로 보내기" }),
    ).toBeDisabled();
  });

  test("site changes refresh the untouched start URL and keep full path", async () => {
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com/invoices",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-1",
            default_network_policy_id: "np-1",
          },
          {
            site_profile_id: "30000000-0000-4000-8000-000000000002",
            name: "HR Portal",
            url_pattern: "https://hr.example.com/forms/onboarding",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            default_browser_identity_id: "bi-2",
            default_network_policy_id: "np-2",
          },
        ],
        next_cursor: null,
      }),
      listBrowserRecordings: async () => ({ items: [], next_cursor: null }),
      listSiteElements: async () => ({ items: [], next_cursor: null }),
    });
    renderApp(client);

    const startUrlInput = await screen.findByLabelText("녹화 시작 주소");
    await waitFor(() => expect(startUrlInput).toHaveValue("https://portal.example.com/invoices"));
    fireEvent.change(screen.getByLabelText("녹화 사이트"), { target: { value: "30000000-0000-4000-8000-000000000002" } });
    await waitFor(() => expect(startUrlInput).toHaveValue("https://hr.example.com/forms/onboarding"));
  });

  test("navigate action uses the start URL when the move URL field is empty", async () => {
    const appended: BrowserRecordingAppendEvent[] = [];
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com/invoices",
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
      listBrowserRecordings: async () => ({ items: [], next_cursor: null }),
      listSiteElements: async () => ({ items: [], next_cursor: null }),
      startBrowserRecording: async (siteId, body) => ({
        recording_session_id: "94000000-0000-4000-8000-000000000003",
        site_profile_id: siteId,
        name: body.name,
        start_url: body.start_url ?? "https://portal.example.com/invoices",
        status: "recording",
        event_count: 0,
        draft_ir: null,
        validation_report: null,
        ...recordingLifecycleFields("94000000-0000-4000-8000-000000000003", "not_started"),
        updated_by: "operator",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }),
      listBrowserRecordingEvents: async () => ({ items: [], next_cursor: null }),
      appendBrowserRecordingEvents: async (_siteId, recordingId, body) => {
        appended.push(...body.events);
        return { recording_session_id: recordingId, appended: body.events.length, event_count: appended.length };
      },
    });
    renderApp(client);

    const actionSelect = await startRecordingAndFindActionSelect();
    fireEvent.change(actionSelect, { target: { value: "navigate" } });
    fireEvent.click(screen.getByRole("button", { name: "동작 추가" }));

    await waitFor(() => expect(appended[0]).toMatchObject({
      event_type: "navigate",
      url: "https://portal.example.com/invoices",
    }));
  });

  test("wait action can be added without a selector", async () => {
    const appended: BrowserRecordingAppendEvent[] = [];
    const client = fakeClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "30000000-0000-4000-8000-000000000001",
            name: "ERP Portal",
            url_pattern: "https://portal.example.com/invoices",
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
      listBrowserRecordings: async () => ({ items: [], next_cursor: null }),
      listSiteElements: async () => ({ items: [], next_cursor: null }),
      startBrowserRecording: async (siteId, body) => ({
        recording_session_id: "94000000-0000-4000-8000-000000000004",
        site_profile_id: siteId,
        name: body.name,
        start_url: body.start_url ?? "https://portal.example.com/invoices",
        status: "recording",
        event_count: 0,
        draft_ir: null,
        validation_report: null,
        ...recordingLifecycleFields("94000000-0000-4000-8000-000000000004", "not_started"),
        updated_by: "operator",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }),
      listBrowserRecordingEvents: async () => ({ items: [], next_cursor: null }),
      appendBrowserRecordingEvents: async (_siteId, recordingId, body) => {
        appended.push(...body.events);
        return { recording_session_id: recordingId, appended: body.events.length, event_count: appended.length };
      },
    });
    renderApp(client);

    const actionSelect = await startRecordingAndFindActionSelect();
    fireEvent.change(actionSelect, { target: { value: "wait" } });
    expect(screen.getByRole("button", { name: "동작 추가" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "동작 추가" }));

    await waitFor(() => expect(appended[0]).toMatchObject({ event_type: "wait" }));
    expect(appended[0]).not.toHaveProperty("selector");
  });
});
