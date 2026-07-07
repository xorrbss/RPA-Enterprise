import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { AutomationIdeaItem, AutomationIdeaStage } from "../src/api/types";
import { fakeClient } from "./fake-client";

function tokenWithRoles(roles: string[]): string {
  const payload = btoa(
    JSON.stringify({ sub: "11111111-0000-4000-8000-000000000001", roles }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.sig`;
}

function renderApp(client: ApiClient): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function ideaFixture(stage: AutomationIdeaStage = "assess"): AutomationIdeaItem {
  return {
    idea_id: "idea-approve",
    title: "Assess Ready Idea",
    description: "Browser workflow candidate ready for CoE approval.",
    business_owner: "finance-ops",
    department: "Finance",
    source: "manual",
    stage,
    priority: "high",
    score: 91,
    scenario_id: null,
    run_trigger_id: null,
    source_import_id: null,
    source_item_ref: null,
    source_lineage: {},
    created_by: "operator",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  };
}

describe("coe pipeline view", () => {
  beforeEach(() => {
    location.hash = "#coePipeline";
    localStorage.setItem("rpa.token", tokenWithRoles(["admin"]));
  });

  test("자동화 후보와 ROI 요약을 표시한다", async () => {
    renderApp(fakeClient());

    expect(await screen.findByRole("heading", { name: "자동화 후보 접수" })).toBeInTheDocument();
    expect((await screen.findAllByText("거래처 포털 지급 상태 확인")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("₩576,000")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "ROI 검토로 이동" })).toBeInTheDocument();
  });

  test("후보가 없으면 빈 상태를 명시한다", async () => {
    renderApp(fakeClient({ listAutomationIdeas: async () => ({ items: [], next_cursor: null }) }));

    expect(await screen.findByText("등록된 자동화 후보가 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("후보를 선택해 주세요.")).toBeInTheDocument();
  });

  test("후보 목록 실패를 오류 상태로 표시한다", async () => {
    renderApp(fakeClient({ listAutomationIdeas: async () => { throw new Error("network down"); } }));

    expect(await screen.findByRole("alert")).toHaveTextContent("자동화 후보 목록을 불러오지 못했습니다.");
    expect(screen.queryByText("등록된 자동화 후보가 없습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  test("후보 등록 버튼이 createAutomationIdea를 호출한다", async () => {
    const createAutomationIdea = vi.fn(fakeClient().createAutomationIdea);
    renderApp(fakeClient({ createAutomationIdea }));

    await screen.findByRole("heading", { name: "자동화 후보 접수" });
    fireEvent.click(screen.getByRole("button", { name: "후보 등록" }));

    await waitFor(() => expect(createAutomationIdea).toHaveBeenCalledTimes(1));
    expect(createAutomationIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "거래처 포털 지급 상태 확인",
        business_owner: "재무운영팀",
        department: "재무",
        source: "manual",
        priority: "high",
        score: 82,
      }),
      expect.any(String),
    );
  });

  test("발굴 출처를 선택해 후보 등록 payload에 반영한다", async () => {
    const createAutomationIdea = vi.fn(fakeClient().createAutomationIdea);
    renderApp(fakeClient({ createAutomationIdea }));

    await screen.findByRole("heading", { name: "자동화 후보 접수" });
    await screen.findByText("celonis-export");
    fireEvent.change(screen.getByLabelText("발굴 출처"), { target: { value: "process_mining" } });
    fireEvent.click(screen.getByRole("button", { name: "후보 등록" }));

    await waitFor(() => expect(createAutomationIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "process_mining",
        source_import_id: "63000000-0000-4000-8000-000000000001",
        source_item_ref: "candidate:vendor-status",
        source_lineage: expect.objectContaining({ source_system: "celonis-export" }),
      }),
      expect.any(String),
    ));
  });

  test("단계 전환과 ROI 저장이 실제 API 메서드로 연결된다", async () => {
    const transitionAutomationIdea = vi.fn(fakeClient().transitionAutomationIdea);
    const upsertRoiEstimate = vi.fn(fakeClient().upsertRoiEstimate);
    const recordRoiActualEvidence = vi.fn(fakeClient().recordRoiActualEvidence);
    renderApp(fakeClient({ transitionAutomationIdea, upsertRoiEstimate, recordRoiActualEvidence }));

    await screen.findAllByText("거래처 포털 지급 상태 확인");
    fireEvent.click(screen.getByRole("button", { name: "ROI 검토로 이동" }));
    await waitFor(() => expect(transitionAutomationIdea).toHaveBeenCalledWith(
      "61000000-0000-4000-8000-000000000001",
      "assess",
      expect.any(String),
    ));

    fireEvent.click(screen.getByRole("button", { name: "ROI 저장" }));
    await waitFor(() => expect(upsertRoiEstimate).toHaveBeenCalledWith(
      "61000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        frequency_per_month: 120,
        minutes_per_case: 8,
        exception_rate: 0.1,
        hourly_cost: 40000,
        implementation_effort: 3200000,
        platform_monthly_cost: 0,
        avoided_license_cost: 0,
      }),
      expect.any(String),
    ));

    fireEvent.click(screen.getByRole("button", { name: "실제값 저장" }));
    await waitFor(() => expect(recordRoiActualEvidence).toHaveBeenCalledWith(
      "61000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        actual_transaction_count: 0,
        actual_failure_rate: 0,
        human_intervention_minutes: 0,
        reprocessing_minutes: 0,
        metadata: { measurement_method: "manual_pilot_reconciliation" },
      }),
      expect.any(String),
    ));
  });

  test("자동화 연결 아이디어: 제안값 불러오기 → 건수/실패율 프리필 + 제안 배지 + 확정 저장 귀속", async () => {
    const linkedIdea = { ...ideaFixture("operate"), scenario_id: "00000000-0000-4000-8000-0000000000a1" };
    const getRoiActualSuggestion = vi.fn(fakeClient().getRoiActualSuggestion);
    const recordRoiActualEvidence = vi.fn(fakeClient().recordRoiActualEvidence);
    renderApp(fakeClient({
      listAutomationIdeas: async () => ({ items: [linkedIdea], next_cursor: null }),
      getRoiActualSuggestion,
      recordRoiActualEvidence,
    }));

    await screen.findAllByText("Assess Ready Idea");
    const loadButton = await screen.findByRole("button", { name: "운영 실행 실적 제안값 불러오기" });
    expect(loadButton).toBeEnabled();
    fireEvent.click(loadButton);

    await waitFor(() => expect(getRoiActualSuggestion).toHaveBeenCalledWith(
      "idea-approve",
      expect.objectContaining({ period_start: expect.any(String), period_end: expect.any(String) }),
    ));
    // 프리필: 건수/실패율만(개입/재처리 시간은 run 통계로 도출 불가 — 사람 입력 유지).
    await screen.findByText("제안값");
    expect(screen.getByText(/운영 실행 완료 12건·실패 2건 기준 제안/)).toBeInTheDocument();
    expect(screen.getByText(/저장 시 본인이 확정한 수치로 기록됩니다/)).toBeInTheDocument();
    const grid = screen.getByText("실제 처리 건수").closest(".coe-roi-grid") as HTMLElement;
    expect((within(grid).getByLabelText("실제 처리 건수") as HTMLInputElement).value).toBe("12");
    expect((within(grid).getByLabelText("실제 실패율") as HTMLInputElement).value).toBe("0.1429");
    expect((within(grid).getByLabelText("사람 개입 시간(분)") as HTMLInputElement).value).toBe("0");

    // 프리필 그대로 저장 → 확정은 사람의 저장이며 출처는 제안값으로 정직 귀속.
    fireEvent.click(screen.getByRole("button", { name: "실제값 저장" }));
    await waitFor(() => expect(recordRoiActualEvidence).toHaveBeenCalledWith(
      "idea-approve",
      expect.objectContaining({
        actual_transaction_count: 12,
        actual_failure_rate: 0.1429,
        metadata: { measurement_method: "prod_run_stats_prefill_operator_confirmed" },
      }),
      expect.any(String),
    ));
  });

  test("제안값을 사람이 고치면 배지가 사라지고 수기 확정으로 귀속된다", async () => {
    const linkedIdea = { ...ideaFixture("operate"), scenario_id: "00000000-0000-4000-8000-0000000000a1" };
    const recordRoiActualEvidence = vi.fn(fakeClient().recordRoiActualEvidence);
    renderApp(fakeClient({
      listAutomationIdeas: async () => ({ items: [linkedIdea], next_cursor: null }),
      recordRoiActualEvidence,
    }));

    await screen.findAllByText("Assess Ready Idea");
    fireEvent.click(await screen.findByRole("button", { name: "운영 실행 실적 제안값 불러오기" }));
    await screen.findByText("제안값");

    const grid = screen.getByText("실제 처리 건수").closest(".coe-roi-grid") as HTMLElement;
    fireEvent.change(within(grid).getByLabelText("실제 처리 건수"), { target: { value: "11" } });
    await waitFor(() => expect(screen.queryByText("제안값")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "실제값 저장" }));
    await waitFor(() => expect(recordRoiActualEvidence).toHaveBeenCalledWith(
      "idea-approve",
      expect.objectContaining({
        actual_transaction_count: 11,
        metadata: { measurement_method: "manual_pilot_reconciliation" },
      }),
      expect.any(String),
    ));
  });

  test("미연결 아이디어는 제안값 버튼이 비활성 + 연결 안내, 종결 0건이면 제안 없음 안내(값 미변경)", async () => {
    const getRoiActualSuggestion = vi.fn(async (ideaId: string, p: { period_start: string; period_end: string }) => ({
      automation_idea_id: ideaId,
      scenario_id: "00000000-0000-4000-8000-0000000000a1",
      period_start: p.period_start,
      period_end: p.period_end,
      run_mode: "prod" as const,
      total_runs: 1,
      completed_runs: 0,
      failed_runs: 0,
      suggested_actual_transaction_count: null,
      suggested_actual_failure_rate: null,
    }));
    const { unmount } = renderApp(fakeClient());
    await screen.findAllByText("거래처 포털 지급 상태 확인"); // 기본 fixture는 scenario 미연결
    const disabledButton = await screen.findByRole("button", { name: "운영 실행 실적 제안값 불러오기" });
    expect(disabledButton).toBeDisabled();
    expect(screen.getByText(/자동화를 연결하면 운영 실행 통계로 제안값을 채울 수 있습니다/)).toBeInTheDocument();
    unmount();

    const linkedIdea = { ...ideaFixture("operate"), scenario_id: "00000000-0000-4000-8000-0000000000a1" };
    renderApp(fakeClient({
      listAutomationIdeas: async () => ({ items: [linkedIdea], next_cursor: null }),
      getRoiActualSuggestion,
    }));
    await screen.findAllByText("Assess Ready Idea");
    fireEvent.click(await screen.findByRole("button", { name: "운영 실행 실적 제안값 불러오기" }));
    await screen.findByText(/이 기간에 집계할 종결된 운영 실행이 없어 제안값이 없습니다/);
    const grid = screen.getByText("실제 처리 건수").closest(".coe-roi-grid") as HTMLElement;
    expect((within(grid).getByLabelText("실제 처리 건수") as HTMLInputElement).value).toBe("0"); // 0 합성 없이 기본값 유지
    expect(screen.queryByText("제안값")).toBeNull();
  });

  test("pilot readiness evidence is shown and can be recorded", async () => {
    const recordAutomationAdoptionEvidence = vi.fn(fakeClient().recordAutomationAdoptionEvidence);
    renderApp(fakeClient({ recordAutomationAdoptionEvidence }));

    expect(await screen.findByRole("heading", { name: "파일럿 준비도 증빙" })).toBeInTheDocument();
    expect(screen.getAllByText("파일럿 차터").length).toBeGreaterThan(0);
    expect(await screen.findByText("ticket:PILOT-123")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "증빙 기록" }));

    await waitFor(() => expect(recordAutomationAdoptionEvidence).toHaveBeenCalledWith(
      "61000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        evidence_type: "pilot_charter_signoff",
        status: "valid",
        evidence_ref: "ticket:PILOT-123",
        summary: "CoE 담당자가 검토한 파일럿 준비도 증빙입니다.",
        metadata: { source: "coe_pipeline" },
      }),
      expect.any(String),
    ));
  });

  test("상세 패널은 승인 준비 상태를 보여준다", async () => {
    renderApp(fakeClient());

    expect(await screen.findByText("승인 준비 상태")).toBeInTheDocument();
    expect(await screen.findByText("ROI 저장됨")).toBeInTheDocument();
    expect(screen.getByText("자동화 설계안 필요")).toBeInTheDocument();
    expect(screen.getByText("운영 예약 필요")).toBeInTheDocument();
    expect(screen.getByText("보완 필요")).toBeInTheDocument();
    expect(screen.getByText("승인 전에 보완할 항목이 있습니다")).toBeInTheDocument();
    expect(screen.getByText("자동화 설계안을 연결해야 구축 착수 여부를 판단할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("운영 예약을 연결해야 실제 운영 전환 범위를 확인할 수 있습니다.")).toBeInTheDocument();
  });

  test("ROI와 실행 연결이 준비되면 승인 추천을 표시한다", async () => {
    renderApp(
      fakeClient({
        listAutomationIdeas: async () => ({
          items: [
            {
              idea_id: "idea-ready",
              title: "월마감 지급 확인",
              description: "월마감 지급 상태를 자동 확인합니다.",
              business_owner: "finance-ops",
              department: "재무",
              source: "manual",
              stage: "approved",
              priority: "high",
              score: 91,
              scenario_id: "scenario-linked",
              run_trigger_id: "trigger-linked",
              source_import_id: null,
              source_item_ref: null,
              source_lineage: {},
              created_by: "operator",
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    expect(await screen.findByText("승인 추천")).toBeInTheDocument();
    expect(screen.getByText("CoE 승인 요건을 충족합니다")).toBeInTheDocument();
    expect(screen.getByText("저장된 ROI, 자동화 설계안, 운영 예약이 모두 준비되어 구축 단계로 넘길 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("회수 기간 5.6개월 · 월 절감액 ₩576,000")).toBeInTheDocument();
  });

  test("ROI 입력값이 유효하지 않으면 저장을 막는다", async () => {
    const upsertRoiEstimate = vi.fn(fakeClient().upsertRoiEstimate);
    renderApp(fakeClient({ upsertRoiEstimate }));

    await screen.findByText("ROI 저장됨");
    fireEvent.change(screen.getByLabelText("예외율"), { target: { value: "1.2" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("예외율은 0에서 1 사이여야 합니다.");
    expect(screen.getByRole("button", { name: "ROI 저장" })).toBeDisabled();
    expect(upsertRoiEstimate).not.toHaveBeenCalled();
  });

  test("예상 월 절감액 지표 카드는 ROI 저장 부작용을 만들지 않는다", async () => {
    const upsertRoiEstimate = vi.fn(fakeClient().upsertRoiEstimate);
    renderApp(fakeClient({ upsertRoiEstimate }));

    expect(await screen.findByLabelText("예상 월 절감액")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /예상 월 절감액/ })).toBeNull();
    expect(upsertRoiEstimate).not.toHaveBeenCalled();
  });

  test("연결된 자동화 설계안과 운영 예약으로 딥링크 이동한다", async () => {
    renderApp(
      fakeClient({
        listAutomationIdeas: async () => ({
          items: [
            {
              idea_id: "idea-linked",
              title: "월마감 지급 확인",
              description: "월마감 지급 상태를 자동 확인합니다.",
              business_owner: "finance-ops",
              department: "재무",
              source: "manual",
              stage: "operate",
              priority: "high",
              score: 91,
              scenario_id: "scenario-linked",
              run_trigger_id: "trigger-linked",
              source_import_id: null,
              source_item_ref: null,
              source_lineage: {},
              created_by: "operator",
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
        listScenarios: async () => ({
          items: [
            {
              scenario_id: "scenario-linked",
              name: "월마감 지급 확인 봇",
              version: 2,
              latest_version_id: "scenario-version-linked",
              promotion_status: "prod",
            },
          ],
          next_cursor: null,
        }),
        listRunTriggers: async () => ({
          items: [
            {
              trigger_id: "trigger-linked",
              scenario_version_id: "scenario-version-linked",
              trigger_type: "cron",
              status: "enabled",
              cron_expression: "0 9 * * *",
              timezone: "Asia/Seoul",
              webhook_secret_ref: null,
              params: {},
              catchup_policy: "skip_missed",
              max_concurrent_runs: 1,
              next_fire_at: "2026-06-24T00:00:00.000Z",
              created_by: "operator",
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    expect((await screen.findAllByText("월마감 지급 확인")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "자동화 설계안 보기" }));
    await waitFor(() => expect(location.hash).toBe("#playground?scenario=scenario-linked"));

    location.hash = "#coePipeline";
    fireEvent.click(await screen.findByRole("button", { name: "운영 예약 보기" }));
    await waitFor(() => expect(location.hash).toBe("#automationOps?trigger=trigger-linked"));
  });

  test("담당자·부서 필터를 서버 쿼리에 반영하고 우선순위 후보를 점수순으로 보여준다", async () => {
    const calls: Array<unknown> = [];
    renderApp(
      fakeClient({
        listAutomationIdeas: async (params) => {
          calls.push(params);
          return {
            items: [
              {
                idea_id: "idea-low",
                title: "월말 정산 상태 확인",
                description: "월말 정산 페이지에서 상태를 확인합니다.",
                business_owner: "finance-ops",
                department: "재무",
                source: "manual",
                stage: "assess",
                priority: "medium",
                score: 42,
                scenario_id: null,
                run_trigger_id: null,
                source_import_id: null,
                source_item_ref: null,
                source_lineage: {},
                created_by: "operator",
                created_at: "2026-06-23T00:00:00.000Z",
                updated_at: "2026-06-23T00:00:00.000Z",
              },
              {
                idea_id: "idea-high",
                title: "송장 검증 큐 자동화",
                description: "송장 증빙을 검증 큐로 라우팅합니다.",
                business_owner: "finance-ops",
                department: "재무",
                source: "manual",
                stage: "assess",
                priority: "critical",
                score: 94,
                scenario_id: null,
                run_trigger_id: null,
                source_import_id: null,
                source_item_ref: null,
                source_lineage: {},
                created_by: "operator",
                created_at: "2026-06-23T00:00:00.000Z",
                updated_at: "2026-06-23T00:00:01.000Z",
              },
            ],
            next_cursor: null,
          };
        },
      }),
    );

    expect(await screen.findByRole("heading", { name: "후보 선별" })).toBeInTheDocument();
    expect(screen.getAllByText("업무 담당자 접수").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("업무 담당자 필터"), { target: { value: "finance-ops" } });
    fireEvent.change(screen.getByLabelText("부서 필터"), { target: { value: "재무" } });

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ owner: "finance-ops", department: "재무" })));
    const high = (await screen.findAllByText("송장 검증 큐 자동화"))[0]!;
    const low = (await screen.findAllByText("월말 정산 상태 확인"))[0]!;
    expect(high.compareDocumentPosition(low) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const beforeReset = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(beforeReset);
      const last = calls[calls.length - 1] as Record<string, unknown>;
      expect(last.limit).toBe(50);
      expect(last).not.toHaveProperty("owner");
      expect(last).not.toHaveProperty("department");
    });
  });

  test("후보 목록 next_cursor가 있으면 더 보기로 누적하고 KPI를 불러온 범위로 표시한다", async () => {
    const calls: Array<unknown> = [];
    const first = {
      ...ideaFixture("assess"),
      idea_id: "idea-first-page",
      title: "첫 페이지 후보",
      score: 81,
      updated_at: "2026-06-23T00:00:00.000Z",
    };
    const second = {
      ...ideaFixture("approved"),
      idea_id: "idea-second-page",
      title: "두 번째 페이지 후보",
      score: 95,
      updated_at: "2026-06-23T00:00:01.000Z",
    };
    renderApp(
      fakeClient({
        listAutomationIdeas: async (params) => {
          calls.push(params);
          if (params?.cursor === "ideas-page-2") {
            return { items: [second], next_cursor: null };
          }
          return { items: [first], next_cursor: "ideas-page-2" };
        },
      }),
    );

    expect((await screen.findAllByText("첫 페이지 후보")).length).toBeGreaterThan(0);
    expect(screen.getByText("현재 필터 1+건")).toBeInTheDocument();
    expect(screen.getByText("불러온 범위 기준")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));

    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ cursor: "ideas-page-2" })),
    );
    expect((await screen.findAllByText("두 번째 페이지 후보")).length).toBeGreaterThan(0);
    expect(screen.getByText("현재 필터 2건")).toBeInTheDocument();
    expect(screen.getByText("전체 필터 결과")).toBeInTheDocument();
  });

  test("자동화 설계안 딥링크가 선택 후보 연결값을 채운다", async () => {
    location.hash = "#coePipeline?scenario=scenario-linked";
    const updateAutomationIdea = vi.fn(fakeClient().updateAutomationIdea);
    renderApp(
      fakeClient({
        updateAutomationIdea,
        listAutomationIdeas: async () => ({
          items: [
            {
              idea_id: "idea-prefill",
              title: "녹화 저장 업무",
              description: "녹화로 만든 업무를 CoE 후보에 연결합니다.",
              business_owner: "finance-ops",
              department: "재무",
              source: "manual",
              stage: "build",
              priority: "high",
              score: 88,
              scenario_id: null,
              run_trigger_id: null,
              source_import_id: null,
              source_item_ref: null,
              source_lineage: {},
              created_by: "operator",
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
        listScenarios: async () => ({
          items: [
            {
              scenario_id: "scenario-default",
              name: "기존 업무",
              version: 1,
              latest_version_id: "scenario-version-default",
              promotion_status: "draft",
            },
            {
              scenario_id: "scenario-linked",
              name: "녹화 저장 업무",
              version: 1,
              latest_version_id: "scenario-version-linked",
              promotion_status: "draft",
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    await screen.findByRole("option", { name: "녹화 저장 업무 · 1차 자동화안" });
    await waitFor(() => expect(screen.getAllByRole("combobox").some((item) => (item as HTMLSelectElement).value === "scenario-linked")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "연결 저장" }));

    await waitFor(() => expect(updateAutomationIdea).toHaveBeenCalledWith(
      "idea-prefill",
      expect.objectContaining({ scenario_id: "scenario-linked", run_trigger_id: null }),
      expect.any(String),
    ));
  });

  test("다른 자동화 설계안의 운영 예약은 연결할 수 없다", async () => {
    location.hash = "#coePipeline?scenario=scenario-linked";
    const updateAutomationIdea = vi.fn(fakeClient().updateAutomationIdea);
    renderApp(
      fakeClient({
        updateAutomationIdea,
        listAutomationIdeas: async () => ({
          items: [
            {
              idea_id: "idea-mismatch",
              title: "예약 불일치 검증",
              description: "다른 자동화 예약 연결을 막습니다.",
              business_owner: "finance-ops",
              department: "재무",
              source: "manual",
              stage: "build",
              priority: "high",
              score: 80,
              scenario_id: null,
              run_trigger_id: null,
              source_import_id: null,
              source_item_ref: null,
              source_lineage: {},
              created_by: "operator",
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
        listScenarios: async () => ({
          items: [
            {
              scenario_id: "scenario-linked",
              name: "녹화 저장 업무",
              version: 1,
              latest_version_id: "scenario-version-linked",
              promotion_status: "draft",
            },
          ],
          next_cursor: null,
        }),
        listRunTriggers: async () => ({
          items: [
            {
              trigger_id: "trigger-mismatch",
              scenario_version_id: "scenario-version-other",
              trigger_type: "cron",
              status: "enabled",
              cron_expression: "0 9 * * *",
              timezone: "Asia/Seoul",
              webhook_secret_ref: null,
              params: {},
              catchup_policy: "skip_missed",
              max_concurrent_runs: 1,
              next_fire_at: null,
              created_by: "operator",
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    expect(await screen.findByRole("option", { name: "정기 실행 예약 · 운영 중 · 대상 자동화 확인 필요" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("combobox").some((item) => (item as HTMLSelectElement).value === "scenario-linked")).toBe(true));
    fireEvent.change(screen.getByRole("combobox", { name: "운영 예약 연결" }), { target: { value: "trigger-mismatch" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("다른 자동화 설계안");
    expect(screen.getByRole("button", { name: "연결 저장" })).toBeDisabled();
    expect(updateAutomationIdea).not.toHaveBeenCalled();
  });

  test("operator can manage ideas but cannot approve or reject CoE candidates", async () => {
    localStorage.setItem("rpa.token", tokenWithRoles(["operator"]));
    const transitionAutomationIdea = vi.fn(fakeClient().transitionAutomationIdea);
    const view = renderApp(
      fakeClient({
        listAutomationIdeas: async () => ({ items: [ideaFixture("assess")], next_cursor: null }),
        transitionAutomationIdea,
      }),
    );

    expect((await screen.findAllByText("Assess Ready Idea")).length).toBeGreaterThan(0);
    const stageRail = await waitFor(() => {
      const element = view.container.querySelector(".stage-rail");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const buttons = within(stageRail).getAllByRole("button");

    expect(buttons).toHaveLength(3);
    expect(buttons.filter((button) => button.hasAttribute("disabled"))).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(transitionAutomationIdea).not.toHaveBeenCalled();
    expect(screen.getByText("승인·반려는 승인자 권한 필요")).toBeInTheDocument();
  });

  test("approver can move an assessed CoE candidate to approved", async () => {
    localStorage.setItem("rpa.token", tokenWithRoles(["approver"]));
    const transitionAutomationIdea = vi.fn(fakeClient().transitionAutomationIdea);
    const view = renderApp(
      fakeClient({
        listAutomationIdeas: async () => ({ items: [ideaFixture("assess")], next_cursor: null }),
        transitionAutomationIdea,
      }),
    );

    expect((await screen.findAllByText("Assess Ready Idea")).length).toBeGreaterThan(0);
    const stageRail = await waitFor(() => {
      const element = view.container.querySelector(".stage-rail");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const buttons = within(stageRail).getAllByRole("button");

    expect(buttons.every((button) => !button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(transitionAutomationIdea).toHaveBeenCalledWith("idea-approve", "approved", expect.any(String)),
    );
  });
});
