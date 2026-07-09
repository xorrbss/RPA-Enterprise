import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { OpsAlertItem, ProductionReadiness } from "../src/api/types";
import { fakeClient } from "./fake-client";

// T1: 상단바 알림 벨 — env 옆 상시 "차단" 칩을 대체하는 단일 알림 진입점.
// 신호 보존(조용한 은폐 금지): readiness 차단·운영 알림 그룹 수가 배지·레이블로 노출된다.

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

  test("readiness blocked surfaces on the bell (not the context badge) and deep-links to the alert center", async () => {
    // fakeClient 기본 readiness = blocked(blocker_count 2)
    renderApp();

    const bell = await screen.findByRole("button", { name: /알림 — 운영 전환 준비 차단 2건/ });
    expect(bell).toBeInTheDocument();

    fireEvent.click(bell);
    expect(location.hash).toBe("#automationOps?section=alerts");
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

    expect(await screen.findByRole("button", { name: /운영 전환 준비 차단 2건 · 운영 알림 확인 불가/ })).toBeInTheDocument();
  });
});
