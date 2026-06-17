import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { Paginated, RunItem } from "../src/api/types";
import { fakeClient } from "./fake-client";

// 대시보드 실패 지표('업무 실패'/'시스템 실패' status별 카드) + 절단 정직성 + 딥링크 모집단 정합.
// 각 카드는 단일 status를 서버 필터로 집계하고 같은 단일 status 해시로 드릴다운한다 → 카운트·목록 모집단이 실제로 일치.
// smoke.test(500라인 한도)에서 의미 단위 분리(CLAUDE.md #7): 신규 status-분기 fake가 필요하므로 별도 파일.
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
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function run(id: string, status: string): RunItem {
  return { run_id: id, status, current_node: null, as_of: null };
}

describe("대시보드 실패 지표(업무/시스템 status별 카드)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  // (a) status별 집계: '업무 실패' 카드는 failed_business 2건('2'), '시스템 실패' 카드는 failed_system 1건('1').
  // 각 카드가 자기 단일 status만 정확히 세고(클라 필터 아님), 두 status 모두 서버 필터로 조회됨을 검증.
  test("failed_business/failed_system를 서버 status 필터로 각각 집계 → 카드별 단일 모집단", async () => {
    const statuses: Array<string | undefined> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          statuses.push(p?.status as string | undefined);
          if (p?.status === "failed_business") {
            return { items: [run("fb-1", "failed_business"), run("fb-2", "failed_business")], next_cursor: null } as Paginated<RunItem>;
          }
          if (p?.status === "failed_system") {
            return { items: [run("fs-1", "failed_system")], next_cursor: null } as Paginated<RunItem>;
          }
          return { items: [], next_cursor: null } as Paginated<RunItem>;
        },
      }),
    );
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    const sysCard = await screen.findByRole("button", { name: /시스템 실패/ });
    await waitFor(() => expect(bizCard).toHaveTextContent("2"));
    await waitFor(() => expect(sysCard).toHaveTextContent("1"));
    expect(bizCard).not.toHaveTextContent("2+");
    expect(sysCard).not.toHaveTextContent("1+");
    // 두 실패 status가 모두 서버 필터로 조회됐다(클라 측 단일조회 후 필터 아님).
    expect(statuses).toContain("failed_business");
    expect(statuses).toContain("failed_system");
  });

  // (b) 절단 정직성: 페이지가 next_cursor!==null이면 카드도 'N+'(총계 위장 금지 회귀 가드).
  test("절단된 카드는 'N+'(하한)으로 표기", async () => {
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          if (p?.status === "failed_business") {
            return { items: [run("fb-1", "failed_business"), run("fb-2", "failed_business")], next_cursor: "more" } as Paginated<RunItem>;
          }
          return { items: [], next_cursor: null } as Paginated<RunItem>;
        },
      }),
    );
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    await waitFor(() => expect(bizCard).toHaveTextContent("2+")); // 절단 → 하한 표기
  });

  // (c) 딥링크 모집단 정합: 각 카드는 자기 단일 status로 드릴다운한다 — 카드 카운트 모집단(단일 status)과
  // 해시가 RunTrace에 시드하는 목록 모집단(같은 단일 status)이 실제로 일치한다(부분 모집단 오표상 없음).
  // 클릭 후 RunTrace 화면으로 이동해 대시보드 카드가 사라지므로 카드별 독립 렌더로 검증.
  test("업무 실패 카드 → #runTrace?status=failed_business", async () => {
    renderApp(fakeClient());
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    bizCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=failed_business"));
  });

  test("시스템 실패 카드 → #runTrace?status=failed_system", async () => {
    renderApp(fakeClient());
    const sysCard = await screen.findByRole("button", { name: /시스템 실패/ });
    sysCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=failed_system"));
  });

  // 정직성: 부제는 화면이 실제 렌더하는 지표만 약속(렌더되지 않는 'AI 비용'/보안 카드를 약속하지 않음).
  test("대시보드 부제가 'AI 비용'을 약속하지 않는다(미렌더 지표 거짓안내 금지)", async () => {
    renderApp(fakeClient());
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    expect(bizCard).toBeInTheDocument(); // 표시되는 지표는 존재
    const sub = document.querySelector(".sub");
    expect(sub?.textContent ?? "").not.toContain("AI 비용");
  });
});
