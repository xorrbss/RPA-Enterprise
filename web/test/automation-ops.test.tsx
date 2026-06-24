import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/types";
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
  const payload = btoa(JSON.stringify({ sub: "operator-a", tenant_id: "tenant-a", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.sig`;
}

function clientWithOpsData(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeClient({
    listScenarios: async () => ({
      items: [{
        scenario_id: "scenario-month-end",
        name: "월말 정산",
        version: 3,
        latest_version_id: "00000000-0000-0000-0000-0000000000c3",
        promotion_status: "prod",
      }],
      next_cursor: null,
    }),
    listRunTriggers: async () => ({
      items: [{
        trigger_id: "00000000-0000-0000-0000-00000000f001",
        scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
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
      }],
      next_cursor: null,
    }),
    listRunTriggerFires: async () => ({
      items: [
        {
          fire_id: "fire-1",
          trigger_id: "00000000-0000-0000-0000-00000000f001",
          fire_key: "cron:2026-06-23T09:00:00.000Z",
          status: "failed" as const,
          scheduled_for: "2026-06-23T09:00:00.000Z",
          run_id: "run-fire-1",
          failure_reason: { code: "CONTROL_PLANE_INTERNAL_ERROR" },
          created_at: "2026-06-23T09:00:01.000Z",
        },
        {
          fire_id: "fire-2",
          trigger_id: "00000000-0000-0000-0000-00000000f001",
          fire_key: "cron:2026-06-23T08:00:00.000Z",
          status: "skipped" as const,
          scheduled_for: "2026-06-23T08:00:00.000Z",
          run_id: null,
          failure_reason: { code: "MAX_CONCURRENCY_REACHED" },
          created_at: "2026-06-23T08:00:01.000Z",
        },
      ],
      next_cursor: null,
    }),
    getRunSummary: async () => ({
      by_status: { queued: 3, running: 2, failed_system: 1 },
      success_rate: 0.8,
      total: 12,
      cache: { by_mode: {}, hit_rate: null },
    }),
    listHumanTasks: async () => ({
      items: [{ human_task_id: "ht-1", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null }],
      next_cursor: null,
    }),
    listDlq: async () => ({
      items: [{ dead_letter_id: "dlq-1", kind: "workitem", status: "dead_letter", source_id: "wi-1" }],
      next_cursor: null,
    }),
    listOpsAlerts: async () => ({
      items: [
        {
          alert_id: "alert-run-sla-1",
          severity: "critical" as const,
          source: "run_sla" as const,
          title: "월말 정산 실행 SLA 초과",
          detail: "실행 run-ops-1이 목표 완료 시간을 12분 초과했습니다.",
          subject_type: "run" as const,
          subject_id: "run-ops-1",
          status: "open" as const,
          recommended_action: "실행 기록에서 병목 단계와 작업자 상태를 확인하세요.",
          route: "#runTrace?status=running",
          detected_at: "2026-06-23T09:01:00.000Z",
          due_at: "2026-06-23T08:49:00.000Z",
        },
        {
          alert_id: "alert-human-sla-1",
          severity: "warning" as const,
          source: "human_task_sla" as const,
          title: "결재 확인 지연",
          detail: "사람 작업 ht-1이 SLA 임계치에 접근했습니다.",
          subject_type: "human_task" as const,
          subject_id: "ht-1",
          status: "open" as const,
          recommended_action: "담당자에게 작업을 재배정하거나 에스컬레이션하세요.",
          route: "#humanTasks?ht=ht-1",
          detected_at: "2026-06-23T09:02:00.000Z",
          due_at: null,
        },
        {
          alert_id: "alert-failure-spike-1",
          severity: "warning" as const,
          source: "failure_spike" as const,
          title: "실패 급증 감지",
          detail: "최근 15분 동안 실패한 실행이 3건 발생했습니다.",
          subject_type: "run" as const,
          subject_id: null,
          status: "open" as const,
          recommended_action: "실행 기록에서 실패 원인을 확인하세요.",
          route: "#runTrace",
          detected_at: "2026-06-23T09:03:00.000Z",
          due_at: null,
        },
      ],
      next_cursor: null,
    }),
    getOpsHealth: async () => ({
      status: "critical" as const,
      detected_at: "2026-06-23T09:04:00.000Z",
      queue: { available: false, pending_jobs: null },
      browser_leases: { reserved: 1, active: 1, draining: 0, expired: 0, expired_open: 1, next_expiry_at: "2026-06-23T09:20:00.000Z" },
      stale_runs: { nonterminal_over_15m: 1, oldest_updated_at: "2026-06-23T08:30:00.000Z" },
    }),
    listBotPools: async () => ({
      items: [
        {
          bot_pool_id: "browser-default",
          name: "브라우저 실행 풀",
          kind: "browser",
          capacity_slots: 1,
          workers: { total: 2, active: 1, draining: 0, dead: 0, stale: 1, open_circuit: 0 },
          leases: { reserved: 1, active: 1, draining: 0, expired_open: 1, next_expiry_at: "2026-06-23T09:20:00.000Z" },
          queue: { pending_runs: 3, due_triggers: 1 },
          health: "critical" as const,
          health_reason: "만료된 활성 브라우저 lease 1건을 회수해야 합니다.",
        },
      ],
      next_cursor: null,
    }),
    listConnectors: async (params) => params?.kind === "notification" ? ({
      items: [{
        catalog_id: "90000000-0000-4000-8000-000000000004",
        connector_id: "teams-webhook",
        name: "Teams / Slack Webhook",
        kind: "notification",
        category: "Notification",
        status: "requires_admin",
        priority: "P1",
        summary: "Notification templates for run failure, SLA risk, and human-task escalation.",
        best_for: ["failure alert", "HITL escalation", "SLA risk notification"],
        supported_actions: ["notify", "webhook"],
        template_ids: ["ops-failure-alert"],
        required_rbac_actions: ["connector.read", "connector.enable"],
        required_secret_refs: ["secret://connectors/teams-webhook/*"],
        allowed_domains: ["hooks.slack.com"],
        manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://connectors/teams-webhook/*"] },
        implementation_state: "notification routing requires an approved dispatch adapter",
        security_notes: ["Webhook URLs are secrets."],
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }],
      next_cursor: null,
    }) : fakeClient().listConnectors(params),
    listTemplates: async (params) => params?.kind === "notification_workflow" ? ({
      items: [{
        catalog_id: "91000000-0000-4000-8000-000000000005",
        template_id: "ops-failure-alert",
        connector_id: "teams-webhook",
        name: "Ops failure alert",
        kind: "notification_workflow",
        status: "requires_admin",
        priority: "P1",
        summary: "Alert template for failed runs, SLA risk, and human task timeout escalation.",
        best_for: ["run failure", "SLA risk", "human-task timeout"],
        required_params: ["channel", "severity", "message_template"],
        required_secret_refs: ["secret://connectors/teams-webhook/*"],
        produced_ir_pattern: "event trigger -> notification dispatch -> audit decision",
        success_criteria: "Notification dispatch is acknowledged or a delivery DLQ row is created.",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }],
      next_cursor: null,
    }) : fakeClient().listTemplates(params),
    ...overrides,
  });
}

describe("automation ops view", () => {
  beforeEach(() => {
    location.hash = "#automationOps";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("큐 운영 수치를 기존 run summary와 대기 목록에서 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "운영 오케스트레이션" })).toBeInTheDocument();
    const queuedRow = (await screen.findByText("대기 실행")).closest("tr") as HTMLTableRowElement;
    const runningRow = screen.getByText("실행 중").closest("tr") as HTMLTableRowElement;
    const humanRow = screen.getByText("사람 확인 대기").closest("tr") as HTMLTableRowElement;
    const dlqRow = screen.getByText("작업 항목 재처리 대기").closest("tr") as HTMLTableRowElement;

    expect(within(queuedRow).getByText("3")).toBeInTheDocument();
    expect(within(runningRow).getByText("2")).toBeInTheDocument();
    expect(within(humanRow).getByText("1")).toBeInTheDocument();
    expect(within(dlqRow).getByText("1")).toBeInTheDocument();
  });

  test("큐 행의 보기 버튼은 실행 기록 필터로 이동한다", async () => {
    renderApp(clientWithOpsData());

    const queuedRow = (await screen.findByText("대기 실행")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(queuedRow).getByRole("button", { name: "보기" }));

    expect(location.hash).toBe("#runTrace?status=queued");
  });

  test("알림 센터는 열린 알림 2건과 권장 조치를 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "알림 센터" })).toBeInTheDocument();
    expect(await screen.findByText("월말 정산 실행 SLA 초과")).toBeInTheDocument();
    expect(await screen.findByText("결재 확인 지연")).toBeInTheDocument();
    expect(await screen.findByText("실패 급증 감지")).toBeInTheDocument();
    expect(screen.getAllByText("실패 급증").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("위험").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("주의").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("권장 조치: 실행 기록에서 병목 단계와 작업자 상태를 확인하세요.")).toBeInTheDocument();
    expect(screen.getByText("권장 조치: 담당자에게 작업을 재배정하거나 에스컬레이션하세요.")).toBeInTheDocument();
    const runAlert = screen.getByText("월말 정산 실행 SLA 초과").closest("li") as HTMLLIElement;
    const humanAlert = screen.getByText("결재 확인 지연").closest("li") as HTMLLIElement;
    const spikeAlert = screen.getByText("실패 급증 감지").closest("li") as HTMLLIElement;
    expect(within(runAlert).getByRole("button", { name: "실행 보기" })).toBeInTheDocument();
    expect(within(humanAlert).getByRole("button", { name: "사람 작업 보기" })).toBeInTheDocument();
    expect(within(spikeAlert).getByRole("button", { name: "실패 기록 보기" })).toBeInTheDocument();
  });

  test("알림 라우팅 준비도는 커넥터와 템플릿 승인 상태를 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "알림 라우팅" })).toBeInTheDocument();
    expect(await screen.findByText("승인 필요 2건")).toBeInTheDocument();
    expect(screen.getByText("Teams / Slack Webhook")).toBeInTheDocument();
    expect(screen.getByText("Ops failure alert")).toBeInTheDocument();
    expect(screen.getAllByText("관리자 승인").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("커넥터 · 관리자 승인 후 알림 발송에 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("템플릿 · 관리자 승인 후 알림 워크플로로 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getAllByText("보안 연결 1개 필요").length).toBeGreaterThanOrEqual(2);
  });

  test("알림 route 버튼은 백엔드 hash route로 이동한다", async () => {
    renderApp(clientWithOpsData());

    const alertRow = (await screen.findByText("월말 정산 실행 SLA 초과")).closest("li") as HTMLLIElement;
    fireEvent.click(within(alertRow).getByRole("button", { name: "실행 보기" }));

    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("알림 필터는 심각도와 유형을 API query로 반영한다", async () => {
    const listOpsAlerts = vi.fn(async () => ({ items: [], next_cursor: null }));
    renderApp(clientWithOpsData({ listOpsAlerts }));

    expect(await screen.findByRole("heading", { name: "알림 센터" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("알림 심각도"), { target: { value: "warning" } });

    await waitFor(() => expect(listOpsAlerts).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, severity: "warning" })));
    fireEvent.change(screen.getByLabelText("알림 유형"), { target: { value: "human_task_sla" } });

    await waitFor(() =>
      expect(listOpsAlerts).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, severity: "warning", source: "human_task_sla" })),
    );
  });

  test("운영 헬스 요약은 큐/브라우저 세션/지연 실행과 딥링크를 보여준다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "운영 헬스" })).toBeInTheDocument();
    expect(await screen.findByText("위험")).toBeInTheDocument();
    expect(await screen.findByText("미연결")).toBeInTheDocument();
    expect(screen.getByText("예약 스케줄러")).toBeInTheDocument();
    expect(screen.getAllByText("작업 큐 미연결").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("큐 연결 확인")).toBeInTheDocument();
    expect(screen.getByText(/실제 정기 실행은 아직 시작되지 않습니다/)).toBeInTheDocument();
    expect(screen.getByText("만료 미회수 1건")).toBeInTheDocument();
    expect(screen.getByText("15분 이상 진행 중")).toBeInTheDocument();

    const staleTile = screen.getByText("지연 실행").closest(".ops-health-tile") as HTMLElement;
    fireEvent.click(within(staleTile).getByRole("button", { name: "실행 보기" }));

    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("봇 풀 용량 패널은 worker/lease/대기 실행 집계를 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "용량" })).toBeInTheDocument();
    const poolRow = (await screen.findByText("브라우저 실행 풀")).closest("li") as HTMLLIElement;
    expect(within(poolRow).getByText("worker 1/2 · 사용 2/1 · 대기 3건 · 발화 예정 1건")).toBeInTheDocument();
    expect(within(poolRow).getByText("만료된 활성 브라우저 lease 1건을 회수해야 합니다.")).toBeInTheDocument();
    expect(within(poolRow).getByText("위험")).toBeInTheDocument();

    const flowRow = screen.getByText("실행 흐름").closest("li") as HTMLLIElement;
    fireEvent.click(within(flowRow).getByRole("button", { name: "실행 보기" }));
    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("알림 센터는 열린 알림이 없을 때 기업용 빈 상태를 표시한다", async () => {
    renderApp(clientWithOpsData({ listOpsAlerts: async () => ({ items: [], next_cursor: null }) }));

    expect(await screen.findByText("열린 운영 알림이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("SLA, 트리거, 재처리 대기 감시는 현재 정상 범위입니다.")).toBeInTheDocument();
  });

  test("예약 저장은 Run Trigger API를 호출하고 저장 결과를 표시한다", async () => {
    const createRunTrigger = vi.fn(async () => ({
      trigger_id: "00000000-0000-0000-0000-00000000f002",
      scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
      trigger_type: "cron" as const,
      status: "enabled" as const,
      cron_expression: "0 9 * * *",
      timezone: "Asia/Seoul",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "skip_missed" as const,
      max_concurrent_runs: 1,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    renderApp(clientWithOpsData({ createRunTrigger }));

    await screen.findByRole("option", { name: "월말 정산 · 변경 3" });
    fireEvent.click(screen.getByRole("button", { name: "예약 저장" }));

    await waitFor(() => expect(createRunTrigger).toHaveBeenCalledTimes(1));
    expect(createRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
      }),
      expect.any(String),
    );
    expect(await screen.findByText("저장됨")).toBeInTheDocument();
  });

  test("viewer role cannot create, pause, or edit run triggers", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    const createRunTrigger = vi.fn(async () => ({
      trigger_id: "00000000-0000-0000-0000-00000000f002",
      scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
      trigger_type: "cron" as const,
      status: "enabled" as const,
      cron_expression: "0 9 * * *",
      timezone: "Asia/Seoul",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "skip_missed" as const,
      max_concurrent_runs: 1,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    renderApp(clientWithOpsData({ createRunTrigger }));

    const saveButton = await screen.findByRole("button", { name: "예약 저장" });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("예약 변경 권한 없음")).toBeInTheDocument();
    fireEvent.click(saveButton);
    expect(createRunTrigger).not.toHaveBeenCalled();

    const triggerRow = (await screen.findByText("매일 09:00")).closest("tr") as HTMLTableRowElement;
    expect(within(triggerRow).queryByRole("button", { name: "일시정지" })).toBeNull();
    expect(within(triggerRow).getByRole("button", { name: "이력" })).toBeInTheDocument();
    expect(within(triggerRow).queryByRole("button", { name: "수정" })).toBeNull();
    expect(within(triggerRow).getByText(/읽기 전용/)).toBeInTheDocument();
  });

  test("scenario 딥링크는 예약 생성 대상 시나리오를 자동 선택한다", async () => {
    location.hash = "#automationOps?scenario=scenario-linked";
    const createRunTrigger = vi.fn(async () => ({
      trigger_id: "00000000-0000-0000-0000-00000000f009",
      scenario_version_id: "scenario-version-linked",
      trigger_type: "cron" as const,
      status: "enabled" as const,
      cron_expression: "0 9 * * *",
      timezone: "Asia/Seoul",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "skip_missed" as const,
      max_concurrent_runs: 1,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    renderApp(clientWithOpsData({
      listScenarios: async () => ({
        items: [
          {
            scenario_id: "scenario-default",
            name: "기본 업무",
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
      createRunTrigger,
    }));

    await screen.findByRole("option", { name: "녹화 저장 업무 · 변경 1" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "자동화" })).toHaveValue("scenario-linked"));
    fireEvent.click(screen.getByRole("button", { name: "예약 저장" }));

    await waitFor(() => expect(createRunTrigger).toHaveBeenCalledTimes(1));
    expect(createRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ scenario_version_id: "scenario-version-linked" }),
      expect.any(String),
    );
  });

  test("예약 저장 실패는 백엔드 details reason을 함께 표시한다", async () => {
    const createRunTrigger = vi.fn(async () => {
      throw new ApiError(422, "IR_SCHEMA_INVALID", {
        code: "IR_SCHEMA_INVALID",
        details: { field: "cron_expression", reason: "invalid_cron_expression", detail: "expected five fields" },
      });
    });
    renderApp(clientWithOpsData({ createRunTrigger }));

    await screen.findByRole("option", { name: /변경 3/ });
    fireEvent.click(screen.getByRole("button", { name: "예약 저장" }));

    expect(await screen.findByText(/예약식을 다시 확인해야 합니다./)).toBeInTheDocument();
    expect(screen.getByText(/항목: 예약식/)).toBeInTheDocument();
    expect(screen.getByText(/설명: 분 시 일 월 요일 형식이어야 합니다./)).toBeInTheDocument();
  });

  test("예약 저장은 동시 실행 제한과 누락 실행 정책을 payload에 포함한다", async () => {
    const createRunTrigger = vi.fn(async () => ({
      trigger_id: "00000000-0000-0000-0000-00000000f004",
      scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
      trigger_type: "cron" as const,
      status: "enabled" as const,
      cron_expression: "0 9 * * *",
      timezone: "Asia/Seoul",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "fire_once" as const,
      max_concurrent_runs: 4,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    renderApp(clientWithOpsData({ createRunTrigger }));

    fireEvent.change(await screen.findByLabelText("동시 실행 제한"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("누락 실행 처리"), { target: { value: "fire_once" } });
    fireEvent.click(screen.getByRole("button", { name: "예약 저장" }));

    await waitFor(() => expect(createRunTrigger).toHaveBeenCalledTimes(1));
    expect(createRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        catchup_policy: "fire_once",
        max_concurrent_runs: 4,
      }),
      expect.any(String),
    );
  });

  test("외부 이벤트 트리거는 보안 연결 이름을 보호 참조 payload로 저장한다", async () => {
    const createRunTrigger = vi.fn(async () => ({
      trigger_id: "00000000-0000-0000-0000-00000000f003",
      scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
      trigger_type: "webhook" as const,
      status: "enabled" as const,
      cron_expression: null,
      timezone: null,
      webhook_secret_ref: "secret://prod/run-triggers/month-end",
      params: {},
      catchup_policy: "skip_missed" as const,
      max_concurrent_runs: 1,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    renderApp(clientWithOpsData({ createRunTrigger }));

    fireEvent.change(await screen.findByLabelText("트리거 방식"), { target: { value: "webhook" } });
    expect(screen.queryByDisplayValue("secret://prod/run-triggers/month-end")).toBeNull();
    fireEvent.change(screen.getByLabelText("외부 이벤트 보안 연결"), { target: { value: "prod/run-triggers/month-end" } });
    fireEvent.click(screen.getByRole("button", { name: "예약 저장" }));

    await waitFor(() => expect(createRunTrigger).toHaveBeenCalledTimes(1));
    expect(createRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_type: "webhook",
        scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
        webhook_secret_ref: "secret://prod/run-triggers/month-end",
      }),
      expect.any(String),
    );
    await waitFor(() => expect(screen.getAllByText("외부 이벤트").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText("보안 키 연결됨")).toBeInTheDocument();
    expect(screen.getByText("외부 시스템 연결 주소 준비됨")).toBeInTheDocument();
    expect(screen.queryByText("/v1/webhooks/run-triggers/{tenant_id}/00000000-0000-0000-0000-00000000f003")).toBeNull();
    expect(screen.queryByTitle(/v1\/webhooks\/run-triggers/)).toBeNull();
  });

  test("등록된 예약은 일시정지 버튼으로 관리할 수 있다", async () => {
    const pauseRunTrigger = vi.fn(async (triggerId: string) => ({
      trigger_id: triggerId,
      scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
      trigger_type: "cron" as const,
      status: "paused" as const,
      cron_expression: "0 9 * * *",
      timezone: "Asia/Seoul",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "skip_missed" as const,
      max_concurrent_runs: 1,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    renderApp(clientWithOpsData({ pauseRunTrigger }));

    const triggerRow = (await screen.findByText("매일 09:00")).closest("tr") as HTMLTableRowElement;
    expect(screen.queryByTitle(/0 9 \* \* \*/)).toBeNull();
    fireEvent.click(within(triggerRow).getByRole("button", { name: "일시정지" }));

    await waitFor(() => expect(pauseRunTrigger).toHaveBeenCalledWith("00000000-0000-0000-0000-00000000f001", expect.any(String)));
  });

  test("등록된 예약은 수정 패널에서 cron과 운영 파라미터를 변경한다", async () => {
    const updateRunTrigger = vi.fn(async (triggerId: string) => ({
      trigger_id: triggerId,
      scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
      trigger_type: "cron" as const,
      status: "enabled" as const,
      cron_expression: "30 10 * * 1",
      timezone: "UTC",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "fire_once" as const,
      max_concurrent_runs: 3,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:01.000Z",
    }));
    renderApp(clientWithOpsData({ updateRunTrigger }));

    const triggerRow = (await screen.findByText("매일 09:00")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(triggerRow).getByRole("button", { name: "수정" }));

    const editPanel = screen.getByLabelText("예약 수정");
    fireEvent.change(within(editPanel).getByLabelText(/고급 예약식/), { target: { value: "30 10 * * 1" } });
    fireEvent.change(within(editPanel).getByLabelText("시간대"), { target: { value: "UTC" } });
    fireEvent.change(within(editPanel).getByLabelText("누락 실행 처리"), { target: { value: "fire_once" } });
    fireEvent.change(within(editPanel).getByLabelText("동시 실행 제한"), { target: { value: "3" } });
    fireEvent.click(within(editPanel).getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(updateRunTrigger).toHaveBeenCalledTimes(1));
    expect(updateRunTrigger).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-00000000f001",
      expect.objectContaining({
        cron_expression: "30 10 * * 1",
        timezone: "UTC",
        catchup_policy: "fire_once",
        max_concurrent_runs: 3,
      }),
      expect.any(String),
    );
  });

  test("최근 발화 이력은 실패/스킵 사유와 실행 딥링크를 보여준다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByText("내부 오류가 발생했습니다.")).toBeInTheDocument();
    expect(screen.getByText("동시 실행 한도에 도달했습니다.")).toBeInTheDocument();
    expect(screen.getByText("실행 연결됨")).toBeInTheDocument();
    expect(screen.queryByText("run-fire-1")).toBeNull();

    const failedRow = screen.getByText("내부 오류가 발생했습니다.").closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(failedRow).getByRole("button", { name: "실행 보기" }));

    expect(location.hash).toBe("#runTrace?run=run-fire-1");
  });

  test("최근 발화 이력은 failure_reason details reason을 함께 보여준다", async () => {
    renderApp(clientWithOpsData({
      listRunTriggerFires: async () => ({
        items: [
          {
            fire_id: "fire-invalid-cron",
            trigger_id: "00000000-0000-0000-0000-00000000f001",
            fire_key: "cron:bad",
            status: "failed",
            scheduled_for: "2026-06-23T11:00:00.000Z",
            run_id: null,
            failure_reason: {
              code: "IR_SCHEMA_INVALID",
              details: { reason: "invalid_cron_expression", field: "cron_expression" },
            },
            created_at: "2026-06-23T11:00:01.000Z",
          },
        ],
        next_cursor: null,
      }),
    }));

    expect(await screen.findByText(/자동화 정의 오류./)).toHaveTextContent("예약식을 다시 확인해야 합니다.");
    expect(screen.getByText(/항목: 예약식/)).toBeInTheDocument();
  });

  test("등록된 예약의 이력 버튼은 trigger 딥링크와 발화 이력을 동기화한다", async () => {
    const listRunTriggerFires = vi.fn(async (triggerId: string) => ({
      items: [
        {
          fire_id: `fire-${triggerId}`,
          trigger_id: triggerId,
          fire_key: `cron:${triggerId}`,
          status: "queued" as const,
          scheduled_for: triggerId === "trigger-second" ? "2026-06-23T10:00:00.000Z" : "2026-06-23T08:00:00.000Z",
          run_id: null,
          failure_reason: null,
          created_at: "2026-06-23T00:00:01.000Z",
        },
      ],
      next_cursor: null,
    }));
    renderApp(clientWithOpsData({
      listRunTriggers: async () => ({
        items: [
          {
            trigger_id: "trigger-first",
            scenario_version_id: "scenario-version-first",
            trigger_type: "cron",
            status: "enabled",
            cron_expression: "0 8 * * *",
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
          {
            trigger_id: "trigger-second",
            scenario_version_id: "scenario-version-second",
            trigger_type: "cron",
            status: "enabled",
            cron_expression: "0 10 * * *",
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
      listRunTriggerFires,
    }));

    const secondRow = (await screen.findByText("매일 10:00")).closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(secondRow).getByRole("button", { name: "이력" }));

    expect(location.hash).toBe("#automationOps?trigger=trigger-second");
    await waitFor(() => expect(listRunTriggerFires).toHaveBeenCalledWith("trigger-second", { limit: 10 }));
    expect(await screen.findByText("실행 생성")).toBeInTheDocument();
    expect(screen.queryByText("2026-06-23T10:00:00.000Z")).toBeNull();
  });

  test("trigger 딥링크는 해당 예약의 발화 이력을 선택한다", async () => {
    location.hash = "#automationOps?trigger=trigger-linked";
    const listRunTriggerFires = vi.fn(async () => ({
      items: [
        {
          fire_id: "fire-linked",
          trigger_id: "trigger-linked",
          fire_key: "cron:linked",
          status: "queued" as const,
          scheduled_for: "2026-06-23T10:00:00.000Z",
          run_id: null,
          failure_reason: null,
          created_at: "2026-06-23T10:00:01.000Z",
        },
      ],
      next_cursor: null,
    }));
    renderApp(clientWithOpsData({
      listRunTriggers: async () => ({
        items: [
          {
            trigger_id: "trigger-default",
            scenario_version_id: "scenario-version-default",
            trigger_type: "cron",
            status: "enabled",
            cron_expression: "0 8 * * *",
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
          {
            trigger_id: "trigger-linked",
            scenario_version_id: "scenario-version-linked",
            trigger_type: "cron",
            status: "enabled",
            cron_expression: "0 10 * * *",
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
      listRunTriggerFires,
    }));

    await waitFor(() => expect(listRunTriggerFires).toHaveBeenCalledWith("trigger-linked", { limit: 10 }));
    expect(await screen.findByText("실행 생성")).toBeInTheDocument();
    expect(screen.queryByText("2026-06-23T10:00:00.000Z")).toBeNull();
  });

  test("trigger 딥링크가 목록 밖 예약이면 by-id로 복원해 해당 발화 이력을 조회한다", async () => {
    location.hash = "#automationOps?trigger=trigger-linked";
    const getRunTrigger = vi.fn(async () => ({
      trigger_id: "trigger-linked",
      scenario_version_id: "scenario-version-linked",
      trigger_type: "cron" as const,
      status: "enabled" as const,
      cron_expression: "0 22 * * *",
      timezone: "Asia/Seoul",
      webhook_secret_ref: null,
      params: {},
      catchup_policy: "skip_missed" as const,
      max_concurrent_runs: 1,
      next_fire_at: null,
      created_by: "operator",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    }));
    const listRunTriggerFires = vi.fn(async () => ({
      items: [
        {
          fire_id: "fire-linked",
          trigger_id: "trigger-linked",
          fire_key: "cron:linked",
          status: "queued" as const,
          scheduled_for: "2026-06-23T22:00:00.000Z",
          run_id: null,
          failure_reason: null,
          created_at: "2026-06-23T22:00:01.000Z",
        },
      ],
      next_cursor: null,
    }));
    renderApp(clientWithOpsData({
      listRunTriggers: async () => ({
        items: [
          {
            trigger_id: "trigger-default",
            scenario_version_id: "scenario-version-default",
            trigger_type: "cron",
            status: "enabled",
            cron_expression: "0 8 * * *",
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
      getRunTrigger,
      listRunTriggerFires,
    }));

    await waitFor(() => expect(getRunTrigger).toHaveBeenCalledWith("trigger-linked"));
    await waitFor(() => expect(listRunTriggerFires).toHaveBeenCalledWith("trigger-linked", { limit: 10 }));
    expect(await screen.findByText("실행 생성")).toBeInTheDocument();
    expect(screen.getByText(/매일 22:00/)).toBeInTheDocument();
    expect(screen.queryByText("2026-06-23T22:00:00.000Z")).toBeNull();
    expect(screen.queryByText(/0 22 \* \* \*/)).toBeNull();
  });
});
