import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { RunArtifactItem } from "../src/api/types";
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
  (await screen.findByRole("button", { name: "상세" })).click();
}

// F3 — 터미널 '도착 순간' 배너. 도착 판정=RunDetail.status(실 필드), 사유(reason)는 만들지 않음.
describe("실행 도착 배너 — 터미널 상태(F3)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", "test-token");
  });

  test("focus=artifacts 딥링크는 실행 결과·산출물 영역에 포커스한다", async () => {
    renderApp(fakeClient({
      listRunArtifacts: async () => ({ items: [], next_cursor: null }),
    }));
    location.hash = "#runTrace?run=11111111-aaaa-bbbb-cccc-000000000001&focus=artifacts";

    const region = await screen.findByRole("region", { name: "실행 결과·산출물" });
    await waitFor(() => expect(document.activeElement).toBe(region));
  });

  test("completed → .arrival-banner.green + '완료' 라벨", async () => {
    renderApp(fakeClient({ getRun: async (id) => ({ run_id: id, status: "completed", worker_id: "w1", attempts: 1, as_of: null }) }));
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

  test("cancelled → .arrival-banner.muted + '취소됨'(abort→cancelled 어휘)", async () => {
    renderApp(fakeClient({ getRun: async (id) => ({ run_id: id, status: "cancelled", worker_id: null, attempts: 1, as_of: null }) }));
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
    renderApp(fakeClient({ getRun: async (id) => ({ run_id: id, status: "failed_system", worker_id: "w1", attempts: 3, as_of: null }) }));
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
    renderApp(fakeClient({
      getRun: async (id) => ({
        run_id: id,
        status: "failed_system",
        worker_id: "w1",
        attempts: 1,
        as_of: null,
        failure_reason: { code: "RUN_LOOP_FAILED", message: "site profile not found" },
      }),
    }));
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
    await waitFor(() => expect(screen.getByText("시도 횟수")).toBeInTheDocument());
    expect(document.querySelector(".arrival-banner")).toBeNull();
  });

  // reads.ts:203이 current_node를 영구 null로 못박음 → 목록의 '현재 노드' 컬럼은 production에서 항상 '—'(조용한 false).
  // 컬럼을 제거했으므로 헤더가 부활하지 않음을 단언(항상-null 컬럼 차단). 진짜 '현재 단계'는 StepTrace가 정직하게 표시.
  test("실행 기록 목록에 항상-null '현재 노드' 컬럼이 없다(조용한 false 제거)", async () => {
    renderApp();
    location.hash = "#runTrace";
    // 목록 행(상세 버튼)이 마운트될 때까지 대기 후 헤더 부재 단언(다른 run-trace 테스트와 동일한 진입 신호).
    await screen.findByRole("button", { name: "상세" });
    expect(screen.queryByRole("columnheader", { name: "현재 노드" })).toBeNull();
  });

  // H1(R1) — suspended(사람 확인 대기) 상세에 연결된 사람 확인 업무 교차 동선 노출 + 클릭 시 해당 task 딥링크 이동.
  test("suspended → 연결된 사람 확인 업무 처리하기 동선 + 클릭 시 #humanTasks?ht 이동", async () => {
    renderApp(fakeClient({
      getRun: async (id) => ({ run_id: id, status: "suspended", worker_id: "w1", attempts: 1, as_of: null }),
      listHumanTasks: async (params) => ({
        items: [{
          human_task_id: "ht-linked",
          state: "open",
          kind: "approval",
          assignee: null,
          timeout: null,
          on_timeout: null,
          run_id: params?.run_id ?? null,
        }],
        next_cursor: null,
      }),
    }));
    await openDetail();
    const link = await screen.findByRole("button", { name: /연결된 사람 확인 업무 처리하기/ });
    link.click();
    await waitFor(() => expect(location.hash).toBe("#humanTasks?ht=ht-linked"));
  });

  // H2(R1, fabrication 가드) — 비-suspended(running)에는 인박스 동선을 만들지 않는다(관찰된 status로만 게이팅).
  test("running → '사람 확인 인박스' 동선 미표시(조용한 false 금지)", async () => {
    renderApp(); // 기본 픽스처 getRun = running
    await openDetail();
    // 상세 패널(상태 dl)이 마운트될 때까지 대기 후(detail resolve 신호) 동선 부재 단언.
    const panel = await screen.findByRole("region", { name: "실행 상세" });
    await waitFor(() => expect(within(panel).getByText("시도 횟수")).toBeInTheDocument());
    expect(within(panel).queryByRole("button", { name: /사람 확인 인박스에서 처리하기/ })).toBeNull();
  });

  test("실행 상세 산출물: JSON rows 결과 요약과 샘플을 바로 표시", async () => {
    renderApp(fakeClient({
      listRunArtifacts: async () => ({
        items: [{ artifact_id: "art-result-1", type: "extract_result_json", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-18T00:00:00.000Z" }],
        next_cursor: null,
      }),
      getArtifact: async (id) => ({
        artifact_id: id,
        type: "extract_result_json",
        sha256: "sha",
        redaction_status: "redacted",
        retention_until: null,
        content: JSON.stringify({ rows: [{ title: "공지 A", author: "Kim" }, { title: "공지 B", author: "Lee" }] }),
      }),
    }));
    await openDetail();
    expect(await screen.findByText("실행 결과·산출물")).toBeInTheDocument();
    expect(await screen.findByText("rows 2건")).toBeInTheDocument();
    expect(screen.getByText(/키 title, author/)).toBeInTheDocument();
    expect(screen.getByText(/공지 A/)).toBeInTheDocument();
  });

  test("실행 상세 산출물: media 메타데이터와 screenshot/video 배지를 표시하고 목록 민감 필드는 숨긴다", async () => {
    installObjectUrlMock();
    const screenshot = {
      artifact_id: "art-shot-1",
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
    renderApp(fakeClient({
      listRunArtifacts: async () => ({ items: [screenshot, video], next_cursor: null }),
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
      getArtifactBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    }));

    await openDetail();
    expect(await screen.findByText("checkout.png")).toBeInTheDocument();
    expect(screen.getByText("checkout.webm")).toBeInTheDocument();
    expect(screen.getByText("스크린샷 1")).toBeInTheDocument();
    expect(screen.getByText("동영상 1")).toBeInTheDocument();
    expect(screen.getByText("image/png · 1.2 MB")).toBeInTheDocument();
    expect(screen.getByText("video/webm · 2.0 MB · 3.5 s")).toBeInTheDocument();
    expect(screen.getByText("screenshot")).toBeInTheDocument();
    expect(screen.getByText("video")).toBeInTheDocument();
    expect(screen.queryByText("LIST_CONTENT_SHOULD_NOT_RENDER")).toBeNull();
    expect(screen.queryByText("s3://secret/object")).toBeNull();
    expect(screen.queryByText("LIST_SHA_SHOULD_NOT_RENDER")).toBeNull();
    const image = await screen.findByRole("img", { name: "checkout.png" });
    expect(image).toHaveAttribute("src", "blob:test-preview");
    expect(screen.getByRole("button", { name: "원본 다운로드" })).toBeInTheDocument();
    const videoRow = screen.getByText("checkout.webm").closest("tr");
    expect(videoRow).not.toBeNull();
    within(videoRow as HTMLElement).getByRole("button", { name: "미리보기" }).click();
    await waitFor(() => {
      const videoEl = document.querySelector("video");
      expect(videoEl).not.toBeNull();
      expect(videoEl).toHaveAttribute("aria-label", "checkout.webm");
      expect(videoEl).toHaveAttribute("controls");
      expect(videoEl).toHaveAttribute("src", "blob:test-preview");
    });
  });

  test("실행 상세 산출물: media_type 없는 video_masked도 영상 미리보기로 처리한다", async () => {
    installObjectUrlMock();
    renderApp(fakeClient({
      listRunArtifacts: async () => ({
        items: [{
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
        }],
        next_cursor: null,
      }),
      getArtifactBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" }),
    }));

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

  test("실행 상세 산출물: JSON보다 스크린샷 증거를 먼저 미리보기로 선택한다", async () => {
    installObjectUrlMock();
    renderApp(fakeClient({
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
        content: JSON.stringify({ rows: [{ title: "should not be initial preview" }] }),
      }),
      getArtifactBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    }));

    await openDetail();
    expect(await screen.findByText("스크린샷 1")).toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "step.png" });
    expect(image).toHaveAttribute("src", "blob:test-preview");
    expect(screen.queryByText(/should not be initial preview/)).toBeNull();
  });
});
