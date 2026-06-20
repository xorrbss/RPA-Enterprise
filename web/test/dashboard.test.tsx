import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { DeadLetterItem, Paginated } from "../src/api/types";
import { fakeClient } from "./fake-client";

// 대시보드 관찰성 지표: run outcome 정확 집계(getRunSummary by_status) + run_success_rate + 절단 정직성(여전히
// 근사인 DLQ 카드) + 딥링크 모집단 정합. run-status 카드는 서버 GROUP BY 집계라 '50+' 근사가 아닌 정확 총계다.
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

function dl(id: string): DeadLetterItem {
  return { dead_letter_id: id, kind: "workitem", status: "DEAD_LETTER", source_id: null };
}

describe("대시보드 관찰성 지표(run outcome 집계 + 성공률)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  // (a) run outcome 정확 집계: 카드 값은 getRunSummary.by_status에서 온다(서버 GROUP BY, 클라 50건 필터 아님).
  // 업무 실패=failed_business 2, 시스템 실패=failed_system 1. 서버 집계라 절단 '+' 없음.
  test("run-status 카드는 getRunSummary by_status 정확 카운트", async () => {
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { failed_business: 2, failed_system: 1, running: 3, completed: 9 }, success_rate: 0.9, total: 15, cache: { by_mode: {}, hit_rate: null } }),
      }),
    );
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    const sysCard = await screen.findByRole("button", { name: /시스템 실패/ });
    const runningCard = await screen.findByRole("button", { name: /실행 중/ });
    await waitFor(() => expect(bizCard).toHaveTextContent("2"));
    await waitFor(() => expect(sysCard).toHaveTextContent("1"));
    await waitFor(() => expect(runningCard).toHaveTextContent("3"));
    expect(bizCard).not.toHaveTextContent("2+"); // 서버 집계라 절단 '+' 없음
  });

  // (a2) 실행 성공률: success_rate(0~1)를 정수 %로 표기.
  test("실행 성공률·캐시 재사용률 카드는 rate를 % 로 표기", async () => {
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { completed: 9, failed_system: 1 }, success_rate: 0.9, total: 10, cache: { by_mode: { hit: 4, miss: 1 }, hit_rate: 0.8 } }),
      }),
    );
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    await waitFor(() => expect(rateCard).toHaveTextContent("90%"));
    const cacheCard = await screen.findByRole("button", { name: /캐시 재사용률/ });
    await waitFor(() => expect(cacheCard).toHaveTextContent("80%")); // hit 4/(hit4+miss1)=80%
  });

  // (a3) 분모 0(종결 run 없음) → success_rate=null → '—'(0/0을 100%/0%로 단정하지 않음).
  test("성공률 분모 0이면 '—'(0/0 단정 금지)", async () => {
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { running: 2 }, success_rate: null, total: 2, cache: { by_mode: {}, hit_rate: null } }),
      }),
    );
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    await waitFor(() => expect(rateCard).toHaveTextContent("—"));
  });

  // (b) 절단 정직성: 여전히 근사(최신 50건)인 DLQ 카드는 next_cursor!==null이면 'N+'(총계 위장 금지 회귀 가드).
  test("근사 카드(DLQ)는 절단 시 'N+'(하한) 표기", async () => {
    renderApp(
      fakeClient({
        listDlq: async () => ({ items: [dl("d1"), dl("d2")], next_cursor: "more" }) as Paginated<DeadLetterItem>,
      }),
    );
    const dlqCard = await screen.findByRole("button", { name: /작업항목 DLQ/ });
    await waitFor(() => expect(dlqCard).toHaveTextContent("2+"));
  });

  // (c) 딥링크 모집단 정합: 각 카드는 자기 단일 status로 드릴다운(카드 모집단↔RunTrace 시드 모집단 일치).
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

  test("실행 성공률 카드 → #runTrace?status=completed", async () => {
    renderApp(fakeClient());
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    rateCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=completed"));
  });
});
