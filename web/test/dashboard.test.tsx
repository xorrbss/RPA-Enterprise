import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { DeadLetterItem, Paginated } from "../src/api/types";
import { fakeClient } from "./fake-client";

// 대시보드 관찰성 지표: run outcome 정확 집계(getRunSummary by_status) + run_success_rate + 절단 정직성(여전히
// 근사인 재처리 대기 카드) + 딥링크 모집단 정합. run-status 카드는 서버 GROUP BY 집계라 '50+' 근사가 아닌 정확 총계다.
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

function dl(id: string): DeadLetterItem {
  return { dead_letter_id: id, kind: "workitem", status: "DEAD_LETTER", source_id: null };
}

function dashboardClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeClient({
    getOpsHealth: async () => ({
      status: "warning",
      detected_at: "2026-06-23T09:10:00.000Z",
      queue: { available: true, pending_jobs: 4 },
      browser_leases: { reserved: 1, active: 2, draining: 0, expired: 0, expired_open: 1, next_expiry_at: null },
      stale_runs: { nonterminal_over_15m: 2, oldest_updated_at: "2026-06-23T08:30:00.000Z" },
    }),
    listOpsAlerts: async () => ({
      items: [
        {
          alert_id: "alert-run-sla-1",
          severity: "critical",
          source: "run_sla",
          title: "월말 정산 실행 SLA 초과",
          detail: "실행 run-ops-1이 목표 완료 시간을 초과했습니다.",
          subject_type: "run",
          subject_id: "run-ops-1",
          status: "open",
          recommended_action: "실행 기록에서 병목 단계를 확인하세요.",
          route: "#runTrace?run=run-ops-1",
          detected_at: "2026-06-23T09:01:00.000Z",
          due_at: null,
        },
        {
          alert_id: "alert-failure-spike-1",
          severity: "warning",
          source: "failure_spike",
          title: "실패 급증 감지",
          detail: "최근 15분 동안 실패한 실행이 3건 발생했습니다.",
          subject_type: "run",
          subject_id: null,
          status: "open",
          recommended_action: "공통 장애 여부를 점검하세요.",
          route: "#runTrace",
          detected_at: "2026-06-23T09:03:00.000Z",
          due_at: null,
        },
      ],
      next_cursor: null,
    }),
    ...overrides,
  });
}

async function findMetricButton(name: RegExp): Promise<HTMLButtonElement> {
  const buttons = await screen.findAllByRole("button", { name });
  const metric = buttons.find((button) => button.classList.contains("metric"));
  if (!(metric instanceof HTMLButtonElement)) throw new Error(`metric button not found: ${name}`);
  return metric;
}

