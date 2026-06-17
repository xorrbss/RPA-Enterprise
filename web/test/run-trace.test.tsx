import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
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

  // H1(R1) — suspended(사람 확인 대기) 상세에 '사람 확인 인박스' 교차 동선 노출 + 클릭 시 #humanTasks 이동(막다른 길 해소).
  test("suspended → '사람 확인 인박스에서 처리하기' 동선 + 클릭 시 #humanTasks 이동", async () => {
    renderApp(fakeClient({ getRun: async (id) => ({ run_id: id, status: "suspended", worker_id: "w1", attempts: 1, as_of: null }) }));
    await openDetail();
    const link = await screen.findByRole("button", { name: /사람 확인 인박스에서 처리하기/ });
    link.click();
    await waitFor(() => expect(location.hash).toBe("#humanTasks"));
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
});
