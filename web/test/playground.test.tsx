import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

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

const SCENARIO = { scenario_id: "sc1", name: "리뷰 수집", version: 2, latest_version_id: "ver-9" };
const withScenario = (over: Partial<ApiClient> = {}): ApiClient =>
  fakeClient({
    listScenarios: async () => ({ items: [SCENARIO], next_cursor: null }),
    getScenario: async (id) => ({ scenario_id: id, name: "리뷰 수집", version: 2, promotion_status: "prod", ir: { start: "open", nodes: { open: { what: [{ action: "observe" }], next: "done" }, done: { terminal: "success" } } } }),
    ...over,
  });

describe("테스트 실행(Playground) — 계획 미리보기 + 실제 실행 시작", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("자연어 자동화 만들기 CTA는 생성 화면으로 이동한다", async () => {
    renderApp(fakeClient({ listScenarios: async () => ({ items: [], next_cursor: null }) }));
    location.hash = "#playground";

    fireEvent.click(await screen.findByRole("button", { name: "자연어로 자동화 만들기" }));

    await waitFor(() => expect(location.hash).toBe("#scenarioStudio"));
  });

  test("시나리오 목록의 계획 확인은 Playground 선택 딥링크로 이동한다", async () => {
    renderApp(withScenario());
    location.hash = "#scenarioStudio";

    fireEvent.click(await screen.findByRole("button", { name: "계획 확인" }));

    await waitFor(() => expect(location.hash).toBe("#playground?scenario=sc1"));
  });

  test("Playground scenario 딥링크는 선택값과 실행 계획을 복원한다", async () => {
    renderApp(withScenario());
    location.hash = "#playground?scenario=sc1";

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("sc1"));
    await waitFor(() => expect(screen.getByText(/open★/)).toBeInTheDocument());
  });

  // 핵심 갭 수정: 자동화 선택 → 실제 실행(createRun) 시작이 이 화면에서 가능.
  test("자동화 선택 → '실행 시작'이 createRun(최신 버전) 디스패치", async () => {
    const calls: Array<{ sver: string; key: string }> = [];
    renderApp(withScenario({ createRun: async (body, key) => { calls.push({ sver: body.scenario_version_id, key }); return { run_id: "r1", status: "queued" }; } }));
    location.hash = "#playground";
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    (await screen.findByRole("button", { name: "실행" })).click(); // RunScenarioButton 패널 열기
    (await screen.findByRole("button", { name: "실행 시작" })).click(); // url_ref 키 없음 → 바로 실행
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.sver).toBe("ver-9"); // latest_version_id
    expect(calls[0]?.key.length).toBeGreaterThan(0); // Idempotency-Key
  });

  // 선택하면 실행 계획(단계)도 함께 미리보기.
  test("자동화 선택 → 실행 계획(단계) 표시", async () => {
    renderApp(withScenario());
    location.hash = "#playground";
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    await waitFor(() => expect(screen.getByText(/open/)).toBeInTheDocument()); // start 노드 표시
  });

  // F2(어휘/DRY): Plan의 action 라벨은 badges.actionLabel(계약 IRActionType 미러) 단일 출처를 쓴다.
  // 같은 단계가 '테스트 실행'과 '실행 기록'에서 다른 이름으로 보이던 드리프트(observe '관찰' vs '화면 확인' 등) 봉쇄.
  test("실행 계획 action 라벨 = 계약-미러(badges.actionLabel), 드리프트 라벨 부재", async () => {
    renderApp(
      withScenario({
        getScenario: async (id) => ({
          scenario_id: id,
          name: "리뷰 수집",
          version: 2,
          promotion_status: "prod",
          ir: {
            start: "look",
            nodes: {
              look: { what: [{ action: "observe" }], next: "do" },
              do: { what: [{ action: "act" }], next: "grab" },
              grab: { what: [{ action: "extract" }], next: "done" },
              done: { terminal: "success" },
            },
          },
        }),
      }),
    );
    location.hash = "#playground";
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    // 계약-미러 라벨(badges.actionLabel)로 표시.
    await waitFor(() => expect(screen.getByText(/화면 확인/)).toBeInTheDocument()); // observe
    expect(screen.getByText(/화면 조작/)).toBeInTheDocument(); // act
    expect(screen.getByText(/데이터 추출/)).toBeInTheDocument(); // extract
    // 옛 로컬 ACTION_LABEL 드리프트 라벨('관찰')은 부재 — 단일출처 수렴 회귀 봉쇄.
    expect(screen.queryByText(/관찰/)).toBeNull();
  });

  // 가치 루프: '실행 기록 보기'로 진행 확인 화면 이동.
  test("'실행 기록 보기' → #runTrace 이동", async () => {
    renderApp(withScenario());
    location.hash = "#playground";
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    (await screen.findByRole("button", { name: "실행 기록 보기" })).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace"));
  });

  // RBAC: viewer는 실행 버튼 미노출(읽기 전용), 미리보기·기록 링크는 가능.
  test("viewer는 '실행' 숨김, 미리보기는 가능", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp(withScenario());
    location.hash = "#playground";
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    expect(await screen.findByRole("button", { name: "실행 기록 보기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실행" })).toBeNull(); // run.create 미보유
  });

  // P0-1 "시작 → 관찰 직행": 실행 시작 성공 시 그 run의 산출물 중심 라이브 트레이스로 자동 드릴다운(수동 이동·UUID 복붙 제거).
  test("실행 시작 성공 → #runTrace?run=<생성된 run_id>&focus=artifacts 자동 드릴다운", async () => {
    renderApp(withScenario({ createRun: async () => ({ run_id: "run-xyz", status: "queued" }) }));
    location.hash = "#playground";
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    (await screen.findByRole("button", { name: "실행" })).click();
    (await screen.findByRole("button", { name: "실행 시작" })).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-xyz&focus=artifacts"));
  });
});
