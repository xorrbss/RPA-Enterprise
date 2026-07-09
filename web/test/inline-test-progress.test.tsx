import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// E4: 인라인 테스트 진행 — 실행 시작이 화면을 튕기지 않고 같은 화면에서 배너+단계 오버레이로 관찰된다.
// suspended 는 resolve 후 서버가 자동 재개(R13) — UI는 폴링 지속만(resume 직접 호출 없음).

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

const SCENARIO = { scenario_id: "sc1", name: "리뷰 수집", version: 2, latest_version_id: "ver-9" };
const IR = {
  start: "open",
  nodes: {
    open: { what: [{ action: "observe", instruction: "목록이 보이는지 확인" }], next: "grab" }, // url_ref 없음 → 실행값 입력 불요
    grab: { what: [{ action: "extract", instruction: "리뷰를 읽는다" }], terminal: "success" },
  },
};

function client(over: Partial<ApiClient> = {}): ApiClient {
  return fakeClient({
    listScenarios: async () => ({ items: [SCENARIO], next_cursor: null }),
    getScenario: async (id) => ({ scenario_id: id, name: "리뷰 수집", version: 2, promotion_status: "prod", ir: IR }),
    ...over,
  });
}

describe("inline test progress (E4)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator", "admin"]));
  });

  test("실행 시작 → 화면 이동 없이 해시에 run 보존 + 진행 배너·단계 오버레이", async () => {
    location.hash = "#scenarioStudio?scenario=sc1&focus=test";
    renderApp(
      client({
        createRun: async () => ({ run_id: "run-e4-1", status: "queued", run_mode: "test", as_of: null }),
        getRun: async (id) => ({ run_id: id, status: "running", run_mode: "test", worker_id: null, attempts: 1, as_of: null, failure_reason: null }),
        listRunSteps: async () => ({
          items: [
            { step_id: "s1", node_id: "open", attempt: 1, action: "navigate", status: "success", cache_mode: "miss", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: null, exception: null },
            { step_id: "s2", node_id: "grab", attempt: 1, action: "extract", status: "started", cache_mode: "miss", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: null, exception: null },
          ],
          next_cursor: null,
        }),
      }),
    );

    // 스튜디오 목록 행의 실행 버튼(운영 실행)과 구분 — 워크벤치 영역으로 스코프.
    const workbench = await screen.findByRole("region", { name: "계획·테스트 작업대" });
    fireEvent.click(await within(workbench).findByRole("button", { name: "실행" }));
    fireEvent.click(await within(workbench).findByRole("button", { name: "실행 시작" }));

    await waitFor(() => expect(location.hash).toContain("run=run-e4-1"));
    expect(location.hash).toContain("#scenarioStudio"); // 화면을 튕기지 않는다
    expect(await screen.findByText("실행 중입니다 — 단계가 실시간으로 갱신됩니다.")).toBeInTheDocument();
    // 단계 오버레이: 성공/실행 중 배지가 카드에 붙는다.
    expect(await screen.findByText(/목록이 보이는지 확인/)).toBeInTheDocument();
    expect((await screen.findAllByText("성공")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("실행 중")).length).toBeGreaterThan(0);
  });

  test("완료 run 딥링크 복원 → 성공 배너(터미널)", async () => {
    location.hash = "#scenarioStudio?scenario=sc1&focus=test&run=run-done";
    renderApp(
      client({
        getRun: async (id) => ({ run_id: id, status: "completed", run_mode: "test", worker_id: null, attempts: 1, as_of: null, failure_reason: null }),
        listRunSteps: async () => ({ items: [], next_cursor: null }),
      }),
    );

    expect(await screen.findByText("테스트 성공! 아래 단계별 결과를 확인하세요.")).toBeInTheDocument();
  });

  test("suspended → 사람 확인 CTA(딥링크)만 — resume 직접 호출 없음", async () => {
    const resumeCalls: string[] = [];
    location.hash = "#scenarioStudio?scenario=sc1&focus=test&run=run-susp";
    renderApp(
      client({
        getRun: async (id) => ({ run_id: id, status: "suspended", run_mode: "test", worker_id: null, attempts: 1, as_of: null, failure_reason: null }),
        listRunSteps: async () => ({ items: [], next_cursor: null }),
        resumeRun: async (id) => {
          resumeCalls.push(id);
          return { run_id: id, status: "resume_requested", previous_status: "suspended" };
        },
      }),
    );

    expect(await screen.findByText(/사람의 확인이 필요해요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "사람 확인 처리하러 가기" }));
    await waitFor(() => expect(location.hash).toContain("#humanTasks"));
    expect(resumeCalls).toHaveLength(0);
  });

  test("실패 run → 원인 코드가 배너 아래 정직 표기(errorCodeLabel)", async () => {
    location.hash = "#scenarioStudio?scenario=sc1&focus=test&run=run-fail";
    renderApp(
      client({
        getRun: async (id) => ({
          run_id: id,
          status: "failed_system",
          run_mode: "test",
          worker_id: null,
          attempts: 1,
          as_of: null,
          failure_reason: { code: "NAVIGATION_TIMEOUT", message: "timeout" },
        }),
        listRunSteps: async () => ({ items: [], next_cursor: null }),
      }),
    );

    expect(await screen.findByText(/시스템 문제로 중단됐어요/)).toBeInTheDocument();
    expect(screen.getByText(/원인:/)).toBeInTheDocument();
  });
});