describe("대시보드 관찰성 지표(run outcome 집계 + 성공률)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  // (a) run outcome 정확 집계: 카드 값은 getRunSummary.by_status에서 온다(서버 GROUP BY, 클라 50건 필터 아님).
  // 업무 실패=failed_business 2, 시스템 실패=failed_system 1. 서버 집계라 절단 '+' 없음.
  test("run-status 카드는 getRunSummary by_status 정확 카운트", async () => {
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { failed_business: 2, failed_system: 1, running: 3, completed: 9 }, success_rate: 0.9, total: 15, cache: { by_mode: {}, hit_rate: null } }),
      }),
    );
    const bizCard = await findMetricButton(/업무 실패/);
    const sysCard = await findMetricButton(/시스템 실패/);
    const runningCard = await findMetricButton(/실행 중/);
    await waitFor(() => expect(bizCard).toHaveTextContent("2"));
    await waitFor(() => expect(sysCard).toHaveTextContent("1"));
    await waitFor(() => expect(runningCard).toHaveTextContent("3"));
    expect(bizCard).not.toHaveTextContent("2+"); // 서버 집계라 절단 '+' 없음
  });

  // (a2) 실행 성공률: success_rate(0~1)를 정수 %로 표기.
  test("실행 성공률·캐시 재사용률 카드는 rate를 % 로 표기", async () => {
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { completed: 9, failed_system: 1 }, success_rate: 0.9, total: 10, cache: { by_mode: { hit: 4, miss: 1 }, hit_rate: 0.8 } }),
      }),
    );
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    await waitFor(() => expect(rateCard).toHaveTextContent("90%"));
    const cacheCard = await screen.findByRole("button", { name: /캐시 재사용률/ });
    await waitFor(() => expect(cacheCard).toHaveTextContent("80%")); // hit 4/(hit4+miss1)=80%
  });

  // (a3) 분모 0(종결 run 없음) → success_rate=null → '—'(0/0을 100%/0%로 단정하지 않음).
  test("성공률 분모 0이면 '—'(0/0 단정 금지)", async () => {
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { running: 2 }, success_rate: null, total: 2, cache: { by_mode: {}, hit_rate: null } }),
      }),
    );
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    await waitFor(() => expect(rateCard).toHaveTextContent("—"));
  });

  // (b) 절단 정직성: 여전히 근사(최신 50건)인 재처리 대기 카드는 next_cursor!==null이면 'N+'(총계 위장 금지 회귀 가드).
  test("근사 카드(재처리 대기)는 절단 시 'N+'(하한) 표기", async () => {
    renderApp(
      fakeClient({
        listDlq: async () => ({ items: [dl("d1"), dl("d2")], next_cursor: "more" }) as Paginated<DeadLetterItem>,
      }),
    );
    const dlqCard = await screen.findByRole("button", { name: /작업 항목 재처리 대기/ });
    await waitFor(() => expect(dlqCard).toHaveTextContent("2+"));
  });

  test("기술 추적값은 기본 표면에서 운영자 문구로 대체", async () => {
    const rawRunId = "run-raw-visible-12345678";
    renderApp(
      fakeClient({
        getRunSummary: async () => ({ by_status: { failed_system: 1, running: 1 }, success_rate: null, total: 2, cache: { by_mode: {}, hit_rate: null } }),
        listRuns: async (params) => {
          if (params?.status === "failed_system") {
            return { items: [{ run_id: rawRunId, status: "failed_system", current_node: null, as_of: null, failure_reason: { code: "RAW_SYSTEM_ERROR_CODE", message: "raw error" } }], next_cursor: null };
          }
          if (params?.status === "running") {
            return { items: [{ run_id: "run-running-raw-87654321", status: "running", current_node: null, as_of: null, updated_at: null, failure_reason: null }], next_cursor: null };
          }
          if (params?.status === "failed_business") return { items: [], next_cursor: null };
          return { items: [{ run_id: rawRunId, status: "failed_system", current_node: null, as_of: null, failure_reason: { code: "RAW_SYSTEM_ERROR_CODE", message: "raw error" } }], next_cursor: null };
        },
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-raw-visible-1", state: "open", kind: "raw_human_kind", assignee: null, timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
        listDlq: async (kind) => ({
          items: kind === "sink"
            ? [{ dead_letter_id: "dead-letter-sink-raw", kind: "sink", status: "DEAD_LETTER", source_id: null, sink_idempotency_key: "sink-key-raw-123" }]
            : [{ dead_letter_id: "dead-letter-work-raw", kind: "workitem", status: "DEAD_LETTER", source_id: "source-id-raw-123", reason_code: "RAW_REASON_CODE" }],
          next_cursor: null,
        }),
        listSites: async () => ({
          items: [{ site_profile_id: "site-profile-raw-123", risk: "red", approval_status: "pending", circuit_status: "closed" }],
          next_cursor: null,
        }),
      }),
    );

    expect(await screen.findByText("실패 사유 확인 필요")).toBeInTheDocument();
    expect(screen.getByText("확인 대기")).toBeInTheDocument();
    expect(screen.getByText("재처리 원인 확인 필요")).toBeInTheDocument();
    expect(screen.getByText("외부 전달 재처리")).toBeInTheDocument();
    expect(screen.getByText("사이트명 확인 필요")).toBeInTheDocument();

    const traceButton = await screen.findByRole("button", { name: "실행 추적 상세 보기" });
    expect(traceButton).toHaveTextContent("상세 보기");
    expect(traceButton).toHaveAttribute("title", `실행 추적 번호: ${rawRunId}`);

    const visibleText = document.body.textContent ?? "";
    expect(visibleText).not.toContain(rawRunId.slice(0, 8));
    expect(visibleText).not.toContain("RAW_SYSTEM_ERROR_CODE");
    expect(visibleText).not.toContain("raw_human_kind");
    expect(visibleText).not.toContain("sink-key-raw-123");
    expect(visibleText).not.toContain("dead-letter-work-raw");
    expect(visibleText).not.toContain("source-id-raw-123");
    expect(visibleText).not.toContain("RAW_REASON_CODE");
  });

  // (c) 딥링크 모집단 정합: 각 카드는 자기 단일 status로 드릴다운(카드 모집단↔RunTrace 시드 모집단 일치).
  test("업무 실패 카드 → #runTrace?status=failed_business", async () => {
    renderApp(fakeClient());
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    bizCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=failed_business"));
  });

  test("시스템 실패 카드 → #runTrace?status=failed_system", async () => {
    renderApp(fakeClient());
    const sysCard = await screen.findByRole("button", { name: /시스템 실패/ });
    sysCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=failed_system"));
  });

  test("실행 성공률 카드 → #runTrace?status=completed", async () => {
    renderApp(fakeClient());
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    rateCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=completed"));
  });

  test("첫 화면에 운영 헬스와 상위 알림을 표시하고 알림으로 이동한다", async () => {
    renderApp(dashboardClient());

    expect(await screen.findByRole("heading", { name: "운영 헬스와 긴급 알림" })).toBeInTheDocument();
    expect((await screen.findAllByText("주의")).length).toBeGreaterThan(0);
    expect(screen.getByText("큐 대기")).toBeInTheDocument();
    expect(screen.getByText("지연 실행")).toBeInTheDocument();
    expect(screen.getByText("만료 미회수 세션")).toBeInTheDocument();
    expect(screen.getByText("월말 정산 실행 SLA 초과")).toBeInTheDocument();
    expect(screen.getByText("실패 급증 감지")).toBeInTheDocument();
    expect(screen.getByText("실행 SLA · 실행 기록에서 병목 단계를 확인하세요.")).toBeInTheDocument();

    screen.getByRole("button", { name: "월말 정산 실행 SLA 초과" }).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-ops-1"));
  });

  test("운영 알림 미니 패널의 센터 버튼은 automationOps로 이동한다", async () => {
    renderApp(dashboardClient({ listOpsAlerts: async () => ({ items: [], next_cursor: null }) }));

    expect(await screen.findByText("긴급 운영 알림이 없습니다.")).toBeInTheDocument();
    screen.getByRole("button", { name: "알림 센터 열기" }).click();
    await waitFor(() => expect(location.hash).toBe("#automationOps"));
  });

  test("월간 자동화 성과 리포트가 ROI, 실패 Top N, CSV/XLSX export를 제공한다", async () => {
    const csvExportMonths: string[] = [];
    const pocExportMonths: string[] = [];
    const xlsxExportMonths: string[] = [];
    const createObjectURL = vi.fn(() => "blob:performance-csv");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    renderApp(
      dashboardClient({
        getAutomationPerformanceReport: async (month) => ({
          month: month ?? "2026-06",
          timezone: "Asia/Seoul",
          period_start: "2026-05-31T15:00:00.000Z",
          period_end: "2026-06-30T15:00:00.000Z",
          summary: {
            total_runs: 12,
            completed: 9,
            failed_business: 2,
            failed_system: 1,
            success_rate: 0.75,
            rerun_count: 2,
            reprocessing_rate: 0.16666666666666666,
            estimated_hours_saved: 18.5,
            estimated_value: 740000,
            gateway_cost: 1234,
          },
          failure_top: [{ code: "SITE_SELECTOR_MISSING", count: 2 }],
          by_workflow: [
            {
              scenario_id: "00000000-0000-4000-8000-0000000000a1",
              scenario_name: "Vendor invoice lookup",
              total_runs: 12,
              completed: 9,
              failed_business: 2,
              failed_system: 1,
              success_rate: 0.75,
              rerun_count: 2,
              reprocessing_rate: 0.16666666666666666,
              estimated_hours_saved: 18.5,
              estimated_value: 740000,
              gateway_cost: 1234,
            },
          ],
        }),
        exportAutomationPerformanceReportCsv: async (month) => {
          csvExportMonths.push(month ?? "");
          return "Summary\nmetric,value\nmonth,2026-06\n";
        },
        exportAutomationPerformanceReportPocMarkdown: async (month) => {
          pocExportMonths.push(month ?? "");
          return "# Automation Performance PoC Report\n\n## Decision Guide\n";
        },
        exportAutomationPerformanceReportXlsx: async (month) => {
          xlsxExportMonths.push(month ?? "");
          return new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          });
        },
      }),
    );

    const panel = await screen.findByRole("region", { name: "월간 자동화 성과 리포트" });
    fireEvent.change(within(panel).getByLabelText("월"), { target: { value: "2026-06" } });

    expect(await within(panel).findByText("Vendor invoice lookup")).toBeInTheDocument();
    expect(within(panel).getByText("SITE_SELECTOR_MISSING")).toBeInTheDocument();
    expect(within(panel).getByText("18.5h")).toBeInTheDocument();
    expect(within(panel).getAllByText("75%").length).toBeGreaterThan(0);

    fireEvent.click(within(panel).getByRole("button", { name: "CSV" }));

    await waitFor(() => expect(csvExportMonths).toEqual(["2026-06"]));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:performance-csv");
    expect(await within(panel).findByText("성과 리포트 CSV를 준비했습니다.")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "PoC MD" }));

    await waitFor(() => expect(pocExportMonths).toEqual(["2026-06"]));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(await within(panel).findByText(/POC_MARKDOWN/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "XLSX" }));

    await waitFor(() => expect(xlsxExportMonths).toEqual(["2026-06"]));
    expect(createObjectURL).toHaveBeenCalledTimes(3);
    expect(click).toHaveBeenCalledTimes(3);
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(await within(panel).findByText("성과 리포트 XLSX를 준비했습니다.")).toBeInTheDocument();
  });

  // (d) 최근 추세 패널: 스냅샷 지표를 일별 시계열로 보강(GET /v1/runs/trends). 성공률·처리량 스파크라인 + 현재값.
  test("최근 추세 패널: 성공률·처리량 스파크라인 + 현재값", async () => {
    renderApp(
      fakeClient({
        getRunTrends: async () => ({
          window_days: 30,
          timezone: "Asia/Seoul",
          points: [
            { day: "2026-06-23", completed: 2, failed_business: 0, failed_system: 0, total: 2, success_rate: 1 },
            { day: "2026-06-24", completed: 0, failed_business: 0, failed_system: 0, total: 0, success_rate: null },
            { day: "2026-06-25", completed: 3, failed_business: 0, failed_system: 1, total: 4, success_rate: 0.75 },
          ],
        }),
      }),
    );
    const panel = await screen.findByRole("region", { name: "실행 추세" });
    expect(await screen.findByRole("img", { name: /성공률 추세/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /처리량 추세/ })).toBeInTheDocument();
    await waitFor(() => expect(panel).toHaveTextContent("75%")); // 최근 non-null 성공률
    expect(panel).toHaveTextContent("6건"); // 처리량 합계 2+0+4
  });

  // (d2) 빈 시리즈 → 정직 표기(스냅샷을 0/100%로 단정하지 않음).
  test("추세 데이터 없음 → '표시할 추세 데이터가 없습니다.'", async () => {
    renderApp(fakeClient({ getRunTrends: async () => ({ window_days: 30, timezone: "Asia/Seoul", points: [] }) }));
    await screen.findByRole("region", { name: "실행 추세" });
    expect(await screen.findByText("표시할 추세 데이터가 없습니다.")).toBeInTheDocument();
  });

  // (d3) 성공률 전부 null(종결 run 0) → 성공률 '—' + 정직 문구, 처리량은 합계 표시.
  test("성공률 전부 null → 성공률 '—' + 정직 문구, 처리량 합계", async () => {
    renderApp(
      fakeClient({
        getRunTrends: async () => ({
          window_days: 7,
          timezone: "Asia/Seoul",
          points: [
            { day: "2026-06-24", completed: 0, failed_business: 0, failed_system: 0, total: 1, success_rate: null },
            { day: "2026-06-25", completed: 0, failed_business: 0, failed_system: 0, total: 2, success_rate: null },
          ],
        }),
      }),
    );
    const panel = await screen.findByRole("region", { name: "실행 추세" });
    await waitFor(() => expect(panel).toHaveTextContent("완료·실패한 실행이 아직 없습니다"));
    expect(panel).toHaveTextContent("3건"); // 처리량 1+2
  });
});
