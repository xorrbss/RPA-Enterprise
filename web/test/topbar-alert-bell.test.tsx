import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { OpsAlertItem, ProductionReadiness } from "../src/api/types";
import { fakeClient } from "./fake-client";

// T1: 상단바 알림 벨 — env 옆 상시 "차단" 칩을 대체하는 단일 알림 진입점.
// 신호 보존(조용한 은폐 금지): readiness 차단·운영 알림 그룹 수가 배지·레이블로 노출된다.
// F4 §4.3: 클릭 즉시 이동 → 미리보기 팝오버로 의도 변경(readiness 차단 행 + severity 내림차순 그룹
// 상위 5행 + "알림 센터에서 모두 보기"). 닫힘 규약 = mousedown 바깥/Escape/트리거 포커스 복원.

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

const READY_READINESS: ProductionReadiness = {
  status: "ready",
  evaluated_at: "2026-07-10T00:00:00.000Z",
  environment: { target: "controlled_prod", tenant_id: "tenant-a" },
  summary: { controlled_prod_ready: true, status: "ready", blocker_count: 0, warning_count: 0, deferred_count: 0 },
  gates: [],
} as unknown as ProductionReadiness;

function alert(overrides: Partial<OpsAlertItem>): OpsAlertItem {
  return {
    alert_id: "al-1",
    severity: "warning",
    source: "run_sla",
    title: "장시간 실행 위험",
    detail: "run running over threshold",
    subject_type: "run",
    subject_id: "run-1",
    status: "open",
    delivery: { channel: "console", status: "delivered", delivered_at: "2026-07-10T00:00:00.000Z", external_delivery: false },
    ack: null,
    recommended_action: "실행 기록에서 확인하세요.",
    route: null,
    detected_at: "2026-07-10T00:00:00.000Z",
    due_at: null,
    ...overrides,
  } as OpsAlertItem;
}

