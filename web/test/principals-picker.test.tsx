import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 사람확인 담당자 '배정' picker — /v1/principals 담당자 디렉터리를 datalist로 노출(자유 입력 폴백 유지).
// 디렉터리 항목은 이름(display_name)으로 보이고 배정값은 sub. 디렉터리 밖 값도 자유 입력 가능(폴백).
const LABEL = "담당자(이름으로 선택 또는 ID 직접 입력)";

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
  test("배정 다이얼로그 — 담당자 디렉터리가 이름(label)+sub(value)로 datalist 렌더", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [OPEN_TASK], next_cursor: null }),
        listPrincipals: async () => ({
          items: [
            { principal_id: "a1000000-0000-0000-0000-000000000001", sub: "70000000-0000-0000-0000-0000000000c1", display_name: "홍길동", email: null, source: "manual" },
            { principal_id: "a1000000-0000-0000-0000-000000000002", sub: "auth0|jane", display_name: "제인", email: "jane@ex.com", source: "jwt" },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#humanTasks";
    fireEvent.click(await screen.findByRole("button", { name: "현재 페이지 1건 배정" }));
    const input = await screen.findByLabelText(LABEL);
    expect(input).toHaveAttribute("list"); // 자유 입력 + 제안 연결
    await waitFor(() => {
      // 배정값은 sub(value), 표시는 이름(label).
      const opt1 = document.querySelector<HTMLOptionElement>('option[value="70000000-0000-0000-0000-0000000000c1"]');
      const opt2 = document.querySelector<HTMLOptionElement>('option[value="auth0|jane"]');
      expect(opt1).not.toBeNull();
      expect(opt1?.label).toBe("홍길동");
      expect(opt2).not.toBeNull();
      expect(opt2?.label).toBe("제인");
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
