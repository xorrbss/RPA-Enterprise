import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { RunResumeRequest, WebAttendedRunRequest } from "../src/api/types";
import { WebAttendedPanel } from "../src/views/orchestration/WebAttendedPanel";
import { fakeClient } from "./fake-client";

// 재감사 후속 3건 회귀 가드 — ① WebAttendedPanel raw enum/취소 톤(U4-3 원 대상), ② nav 효과 역할 게이팅(A3-1 잔여).
// (③ 알림 라우트 dead link 는 백엔드 int 테스트가 단언.)

const POLICY = {
  source: "ops-defaults.md#human_task.default_timeout",
  default_timeout_ms: 1_800_000,
  on_timeout: "fail" as const,
  allowed_kinds: ["approval"],
};

function attendedRequest(status: WebAttendedRunRequest["status"]): WebAttendedRunRequest {
  return {
    request_id: `req-${status}`,
    scenario_version_id: "sv-1",
    run_id: null,
    human_task_id: null,
    status,
    requested_by: "operator-a",
    request_idempotency_key: `key-${status}`,
    consent_summary: "동의 요약",
    consent_evidence_ref: null,
    input_refs: [],
    human_task_policy: POLICY,
    metadata: {},
    requested_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
    legal_hold: false,
  } as WebAttendedRunRequest;
}

function resumeRequest(status: RunResumeRequest["status"]): RunResumeRequest {
  return {
    request_id: `resume-${status}`,
    run_id: "run-1",
    human_task_id: "ht-1",
    status,
    previous_run_status: "suspended",
    requested_by: "operator-a",
    reason: null,
    human_task_policy: POLICY,
    requested_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
  } as RunResumeRequest;
}

function renderPanel(runRequests: readonly WebAttendedRunRequest[], resumeRequests: readonly RunResumeRequest[] = []): void {
  render(
    <WebAttendedPanel
      runRequests={runRequests}
      resumeRequests={resumeRequests}
      suspendedRuns={[]}
      isLoading={false}
      isError={false}
      canCreate={false}
      isCreating={false}
      createError={false}
      onCreate={() => {}}
      canResume={false}
      resumingRunId={null}
      resumeErrorRunId={null}
      onResume={() => {}}
    />,
  );
}

describe("WebAttendedPanel 라벨·톤 (U4-3 원 대상)", () => {
  test("상태 배지가 raw enum 대신 운영자 한국어로, 취소됨은 중립(muted) 톤", () => {
    renderPanel([attendedRequest("cancelled"), attendedRequest("run_queued"), attendedRequest("blocked")]);

    const cancelled = screen.getByText("취소됨");
    expect(cancelled.className).toContain("muted");
    expect(cancelled.className).not.toContain("red");
    expect(screen.getByText("실행 대기").className).toContain("green");
    expect(screen.getByText("차단됨").className).toContain("red");
    expect(screen.queryByText("cancelled")).toBeNull();
    expect(screen.queryByText("run_queued")).toBeNull();
  });

  test("재개 요청 상태·이전 실행 상태·타임아웃 동작도 한국어 라벨", () => {
    renderPanel([], [resumeRequest("reenqueued")]);

    expect(screen.getByText("재대기")).toBeInTheDocument();
    expect(screen.getByText(/이전 상태: 사람 확인 대기/)).toBeInTheDocument(); // suspended → badges statusLabel
    expect(screen.getByText("실패 처리")).toBeInTheDocument(); // on_timeout=fail
    expect(screen.queryByText("reenqueued")).toBeNull();
  });
});

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "granted-user", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(client = fakeClient()): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("nav 효과 역할 게이팅 (A3-1 잔여)", () => {
  beforeEach(() => {
    location.hash = "#myWork";
    // 토큰 클레임은 viewer뿐 — operator 메뉴(실행 예약·알림)는 토큰만 보면 안 보인다.
    localStorage.setItem("rpa.token", jwt(["viewer"]));
  });

  test("수동 부여된 operator 역할(서버 효과 역할)이 nav 메뉴에 반영된다", async () => {
    renderApp(
      fakeClient({
        getAuthReadiness: async () => ({
          ...(await fakeClient().getAuthReadiness()),
          current_principal: {
            subject_id: "granted-user",
            tenant_id: "t",
            roles: ["viewer", "operator"], // 토큰 viewer + 수동 부여 operator 합산
            source: "jwt",
            display_name: null,
            email: null,
          },
        }),
      }),
    );

    const nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    expect(await within(nav).findByRole("button", { name: /실행 예약·알림/ })).toBeInTheDocument();
  });

  test("부여가 없으면(서버=토큰 미러) operator 메뉴는 기존처럼 숨긴다", async () => {
    renderApp(); // 기본 fake = 토큰 미러(viewer)

    const nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(nav).queryByRole("button", { name: /실행 예약·알림/ })).toBeNull();
  });
});
