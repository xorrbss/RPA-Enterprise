import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { NAV_GROUPS, VIEW_KEYS } from "../src/router";
import { fakeClient } from "./fake-client";

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

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}
const ALL_ROLES = ["viewer", "operator", "reviewer", "approver", "admin"];

describe("UX quick-wins (A)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
  });

  // A1 — 거짓 지표 수정: '실행 중'은 클라 필터가 아니라 서버 status 필터로 집계해야 한다.
  test("A1: '실행 중' 지표는 서버 status='running' 필터로 집계", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          return { items: [{ run_id: "r1", status: "running", current_node: null, as_of: null }], next_cursor: null };
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("최근 실행")).toBeInTheDocument());
    // 두 호출 중 정확히 하나가 status='running'(지표), 하나는 무필터(최근 실행 표).
    await waitFor(() => expect(calls.some((c) => c.status === "running")).toBe(true));
    expect(calls.some((c) => c.status === undefined)).toBe(true);
  });

  // A1 — 절단 정직성: next_cursor 있으면 'N+'(하한), 없으면 정확한 N. 페이지 길이를 총계처럼 보이지 않게.
  test("A1: 더 있으면 'N+', 없으면 정확한 수(조용한 false 금지)", async () => {
    renderApp(
      fakeClient({
        listRuns: async (p) =>
          p?.status === "running"
            ? { items: [1, 2, 3].map((n) => ({ run_id: `run-${n}`, status: "running", current_node: null, as_of: null })), next_cursor: "more" }
            : { items: [{ run_id: "run-1", status: "running", current_node: null, as_of: null }], next_cursor: null },
        listHumanTasks: async () => ({ items: [{ human_task_id: "h1", state: "open", kind: "approval", assignee: null, timeout: null, run_id: null }], next_cursor: null }),
      }),
    );
    const running = await screen.findByRole("button", { name: /실행 중/ });
    await waitFor(() => expect(running).toHaveTextContent("3+")); // 3건 + 더 있음 → 하한 표기
    const human = screen.getByRole("button", { name: /사람 확인 대기/ });
    expect(human).toHaveTextContent("1"); // next_cursor 없음 → 정확한 수
    expect(human).not.toHaveTextContent("1+");
  });

  // A2 — 죽은 대시보드 → 진입점: 지표 카드 클릭 시 해당 화면으로 이동.
  test("A2: 지표 카드 클릭 → 해당 화면으로 드릴다운", async () => {
    renderApp();
    const human = await screen.findByRole("button", { name: /사람 확인 대기/ });
    human.click();
    await waitFor(() => expect(location.hash).toBe("#humanTasks"));
  });

  // A2 — '최근 실행' 행 클릭 → run 드릴다운 딥링크.
  test("A2: 최근 실행 행 클릭 → #runTrace?run=<id>", async () => {
    renderApp();
    const idBtn = await screen.findByRole("button", { name: /상세 보기/ });
    idBtn.click();
    await waitFor(() => expect(location.hash).toContain("#runTrace?run=11111111-aaaa-bbbb-cccc-000000000001"));
  });

  // A3 — 증빙 UUID 복붙 제거: 단계 트레이스의 artifact_id 클릭 → 산출물 조회 자동 입력·조회(전체 uuid).
  test("A3: artifact_id 클릭 → ArtifactLookup 자동 조회(전체 uuid)", async () => {
    const fetched: string[] = [];
    renderApp(
      fakeClient({
        getArtifact: async (id) => {
          fetched.push(id);
          return { artifact_id: id, type: "screenshot", sha256: "abc", redaction_status: "redacted", retention_until: null, content: "masked" };
        },
      }),
    );
    location.hash = "#runTrace";
    (await screen.findByRole("button", { name: "상세" })).click(); // 실행 상세 열기
    const ref = await screen.findByRole("button", { name: /산출물 72000000-0000-0000-0000-000000000001/ });
    ref.click();
    await waitFor(() => expect(fetched).toContain("72000000-0000-0000-0000-000000000001")); // 8자리 축약 아닌 전체 uuid
  });

  // A4 — 빈 상태 진입 CTA: 권한 있으면 빈 목록 안에서 첫 자동화 만들기 유도, 클릭 시 작성 폼 오픈.
  test("A4: 빈 시나리오 목록의 CTA → 작성 폼 오픈(권한 있을 때)", async () => {
    renderApp(); // 기본 fake listScenarios = 빈 목록
    location.hash = "#scenarioStudio";
    const cta = await screen.findByRole("button", { name: "+ 첫 자동화 만들기" });
    cta.click();
    await waitFor(() => expect(screen.getByRole("region", { name: "자동화 작성" })).toBeInTheDocument()); // ScenarioForm 작성 폼 오픈
  });

  test("A4: viewer는 빈 상태 CTA 미노출(RBAC)", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp();
    location.hash = "#scenarioStudio";
    await waitFor(() => expect(screen.getByText(/저장된 시나리오가 없습니다/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ 첫 자동화 만들기" })).toBeNull();
  });

  // A6 — 셸 신뢰감: 역할 칩 + 사이드바 3그룹.
  test("A6: 탑바 역할 칩 표시(한국어 라벨)", async () => {
    renderApp();
    expect(await screen.findByText("관리자")).toBeInTheDocument(); // admin ∈ ALL_ROLES
    expect(screen.getByText("운영자")).toBeInTheDocument(); // operator
  });

  test("A6: 사이드바 3그룹 헤딩 + 11 nav item 유지", async () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByText("제작")).toBeInTheDocument();
    expect(within(nav).getByText("운영")).toBeInTheDocument();
    expect(within(nav).getByText("고급 설정")).toBeInTheDocument();
    expect(within(nav).getAllByRole("button")).toHaveLength(11); // 그룹화 후에도 11개 유지
  });

  // A6 회귀 가드: 그룹이 11개 뷰를 정확히 한 번씩 덮어야 한다(누락/중복 시 nav에서 사라짐).
  test("A6: NAV_GROUPS가 VIEW_KEYS를 정확히 분할", () => {
    const grouped = NAV_GROUPS.flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual([...VIEW_KEYS].sort());
    expect(grouped.length).toBe(VIEW_KEYS.length); // 중복 없음
  });
});
