import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { ApiError, type ConnectorCatalogItem, type TemplateCatalogItem } from "../src/api/types";
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
          delivery: { channel: "console" as const, status: "delivered" as const, delivered_at: "2026-06-23T09:01:00.000Z", external_delivery: false as const },
          ack: null,
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
          delivery: { channel: "console" as const, status: "delivered" as const, delivered_at: "2026-06-23T09:02:00.000Z", external_delivery: false as const },
          ack: null,
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
          delivery: { channel: "console" as const, status: "delivered" as const, delivered_at: "2026-06-23T09:03:00.000Z", external_delivery: false as const },
          ack: null,
          recommended_action: "실행 기록에서 실패 원인을 확인하세요.",
          route: "#runTrace",
          detected_at: "2026-06-23T09:03:00.000Z",
          due_at: null,
        },
        {
          alert_id: "audit_verifier:stale",
          severity: "warning" as const,
          source: "audit_verifier" as const,
          title: "감사 체인 검증 증적 지연",
          detail: "감사 로그가 존재하지만 자동 검증 증적이 지연되었습니다.",
          subject_type: "audit_verifier" as const,
          subject_id: null,
          status: "open" as const,
          delivery: { channel: "console" as const, status: "delivered" as const, delivered_at: "2026-06-23T09:04:00.000Z", external_delivery: false as const },
          ack: null,
          recommended_action: "Audit Explorer에서 검증 실행 증적을 확인하세요.",
          route: "#auditExplorer",
          detected_at: "2026-06-23T09:04:00.000Z",
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
    getProductionReadiness: async () => ({
      status: "warning" as const,
      evaluated_at: "2026-06-23T09:04:00.000Z",
      environment: { target: "controlled_prod" as const, tenant_id: "tenant-a" },
      summary: {
        controlled_prod_ready: false,
        status: "warning" as const,
        blocker_count: 0,
        warning_count: 0,
        deferred_count: 5,
      },
      gates: [
        {
          gate_id: "database_migrations",
          label: "Database migrations",
          status: "pass" as const,
          reason_code: null,
          detail: "Required schema migrations are recorded as applied.",
          evidence: ["schema_migrations:0001:applied", "schema_migrations:0002:applied"],
          required_action: null,
        },
        {
          gate_id: "browser_pool_ha",
          label: "Browser pool HA",
          status: "pass" as const,
          reason_code: null,
          detail: "The assigned browser pool has at least two active workers.",
          evidence: ["pool_key=finance-prod", "active_workers=2"],
          required_action: null,
        },
        {
          gate_id: "audit_chain_evidence",
          label: "Audit chain evidence",
          status: "pass" as const,
          reason_code: null,
          detail: "The latest audit verifier run is valid and fresh.",
          evidence: ["latest_run_id=verifier-1"],
          required_action: null,
        },
        {
          gate_id: "external_alert_delivery",
          label: "External alert delivery",
          status: "deferred" as const,
          reason_code: "external_delivery_contract_not_open",
          detail: "Console-only alerts are available.",
          evidence: ["ops_alert.delivery.external_delivery=false"],
          required_action: "Open the notification delivery contract.",
        },
        {
          gate_id: "managed_backup_restore_drill",
          label: "Managed backup restore drill",
          status: "deferred" as const,
          reason_code: "owner_controlled_pitr_evidence_missing",
          detail: "Owner-controlled managed backup/PITR restore evidence is external.",
          evidence: ["local_restore_drill=available", "managed_backup_pitr=evidence_required", "rto_rpo_targets=evidence_required"],
          required_action: "Attach owner-controlled backup/PITR restore drill evidence.",
        },
        {
          gate_id: "slo_oncall_signoff",
          label: "SLO/on-call sign-off",
          status: "deferred" as const,
          reason_code: "slo_oncall_signoff_missing",
          detail: "SLO targets, severity policy, and on-call/RACI coverage evidence are owner-controlled.",
          evidence: ["slo_dashboard=evidence_required", "on_call_raci=evidence_required", "support_hours=evidence_required"],
          required_action: "Attach SLO dashboard and on-call/RACI sign-off evidence.",
        },
        {
          gate_id: "support_training_completion",
          label: "Support/training completion",
          status: "deferred" as const,
          reason_code: "support_training_completion_missing",
          detail: "Support model, trained roles, and coverage evidence are owner-controlled.",
          evidence: ["support_model_ref=evidence_required", "training_completion_ref=evidence_required", "coverage_percent=evidence_required"],
          required_action: "Attach support model and training completion evidence.",
        },
        {
          gate_id: "observability_telemetry_wiring",
          label: "Observability telemetry wiring",
          status: "deferred" as const,
          reason_code: "observability_telemetry_evidence_missing",
          detail: "OTLP/Prometheus exporter, collector, dashboard, and alert-route evidence are owner-controlled.",
          evidence: ["telemetry_exporter=evidence_required", "collector_ref=evidence_required", "dashboard_alert_route=evidence_required"],
          required_action: "Attach telemetry collector, dashboard, and alert-route evidence.",
        },
      ],
      signals: {
        ops_health: {
          status: "ok" as const,
          detected_at: "2026-06-23T09:04:00.000Z",
          queue: { available: true, pending_jobs: 0 },
          browser_leases: { reserved: 0, active: 0, draining: 0, expired: 0, expired_open: 0, next_expiry_at: null },
          stale_runs: { nonterminal_over_15m: 0, oldest_updated_at: null },
        },
        bot_pool: {
          bot_pool_id: "browser-finance-prod",
          capacity_slots: 2,
          workers: { total: 2, active: 2, draining: 0, dead: 0, stale: 0, open_circuit: 0 },
          leases: { reserved: 0, active: 0, draining: 0, expired_open: 0, next_expiry_at: null },
          queue: { pending_runs: 0, queued_runs: 0, claimed_runs: 0, oldest_queued_at: null, due_triggers: 0 },
          health: "ok" as const,
        },
        audit_verifier: {
          audit_count: 8,
          latest_run_id: "verifier-1",
          latest_status: "valid" as const,
          latest_completed_at: "2026-06-23T09:03:00.000Z",
          rows_checked: 8,
          violation_count: 0,
          stale: false,
        },
      },
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
          queue: { pending_runs: 3, queued_runs: 3, claimed_runs: 0, oldest_queued_at: "2026-06-23T08:30:00.000Z", due_triggers: 1 },
          capacity: {
            occupied_slots: 2,
            available_slots: 0,
            capacity_gap: 3,
            queue_pressure: 3,
            live_capacity: { available: false, reason_code: "worker_pool_membership_missing" },
          },
          health: "critical" as const,
          health_reason: "만료된 활성 브라우저 lease 1건을 회수해야 합니다.",
        },
      ],
      next_cursor: null,
    }),
    listConnectors: async (params) => params?.kind === "notification" ? ({
      items: [{
        catalog_id: "90000000-0000-4000-8000-000000000004",
        connector_id: "ops-webhook-sender",
        name: "Ops webhook sender",
        kind: "notification",
        category: "Notification",
        status: "available",
        priority: "P1",
        summary: "SecretRef-backed HTTPS webhook sender for ops alerts. Teams/Slack/email adapters remain future channels.",
        best_for: ["failure alert webhook", "HITL escalation webhook", "SLA risk notification"],
        supported_actions: ["ops_alert_webhook_send"],
        template_ids: ["ops-failure-alert"],
        required_rbac_actions: ["ops_alert.deliver"],
        required_secret_refs: ["endpoint_secret_ref"],
        allowed_domains: ["hooks.slack.com", "example.webhook.office.com"],
        manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["endpoint_secret_ref"] },
        implementation_state: "Implemented: /v1/ops-alerts/{alert_id}/deliveries/send-webhook queues durable SecretRef-backed webhook attempts.",
        security_notes: ["Webhook URLs remain SecretRef-only.", "Console sends only endpoint_secret_ref, route_policy_ref, recipient_group_ref, and allowed host metadata."],
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }],
      next_cursor: null,
    }) : fakeClient().listConnectors(params),
    listTemplates: async (params) => params?.kind === "notification_workflow" ? ({
      items: [{
        catalog_id: "91000000-0000-4000-8000-000000000005",
        template_id: "ops-failure-alert",
        connector_id: "ops-webhook-sender",
        name: "Ops failure alert",
        kind: "notification_workflow",
        status: "available",
        priority: "P1",
        summary: "Webhook notification pattern for failed runs, SLA risk, and human task timeout escalation.",
        best_for: ["run failure alert", "SLA risk webhook", "human-task timeout"],
        required_params: ["severity", "message_template", "allowed_hosts"],
        required_secret_refs: [],
        produced_ir_pattern: "ops event -> /v1/ops-alerts alert -> webhook send attempt",
        success_criteria: "The webhook attempt is queued and provider delivery evidence appears in delivery receipts.",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      }],
      next_cursor: null,
    }) : fakeClient().listTemplates(params),
    ...overrides,
  });
}

