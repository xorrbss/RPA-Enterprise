import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { ListParams } from "../src/api/types";
import { fakeClient } from "./fake-client";

// 실행 식별성(S1) — 실행 표면(목록·상세·랜딩 딥링크)에서 "어떤 자동화의 실행인지"가 업무 언어(이름)로
// 읽히고, 원인 확인 자리(상세 패널)에서 원본 입력값 프리필로 재실행까지 이어지는지 잠근다.
// 원시 추적 번호는 기존 정책대로 셀에 노출하지 않는다(툴팁 전용).

const SCEN = "70000000-0000-0000-0000-0000000000a1";
const RUN = "11111111-aaaa-bbbb-cccc-000000000001";

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
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("run identity (S1)", () => {
  beforeEach(() => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("실행 목록: 자동화 이름 렌더 + 딥링크 scenario 파라미터가 서버 필터로 시드된다", async () => {
    location.hash = `#runTrace?scenario=${SCEN}`;
    const listCalls: ListParams[] = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          listCalls.push(p ?? {});
          return {
            items: [
              {
                run_id: RUN,
                status: "completed",
                scenario_id: SCEN,
                scenario_name: "하이웍스 결재 수집",
                current_node: null,
                as_of: "2026-06-25T00:00:00.000Z",
                failure_reason: null,
              },
            ],
            next_cursor: null,
          };
        },
      }),
    );

    expect(await screen.findByText("하이웍스 결재 수집")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "자동화" })).toBeInTheDocument();
    await waitFor(() => {
      expect(listCalls.some((p) => p.scenario_id === SCEN)).toBe(true);
    });
    // T6(감사 P1-9)로 정책 개정: 축약 실행 번호(#8자)를 이름 아래 병기 — 같은 자동화의 실행 여러 건이
    // 기준 시각까지 같으면 구분 불가했다. 전체 원시 번호는 여전히 셀 텍스트에 없다(툴팁·상세 전용).
    expect(screen.getByText(`#${RUN.slice(0, 8)}`)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain(RUN.slice(0, 12));
  });

  test("같은 자동화·같은 기준 시각의 실행 두 건이 실행 번호로 구분된다 (T6)", async () => {
    location.hash = "#runTrace";
    const runBase = {
      status: "running",
      scenario_id: SCEN,
      scenario_name: "주문 수집 자동화",
      current_node: null,
      as_of: "2026-06-25T00:00:00.000Z",
      failure_reason: null,
    };
    renderApp(
      fakeClient({
        listRuns: async () => ({
          items: [
            { ...runBase, run_id: "aaaa1111-0000-4000-8000-000000000001" },
            { ...runBase, run_id: "bbbb2222-0000-4000-8000-000000000002" },
          ],
          next_cursor: null,
        }),
      }),
    );

    expect(await screen.findAllByText("주문 수집 자동화")).toHaveLength(2);
    expect(screen.getByText("#aaaa1111")).toBeInTheDocument();
    expect(screen.getByText("#bbbb2222")).toBeInTheDocument();
  });

  test("레거시 #myWork 해시는 만들기 홈으로 리다이렉트된다 (R4 은퇴·북마크 보존)", async () => {
    location.hash = "#myWork";
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [
            { scenario_id: SCEN, name: "메일 답장 수집", version: 1, latest_version_id: "70000000-0000-0000-0000-0000000000a2" },
          ],
          next_cursor: null,
        }),
      }),
    );

    await waitFor(() => expect(location.hash).toBe("#create"));
    expect(await screen.findByRole("heading", { level: 1, name: "만들기 콘솔" })).toBeInTheDocument();
  });

  test("실행 상세: 자동화 이름 표시 + 원본 입력값 프리필 '수정 입력으로 재실행'(타입 보존 강제)", async () => {
    location.hash = `#runTrace?run=${RUN}`;
    const rerunCalls: Array<{ body: { mode: string; params?: Record<string, unknown>; reason?: string | null } }> = [];
    renderApp(
      fakeClient({
        listRuns: async () => ({ items: [], next_cursor: null }),
        getRun: async () => ({
          run_id: RUN,
          status: "failed_business",
          scenario_id: SCEN,
          scenario_name: "메일 답장 수집",
          scenario_version_id: "70000000-0000-0000-0000-0000000000a2",
          worker_id: null,
          attempts: 1,
          as_of: "2026-06-25T00:00:00.000Z",
          params: { entry_url: "https://a.example/inbox", page_size: 10 },
          failure_reason: { code: "IR_SCHEMA_INVALID", message: "input missing" },
        }),
        rerunRun: async (runId, body) => {
          rerunCalls.push({ body });
          return {
            rerun_id: "77000000-0000-0000-0000-000000000003",
            source_run_id: runId,
            run_id: "77000000-0000-0000-0000-000000000004",
            status: "queued",
            mode: body.mode,
            as_of: "2026-06-26T00:00:00.000Z",
            run_mode: "prod",
          };
        },
      }),
    );

    // 자동화 이름이 상세에 보인다.
    expect(await screen.findByText("메일 답장 수집")).toBeInTheDocument();
    // 같은 입력 재실행이 패널 안에 있다(목록 복귀 불필요).
    expect(screen.getByRole("button", { name: "같은 입력 재실행" })).toBeInTheDocument();

    // 원본 입력값이 필드로 프리필되어 있다.
    const urlInput = screen.getByLabelText("entry_url");
    expect(urlInput).toHaveValue("https://a.example/inbox");
    fireEvent.change(urlInput, { target: { value: "https://b.example/inbox" } });
    const sizeInput = screen.getByLabelText("page_size");
    expect(sizeInput).toHaveValue("10");
    fireEvent.change(sizeInput, { target: { value: "12" } });

    fireEvent.click(screen.getByRole("button", { name: "수정 입력으로 재실행" }));
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]!);

    await waitFor(() => expect(rerunCalls).toHaveLength(1));
    // 숫자 파라미터는 숫자로 되돌려 보낸다(params_schema 검증 정합).
    expect(rerunCalls[0]!.body).toEqual({
      mode: "edited_input",
      params: { entry_url: "https://b.example/inbox", page_size: 12 },
      reason: "operator edited input",
    });
  });
});
