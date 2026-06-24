import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
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
import type { RunArtifactItem } from "../src/api/types";
import { runDetailRefetchInterval } from "../src/views/RunTrace";
import { fakeClient } from "./fake-client";

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

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

// 실행 상세 패널을 열어 도착 배너(RunDetail.status 파생)를 마운트.
async function openDetail(): Promise<void> {
  location.hash = "#runTrace";
  (await screen.findByRole("button", { name: "실행 추적 상세 보기" })).click();
}

// F3 — 터미널 '도착 순간' 배너. 도착 판정=RunDetail.status(실 필드), 사유(reason)는 만들지 않음.
describe("실행 도착 배너 — 터미널 상태(F3)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", "test-token");
  });

  test("focus=artifacts 딥링크는 실행 결과·증빙 영역에 포커스한다", async () => {
    renderApp(
      fakeClient({
        listRunArtifacts: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash =
      "#runTrace?run=11111111-aaaa-bbbb-cccc-000000000001&focus=artifacts";

    const region = await screen.findByRole("region", {
      name: "실행 결과·증빙",
    });
    await waitFor(() => expect(document.activeElement).toBe(region));
  });

  test("completed → .arrival-banner.green + '완료' 라벨", async () => {
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
      }),
    );
    await openDetail();
    const banner = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".arrival-banner");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.className).toContain("green");
    expect(banner.textContent).toContain("완료"); // StatusBadge 라벨
  });

  test("completed + scenario.promote 권한 → 성공 실행을 draft 봇 버전으로 승격한다", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const calls: Array<{ scenarioId: string; runId: string; idempotencyKey: string }> = [];
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        promoteScenarioFromRun: async (scenarioId, runId, idempotencyKey) => {
          calls.push({ scenarioId, runId, idempotencyKey });
          return {
            scenario_id: scenarioId,
            version: 4,
            scenario_version_id: "00000000-0000-0000-0000-0000000000c4",
            promotion_status: "draft",
            promoted_node_ids: ["open_orders", "submit_filter"],
            skipped: [
              { nodeId: "manual_review", reason: "unsupported_operation" },
            ],
          };
        },
      }),
    );
    await openDetail();

    const panel = await screen.findByRole("region", {
      name: "성공 실행 봇 승격",
    });
    const promoteButton = within(panel).getByRole("button", { name: "이 실행을 봇으로 굳히기" });
    fireEvent.click(promoteButton);
    fireEvent.click(promoteButton);

    await waitFor(() =>
      expect(calls).toEqual([
        {
          scenarioId: "00000000-0000-0000-0000-0000000000c1",
          runId: "11111111-aaaa-bbbb-cccc-000000000001",
          idempotencyKey:
            "promote-from-run:00000000-0000-0000-0000-0000000000c1:11111111-aaaa-bbbb-cccc-000000000001",
        },
      ]),
    );
    expect(await within(panel).findByText("초안 변경 4 생성")).toBeInTheDocument();
    expect(within(panel).getByText("자동화 단계 2개 반영")).toBeInTheDocument();
    expect(within(panel).getByText("검토 필요 1개")).toBeInTheDocument();
    expect(
      within(panel).getByText(/지원하지 않는 동작 유형/),
    ).toBeInTheDocument();
    const promotedButton = within(panel).getByRole("button", {
      name: "이미 초안으로 굳힘",
    });
    expect(promotedButton).toBeDisabled();
    fireEvent.click(promotedButton);
    expect(calls).toHaveLength(1);
  });

  test("completed + scenario.promote 권한 → 다른 실행 상세로 이동하면 승격 결과를 초기화한다", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const runA = "11111111-aaaa-bbbb-cccc-000000000001";
    const runB = "11111111-aaaa-bbbb-cccc-000000000002";
    const scenarioA = "00000000-0000-0000-0000-0000000000c1";
    const scenarioB = "00000000-0000-0000-0000-0000000000d1";
    const calls: Array<{ scenarioId: string; runId: string; idempotencyKey: string }> = [];
    location.hash = `#runTrace?run=${runA}`;
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          scenario_id: id === runA ? scenarioA : scenarioB,
          scenario_version_id: id === runA
            ? "00000000-0000-0000-0000-0000000000c2"
            : "00000000-0000-0000-0000-0000000000d2",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        promoteScenarioFromRun: async (scenarioId, runId, idempotencyKey) => {
          calls.push({ scenarioId, runId, idempotencyKey });
          return {
            scenario_id: scenarioId,
            version: runId === runA ? 7 : 8,
            scenario_version_id: runId === runA
              ? "00000000-0000-0000-0000-0000000000c7"
              : "00000000-0000-0000-0000-0000000000d8",
            promotion_status: "draft",
            promoted_node_ids: ["open_orders"],
            skipped: [],
          };
        },
      }),
    );

    let panel = await screen.findByRole("region", {
      name: "성공 실행 봇 승격",
    });
    fireEvent.click(within(panel).getByRole("button", { name: "이 실행을 봇으로 굳히기" }));
    expect(await within(panel).findByText("초안 변경 7 생성")).toBeInTheDocument();

    await act(async () => {
      location.hash = `#runTrace?run=${runB}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    panel = await screen.findByRole("region", {
      name: "성공 실행 봇 승격",
    });
    const promoteButton = await waitFor(() =>
      within(panel).getByRole("button", { name: "이 실행을 봇으로 굳히기" }),
    );
    expect(within(panel).queryByText(/초안 변경 7/)).not.toBeInTheDocument();
    expect(promoteButton).toBeEnabled();
    fireEvent.click(promoteButton);

    await waitFor(() =>
      expect(calls).toEqual([
        {
          scenarioId: scenarioA,
          runId: runA,
          idempotencyKey: `promote-from-run:${scenarioA}:${runA}`,
        },
        {
          scenarioId: scenarioB,
          runId: runB,
          idempotencyKey: `promote-from-run:${scenarioB}:${runB}`,
        },
      ]),
    );
  });

  test("completed + operator 권한 → 성공 실행 봇 승격 패널을 노출하지 않는다", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "성공 실행 봇 승격" }),
      ).not.toBeInTheDocument(),
    );
  });

  test("cancelled → .arrival-banner.muted + '취소됨'(abort→cancelled 어휘)", async () => {
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "cancelled",
          worker_id: null,
          attempts: 1,
          as_of: null,
        }),
      }),
    );
    await openDetail();
    const banner = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".arrival-banner");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.className).toContain("muted");
    expect(banner.textContent).toContain("취소됨");
  });

  test("failed_system → .arrival-banner.red + 실패 라벨 + 단계 트레이스 유도 문구", async () => {
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "failed_system",
          worker_id: "w1",
          attempts: 3,
          as_of: null,
        }),
      }),
    );
    await openDetail();
    const banner = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".arrival-banner");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.className).toContain("red");
    expect(banner.textContent).toContain("시스템 실패");
    expect(banner.textContent).toContain("시도 3회"); // attempts>1 표기(실 필드)
    expect(banner.textContent).toContain("단계 트레이스"); // 구체 사유 대신 유도(reason 창작 금지)
  });

  test("failed_system + failure_reason → 코드와 메시지를 상세 배너에 표시", async () => {
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "failed_system",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
          failure_reason: {
            code: "RUN_LOOP_FAILED",
            message: "site profile not found",
          },
        }),
      }),
    );
    await openDetail();
    const banner = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".arrival-banner");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.textContent).toContain("RUN_LOOP_FAILED");
    expect(banner.textContent).toContain("site profile not found");
  });

  // 비-터미널(running)은 도착하지 않았으므로 배너를 그리지 않는다(조용한 false 금지 가드).
  test("running → 도착 배너 미표시", async () => {
    renderApp(); // 기본 픽스처 getRun = running
    await openDetail();
    // 상세 패널(상태 dl)이 마운트될 때까지 대기 후 배너 부재 단언.
    await waitFor(() =>
      expect(screen.getByText("시도 횟수")).toBeInTheDocument(),
    );
    expect(document.querySelector(".arrival-banner")).toBeNull();
  });

  // reads.ts:203이 current_node를 영구 null로 못박음 → 목록의 '현재 노드' 컬럼은 production에서 항상 '—'(조용한 false).
  // 컬럼을 제거했으므로 헤더가 부활하지 않음을 단언(항상-null 컬럼 차단). 진짜 '현재 단계'는 StepTrace가 정직하게 표시.
  test("실행 기록 목록에 항상-null '현재 노드' 컬럼이 없다(조용한 false 제거)", async () => {
    renderApp();
    location.hash = "#runTrace";
    // 목록 행(상세 버튼)이 마운트될 때까지 대기 후 헤더 부재 단언(다른 run-trace 테스트와 동일한 진입 신호).
    await screen.findByRole("button", { name: "실행 추적 상세 보기" });
    expect(
      screen.queryByRole("columnheader", { name: "현재 노드" }),
    ).toBeNull();
  });

  // H1(R1) — suspended(사람 확인 대기) 상세에 연결된 사람 확인 업무 교차 동선 노출 + 클릭 시 해당 task 딥링크 이동.
  test("suspended → 연결된 사람 확인 업무 처리하기 동선 + 클릭 시 #humanTasks?ht 이동", async () => {
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "suspended",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        listHumanTasks: async (params) => ({
          items: [
            {
              human_task_id: "ht-linked",
              state: "open",
              kind: "approval",
              assignee: null,
              timeout: null,
              on_timeout: null,
              run_id: params?.run_id ?? null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    const link = await screen.findByRole("button", {
      name: /연결된 사람 확인 업무 처리하기/,
    });
    link.click();
    await waitFor(() => expect(location.hash).toBe("#humanTasks?ht=ht-linked"));
  });

  // H2(R1, fabrication 가드) — 비-suspended(running)에는 인박스 동선을 만들지 않는다(관찰된 status로만 게이팅).
  test("running → '사람 확인 인박스' 동선 미표시(조용한 false 금지)", async () => {
    renderApp(); // 기본 픽스처 getRun = running
    await openDetail();
    // 상세 패널(상태 dl)이 마운트될 때까지 대기 후(detail resolve 신호) 동선 부재 단언.
    const panel = await screen.findByRole("region", { name: "실행 상세" });
    await waitFor(() =>
      expect(within(panel).getByText("시도 횟수")).toBeInTheDocument(),
    );
    expect(
      within(panel).queryByRole("button", {
        name: /사람 확인 인박스에서 처리하기/,
      }),
    ).toBeNull();
  });

  test("실행 상세 산출물: JSON rows 결과를 표로 표시하고 원문 JSON은 노출하지 않는다", async () => {
    renderApp(
      fakeClient({
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-result-1",
              type: "extract_result_json",
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifact: async (id) => ({
          artifact_id: id,
          type: "extract_result_json",
          sha256: "sha",
          redaction_status: "redacted",
          retention_until: null,
          content: JSON.stringify({
            rows: [
              { title: "공지 A", author: "Kim" },
              { title: "공지 B", author: "Lee" },
            ],
          }),
        }),
      }),
    );
    await openDetail();
    expect(await screen.findByText("실행 결과·증빙")).toBeInTheDocument();
    expect(await screen.findByText("결과 2건")).toBeInTheDocument();
    expect(screen.getByText(/표시 항목 title, author/)).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "title" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "author" }),
    ).toBeInTheDocument();
    expect(screen.getByText("공지 A")).toBeInTheDocument();
    expect(screen.queryByText("원본 결과 보기")).toBeNull();
  });

  test("실행 상세 산출물: next_cursor가 있으면 더 보기로 다음 페이지를 append한다", async () => {
    const artifactCalls: unknown[] = [];
    const firstArtifact: RunArtifactItem = {
      artifact_id: "art-page-1",
      type: "extract_result_json",
      media_type: "application/json",
      filename: "first-page.json",
      byte_size: 100,
      duration_ms: null,
      redaction_status: "redacted",
      retention_until: null,
      legal_hold: false,
      created_at: "2026-06-18T00:00:00.000Z",
    };
    const secondArtifact: RunArtifactItem = {
      artifact_id: "art-page-2",
      type: "extract_result_json",
      media_type: "application/json",
      filename: "second-page.json",
      byte_size: 200,
      duration_ms: null,
      redaction_status: "redacted",
      retention_until: null,
      legal_hold: false,
      created_at: "2026-06-18T00:00:01.000Z",
    };

    renderApp(
      fakeClient({
        listRunArtifacts: async (_runId, params) => {
          artifactCalls.push(params);
          if (params?.cursor === "cursor-page-2") {
            return {
              items: [firstArtifact, secondArtifact],
              next_cursor: null,
            };
          }
          return { items: [firstArtifact], next_cursor: "cursor-page-2" };
        },
        getArtifact: async (id) => ({
          artifact_id: id,
          type: "extract_result_json",
          sha256: "sha",
          redaction_status: "redacted",
          retention_until: null,
          content: JSON.stringify({ rows: [] }),
        }),
      }),
    );

    await openDetail();

    expect(await screen.findByText("first-page.json")).toBeInTheDocument();
    expect(await screen.findByLabelText("증빙 요약")).toHaveTextContent(
      "증빙 1+건",
    );
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));

    expect(await screen.findByText("second-page.json")).toBeInTheDocument();
    await waitFor(() =>
      expect(artifactCalls).toContainEqual({
        limit: 100,
        cursor: "cursor-page-2",
      }),
    );
    expect(screen.getAllByText("first-page.json")).toHaveLength(1);
    expect(screen.getByLabelText("증빙 요약")).toHaveTextContent(
      "증빙 2건",
    );
  });

  test("실행 상세 산출물: media 메타데이터와 screenshot/video 배지를 표시하고 목록 민감 필드는 숨긴다", async () => {
    installObjectUrlMock();
    const screenshot = {
      artifact_id: "art-shot-1",
      step_id: "checkout_submit",
      attempt: 1,
      type: "screen_capture",
      media_type: "image/png",
      filename: "checkout.png",
      byte_size: 1_234_567,
      duration_ms: null,
      redaction_status: "redacted",
      retention_until: null,
      legal_hold: false,
      created_at: "2026-06-18T00:00:00.000Z",
      content: "LIST_CONTENT_SHOULD_NOT_RENDER",
      object_ref: "s3://secret/object",
      sha256: "LIST_SHA_SHOULD_NOT_RENDER",
    } as unknown as RunArtifactItem;
    const video = {
      artifact_id: "art-video-1",
      step_id: null,
      attempt: null,
      type: "run_video",
      media_type: "video/webm",
      filename: "checkout.webm",
      byte_size: 2_097_152,
      duration_ms: 3456,
      redaction_status: "redacted",
      retention_until: null,
      legal_hold: false,
      created_at: "2026-06-18T00:00:01.000Z",
    };
    renderApp(
      fakeClient({
        listRunArtifacts: async () => ({
          items: [screenshot, video],
          next_cursor: null,
        }),
        getArtifact: async (id) => ({
          artifact_id: id,
          type: "screen_capture",
          media_type: "image/png",
          filename: "checkout.png",
          sha256: "detail-sha",
          redaction_status: "redacted",
          retention_until: null,
          content: "redacted detail content",
        }),
        getArtifactBlob: async () =>
          new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      }),
    );

    await openDetail();
    expect(await screen.findByText("checkout.png")).toBeInTheDocument();
    expect(screen.getByText("checkout.webm")).toBeInTheDocument();
    expect(screen.getByText("스크린샷 1")).toBeInTheDocument();
    expect(screen.getByText("동영상 1")).toBeInTheDocument();
    expect(screen.getByText("PNG 이미지 · 1.2 MB")).toBeInTheDocument();
    expect(screen.getByText("WebM 영상 · 2.0 MB · 3.5 s")).toBeInTheDocument();
    expect(screen.getByText("자동화 단계 · 시도 1")).toBeInTheDocument();
    expect(screen.getByText("실행 전체")).toBeInTheDocument();
    expect(screen.getByText("스크린샷")).toBeInTheDocument();
    expect(screen.getByText("영상")).toBeInTheDocument();
    expect(screen.queryByText("LIST_CONTENT_SHOULD_NOT_RENDER")).toBeNull();
    expect(screen.queryByText("s3://secret/object")).toBeNull();
    expect(screen.queryByText("LIST_SHA_SHOULD_NOT_RENDER")).toBeNull();
    const image = await screen.findByRole("img", { name: "checkout.png" });
    expect(image).toHaveAttribute("src", "blob:test-preview");
    expect(
      screen.getByRole("button", { name: "원본 다운로드" }),
    ).toBeInTheDocument();
    const videoRow = screen.getByText("checkout.webm").closest("tr");
    expect(videoRow).not.toBeNull();
    within(videoRow as HTMLElement)
      .getByRole("button", { name: "미리보기" })
      .click();
    await waitFor(() => {
      const videoEl = document.querySelector("video");
      expect(videoEl).not.toBeNull();
      expect(videoEl).toHaveAttribute("aria-label", "checkout.webm");
      expect(videoEl).toHaveAttribute("controls");
      expect(videoEl).toHaveAttribute("src", "blob:test-preview");
    });
  });

  test("실행 상세 산출물: step provenance 클릭 → 해당 단계/시도 강조", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            {
              step_id: "open_page",
              node_id: "open_page",
              attempt: 0,
              action: "navigate",
              status: "success",
              cache_mode: "bypass",
              artifact_ids: [],
              stagehand_calls: [],
              started_at: null,
              ended_at: null,
              duration_ms: 100,
              exception: null,
            },
            {
              step_id: "checkout_submit",
              node_id: "checkout_submit",
              attempt: 1,
              action: "act",
              status: "success",
              cache_mode: "miss",
              artifact_ids: ["art-shot-1"],
              stagehand_calls: [],
              started_at: null,
              ended_at: null,
              duration_ms: 250,
              exception: null,
            },
          ],
          next_cursor: null,
        }),
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-shot-1",
              step_id: "checkout_submit",
              attempt: 1,
              type: "screen_capture",
              media_type: "image/png",
              filename: "checkout.png",
              byte_size: 1000,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    await openDetail();
    (
      await screen.findByRole("button", { name: "자동화 단계 · 시도 1" })
    ).click();
    await waitFor(() =>
      expect(location.hash).toContain("step=checkout_submit"),
    );
    expect(location.hash).toContain("attempt=1");
    const focused = document.querySelector<HTMLElement>(".step-card.focused");
    expect(focused).not.toBeNull();
    expect(focused!.textContent).toContain("단계 #2");
    expect(focused!.textContent).toContain("산출물 선택 단계");
    screen.getByRole("button", { name: "표" }).click();
    await waitFor(() => {
      const focusedRow = document.querySelector<HTMLElement>(
        "tr[data-focus='true']",
      );
      expect(focusedRow).not.toBeNull();
      expect(focusedRow!.textContent).toContain("단계 #2");
    });
  });

  test("실행 상세 산출물: StepTrace 증빙 클릭은 실행 산출물 미리보기도 같은 artifact로 맞춘다", async () => {
    installObjectUrlMock();
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            {
              step_id: "capture_page",
              node_id: "capture_page",
              attempt: 0,
              action: "navigate",
              status: "success",
              cache_mode: "bypass",
              artifact_ids: ["art-video-1"],
              stagehand_calls: [],
              started_at: null,
              ended_at: null,
              duration_ms: 100,
              exception: null,
            },
          ],
          next_cursor: null,
        }),
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-shot-1",
              step_id: "capture_page",
              attempt: 0,
              type: "screen_capture",
              media_type: "image/png",
              filename: "initial.png",
              byte_size: 1000,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:00.000Z",
            },
            {
              artifact_id: "art-video-1",
              step_id: "capture_page",
              attempt: 0,
              type: "run_video",
              media_type: "video/webm",
              filename: "trace.webm",
              byte_size: 2000,
              duration_ms: 1200,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:01.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifactBlob: async (artifactId) =>
          new Blob([new Uint8Array([1, 2, 3])], {
            type: artifactId === "art-video-1" ? "video/webm" : "image/png",
          }),
      }),
    );

    await openDetail();
    const initialImage = await screen.findByRole("img", {
      name: "initial.png",
    });
    expect(initialImage).toHaveAttribute("src", "blob:test-preview");
    const initialVideoRow = screen.getByText("trace.webm").closest("tr");
    expect(initialVideoRow).not.toBeNull();
    expect(initialVideoRow).not.toHaveAttribute("data-current", "true");

    const stepCard = (await screen.findByText("단계 #1")).closest(".step-card");
    expect(stepCard).not.toBeNull();
    within(stepCard as HTMLElement)
      .getByRole("button", { name: "증빙 1 조회" })
      .click();

    await waitFor(() =>
      expect(location.hash).toContain("artifact=art-video-1"),
    );
    await waitFor(() => {
      const selectedVideoRow = screen.getByText("trace.webm").closest("tr");
      expect(selectedVideoRow).not.toBeNull();
      expect(selectedVideoRow).toHaveAttribute("data-current", "true");
      const videoEl = document.querySelector("video");
      expect(videoEl).not.toBeNull();
      expect(videoEl).toHaveAttribute("aria-label", "trace.webm");
      expect(videoEl).toHaveAttribute("src", "blob:test-preview");
    });
    expect(screen.queryByRole("img", { name: "initial.png" })).toBeNull();

    const imageRow = screen.getByText("initial.png").closest("tr");
    expect(imageRow).not.toBeNull();
    within(imageRow as HTMLElement)
      .getByRole("button", { name: "미리보기" })
      .click();
    await waitFor(() => expect(location.hash).toContain("artifact=art-shot-1"));
    await waitFor(() => {
      expect(screen.getByText("initial.png").closest("tr")).toHaveAttribute(
        "data-current",
        "true",
      );
      expect(screen.getByRole("img", { name: "initial.png" })).toHaveAttribute(
        "src",
        "blob:test-preview",
      );
    });
  });

  test("실행 상세 산출물: media_type 없는 video_masked도 영상 미리보기로 처리한다", async () => {
    installObjectUrlMock();
    renderApp(
      fakeClient({
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-video-masked-1",
              type: "video_masked",
              media_type: null,
              filename: "run.webm",
              byte_size: 4096,
              duration_ms: 1200,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:01.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifactBlob: async () =>
          new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" }),
      }),
    );

    await openDetail();
    expect(await screen.findByText("run.webm")).toBeInTheDocument();
    expect(screen.getByText("동영상 1")).toBeInTheDocument();
    const videoEl = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    expect(videoEl).toHaveAttribute("aria-label", "run.webm");
    expect(videoEl).toHaveAttribute("src", "blob:test-preview");
  });

  test("실행 상세 산출물: not_required 미디어도 redaction 완료 산출물처럼 미리보기한다", async () => {
    installObjectUrlMock();
    const blobCalls: string[] = [];
    renderApp(
      fakeClient({
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-not-required-video-1",
              type: "video_masked",
              media_type: "video/webm",
              filename: "not-required.webm",
              byte_size: 4096,
              duration_ms: 1200,
              redaction_status: "not_required",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:01.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifact: async () => {
          throw new Error(
            "not_required media preview must use blob route, not body route",
          );
        },
        getArtifactBlob: async (artifactId) => {
          blobCalls.push(artifactId);
          return new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" });
        },
      }),
    );

    await openDetail();
    expect(await screen.findByText("조회 가능")).toBeInTheDocument();
    expect(screen.getByText("not-required.webm")).toBeInTheDocument();
    const notRequiredVideoEl = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    expect(notRequiredVideoEl).toHaveAttribute(
      "aria-label",
      "not-required.webm",
    );
    expect(notRequiredVideoEl).toHaveAttribute("src", "blob:test-preview");
    expect(
      screen.queryByText("처리가 완료되면 미리볼 수 있습니다."),
    ).toBeNull();
    expect(blobCalls).toEqual(["art-not-required-video-1"]);
  });

  test("실행 상세 산출물: JSON보다 스크린샷 증거를 먼저 미리보기로 선택한다", async () => {
    installObjectUrlMock();
    renderApp(
      fakeClient({
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-json-1",
              type: "extract_result_json",
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:00.000Z",
            },
            {
              artifact_id: "art-screen-1",
              type: "screen_capture",
              media_type: null,
              filename: "step.png",
              byte_size: 1024,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:01.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifact: async (id) => ({
          artifact_id: id,
          type: "extract_result_json",
          sha256: "sha",
          redaction_status: "redacted",
          retention_until: null,
          content: JSON.stringify({
            rows: [{ title: "should not be initial preview" }],
          }),
        }),
        getArtifactBlob: async () =>
          new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      }),
    );

    await openDetail();
    expect(await screen.findByText("스크린샷 1")).toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "step.png" });
    expect(image).toHaveAttribute("src", "blob:test-preview");
    expect(screen.queryByText(/should not be initial preview/)).toBeNull();
  });

  test("prompt-created run shows requested evidence policy with stored artifact counts", async () => {
    installObjectUrlMock();
    const runId = "11111111-aaaa-bbbb-cccc-000000000001";
    const generationId = "00000000-0000-0000-0000-0000000000a1";
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        getScenarioGeneration: async (id) => ({
          generation_id: id,
          mode: "save_and_run",
          status: "run_queued",
          prompt_hash: "hash",
          planner: "llm_v1",
          model: "gpt-4o-mini",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          run_id: runId,
          evidence_policy: { screenshot: "each_step", video: "always" },
          blockers: [],
          created_at: "2026-06-18T00:00:00.000Z",
          created_by: "operator",
          draft_ir: {},
          validation_report: {},
        }),
        listScenarioGenerationArtifacts: async () => ({
          items: [
            {
              artifact_id: "gen-art-planner-1",
              type: "scenario_generation_planner_output",
              media_type: "application/json",
              filename: "planner.json",
              byte_size: 80,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:00.500Z",
            },
          ],
          next_cursor: null,
        }),
        getScenarioGenerationArtifact: async (id, artifactId) => ({
          generation_id: id,
          artifact_id: artifactId,
          type: "scenario_generation_planner_output",
          sha256: "planner-sha",
          redaction_status: "redacted",
          retention_until: null,
          content: '{"planner":"ready"}',
        }),
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-screen-1",
              type: "screen_capture",
              media_type: "image/png",
              filename: "step.png",
              byte_size: 1024,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:01.000Z",
            },
            {
              artifact_id: "art-video-1",
              type: "run_video",
              media_type: "video/webm",
              filename: "run.webm",
              byte_size: 2048,
              duration_ms: 2000,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:02.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifactBlob: async () =>
          new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      }),
    );
    location.hash = `#runTrace?run=${runId}&generation=${generationId}&focus=artifacts`;

    const readout = await screen.findByLabelText("evidence storage");
    expect(readout).toHaveTextContent("요청 이미지: 매 단계");
    expect(readout).toHaveTextContent("요청 동영상: 전체 실행");
    expect(readout).toHaveTextContent("저장 이미지 1");
    expect(readout).toHaveTextContent("저장 동영상 1");
    expect(await screen.findByText("자연어 생성 산출물")).toBeInTheDocument();
    expect(
      (await screen.findAllByText("scenario_generation_planner_output")).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText(/ready/)).length).toBeGreaterThan(0);
  });

  test("running prompt-created run shows pending evidence storage instead of missing warnings", async () => {
    const runId = "11111111-aaaa-bbbb-cccc-000000000001";
    const generationId = "00000000-0000-0000-0000-0000000000a1";
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "running",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        getScenarioGeneration: async (id) => ({
          generation_id: id,
          mode: "save_and_run",
          status: "run_queued",
          prompt_hash: "hash",
          planner: "llm_v1",
          model: "gpt-4o-mini",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          run_id: runId,
          evidence_policy: { screenshot: "each_step", video: "failure" },
          blockers: [],
          created_at: "2026-06-18T00:00:00.000Z",
          created_by: "operator",
          draft_ir: {},
          validation_report: {},
        }),
        listRunArtifacts: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash = `#runTrace?run=${runId}&generation=${generationId}&focus=artifacts`;

    const readout = await screen.findByLabelText("evidence storage");
    expect(readout).toHaveTextContent("요청 이미지: 매 단계");
    expect(readout).toHaveTextContent("요청 동영상: 실패 시");
    expect(readout).toHaveTextContent("저장 이미지 0");
    expect(readout).toHaveTextContent("저장 동영상 0");
    expect(readout).toHaveTextContent("이미지 저장 대기");
    expect(readout).toHaveTextContent("실패 시 동영상 저장 대기");
    expect(readout).not.toHaveTextContent("미저장");
  });

  test("failed prompt-created run warns when failure screenshot evidence is missing", async () => {
    const runId = "11111111-aaaa-bbbb-cccc-000000000001";
    const generationId = "00000000-0000-0000-0000-0000000000a1";
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "failed_system",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
          failure_reason: {
            code: "VISUAL_EVIDENCE_MISSING",
            message: "screenshot artifact was not stored",
          },
        }),
        getScenarioGeneration: async (id) => ({
          generation_id: id,
          mode: "save_and_run",
          status: "run_queued",
          prompt_hash: "hash",
          planner: "llm_v1",
          model: "gpt-4o-mini",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          run_id: runId,
          evidence_policy: { screenshot: "failure", video: "never" },
          blockers: [],
          created_at: "2026-06-18T00:00:00.000Z",
          created_by: "operator",
          draft_ir: {},
          validation_report: {},
        }),
        listRunArtifacts: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash = `#runTrace?run=${runId}&generation=${generationId}&focus=artifacts`;

    const readout = await screen.findByLabelText("evidence storage");
    expect(readout).toHaveTextContent("요청 이미지: 실패 시");
    expect(readout).toHaveTextContent("저장 이미지 0");
    expect(readout).toHaveTextContent("실패 스크린샷 미표시(처리 중 가능)");
    expect(readout).not.toHaveTextContent("요청 이미지 미표시");
    expect(readout).not.toHaveTextContent("저장 대기");
    expect(readout).not.toHaveTextContent("미저장");
  });

  test("completed prompt-created run treats hidden evidence artifacts as redaction-aware unavailable", async () => {
    const runId = "11111111-aaaa-bbbb-cccc-000000000001";
    const generationId = "00000000-0000-0000-0000-0000000000a1";
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        getScenarioGeneration: async (id) => ({
          generation_id: id,
          mode: "save_and_run",
          status: "run_queued",
          prompt_hash: "hash",
          planner: "llm_v1",
          model: "gpt-4o-mini",
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          run_id: runId,
          evidence_policy: { screenshot: "each_step", video: "always" },
          blockers: [],
          created_at: "2026-06-18T00:00:00.000Z",
          created_by: "operator",
          draft_ir: {},
          validation_report: {},
        }),
        listRunArtifacts: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash = `#runTrace?run=${runId}&generation=${generationId}&focus=artifacts`;

    const readout = await screen.findByLabelText("evidence storage");
    expect(readout).toHaveTextContent("요청 이미지: 매 단계");
    expect(readout).toHaveTextContent("요청 동영상: 전체 실행");
    expect(readout).toHaveTextContent("저장 이미지 0");
    expect(readout).toHaveTextContent("저장 동영상 0");
    expect(readout).toHaveTextContent("요청 이미지 미표시(처리 중 가능)");
    expect(readout).toHaveTextContent("요청 동영상 미표시(처리 중 가능)");
    expect(readout).not.toHaveTextContent("미저장");
  });

  test("run detail polling stays active until terminal status", () => {
    expect(runDetailRefetchInterval(undefined)).toBe(5_000);
    expect(runDetailRefetchInterval("queued")).toBe(5_000);
    expect(runDetailRefetchInterval("running")).toBe(5_000);
    expect(runDetailRefetchInterval("completed")).toBe(false);
    expect(runDetailRefetchInterval("failed_system")).toBe(false);
    expect(runDetailRefetchInterval("failed_business")).toBe(false);
    expect(runDetailRefetchInterval("cancelled")).toBe(false);
  });

  test("prompt-created run recovers linked generation from run_id when generation hash is absent", async () => {
    installObjectUrlMock();
    const runId = "11111111-aaaa-bbbb-cccc-000000000001";
    const generationId = "00000000-0000-0000-0000-0000000000a1";
    const lookupParams: unknown[] = [];
    let getByIdCalls = 0;
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        getScenarioGeneration: async () => {
          getByIdCalls += 1;
          throw new Error("generation hash lookup should not run");
        },
        listScenarioGenerations: async (params) => {
          lookupParams.push(params);
          return {
            items: [
              {
                generation_id: generationId,
                mode: "save_and_run",
                status: "run_queued",
                prompt_hash: "hash",
                planner: "llm_v1",
                model: "gpt-4o-mini",
                scenario_id: "00000000-0000-0000-0000-0000000000c1",
                scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
                run_id: runId,
                evidence_policy: { screenshot: "each_step", video: "always" },
                blockers: [],
                created_at: "2026-06-18T00:00:00.000Z",
                created_by: "operator",
                draft_ir: {},
                validation_report: {},
              },
            ],
            next_cursor: null,
          };
        },
        listScenarioGenerationArtifacts: async () => ({
          items: [
            {
              artifact_id: "gen-art-planner-1",
              type: "scenario_generation_planner_output",
              media_type: "application/json",
              filename: "planner.json",
              byte_size: 80,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:00.500Z",
            },
          ],
          next_cursor: null,
        }),
        getScenarioGenerationArtifact: async (id, artifactId) => ({
          generation_id: id,
          artifact_id: artifactId,
          type: "scenario_generation_planner_output",
          sha256: "planner-sha",
          redaction_status: "redacted",
          retention_until: null,
          content: '{"planner":"ready"}',
        }),
        listRunArtifacts: async () => ({
          items: [
            {
              artifact_id: "art-screen-1",
              type: "screen_capture",
              media_type: "image/png",
              filename: "step.png",
              byte_size: 1024,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:01.000Z",
            },
            {
              artifact_id: "art-video-1",
              type: "run_video",
              media_type: "video/webm",
              filename: "run.webm",
              byte_size: 2048,
              duration_ms: 2000,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-18T00:00:02.000Z",
            },
          ],
          next_cursor: null,
        }),
        getArtifactBlob: async () =>
          new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      }),
    );
    location.hash = `#runTrace?run=${runId}&focus=artifacts`;

    expect(
      await screen.findByLabelText("generation context"),
    ).toHaveTextContent(generationId.slice(0, 8));
    const readout = await screen.findByLabelText("evidence storage");
    expect(lookupParams[0]).toEqual({ run_id: runId, limit: 1 });
    expect(getByIdCalls).toBe(0);
    expect(readout).toHaveTextContent("저장 이미지 1");
    expect(readout).toHaveTextContent("저장 동영상 1");
    expect(
      (await screen.findAllByText("scenario_generation_planner_output")).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText(/ready/)).length).toBeGreaterThan(0);
  });

  test("mismatched generation deep link is called out and does not drive evidence storage", async () => {
    const runId = "11111111-aaaa-bbbb-cccc-000000000001";
    const generationId = "00000000-0000-0000-0000-0000000000a1";
    renderApp(
      fakeClient({
        getRun: async (id) => ({
          run_id: id,
          status: "completed",
          worker_id: "w1",
          attempts: 1,
          as_of: null,
        }),
        getScenarioGeneration: async (id) => ({
          generation_id: id,
          mode: "save_and_run",
          status: "run_queued",
          prompt_hash: "hash",
          planner: "deterministic_mvp",
          model: null,
          scenario_id: "00000000-0000-0000-0000-0000000000c1",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
          run_id: "22222222-aaaa-bbbb-cccc-000000000002",
          evidence_policy: { screenshot: "each_step", video: "always" },
          blockers: [],
          created_at: "2026-06-18T00:00:00.000Z",
          created_by: "operator",
          draft_ir: {},
          validation_report: {},
        }),
        listRunArtifacts: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash = `#runTrace?run=${runId}&generation=${generationId}&focus=artifacts`;

    await waitFor(() =>
      expect(screen.getByLabelText("generation context")).toHaveTextContent(
        "실행 연결 확인 필요",
      ),
    );
    expect(screen.queryByLabelText("evidence storage")).toBeNull();
  });
});