function notificationConnector(
  connectorId: string,
  name: string,
  status: ConnectorCatalogItem["status"],
  summary: string,
  options: {
    readonly requiredSecretRefs?: readonly string[];
    readonly templateIds?: readonly string[];
    readonly supportedActions?: readonly string[];
    readonly implementationState?: string;
  } = {},
): ConnectorCatalogItem {
  const requiredSecretRefs = options.requiredSecretRefs ?? [];
  return {
    catalog_id: `catalog-${connectorId}`,
    connector_id: connectorId,
    name,
    kind: "notification",
    category: "Notification",
    status,
    priority: status === "available" ? "P1" : "P2",
    summary,
    best_for: ["ops alert routing"],
    supported_actions: options.supportedActions ?? ["owner_evidence_review"],
    template_ids: options.templateIds ?? [],
    required_rbac_actions: status === "available" ? ["connector.read", "ops_alert.deliver"] : ["connector.read"],
    required_secret_refs: requiredSecretRefs,
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: requiredSecretRefs },
    implementation_state: options.implementationState ?? "candidate: owner/provider evidence required before provider-specific auth, recipient resolution, or receipt semantics can be approved",
    security_notes: ["SecretRef values, provider tokens, rosters, and endpoint URLs stay out of the catalog."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  };
}

