import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 사람확인 담당자 '배정' picker — /v1/principals 제안 목록을 datalist로 노출(자유 입력 폴백 유지).
// 표시명 소스가 없어 식별자(principal_id)만 제안한다(날조 금지). 백엔드 reads.ts가 distinct union을 투영.
const LABEL = "담당자(목록에서 선택 또는 ID 직접 입력)";

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
const OPEN_TASK = { human_task_id: "73000000-0000-0000-0000-0000000000a2", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null };

describe("담당자 배정 picker(/v1/principals datalist)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  // 제안 목록이 datalist option으로 렌더되고, 입력은 자유형(list 연결) — 목록 밖 값도 허용(폴백).
  test("배정 다이얼로그 — principals가 datalist 제안으로 렌더", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [OPEN_TASK], next_cursor: null }),
        listPrincipals: async () => ({ items: [{ principal_id: "70000000-0000-0000-0000-0000000000c1" }, { principal_id: "auth0|jane" }], next_cursor: null }),
      }),
    );
    location.hash = "#humanTasks";
    fireEvent.click(await screen.findByRole("button", { name: "현재 페이지 1건 배정" }));
    const input = await screen.findByLabelText(LABEL);
    expect(input).toHaveAttribute("list"); // 자유 입력 + 제안 연결
    await waitFor(() => {
      expect(document.querySelector('option[value="70000000-0000-0000-0000-0000000000c1"]')).not.toBeNull();
      expect(document.querySelector('option[value="auth0|jane"]')).not.toBeNull();
    });
  });

  // 제안이 비어도(목록 0건) 입력은 렌더 — 자유 입력 폴백(조용한 차단 금지).
  test("principals 비어도 자유 입력 폴백 유지", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [OPEN_TASK], next_cursor: null }),
        listPrincipals: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash = "#humanTasks";
    fireEvent.click(await screen.findByRole("button", { name: "현재 페이지 1건 배정" }));
    const input = await screen.findByLabelText(LABEL);
    expect(input).toBeInTheDocument();
    expect(document.querySelectorAll("datalist option").length).toBe(0); // 제안 0 — 그래도 입력 가능
  });
});