describe("topbar alert bell", () => {
  beforeEach(() => {
    location.hash = "#dashboard";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("readiness blocked surfaces on the bell, and clicking opens the preview popover (no immediate navigation)", async () => {
    // fakeClient 기본 readiness = blocked(blocker_count 2)
    renderApp();

    const bell = await screen.findByRole("button", { name: /알림 — 운영 전환 준비 차단 2건/ });
    expect(bell).toHaveAttribute("aria-haspopup", "menu");
    expect(bell).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(bell);
    expect(location.hash).toBe("#dashboard"); // F4: 즉시 이동하지 않는다
    expect(bell).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "알림 미리보기" });
    expect(within(menu).getByRole("menuitem", { name: /운영 전환 준비 차단 2건/ })).toBeInTheDocument();
  });

  test("popover readiness blocker row deep-links to the production readiness section", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /알림 — 운영 전환 준비 차단 2건/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /운영 전환 준비 차단 2건/ }));

    await waitFor(() => expect(location.hash).toBe("#automationOps?section=readiness"));
    expect(screen.queryByRole("menu", { name: "알림 미리보기" })).toBeNull();
  });

  test("group rows sort by severity, show 외 N건, and navigate to the representative route", async () => {
    renderApp(
      fakeClient({
        getProductionReadiness: async () => READY_READINESS,
        listOpsAlerts: async () => ({
          items: [
            alert({ alert_id: "w1" }),
            alert({ alert_id: "w2" }), // run:run_sla 그룹 → 외 1건
            alert({
              alert_id: "c1",
              source: "session_expiry",
              subject_type: "browser_session",
              severity: "critical",
              title: "정산 사이트 로그인 세션 만료",
              route: "#security?section=sites&site=site-1",
            }),
          ],
          next_cursor: null,
        }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /알림 — 운영 알림 2건/ }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3); // critical 그룹 + warning 그룹 + 모두 보기
    expect(items[0]).toHaveTextContent("정산 사이트 로그인 세션 만료"); // critical 먼저(severity 내림차순)
    expect(items[0]).toHaveTextContent("로그인 세션 만료"); // opsAlertSourceLabel
    expect(items[1]).toHaveTextContent("장시간 실행 위험");
    expect(items[1]).toHaveTextContent("외 1건");
    expect(items[1]).toHaveTextContent("실행 SLA");

    fireEvent.click(items[0]!);
    await waitFor(() => expect(location.hash).toBe("#security?section=sites&site=site-1"));
    expect(screen.queryByRole("menu", { name: "알림 미리보기" })).toBeNull();
  });

  test("a group row without a route falls back to the alert center section", async () => {
    renderApp(
      fakeClient({
        getProductionReadiness: async () => READY_READINESS,
        listOpsAlerts: async () => ({ items: [alert({ route: null })], next_cursor: null }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /알림 — 운영 알림 1건/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /장시간 실행 위험/ }));
    await waitFor(() => expect(location.hash).toBe("#automationOps?section=alerts"));
  });

  test("'알림 센터에서 모두 보기' deep-links to the alert center", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /알림 — 운영 전환 준비 차단 2건/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /알림 센터에서 모두 보기/ }));
    await waitFor(() => expect(location.hash).toBe("#automationOps?section=alerts"));
  });

  test("Escape closes the popover and restores focus to the trigger", async () => {
    renderApp();

    const bell = await screen.findByRole("button", { name: /알림 — 운영 전환 준비 차단 2건/ });
    fireEvent.click(bell);
    fireEvent.keyDown(screen.getByRole("menu", { name: "알림 미리보기" }), { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "알림 미리보기" })).toBeNull();
    expect(document.activeElement).toBe(bell);
  });

  test("mousedown outside closes the popover", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /알림 — 운영 전환 준비 차단 2건/ }));
    expect(screen.getByRole("menu", { name: "알림 미리보기" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "알림 미리보기" })).toBeNull();
  });

  test("an observed empty list renders the honest empty row (never a fabricated zero while loading)", async () => {
    // 기본 listOpsAlerts = 빈 목록(관측된 0건) + readiness ready → 벨은 남고 팝오버가 0건을 문장으로 말한다.
    renderApp(fakeClient({ getProductionReadiness: async () => READY_READINESS }));

    fireEvent.click(await screen.findByRole("button", { name: /알림 — 새 알림 없음/ }));
    expect(screen.getByText("새 알림이 없습니다.")).toBeInTheDocument();
  });

  test("groups duplicate alerts before counting — same subject/source counts once", async () => {
    renderApp(
      fakeClient({
        getProductionReadiness: async () => READY_READINESS,
        listOpsAlerts: async () => ({
          items: [
            alert({ alert_id: "a1" }),
            alert({ alert_id: "a2" }),
            alert({ alert_id: "a3" }),
            alert({ alert_id: "a4", source: "session_expiry", subject_type: "browser_session", severity: "critical" }),
          ],
          next_cursor: null,
        }),
      }),
    );

    // run:run_sla ×3 → 1그룹, browser_session:session_expiry → 1그룹 = 알림 2건
    const bell = await screen.findByRole("button", { name: /알림 — 운영 알림 2건/ });
    expect(bell.querySelector(".alert-bell-count")?.textContent).toBe("2");
    expect(bell.querySelector(".alert-bell-count")).toHaveClass("red"); // critical 포함 → red
  });

  test("hides the bell when alerts are unreadable and no readiness blockers exist (no fake zero)", async () => {
    renderApp(
      fakeClient({
        getProductionReadiness: async () => READY_READINESS,
        listOpsAlerts: async () => {
          throw new Error("forbidden");
        },
      }),
    );

    await screen.findByRole("button", { name: /tenant\/environment 컨텍스트/ });
    expect(screen.queryByRole("button", { name: /^알림 — / })).toBeNull();
  });

  test("keeps the bell with an honest label when alerts fail but readiness is blocked", async () => {
    renderApp(
      fakeClient({
        listOpsAlerts: async () => {
          throw new Error("forbidden");
        },
      }),
    );

    const bell = await screen.findByRole("button", { name: /운영 전환 준비 차단 2건 · 운영 알림 확인 불가/ });
    expect(bell).toBeInTheDocument();
    // 팝오버도 실패를 문장으로 말한다(가짜 0 금지).
    fireEvent.click(bell);
    expect(screen.getByText("운영 알림을 확인할 수 없습니다.")).toBeInTheDocument();
  });
});