function notificationTemplate(
  templateId: string,
  connectorId: string,
  name: string,
  status: TemplateCatalogItem["status"],
): TemplateCatalogItem {
  return {
    catalog_id: `template-catalog-${templateId}`,
    template_id: templateId,
    connector_id: connectorId,
    name,
    kind: "notification_workflow",
    status,
    priority: status === "available" ? "P1" : "P2",
    summary: `${name} summary`,
    best_for: ["ops alert routing"],
    required_params: ["severity", "message_template"],
    required_secret_refs: status === "available" ? ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"] : [],
    produced_ir_pattern: "ops event -> webhook send attempt",
    success_criteria: "sent/failed metadata is recorded; delivered requires provider receipt/callback evidence.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  };
}

describe("automation ops view", () => {
  beforeEach(() => {
    location.hash = "#automationOps";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("큐 운영 수치를 기존 run summary와 대기 목록에서 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "예약·큐 운영" })).toBeInTheDocument();
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
    expect(await screen.findByText("감사 체인 검증 증적 지연")).toBeInTheDocument();
    expect(screen.getAllByText("실패 급증").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("위험").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("주의").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("권장 조치: 실행 기록에서 병목 단계와 작업자 상태를 확인하세요.")).toBeInTheDocument();
    expect(screen.getByText("권장 조치: 담당자에게 작업을 재배정하거나 에스컬레이션하세요.")).toBeInTheDocument();
    const runAlert = screen.getByText("월말 정산 실행 SLA 초과").closest("li") as HTMLLIElement;
    const humanAlert = screen.getByText("결재 확인 지연").closest("li") as HTMLLIElement;
    const spikeAlert = screen.getByText("실패 급증 감지").closest("li") as HTMLLIElement;
    const auditAlert = screen.getByText("감사 체인 검증 증적 지연").closest("li") as HTMLLIElement;
    expect(within(runAlert).getByRole("button", { name: "실행 보기" })).toBeInTheDocument();
    expect(within(humanAlert).getByRole("button", { name: "사람 작업 보기" })).toBeInTheDocument();
    expect(within(spikeAlert).getByRole("button", { name: "실패 기록 보기" })).toBeInTheDocument();
    expect(within(auditAlert).getByRole("button", { name: "감사 검증 보기" })).toBeInTheDocument();
  });

  test("알림 라우팅 준비도는 활성 웹훅 발송 경로와 SecretRef 요구사항을 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "알림 라우팅" })).toBeInTheDocument();
    expect(await screen.findByText("2개 경로")).toBeInTheDocument();
    expect(screen.getByText("Ops webhook sender")).toBeInTheDocument();
    expect(screen.getByText("Ops failure alert")).toBeInTheDocument();
    expect(screen.getAllByText("사용 가능").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("커넥터 · SecretRef 기반 알림 발송에 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("템플릿 · 실패, SLA, 사람 작업 알림을 웹훅 시도로 큐잉할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("보안 연결 1개 필요")).toBeInTheDocument();
  });

  test("알림 라우팅 준비도는 provider별 후보를 owner/provider 증거 필요 상태로 분리한다", async () => {
    const endpointRef = "secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint";
    renderApp(clientWithOpsData({
      listConnectors: async (params) => params?.kind === "notification" ? ({
        items: [
          notificationConnector("ops-webhook-sender", "Ops webhook sender", "available", "SecretRef-backed generic webhook sender.", {
            requiredSecretRefs: [endpointRef],
            templateIds: ["ops-failure-alert"],
            supportedActions: ["notify", "receipt_record", "provider_callback"],
            implementationState: "Implemented: send-webhook queues SecretRef-backed attempts and records metadata-only receipts.",
          }),
          notificationConnector("slack-notification-candidate", "Slack notification profile candidate", "candidate", "Slack-specific OAuth/app auth, channel ownership, and delivery receipts require owner/provider evidence."),
          notificationConnector("teams-notification-candidate", "Teams notification profile candidate", "candidate", "Teams-specific app auth, channel ownership, and delivery receipts require owner/provider evidence."),
          notificationConnector("email-notification-candidate", "Email notification profile candidate", "candidate", "SMTP/OAuth auth, recipient-group expansion, and delivery/bounce receipts require owner/provider evidence."),
          notificationConnector("pagerduty-notification-candidate", "PagerDuty incident profile candidate", "candidate", "Incident routing ownership and accepted/resolved receipt semantics require owner/provider evidence."),
          notificationConnector("servicenow-notification-candidate", "ServiceNow incident profile candidate", "candidate", "Instance ownership, auth, incident mapping, and receipt semantics require owner/provider evidence."),
        ],
        next_cursor: null,
      }) : fakeClient().listConnectors(params),
      listTemplates: async (params) => params?.kind === "notification_workflow" ? ({
        items: [notificationTemplate("ops-failure-alert", "ops-webhook-sender", "Ops failure alert", "available")],
        next_cursor: null,
      }) : fakeClient().listTemplates(params),
    }));

    expect(await screen.findByRole("heading", { name: "알림 라우팅" })).toBeInTheDocument();
    expect(await screen.findByText("검토 후보 5건")).toBeInTheDocument();
    expect(screen.getByText("Ops webhook sender")).toBeInTheDocument();
    expect(screen.getByText("Slack notification profile candidate")).toBeInTheDocument();
    expect(screen.getByText("ServiceNow incident profile candidate")).toBeInTheDocument();
    expect(screen.getByText("커넥터 · SecretRef 기반 알림 발송에 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getAllByText("커넥터 · owner/provider 증거가 필요한 도입 후보입니다.").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText(/외부 발송 보류/)).not.toBeInTheDocument();
  });

  test("알림 route 버튼은 백엔드 hash route로 이동한다", async () => {
    renderApp(clientWithOpsData());

    const alertRow = (await screen.findByText("월말 정산 실행 SLA 초과")).closest("li") as HTMLLIElement;
    fireEvent.click(within(alertRow).getByRole("button", { name: "실행 보기" }));

    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("operator creates an external RPA integration handoff with a stable idempotency key", async () => {
    const createIntegrationHandoff = vi.fn(async (
      body: Parameters<ApiClient["createIntegrationHandoff"]>[0],
      idempotencyKey: Parameters<ApiClient["createIntegrationHandoff"]>[1],
    ) => ({
      handoff_id: "integration-handoff-created",
      provider_alias: body.provider_alias,
      job_ref: body.job_ref,
      payload_ref: body.payload_ref,
      callback_url_secret_ref: body.callback_url_secret_ref ?? null,
      callback_signature_secret_ref: body.callback_signature_secret_ref ?? null,
      external_job_id: null,
      status: "deferred" as const,
      latest_receipt_id: null,
      error_code: null,
      requested_by: "operator-a",
      request_idempotency_key: idempotencyKey,
      requested_at: "2026-06-29T00:00:01.000Z",
      updated_at: "2026-06-29T00:00:01.000Z",
      callback_received_at: null,
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({ createIntegrationHandoff }));

    await screen.findByRole("heading", { name: "Existing RPA handoff" });
    fireEvent.change(screen.getByLabelText("Handoff provider"), { target: { value: "uipath-secondary" } });
    fireEvent.change(screen.getByLabelText("Handoff job ref"), { target: { value: "queue:cash-app" } });
    fireEvent.change(screen.getByLabelText("Handoff payload ref"), { target: { value: "artifact://handoff/cash-app-042" } });
    fireEvent.change(screen.getByLabelText("Handoff callback SecretRef"), { target: { value: "secret://tenant-a/integration/uipath-secondary/callback-url" } });
    fireEvent.change(screen.getByLabelText("Handoff signature SecretRef"), { target: { value: "secret://tenant-a/integration/uipath-secondary/callback-signing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));

    await waitFor(() => expect(createIntegrationHandoff).toHaveBeenCalledWith(
      {
        provider_alias: "uipath-secondary",
        job_ref: "queue:cash-app",
        payload_ref: "artifact://handoff/cash-app-042",
        callback_url_secret_ref: "secret://tenant-a/integration/uipath-secondary/callback-url",
        callback_signature_secret_ref: "secret://tenant-a/integration/uipath-secondary/callback-signing",
        legal_hold: false,
      },
      expect.stringMatching(/^integration-handoff-uipath-secondary-queue:cash-app-artifact:__handoff_cash-app-042-\d+$/),
    ));
  });

  test("operator selects handoff provider profiles without exposing raw callback URLs", async () => {
    const createIntegrationHandoff = vi.fn();
    renderApp(clientWithOpsData({ createIntegrationHandoff }));

    await screen.findByRole("heading", { name: "Existing RPA handoff" });
    expect(screen.getByText(/Vendor API\/OAuth, job mapping, and endpoint ownership remain owner\/provider decisions/)).toBeInTheDocument();
    expect((screen.getByLabelText("Handoff provider") as HTMLInputElement).value).toBe("existing-rpa-primary");

    const profileSelect = screen.getByLabelText("Handoff provider profile") as HTMLSelectElement;
    expect(Array.from(profileSelect.options).map((option) => option.text)).toEqual([
      "Owner-defined existing RPA",
      "UiPath provider profile",
      "Automation Anywhere provider profile",
      "Power Automate provider profile",
      "Blue Prism provider profile",
    ]);

    fireEvent.change(profileSelect, { target: { value: "power-automate" } });
    expect((screen.getByLabelText("Handoff provider") as HTMLInputElement).value).toBe("power-automate-primary");
    expect((screen.getByLabelText("Handoff callback SecretRef") as HTMLInputElement).value).toBe("secret://tenant-a/integration/power-automate/callback-url");
    expect((screen.getByLabelText("Handoff signature SecretRef") as HTMLInputElement).value).toBe("secret://tenant-a/integration/power-automate/callback-signing");

    fireEvent.change(screen.getByLabelText("Handoff callback SecretRef"), { target: { value: "https://flows.example.com/raw-callback" } });
    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Callback URL must be a SecretRef.");
    expect(createIntegrationHandoff).not.toHaveBeenCalled();
  });

  test("dispatch form derives provider SecretRef defaults and rejects raw endpoints", async () => {
    const listIntegrationHandoffs = vi.fn(async () => ({
      items: [{
        handoff_id: "integration-handoff-aa",
        provider_alias: "automation-anywhere-primary",
        job_ref: "queue:bot-dispatch",
        payload_ref: "artifact://handoff/bot-dispatch-001",
        callback_url_secret_ref: "secret://tenant-a/integration/automation-anywhere/callback-url",
        callback_signature_secret_ref: "secret://tenant-a/integration/automation-anywhere/callback-signing",
        external_job_id: null,
        status: "deferred" as const,
        latest_receipt_id: null,
        error_code: null,
        requested_by: "operator-a",
        request_idempotency_key: "integration-handoff-aa-key",
        requested_at: "2026-06-29T00:00:00.000Z",
        updated_at: "2026-06-29T00:00:00.000Z",
        callback_received_at: null,
        legal_hold: false,
      }],
      next_cursor: null,
    }));
    const dispatchIntegrationHandoff = vi.fn(async (
      handoffId: string,
      body: Parameters<ApiClient["dispatchIntegrationHandoff"]>[1],
    ) => ({
      attempt_id: "integration-handoff-dispatch-aa",
      handoff_id: handoffId,
      provider_alias: "automation-anywhere-primary",
      status: "pending" as const,
      endpoint_secret_ref: body.endpoint_secret_ref,
      allowed_hosts: body.allowed_hosts,
      request_idempotency_key: "integration-handoff-dispatch-aa-key",
      attempt_no: 1,
      max_attempts: body.max_attempts ?? 3,
      external_job_id: null,
      receipt_id: null,
      error_code: null,
      requested_by: "operator-a",
      requested_at: "2026-06-29T00:00:01.500Z",
      updated_at: "2026-06-29T00:00:01.500Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({ listIntegrationHandoffs, dispatchIntegrationHandoff }));

    expect(await screen.findByText("queue:bot-dispatch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dispatch" }));
    const endpointInput = screen.getByLabelText("Dispatch endpoint SecretRef for integration-handoff-aa") as HTMLInputElement;
    const hostsInput = screen.getByLabelText("Dispatch allowed hosts for integration-handoff-aa") as HTMLInputElement;
    expect(endpointInput.value).toBe("secret://tenant-a/integration/automation-anywhere/dispatch-endpoint");
    expect(hostsInput.value).toBe("automation-anywhere.example.com");

    fireEvent.change(endpointInput, { target: { value: "https://controlroom.example.com/jobs" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue dispatch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dispatch endpoint must be a SecretRef.");
    expect(dispatchIntegrationHandoff).not.toHaveBeenCalled();

    fireEvent.change(endpointInput, { target: { value: "secret://tenant-a/integration/automation-anywhere/dispatch-endpoint" } });
    fireEvent.change(hostsInput, { target: { value: "controlroom.example.com, botrunner.example.com" } });
    fireEvent.change(screen.getByLabelText("Dispatch max attempts for integration-handoff-aa"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue dispatch" }));

    await waitFor(() => expect(dispatchIntegrationHandoff).toHaveBeenCalledWith(
      "integration-handoff-aa",
      expect.objectContaining({
        endpoint_secret_ref: "secret://tenant-a/integration/automation-anywhere/dispatch-endpoint",
        allowed_hosts: ["controlroom.example.com", "botrunner.example.com"],
        max_attempts: 4,
        metadata: { requested_from: "admin_console" },
        legal_hold: false,
      }),
      expect.stringMatching(/^integration-handoff-dispatch-/),
    ));
  });

  test("operator records an external RPA integration handoff receipt", async () => {
    const listIntegrationHandoffs = vi.fn(async () => ({
      items: [{
        handoff_id: "integration-handoff-deferred",
        provider_alias: "uipath-primary",
        job_ref: "queue:invoice-posting",
        payload_ref: "artifact://handoff/invoice-posting-001",
        callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
        callback_signature_secret_ref: "secret://tenant-a/integration/uipath/callback-signing",
        external_job_id: null,
        status: "deferred" as const,
        latest_receipt_id: null,
        error_code: null,
        requested_by: "operator-a",
        request_idempotency_key: "integration-handoff-fixture-key",
        requested_at: "2026-06-29T00:00:00.000Z",
        updated_at: "2026-06-29T00:00:00.000Z",
        callback_received_at: null,
        legal_hold: false,
      }],
      next_cursor: null,
    }));
    const recordIntegrationHandoffCallback = vi.fn(async (
      handoffId: string,
      body: Parameters<ApiClient["recordIntegrationHandoffCallback"]>[1],
    ) => ({
      handoff_id: handoffId,
      provider_alias: "uipath-primary",
      job_ref: "queue:invoice-posting",
      payload_ref: "artifact://handoff/invoice-posting-001",
      callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
      callback_signature_secret_ref: "secret://tenant-a/integration/uipath/callback-signing",
      external_job_id: body.external_job_id,
      status: body.status,
      latest_receipt_id: body.receipt_id,
      error_code: body.error_code ?? null,
      requested_by: "operator-a",
      request_idempotency_key: "integration-handoff-fixture-key",
      requested_at: "2026-06-29T00:00:00.000Z",
      updated_at: "2026-06-29T00:00:02.000Z",
      callback_received_at: "2026-06-29T00:00:02.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({ listIntegrationHandoffs, recordIntegrationHandoffCallback }));

    expect(await screen.findByText("queue:invoice-posting")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText("Handoff external job id"), { target: { value: "job-uipath-20260629-001" } });
    fireEvent.change(screen.getByLabelText("Handoff receipt status"), { target: { value: "completed" } });
    fireEvent.change(screen.getByLabelText("Handoff receipt id"), { target: { value: "receipt-uipath-001" } });
    fireEvent.click(screen.getByRole("button", { name: "Save receipt" }));

    await waitFor(() => expect(recordIntegrationHandoffCallback).toHaveBeenCalledWith(
      "integration-handoff-deferred",
      {
        external_job_id: "job-uipath-20260629-001",
        status: "completed",
        receipt_id: "receipt-uipath-001",
        error_code: null,
        legal_hold: false,
      },
    ));
  });

  test("console alert ack button calls the ack API and marks the alert acknowledged", async () => {
    const ackOpsAlert = vi.fn(async (alertId: string) => ({
      alert_id: alertId,
      severity: "critical" as const,
      source: "run_sla" as const,
      title: "Run SLA exceeded",
      detail: "Run is past its target completion time.",
      subject_type: "run" as const,
      subject_id: "run-ops-1",
      status: "acknowledged" as const,
      delivery: { channel: "console" as const, status: "delivered" as const, delivered_at: "2026-06-23T09:01:00.000Z", external_delivery: false as const },
      ack: { acknowledged_by: "operator-a", acknowledged_at: "2026-06-23T09:05:00.000Z", comment: null },
      recommended_action: "Review run trace.",
      route: "#runTrace?status=running",
      detected_at: "2026-06-23T09:01:00.000Z",
      due_at: "2026-06-23T08:49:00.000Z",
    }));
    renderApp(clientWithOpsData({ ackOpsAlert }));

    const ackButtons = await screen.findAllByRole("button", { name: "확인" });
    fireEvent.click(ackButtons[0] as HTMLButtonElement);

    await waitFor(() => expect(ackOpsAlert).toHaveBeenCalledWith("alert-run-sla-1", expect.stringMatching(/^ops-alert-ack-/)));
    expect(await screen.findByText("확인됨")).toBeInTheDocument();
  });

  test("admin queues a SecretRef-backed webhook delivery attempt from the alert center", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const sendOpsAlertWebhookDelivery = vi.fn(async (
      alertId: string,
      body: Parameters<ApiClient["sendOpsAlertWebhookDelivery"]>[1],
    ) => ({
      attempt_id: "attempt-webhook-1",
      alert_id: alertId,
      detected_at: "2026-06-23T09:01:00.000Z",
      source: "run_sla" as const,
      subject_type: "run" as const,
      subject_id: "run-ops-1",
      channel: "webhook" as const,
      provider_alias: body.provider_alias ?? "webhook-primary",
      status: "pending" as const,
      endpoint_secret_ref: body.endpoint_secret_ref,
      callback_signature_secret_ref: body.callback_signature_secret_ref ?? null,
      route_policy_ref: body.route_policy_ref,
      recipient_group_ref: body.recipient_group_ref ?? null,
      allowed_hosts: body.allowed_hosts,
      attempt_no: 1,
      max_attempts: 3,
      next_attempt_at: "2026-06-23T09:02:00.000Z",
      summary: body.summary ?? "Webhook queued.",
      error_code: null,
      receipt_id: null,
      receipt_at: null,
      metadata: body.metadata ?? {},
      requested_by: "admin-a",
      requested_at: "2026-06-23T09:01:30.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({ sendOpsAlertWebhookDelivery }));

    const alertRow = (await screen.findByText("월말 정산 실행 SLA 초과")).closest("li") as HTMLLIElement;
    fireEvent.click(within(alertRow).getByRole("button", { name: "웹훅 발송" }));
    fireEvent.change(within(alertRow).getByLabelText("Endpoint SecretRef"), {
      target: { value: "secret://rpa/staging/notification-sender/notification/webhook/ops-primary" },
    });
    fireEvent.change(within(alertRow).getByLabelText("Allowed hosts"), {
      target: { value: "hooks.slack.com, example.webhook.office.com" },
    });
    fireEvent.change(within(alertRow).getByLabelText("Callback signing SecretRef"), {
      target: { value: "secret://rpa/staging/notification-sender/signing/webhook-callback" },
    });
    fireEvent.change(within(alertRow).getByLabelText("Recipient group ref"), {
      target: { value: "ops-primary-oncall" },
    });
    fireEvent.change(within(alertRow).getByLabelText("Webhook summary"), {
      target: { value: "월말 정산 SLA 초과 webhook" },
    });
    fireEvent.click(within(alertRow).getByLabelText("법적 보존"));
    fireEvent.click(within(alertRow).getByRole("button", { name: "발송 큐잉" }));

    await waitFor(() =>
      expect(sendOpsAlertWebhookDelivery).toHaveBeenCalledWith(
        "alert-run-sla-1",
        expect.objectContaining({
          endpoint_secret_ref: "secret://rpa/staging/notification-sender/notification/webhook/ops-primary",
          callback_signature_secret_ref: "secret://rpa/staging/notification-sender/signing/webhook-callback",
          route_policy_ref: "ops-alerts-primary",
          recipient_group_ref: "ops-primary-oncall",
          allowed_hosts: ["hooks.slack.com", "example.webhook.office.com"],
          provider_alias: "webhook-primary",
          summary: "월말 정산 SLA 초과 webhook",
          metadata: { requested_from: "admin_console" },
          legal_hold: true,
        }),
        expect.stringMatching(/^ops-alert-webhook-/),
      ),
    );
    expect(await within(alertRow).findByText("pending")).toBeInTheDocument();
    expect(within(alertRow).getByText(/attempt 1\/3/)).toBeInTheDocument();
  });

  test("알림 필터는 심각도와 유형을 API query로 반영한다", async () => {
    const listOpsAlerts = vi.fn(async () => ({ items: [], next_cursor: null }));
    renderApp(clientWithOpsData({ listOpsAlerts }));

    expect(await screen.findByRole("heading", { name: "알림 센터" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("알림 심각도"), { target: { value: "warning" } });

    await waitFor(() => expect(listOpsAlerts).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, severity: "warning" })));
    const sourceSelect = (): HTMLSelectElement => screen.getAllByRole("combobox").find((element) =>
      Array.from((element as HTMLSelectElement).options).some((option) => option.value === "readiness_evidence"),
    ) as HTMLSelectElement;
    fireEvent.change(screen.getByLabelText("알림 유형"), { target: { value: "human_task_sla" } });

    await waitFor(() =>
      expect(listOpsAlerts).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, severity: "warning", source: "human_task_sla" })),
    );
    fireEvent.change(screen.getByLabelText("알림 유형"), { target: { value: "audit_verifier" } });

    await waitFor(() =>
      expect(listOpsAlerts).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, severity: "warning", source: "audit_verifier" })),
    );
    fireEvent.change(sourceSelect(), { target: { value: "readiness_evidence" } });

    await waitFor(() =>
      expect(listOpsAlerts).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, severity: "warning", source: "readiness_evidence" })),
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
    // 브라우저 세션 타일: 만료 미회수 건수 + 다음 만료 시각(next_expiry_at) 표면화.
    const browserTile = screen.getByText("브라우저 세션").closest(".ops-health-tile") as HTMLElement;
    expect(browserTile).toHaveTextContent("만료 미회수 1건");
    expect(browserTile).toHaveTextContent("다음 만료");

    // 지연 실행 타일: 가장 오래된 시작 시각(oldest_updated_at) 표면화.
    const staleTile = screen.getByText("지연 실행").closest(".ops-health-tile") as HTMLElement;
    expect(staleTile).toHaveTextContent("가장 오래된 시작");
    fireEvent.click(within(staleTile).getByRole("button", { name: "실행 보기" }));

    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("운영 헬스: 만료 시각/지연 실행이 없으면 시각을 지어내지 않는다(조용한 false 금지)", async () => {
    renderApp(
      clientWithOpsData({
        getOpsHealth: async () => ({
          status: "ok" as const,
          detected_at: "2026-06-23T09:04:00.000Z",
          queue: { available: true, pending_jobs: 0 },
          browser_leases: { reserved: 0, active: 1, draining: 0, expired: 0, expired_open: 0, next_expiry_at: null },
          stale_runs: { nonterminal_over_15m: 0, oldest_updated_at: null },
        }),
      }),
    );

    // health 로드 완료를 기다린다(로딩 중엔 타일이 '사용 중/예약'을 보임).
    const detailBadge = await screen.findByText("만료 미회수 0건");
    const browserTile = detailBadge.closest(".ops-health-tile") as HTMLElement;
    expect(browserTile).not.toHaveTextContent("다음 만료"); // next_expiry_at null → 표기 안 함

    const staleTile = screen.getByText("지연 실행").closest(".ops-health-tile") as HTMLElement;
    expect(staleTile).toHaveTextContent("15분 이상 진행 중"); // 지연 없음 → 일반 문구
    expect(staleTile).not.toHaveTextContent("가장 오래된 시작");
  });

  test("controlled-prod readiness panel shows runtime blockers and deferred external evidence", async () => {
    const listProductionReadinessEvidence = vi.fn(async (params) => {
      if (params?.evidence_type === "external_alert_delivery") {
        return {
          items: [
            {
              evidence_id: "alert-evidence-1",
              evidence_type: "external_alert_delivery" as const,
              status: "valid" as const,
              evidence_at: "2026-06-23T09:04:00.000Z",
              expires_at: "2026-09-23T09:04:00.000Z",
              summary: "Provider delivered the controlled-prod alert drill.",
              evidence_ref: "ticket:OPS-123",
              metadata: {
                channel: "webhook",
                provider_alias: "webhook-primary",
                receipt_id: "receipt-123",
                receipt_at: "2026-06-23T09:04:30.000Z",
                delivery_status: "delivered",
              },
              recorded_by: "admin-a",
              recorded_at: "2026-06-23T09:05:00.000Z",
              legal_hold: false,
            },
          ],
          next_cursor: null,
        };
      }
      if (params?.evidence_type === "managed_backup_restore_drill") {
        return {
          items: [
            {
              evidence_id: "backup-evidence-1",
              evidence_type: "managed_backup_restore_drill" as const,
              status: "valid" as const,
              evidence_at: "2026-06-23T09:05:00.000Z",
              expires_at: "2026-09-23T09:05:00.000Z",
              summary: "Managed backup PITR restore completed within controlled-prod target.",
              evidence_ref: "drill:PITR-2026-06-23",
              metadata: {
                backup_policy_ref: "backup-policy:managed-pg-prod",
                restore_scope: "tenant-a-control-plane",
                restore_completed_at: "2026-06-23T09:25:00.000Z",
                rto_minutes: 20,
                rpo_minutes: 5,
              },
              recorded_by: "admin-a",
              recorded_at: "2026-06-23T09:26:00.000Z",
              legal_hold: false,
            },
          ],
          next_cursor: null,
        };
      }
      if (params?.evidence_type === "observability_telemetry_wiring") {
        return {
          items: [
            {
              evidence_id: "observability-evidence-1",
              evidence_type: "observability_telemetry_wiring" as const,
              status: "valid" as const,
              evidence_at: "2026-06-23T09:06:00.000Z",
              expires_at: "2026-09-23T09:06:00.000Z",
              summary: "OTLP collector, dashboard, and alert route evidence approved.",
              evidence_ref: "ticket:OBS-124",
              metadata: {
                exporter: "otlp",
                collector_ref: "otel-collector:rpa-prod",
                dashboard_ref: "grafana-folder-rpa",
                alert_route_ref: "alert-route:rpa-sev",
                sampled_at: "2026-06-23T09:06:30.000Z",
              },
              recorded_by: "admin-a",
              recorded_at: "2026-06-23T09:07:00.000Z",
              legal_hold: false,
            },
          ],
          next_cursor: null,
        };
      }
      if (params?.evidence_type === "support_training_completion") {
        return {
          items: [
            {
              evidence_id: "support-training-evidence-1",
              evidence_type: "support_training_completion" as const,
              status: "valid" as const,
              evidence_at: "2026-06-23T09:08:00.000Z",
              expires_at: "2026-09-23T09:08:00.000Z",
              summary: "Support model and training completion evidence approved.",
              evidence_ref: "ticket:TRAIN-123",
              metadata: {
                support_model_ref: "support-model:L1-L3",
                training_completion_ref: "training:completion-2026-06",
                trained_role_count: 3,
                trained_user_count: 18,
                coverage_percent: 95,
                completed_at: "2026-06-23T09:08:30.000Z",
              },
              recorded_by: "admin-a",
              recorded_at: "2026-06-23T09:09:00.000Z",
              legal_hold: false,
            },
          ],
          next_cursor: null,
        };
      }
      return {
        items: [
          {
            evidence_id: "slo-evidence-1",
            evidence_type: "slo_oncall_signoff" as const,
            status: "valid" as const,
            evidence_at: "2026-06-23T09:10:00.000Z",
            expires_at: "2026-09-23T09:10:00.000Z",
            summary: "SLO dashboard, severity policy, and on-call/RACI sign-off approved.",
            evidence_ref: "ticket:SRE-456",
            metadata: {
              slo_dashboard: "grafana-folder-rpa",
              severity_model: "sev1-sev4",
              oncall_rota: "primary-secondary",
              raci_ref: "raci:SRE-RPA",
              support_hours: "24x7",
            },
            recorded_by: "admin-a",
            recorded_at: "2026-06-23T09:11:00.000Z",
            legal_hold: false,
          },
        ],
        next_cursor: null,
      };
    });
    renderApp(clientWithOpsData({ listProductionReadinessEvidence }));

    expect(await screen.findByRole("heading", { name: "운영 전환 준비 상태" })).toBeInTheDocument();
    await screen.findByText("차단 없음");
    const runtimeTile = screen.getByText("실행 차단 요인").closest(".ops-health-tile") as HTMLElement;
    const externalTile = screen.getByText("외부 증빙").closest(".ops-health-tile") as HTMLElement;
    const capacityTile = screen.getByText("브라우저 용량").closest(".ops-health-tile") as HTMLElement;
    const auditTile = screen.getByText("감사 검증").closest(".ops-health-tile") as HTMLElement;

    expect(runtimeTile).toHaveTextContent("0");
    expect(runtimeTile).toHaveTextContent("차단 없음");
    expect(externalTile).toHaveTextContent("5");
    expect(externalTile).toHaveTextContent("담당자 증빙 필요");
    expect(capacityTile).toHaveTextContent("활성 2");
    expect(auditTile).toHaveTextContent("valid");
    expect(screen.getByText("External alert delivery")).toBeInTheDocument();
    expect(screen.getByText("Managed backup restore drill")).toBeInTheDocument();
    expect(screen.getByText("SLO/on-call sign-off")).toBeInTheDocument();
    expect(screen.getByText("Support/training completion")).toBeInTheDocument();
    expect(screen.getByText("Observability telemetry wiring")).toBeInTheDocument();
    await waitFor(() => expect(listProductionReadinessEvidence).toHaveBeenCalledWith({ evidence_type: "external_alert_delivery", limit: 3 }));
    await waitFor(() => expect(listProductionReadinessEvidence).toHaveBeenCalledWith({ evidence_type: "managed_backup_restore_drill", limit: 3 }));
    await waitFor(() => expect(listProductionReadinessEvidence).toHaveBeenCalledWith({ evidence_type: "slo_oncall_signoff", limit: 3 }));
    await waitFor(() => expect(listProductionReadinessEvidence).toHaveBeenCalledWith({ evidence_type: "support_training_completion", limit: 3 }));
    await waitFor(() => expect(listProductionReadinessEvidence).toHaveBeenCalledWith({ evidence_type: "observability_telemetry_wiring", limit: 3 }));
    expect(await screen.findByText("외부 알림 증빙")).toBeInTheDocument();
    expect(screen.getByText("Provider delivered the controlled-prod alert drill.")).toBeInTheDocument();
    expect(screen.getByText("ticket:OPS-123")).toBeInTheDocument();
    expect(screen.getByText(/webhook \/ webhook-primary \/ delivered/)).toBeInTheDocument();
    expect(screen.getByText(/receipt receipt-123 at 2026-06-23T09:04:30.000Z/)).toBeInTheDocument();
    expect(await screen.findByText("백업/PITR 증빙")).toBeInTheDocument();
    expect(screen.getByText("Managed backup PITR restore completed within controlled-prod target.")).toBeInTheDocument();
    expect(screen.getByText("drill:PITR-2026-06-23")).toBeInTheDocument();
    expect(screen.getByText(/policy backup-policy:managed-pg-prod \/ scope tenant-a-control-plane/)).toBeInTheDocument();
    expect(screen.getByText(/RTO 20m \/ RPO 5m \/ restored 2026-06-23T09:25:00.000Z/)).toBeInTheDocument();
    expect(await screen.findByText("SLO·당직 증빙")).toBeInTheDocument();
    expect(screen.getByText("SLO dashboard, severity policy, and on-call/RACI sign-off approved.")).toBeInTheDocument();
    expect(screen.getByText("ticket:SRE-456")).toBeInTheDocument();
    expect(screen.getByText(/dashboard grafana-folder-rpa \/ severity sev1-sev4 \/ rota primary-secondary/)).toBeInTheDocument();
    expect(screen.getByText(/RACI raci:SRE-RPA \/ support 24x7/)).toBeInTheDocument();
    expect(await screen.findByText("지원·교육 증빙")).toBeInTheDocument();
    expect(screen.getByText("Support model and training completion evidence approved.")).toBeInTheDocument();
    expect(screen.getByText("ticket:TRAIN-123")).toBeInTheDocument();
    expect(screen.getByText(/model support-model:L1-L3 \/ training training:completion-2026-06/)).toBeInTheDocument();
    expect(screen.getByText(/roles 3 \/ users 18 \/ coverage 95%/)).toBeInTheDocument();
    expect(screen.getByText(/completed 2026-06-23T09:08:30.000Z/)).toBeInTheDocument();
    expect(await screen.findByText("관측성 증빙")).toBeInTheDocument();
    expect(screen.getByText("OTLP collector, dashboard, and alert route evidence approved.")).toBeInTheDocument();
    expect(screen.getByText("ticket:OBS-124")).toBeInTheDocument();
    expect(screen.getByText(/exporter otlp \/ collector otel-collector:rpa-prod/)).toBeInTheDocument();
    expect(screen.getByText(/dashboard grafana-folder-rpa \/ alert route alert-route:rpa-sev/)).toBeInTheDocument();
    expect(screen.getByText(/sampled 2026-06-23T09:06:30.000Z/)).toBeInTheDocument();
  });

  test("admin records external alert delivery readiness evidence from the readiness panel", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordProductionReadinessEvidence = vi.fn(async (body) => ({
      evidence_id: "alert-evidence-recorded",
      evidence_type: body.evidence_type,
      status: body.status,
      evidence_at: body.evidence_at,
      expires_at: body.expires_at ?? null,
      summary: body.summary,
      evidence_ref: body.evidence_ref ?? null,
      metadata: body.metadata ?? {},
      recorded_by: "admin-a",
      recorded_at: "2026-06-23T09:11:00.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({
      listProductionReadinessEvidence: async () => ({ items: [], next_cursor: null }),
      recordProductionReadinessEvidence,
    }));

    expect(await screen.findByRole("heading", { name: "운영 전환 준비 상태" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Alert evidence ref"), { target: { value: "ticket:OPS-123" } });
    fireEvent.change(screen.getByLabelText("Alert evidence summary"), { target: { value: "Provider delivered the drill alert." } });
    fireEvent.change(screen.getByLabelText("Notification channel"), { target: { value: "webhook" } });
    fireEvent.change(screen.getByLabelText("Provider alias"), { target: { value: "webhook-primary" } });
    fireEvent.change(screen.getByLabelText("Receipt id"), { target: { value: "receipt-123" } });
    fireEvent.change(screen.getByLabelText("Receipt at"), { target: { value: "2026-06-29T00:05:30.000Z" } });
    fireEvent.change(screen.getByLabelText("Alert evidence expires on"), { target: { value: "2026-09-29" } });
    fireEvent.click(screen.getByRole("button", { name: "알림 증빙 기록" }));

    await waitFor(() => expect(recordProductionReadinessEvidence).toHaveBeenCalledTimes(1));
    expect(recordProductionReadinessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence_type: "external_alert_delivery",
        status: "valid",
        expires_at: "2026-09-29T23:59:59.000Z",
        summary: "Provider delivered the drill alert.",
        evidence_ref: "ticket:OPS-123",
        metadata: {
          channel: "webhook",
          provider_alias: "webhook-primary",
          receipt_id: "receipt-123",
          receipt_at: "2026-06-29T00:05:30.000Z",
          delivery_status: "delivered",
        },
        legal_hold: false,
      }),
      expect.stringMatching(/^readiness-alert-ticket:OPS-123-receipt-123-/),
    );
  });

  test("admin records SLO/on-call readiness evidence from the readiness panel", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordProductionReadinessEvidence = vi.fn(async (body) => ({
      evidence_id: "slo-evidence-recorded",
      evidence_type: body.evidence_type,
      status: body.status,
      evidence_at: body.evidence_at,
      expires_at: body.expires_at ?? null,
      summary: body.summary,
      evidence_ref: body.evidence_ref ?? null,
      metadata: body.metadata ?? {},
      recorded_by: "admin-a",
      recorded_at: "2026-06-23T09:11:00.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({
      listProductionReadinessEvidence: async () => ({ items: [], next_cursor: null }),
      recordProductionReadinessEvidence,
    }));

    expect(await screen.findByRole("heading", { name: "운영 전환 준비 상태" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Evidence ref"), { target: { value: "ticket:SRE-789" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "SLO and on-call sign-off approved." } });
    fireEvent.change(screen.getByLabelText("SLO dashboard"), { target: { value: "grafana-folder-rpa" } });
    fireEvent.change(screen.getByLabelText("Severity model"), { target: { value: "sev1-sev4" } });
    fireEvent.change(screen.getByLabelText("On-call rota"), { target: { value: "primary-secondary" } });
    fireEvent.change(screen.getByLabelText("RACI ref"), { target: { value: "raci:SRE-RPA" } });
    fireEvent.change(screen.getByLabelText("Support hours"), { target: { value: "24x7" } });
    fireEvent.change(screen.getByLabelText("Expires on"), { target: { value: "2026-09-29" } });
    fireEvent.click(screen.getByRole("button", { name: "SLO 증빙 기록" }));

    await waitFor(() => expect(recordProductionReadinessEvidence).toHaveBeenCalledTimes(1));
    expect(recordProductionReadinessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence_type: "slo_oncall_signoff",
        status: "valid",
        expires_at: "2026-09-29T23:59:59.000Z",
        summary: "SLO and on-call sign-off approved.",
        evidence_ref: "ticket:SRE-789",
        metadata: {
          slo_dashboard: "grafana-folder-rpa",
          severity_model: "sev1-sev4",
          oncall_rota: "primary-secondary",
          raci_ref: "raci:SRE-RPA",
          support_hours: "24x7",
        },
        legal_hold: false,
      }),
      expect.stringMatching(/^readiness-slo-ticket:SRE-789-/),
    );
  });

  test("admin records support/training readiness evidence from the readiness panel", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordProductionReadinessEvidence = vi.fn(async (body) => ({
      evidence_id: "support-training-evidence-recorded",
      evidence_type: body.evidence_type,
      status: body.status,
      evidence_at: body.evidence_at,
      expires_at: body.expires_at ?? null,
      summary: body.summary,
      evidence_ref: body.evidence_ref ?? null,
      metadata: body.metadata ?? {},
      recorded_by: "admin-a",
      recorded_at: "2026-06-23T09:11:00.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({
      listProductionReadinessEvidence: async () => ({ items: [], next_cursor: null }),
      recordProductionReadinessEvidence,
    }));

    expect(await screen.findByRole("heading", { name: "운영 전환 준비 상태" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Support evidence ref"), { target: { value: "ticket:TRAIN-123" } });
    fireEvent.change(screen.getByLabelText("Support summary"), { target: { value: "Support model and training completion approved." } });
    fireEvent.change(screen.getByLabelText("Support model ref"), { target: { value: "support-model:L1-L3" } });
    fireEvent.change(screen.getByLabelText("Training completion ref"), { target: { value: "training:completion-2026-06" } });
    fireEvent.change(screen.getByLabelText("Trained role count"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Trained user count"), { target: { value: "18" } });
    fireEvent.change(screen.getByLabelText("Coverage percent"), { target: { value: "95" } });
    fireEvent.change(screen.getByLabelText("Completed at"), { target: { value: "2026-06-29T00:45:00.000Z" } });
    fireEvent.change(screen.getByLabelText("Support training expires on"), { target: { value: "2026-09-29" } });
    fireEvent.click(screen.getByRole("button", { name: "지원 증빙 기록" }));

    await waitFor(() => expect(recordProductionReadinessEvidence).toHaveBeenCalledTimes(1));
    expect(recordProductionReadinessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence_type: "support_training_completion",
        status: "valid",
        expires_at: "2026-09-29T23:59:59.000Z",
        summary: "Support model and training completion approved.",
        evidence_ref: "ticket:TRAIN-123",
        metadata: {
          support_model_ref: "support-model:L1-L3",
          training_completion_ref: "training:completion-2026-06",
          trained_role_count: 3,
          trained_user_count: 18,
          coverage_percent: 95,
          completed_at: "2026-06-29T00:45:00.000Z",
        },
        legal_hold: false,
      }),
      expect.stringMatching(/^readiness-support-training-ticket:TRAIN-123-training:completion-2026-06-/),
    );
  });

  test("admin records observability telemetry readiness evidence from the readiness panel", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordProductionReadinessEvidence = vi.fn(async (body) => ({
      evidence_id: "observability-evidence-recorded",
      evidence_type: body.evidence_type,
      status: body.status,
      evidence_at: body.evidence_at,
      expires_at: body.expires_at ?? null,
      summary: body.summary,
      evidence_ref: body.evidence_ref ?? null,
      metadata: body.metadata ?? {},
      recorded_by: "admin-a",
      recorded_at: "2026-06-23T09:11:00.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({
      listProductionReadinessEvidence: async () => ({ items: [], next_cursor: null }),
      recordProductionReadinessEvidence,
    }));

    expect(await screen.findByRole("heading", { name: "운영 전환 준비 상태" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Telemetry evidence ref"), { target: { value: "ticket:OBS-124" } });
    fireEvent.change(screen.getByLabelText("Telemetry summary"), { target: { value: "OTLP collector, dashboard, and alert route approved." } });
    fireEvent.change(screen.getByLabelText("Telemetry exporter"), { target: { value: "otlp" } });
    fireEvent.change(screen.getByLabelText("Collector ref"), { target: { value: "otel-collector:rpa-prod" } });
    fireEvent.change(screen.getByLabelText("Dashboard ref"), { target: { value: "grafana-folder-rpa" } });
    fireEvent.change(screen.getByLabelText("Alert route ref"), { target: { value: "alert-route:rpa-sev" } });
    fireEvent.change(screen.getByLabelText("Sampled at"), { target: { value: "2026-06-29T00:16:30.000Z" } });
    fireEvent.change(screen.getByLabelText("Telemetry evidence expires on"), { target: { value: "2026-09-29" } });
    fireEvent.click(screen.getByRole("button", { name: "관측성 증빙 기록" }));

    await waitFor(() => expect(recordProductionReadinessEvidence).toHaveBeenCalledTimes(1));
    expect(recordProductionReadinessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence_type: "observability_telemetry_wiring",
        status: "valid",
        expires_at: "2026-09-29T23:59:59.000Z",
        summary: "OTLP collector, dashboard, and alert route approved.",
        evidence_ref: "ticket:OBS-124",
        metadata: {
          exporter: "otlp",
          collector_ref: "otel-collector:rpa-prod",
          dashboard_ref: "grafana-folder-rpa",
          alert_route_ref: "alert-route:rpa-sev",
          sampled_at: "2026-06-29T00:16:30.000Z",
        },
        legal_hold: false,
      }),
      expect.stringMatching(/^readiness-observability-ticket:OBS-124-otel-collector:rpa-prod-/),
    );
  });

  test("admin records managed backup/PITR readiness evidence from the readiness panel", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordProductionReadinessEvidence = vi.fn(async (body) => ({
      evidence_id: "backup-evidence-recorded",
      evidence_type: body.evidence_type,
      status: body.status,
      evidence_at: body.evidence_at,
      expires_at: body.expires_at ?? null,
      summary: body.summary,
      evidence_ref: body.evidence_ref ?? null,
      metadata: body.metadata ?? {},
      recorded_by: "admin-a",
      recorded_at: "2026-06-23T09:11:00.000Z",
      legal_hold: body.legal_hold ?? false,
    }));
    renderApp(clientWithOpsData({
      listProductionReadinessEvidence: async () => ({ items: [], next_cursor: null }),
      recordProductionReadinessEvidence,
    }));

    expect(await screen.findByRole("heading", { name: "운영 전환 준비 상태" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Backup evidence ref"), { target: { value: "drill:PITR-2026-06-29" } });
    fireEvent.change(screen.getByLabelText("Backup summary"), { target: { value: "PITR restore completed within target." } });
    fireEvent.change(screen.getByLabelText("Backup policy ref"), { target: { value: "backup-policy:managed-pg-prod" } });
    fireEvent.change(screen.getByLabelText("Restore scope"), { target: { value: "tenant-a-control-plane" } });
    fireEvent.change(screen.getByLabelText("Restore completed at"), { target: { value: "2026-06-29T00:30:00.000Z" } });
    fireEvent.change(screen.getByLabelText("RTO minutes"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("RPO minutes"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Backup expires on"), { target: { value: "2026-09-29" } });
    fireEvent.click(screen.getByRole("button", { name: "백업 증빙 기록" }));

    await waitFor(() => expect(recordProductionReadinessEvidence).toHaveBeenCalledTimes(1));
    expect(recordProductionReadinessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence_type: "managed_backup_restore_drill",
        status: "valid",
        expires_at: "2026-09-29T23:59:59.000Z",
        summary: "PITR restore completed within target.",
        evidence_ref: "drill:PITR-2026-06-29",
        metadata: {
          backup_policy_ref: "backup-policy:managed-pg-prod",
          restore_scope: "tenant-a-control-plane",
          restore_completed_at: "2026-06-29T00:30:00.000Z",
          rto_minutes: 20,
          rpo_minutes: 5,
        },
        legal_hold: false,
      }),
      expect.stringMatching(/^readiness-backup-drill:PITR-2026-06-29-/),
    );
  });

  test("봇 풀 용량 패널은 worker/lease/대기 실행 집계를 표시한다", async () => {
    renderApp(clientWithOpsData());

    expect(await screen.findByRole("heading", { name: "용량" })).toBeInTheDocument();
    const poolRow = (await screen.findByText("브라우저 실행 풀")).closest("li") as HTMLLIElement;
    expect(within(poolRow).getByText("worker 1/2 · 사용 2/1 · 여유 0 · 부족 3")).toBeInTheDocument();
    expect(poolRow).toHaveTextContent("queued 3건 · claimed 0건 · 압력 3.0x · 발화 예정 1건");
    expect(poolRow).toHaveTextContent("가장 오래된 대기");
    expect(poolRow).toHaveTextContent("풀별 live 용량 미계약");
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
    expect(screen.getByText("수신 트리거 저장됨 · 외부 시스템 등록은 별도")).toBeInTheDocument();
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

  test("ops alert center shows metadata-only provider delivery receipts", async () => {
    const listOpsAlertDeliveries = vi.fn(async () => ({
      items: [
        {
          delivery_id: "delivery-1",
          alert_id: "alert-run-sla-1",
          detected_at: "2026-06-23T09:01:00.000Z",
          source: "run_sla" as const,
          subject_type: "run" as const,
          subject_id: "run-ops-1",
          channel: "teams" as const,
          provider_alias: "teams-primary",
          status: "delivered" as const,
          receipt_id: "teams-receipt-1",
          receipt_at: "2026-06-23T09:02:00.000Z",
          endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
          credential_secret_ref: "secret://tenant-a/notification/teams/credential",
          callback_signature_secret_ref: null,
          route_policy_ref: "ops-alerts-primary",
          recipient_group_ref: "ops-primary-oncall",
          attempt_no: 1,
          summary: "Provider accepted and delivered the drill alert.",
          error_code: null,
          metadata: { provider_region: "ap-northeast-2" },
          recorded_by: "admin-a",
          recorded_at: "2026-06-23T09:03:00.000Z",
          legal_hold: false,
        },
      ],
      next_cursor: null,
    }));
    renderApp(clientWithOpsData({ listOpsAlertDeliveries }));

    const receiptButtons = await screen.findAllByRole("button", { name: "전달 증빙" });
    const alertRow = (receiptButtons[0] as HTMLButtonElement).closest("li") as HTMLLIElement;
    fireEvent.click(receiptButtons[0] as HTMLButtonElement);

    await waitFor(() => expect(listOpsAlertDeliveries).toHaveBeenCalledWith("alert-run-sla-1", { limit: 5 }));
    expect(await within(alertRow).findByText("제공자 전달 증빙")).toBeInTheDocument();
    expect(within(alertRow).getByText("teams / teams-primary")).toBeInTheDocument();
    expect(within(alertRow).getByText(/receipt teams-receipt-1/)).toBeInTheDocument();
    expect(within(alertRow).getByText(/secret:\/\/tenant-a\/notification\/teams\/primary/)).toBeInTheDocument();
    expect(within(alertRow).getByText(/recipient group ops-primary-oncall/)).toBeInTheDocument();
  });
});
