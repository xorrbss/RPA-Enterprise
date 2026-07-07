import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { AuthReadiness, AutomationPerformanceRoiSourceLineage, DeadLetterItem, ListParams, Paginated } from "../src/api/types";
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

const automationPerformanceRoiSourceLineage: AutomationPerformanceRoiSourceLineage = {
  idea_count: 2,
  source_counts: { manual: 1, process_mining: 1, task_mining: 0, imported: 0 },
  stage_counts: { approved: 1, build: 1, operate: 0 },
  departments: ["Finance", "Procurement"],
  business_owners: ["Mina Kim", "Joon Park"],
  sample_ideas: [
    {
      idea_id: "61000000-0000-4000-8000-000000000001",
      title: "Invoice lookup ROI",
      source: "process_mining",
      stage: "approved",
      department: "Finance",
      business_owner: "Mina Kim",
    },
    {
      idea_id: "61000000-0000-4000-8000-000000000002",
      title: "Vendor exception triage",
      source: "manual",
      stage: "build",
      department: "Procurement",
      business_owner: "Joon Park",
    },
  ],
};

const AUTH_SETUP_NEEDED: AuthReadiness = {
  status: "warning",
  enterprise_sso_ready: false,
  provider: {
    mode: "hs256",
    configuration_source: "deployment_config",
    algorithm: "HS256",
    jwks_url_configured: false,
    jwks_host: null,
    issuer_configured: false,
    issuer: null,
    audience_configured: false,
    audience: null,
  },
  claim_mapping: {
    subject_claim: "sub",
    tenant_claim: "tenant_id",
    roles_claim: "roles",
    expiry_claim: "exp",
    display_name_claim: "name",
    email_claim: "email",
  },
  role_mapping: {
    configured: false,
    mapped_values: 0,
  },
  required_claims: [
    { claim: "sub", label: "처리자 식별", required: true, present: true, mapped_to: "current_principal.subject_id" },
    { claim: "tenant_id", label: "테넌트 경계", required: true, present: true, mapped_to: "current_principal.tenant_id" },
    { claim: "roles", label: "역할 매핑", required: true, present: true, mapped_to: "current_principal.roles" },
    { claim: "exp", label: "만료 시간", required: true, present: true, mapped_to: "인증 만료 검증" },
  ],
  current_principal: {
    subject_id: "viewer-a",
    tenant_id: "tenant-a",
    roles: ["viewer"],
    source: "jwt",
    display_name: null,
    email: null,
  },
  operational_gaps: ["SSO 설정 확인 필요"],
};

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
          delivery: { channel: "console", status: "delivered", delivered_at: "2026-06-23T09:01:00.000Z", external_delivery: false },
          ack: null,
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
          delivery: { channel: "console", status: "delivered", delivered_at: "2026-06-23T09:03:00.000Z", external_delivery: false },
          ack: null,
          recommended_action: "공통 장애 여부를 점검하세요.",
          route: "#runTrace",
          detected_at: "2026-06-23T09:03:00.000Z",
          due_at: null,
        },
        {
          alert_id: "audit_verifier:stale",
          severity: "warning",
          source: "audit_verifier",
          title: "감사 체인 검증 증적 지연",
          detail: "감사 로그가 존재하지만 자동 검증 증적이 지연되었습니다.",
          subject_type: "audit_verifier",
          subject_id: null,
          status: "open",
          delivery: { channel: "console", status: "delivered", delivered_at: "2026-06-23T09:04:00.000Z", external_delivery: false },
          ack: null,
          recommended_action: "Audit Explorer에서 검증 실행 증적을 확인하세요.",
          route: "#auditExplorer",
          detected_at: "2026-06-23T09:04:00.000Z",
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
    location.hash = "#dashboard"; // 랜딩 디폴트가 myWork 로 바뀌어 대시보드 콘텐츠 테스트는 명시 이동.
    localStorage.setItem("rpa.token", jwt(["operator"]));
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("role workbench keeps Product-open out of operator quick actions but available to admin internal", async () => {
    renderApp(dashboardClient());
    const operatorWorkbench = await screen.findByRole("region", { name: "역할별 작업대" });
    expect(within(operatorWorkbench).queryByRole("button", { name: "Product-open 점검" })).toBeNull();

    vi.stubEnv("VITE_SHOW_INTERNAL_OPEN_GATE", "true");
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(dashboardClient());
    const workbenches = await screen.findAllByRole("region", { name: "역할별 작업대" });
    const adminWorkbench = workbenches[workbenches.length - 1];
    if (adminWorkbench === undefined) throw new Error("admin workbench not found");
    expect(within(adminWorkbench).getByRole("button", { name: "Product-open 점검" })).toBeInTheDocument();
  });

  test("adoption-readiness shows every gate without optimistic success or unauthorized setup CTAs", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp(dashboardClient({
      getAuthReadiness: async () => AUTH_SETUP_NEEDED,
      listSites: async () => ({ items: [], next_cursor: null }),
      listScenarios: async () => ({ items: [], next_cursor: null }),
      listRuns: async () => ({ items: [], next_cursor: null }),
      getRunSummary: async () => ({ by_status: {}, success_rate: null, total: 0, cache: { by_mode: {}, hit_rate: null } }),
    }));

    const panel = await screen.findByRole("region", { name: "파일럿 준비 상태" });
    for (const label of ["SSO", "RBAC", "사이트", "브라우저 세션", "첫 자동화", "테스트 실행", "증거", "지원 체계", "ROI"]) {
      expect(within(panel).getByText(label)).toBeInTheDocument();
    }
    await within(panel).findByText("SSO 설정 확인 필요");
    await waitFor(() => expect(within(panel).getAllByText("확인 필요").length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(within(panel).getAllByText("보류").length).toBeGreaterThanOrEqual(2));
    expect(panel).not.toHaveTextContent("9/9 준비");

    for (const gate of within(panel).getAllByRole("listitem")) {
      expect(within(gate).queryAllByRole("button").length).toBeLessThanOrEqual(1);
    }
    expect(within(panel).queryByRole("button", { name: "접속 설정 확인" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "역할 매핑 확인" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "사이트 등록" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "자동화 초안 만들기" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "테스트 실행" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "운영 증빙 확인" })).toBeNull();
    expect(within(panel).getAllByText("권한 있는 담당자에게 요청").length).toBeGreaterThanOrEqual(5);
  });

  test("adoption-readiness treats controlled_prod_ready as the production source of truth", async () => {
    renderApp(dashboardClient({
      getAuthReadiness: async () => ({
        ...AUTH_SETUP_NEEDED,
        status: "ok",
        enterprise_sso_ready: true,
        role_mapping: { configured: true, mapped_values: 5 },
        operational_gaps: [],
      }),
      getProductionReadiness: async () => {
        const base = await fakeClient().getProductionReadiness();
        return {
          ...base,
          status: "ready",
          summary: { controlled_prod_ready: false, status: "ready", blocker_count: 0, warning_count: 1, deferred_count: 0 },
          gates: base.gates.map((gate) => ({ ...gate, status: "pass" as const, reason_code: null, detail: "ready", required_action: null })),
        };
      },
      listSites: async () => ({
        items: [{
          site_profile_id: "site-login",
          name: "Login Site",
          risk: "green",
          approval_status: "approved",
          circuit_status: "closed",
          login_capable: true,
          session_ready: true,
        }],
        next_cursor: null,
      }),
      listScenarios: async () => ({
        items: [{ scenario_id: "scenario-ready", name: "Invoice lookup", version: 3, latest_version_id: "version-ready", promotion_status: "approved" }],
        next_cursor: null,
      }),
      listRuns: async () => ({
        items: [{ run_id: "run-ready", status: "completed", scenario_name: "Invoice lookup", current_node: null, as_of: "2026-06-30T03:00:00.000Z", failure_reason: null }],
        next_cursor: null,
      }),
      getRunSummary: async () => ({ by_status: { completed: 1 }, success_rate: 1, total: 1, cache: { by_mode: { hit: 1 }, hit_rate: 1 } }),
    }));

    const panel = await screen.findByRole("region", { name: "파일럿 준비 상태" });
    await waitFor(() => expect(panel).toHaveTextContent("경고 1건"));
    expect(panel).toHaveTextContent("운영 전 경고 해소 필요");
    expect(panel).not.toHaveTextContent("9/9 준비");
  });

  test("adoption-readiness collapses gate details when all checks are ready", async () => {
    renderApp(dashboardClient({
      getAuthReadiness: async () => ({
        ...AUTH_SETUP_NEEDED,
        status: "ok",
        enterprise_sso_ready: true,
        role_mapping: { configured: true, mapped_values: 5 },
        operational_gaps: [],
      }),
      getProductionReadiness: async () => {
        const base = await fakeClient().getProductionReadiness();
        return {
          ...base,
          status: "ready",
          summary: { controlled_prod_ready: true, status: "ready", blocker_count: 0, warning_count: 0, deferred_count: 0 },
          gates: base.gates.map((gate) => ({ ...gate, status: "pass" as const, reason_code: null, detail: "ready", required_action: null })),
        };
      },
      listSites: async () => ({
        items: [{
          site_profile_id: "site-login",
          name: "Login Site",
          risk: "green",
          approval_status: "approved",
          circuit_status: "closed",
          login_capable: true,
          session_ready: true,
        }],
        next_cursor: null,
      }),
      listScenarios: async () => ({
        items: [{ scenario_id: "scenario-ready", name: "Invoice lookup", version: 3, latest_version_id: "version-ready", promotion_status: "approved" }],
        next_cursor: null,
      }),
      listRuns: async () => ({
        items: [{ run_id: "run-ready", status: "completed", scenario_name: "Invoice lookup", current_node: null, as_of: "2026-06-30T03:00:00.000Z", failure_reason: null }],
        next_cursor: null,
      }),
      getRunSummary: async () => ({ by_status: { completed: 1 }, success_rate: 1, total: 1, cache: { by_mode: { hit: 1 }, hit_rate: 1 } }),
    }));

    const panel = await screen.findByRole("region", { name: "파일럿 준비 상태" });
    await waitFor(() => expect(panel).toHaveTextContent("9/9 준비"));
    expect(within(panel).getByText("모든 필수 관문이 준비되었습니다. 운영 전환 패킷과 최근 실행 증거를 기준으로 계속 모니터링하세요.")).toBeInTheDocument();
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
  });

  test("AdminAdoptionSetup is an admin-only dashboard panel with existing route links", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp(dashboardClient());
    await screen.findByRole("region", { name: "파일럿 준비 상태" });
    expect(screen.queryByRole("region", { name: "관리자 도입 설정" })).toBeNull();

    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(dashboardClient({
      listScimProviders: async () => ({ items: [], next_cursor: null }),
    }));

    const panels = await screen.findAllByRole("region", { name: "관리자 도입 설정" });
    const panel = panels[panels.length - 1];
    if (panel === undefined) throw new Error("admin adoption setup panel not found");
    expect(within(panel).getByText("접속과 역할")).toBeInTheDocument();
    expect(within(panel).getByText("사람과 조직")).toBeInTheDocument();
    expect(within(panel).getByText("비밀과 연결")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "접속·권한 열기" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "SCIM 설정 열기" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "운영 증빙 열기" })).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("AdminAdoptionSetup");
    expect(panel).not.toHaveTextContent("token");
  });

  test("adoption evidence packet summarizes metadata without raw secret or audit payload", async () => {
    renderApp(dashboardClient({
      listSites: async () => ({
        items: [
          {
            site_profile_id: "site-login",
            name: "Login Site",
            risk: "green",
            approval_status: "approved",
            circuit_status: "closed",
            login_capable: true,
            session_ready: true,
            session_expires_at: null,
            enc_kid: "kms-envelope-prod-1",
          },
        ],
        next_cursor: null,
      }),
      listRunArtifacts: async () => ({
        items: [
          {
            artifact_id: "artifact-1",
            type: "screen_capture",
            redaction_status: "redacted",
            retention_until: null,
            legal_hold: false,
            created_at: "2026-06-23T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      }),
      getProductionReadiness: async () => ({
        ...(await fakeClient().getProductionReadiness()),
        status: "warning",
        summary: { controlled_prod_ready: false, status: "warning", blocker_count: 0, warning_count: 1, deferred_count: 1 },
      }),
    }));

    const panel = await screen.findByRole("region", { name: "도입 증빙 패킷" });
    expect(within(panel).getByText(/Dashboard embedded panel/)).toBeInTheDocument();
    expect(within(panel).getByText(/Negative proof/)).toBeInTheDocument();
    expect(within(panel).getByText(/automationOps\?section=readiness/)).toBeInTheDocument();
    expect(within(panel).getByText("세션 저장 암호화")).toBeInTheDocument();
    expect(await within(panel).findByText(/KMS envelope kid/)).toBeInTheDocument();
    await waitFor(() => expect(panel).toHaveTextContent("S11"));
    expect(within(panel).getByText(/SecretRef audit summary: 1 metadata rows/)).toBeInTheDocument();
    expect(within(panel).getByText("artifact redaction 상태")).toBeInTheDocument();
    expect(within(panel).getByText(/1\/1개 artifact/)).toBeInTheDocument();
    expect(within(panel).getByText("scenario certification/release")).toBeInTheDocument();
    expect(within(panel).getByText(/scenario certification: 0 scenarios/)).toBeInTheDocument();
    expect(within(panel).getByText("AI 데이터 반출 경계")).toBeInTheDocument();
    expect(within(panel).getByText(/AI governance evidence: valid 1, deferred 1, failed 0/)).toBeInTheDocument();
    expect(within(panel).getByText("controlled-prod gate summary")).toBeInTheDocument();
    expect(within(panel).getByText(/차단 0건, 경고 1건, 보류 1건은 모두 미해소/)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("must-not-leak");
    expect(panel).not.toHaveTextContent("payload");
    fireEvent.click(within(panel).getByRole("button", { name: "AI 증거 열기" }));
    await waitFor(() => expect(location.hash).toBe("#security?section=ai"));
  });

  test("dashboard focus hash targets evidence packet and automation report anchors", async () => {
    location.hash = "#dashboard?focus=evidence-packet";
    renderApp(dashboardClient());

    const evidence = await screen.findByRole("region", { name: "도입 증빙 패킷" });
    const evidenceAnchor = evidence.closest("[data-dashboard-focus='evidence-packet']");
    await waitFor(() => expect(document.activeElement).toBe(evidenceAnchor));

    location.hash = "#dashboard?focus=automation-report";
    const report = await screen.findByRole("region", { name: "월간 자동화 성과 리포트" });
    const reportAnchor = report.closest("[data-dashboard-focus='automation-report']");
    await waitFor(() => expect(document.activeElement).toBe(reportAnchor));
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
            return { items: [{ run_id: rawRunId, status: "failed_system", run_mode: "prod", current_node: null, as_of: null, failure_reason: { code: "RAW_SYSTEM_ERROR_CODE", message: "raw error" } }], next_cursor: null };
          }
          if (params?.status === "running") {
            return { items: [{ run_id: "run-running-raw-87654321", status: "running", run_mode: "prod", current_node: null, as_of: null, updated_at: null, failure_reason: null }], next_cursor: null };
          }
          if (params?.status === "failed_business") return { items: [], next_cursor: null };
          return { items: [{ run_id: rawRunId, status: "failed_system", run_mode: "prod", current_node: null, as_of: null, failure_reason: { code: "RAW_SYSTEM_ERROR_CODE", message: "raw error" } }], next_cursor: null };
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
  test("업무 실패 카드 → #runTrace?status=failed_business&run_mode=prod", async () => {
    renderApp(fakeClient());
    const bizCard = await screen.findByRole("button", { name: /업무 실패/ });
    bizCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=failed_business&run_mode=prod"));
  });

  test("사람 확인 대기 카드와 Top5는 종결 업무를 제외하고 terminal=false로 드릴다운한다", async () => {
    const humanCalls: ListParams[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async (params) => {
          humanCalls.push(params ?? {});
          return {
            items: [
              { human_task_id: "ht-open", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null },
              { human_task_id: "ht-resolved", state: "resolved", kind: "approval", assignee: "u", timeout: "2026-06-01T00:00:00.000Z", on_timeout: "escalate", run_id: null },
            ],
            next_cursor: null,
          };
        },
      }),
    );

    const humanCard = await screen.findByRole("button", { name: /사람 확인 대기/ });
    expect(humanCalls).toContainEqual(expect.objectContaining({ terminal: "false", limit: 50 }));
    await waitFor(() => expect(humanCard).toHaveTextContent("1"));
    expect(document.body.textContent ?? "").toContain("ht-open");
    expect(document.body.textContent ?? "").not.toContain("ht-resolv");

    humanCard.click();
    await waitFor(() => expect(location.hash).toBe("#humanTasks?terminal=false"));
  });

  test("시스템 실패 카드 → #runTrace?status=failed_system", async () => {
    renderApp(fakeClient());
    const sysCard = await screen.findByRole("button", { name: /시스템 실패/ });
    sysCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=failed_system&run_mode=prod"));
  });

  test("실행 성공률 카드 → #runTrace?status=completed", async () => {
    renderApp(fakeClient());
    const rateCard = await screen.findByRole("button", { name: /실행 성공률/ });
    rateCard.click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=completed&run_mode=prod"));
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
    expect(screen.getByText("감사 체인 검증 증적 지연")).toBeInTheDocument();
    expect(screen.getByText("실행 SLA · 실행 기록에서 병목 단계를 확인하세요.")).toBeInTheDocument();
    expect(screen.getByText("감사 체인 · Audit Explorer에서 검증 실행 증적을 확인하세요.")).toBeInTheDocument();

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
    const csvExports: string[] = [];
    const pocExports: string[] = [];
    const xlsxExports: string[] = [];
    const createObjectURL = vi.fn(() => "blob:performance-csv");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    renderApp(
      dashboardClient({
        getAutomationPerformanceReport: async (month, runMode = "prod") => ({
          month: month ?? "2026-06",
          run_mode: runMode,
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
            implementation_effort: 900000,
            net_value: 738766,
            value_to_cost_ratio: 599.6758508914101,
            payback_months: 1.2162162162162162,
            gateway_cost: 1234,
            cost_by_status: { completed: 900, failed_business: 200, failed_system: 134, other: 0 },
            failed_cost: 334,
            rerun_cost: 120,
            avg_cost_per_run: 102.83333333333333,
            cost_per_completed_run: 100,
            llm_call_cost: 1000,
            run_vs_call_cost_delta: 234,
            roi_idea_count: 2,
            roi_confidence: { low: 0, medium: 1, high: 1 },
            roi_source_lineage: automationPerformanceRoiSourceLineage,
            roi_actuals: {
              evidence_count: 2,
              estimated_transaction_count: 110,
              actual_transaction_count: 98,
              comparable_actual_transaction_count: 98,
              transaction_attainment_rate: 98 / 110,
              estimated_exception_rate: 0,
              actual_failure_rate: 5.5 / 98,
              comparable_actual_failure_rate: 5.5 / 98,
              failure_rate_delta: 5.5 / 98,
              human_intervention_minutes: 140,
              reprocessing_minutes: 40,
              latest_period_end: "2026-06-28",
            },
            decision_signal: { status: "hold", reason: "improve reliability before scaling" },
          },
          cost_by_model: [
            { model: "gpt-4o-mini", calls: 12, input_tokens: 12000, output_tokens: 2400, cost: 1000, cost_share: 1 },
          ],
          model_cost_trends: [
            {
              day: "2026-06-02",
              model: "gpt-4o-mini",
              calls: 8,
              input_tokens: 8000,
              output_tokens: 1600,
              cost: 600,
              cost_share_of_day: 1,
              cost_delta_from_previous_day_for_model: null,
            },
            {
              day: "2026-06-03",
              model: "gpt-4o-mini",
              calls: 4,
              input_tokens: 4000,
              output_tokens: 800,
              cost: 400,
              cost_share_of_day: 1,
              cost_delta_from_previous_day_for_model: -200,
            },
          ],
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
              implementation_effort: 900000,
              net_value: 738766,
              value_to_cost_ratio: 599.6758508914101,
              payback_months: 1.2162162162162162,
              gateway_cost: 1234,
              cost_by_status: { completed: 900, failed_business: 200, failed_system: 134, other: 0 },
              rerun_cost: 120,
              avg_cost_per_run: 102.83333333333333,
              cost_per_completed_run: 100,
              roi_idea_count: 2,
              roi_confidence: { low: 0, medium: 1, high: 1 },
              roi_source_lineage: automationPerformanceRoiSourceLineage,
              roi_actuals: {
                evidence_count: 2,
                estimated_transaction_count: 110,
                actual_transaction_count: 98,
                comparable_actual_transaction_count: 98,
                transaction_attainment_rate: 98 / 110,
                estimated_exception_rate: 0,
                actual_failure_rate: 5.5 / 98,
                comparable_actual_failure_rate: 5.5 / 98,
                failure_rate_delta: 5.5 / 98,
                human_intervention_minutes: 140,
                reprocessing_minutes: 40,
                latest_period_end: "2026-06-28",
              },
              decision_signal: { status: "hold", reason: "improve reliability" },
            },
          ],
          trends: [],
        }),
        exportAutomationPerformanceReportCsv: async (month, runMode = "prod") => {
          csvExports.push(`${month ?? ""}:${runMode}`);
          return "Summary\nmetric,value\nmonth,2026-06\n";
        },
        exportAutomationPerformanceReportPocMarkdown: async (month, runMode = "prod") => {
          pocExports.push(`${month ?? ""}:${runMode}`);
          return "# Automation Performance PoC Report\n\n## Decision Guide\n";
        },
        exportAutomationPerformanceReportXlsx: async (month, runMode = "prod") => {
          xlsxExports.push(`${month ?? ""}:${runMode}`);
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
    expect(within(panel).getAllByText("gpt-4o-mini").length).toBeGreaterThan(0);
    expect(within(panel).getByRole("img", { name: /ROI 근거 출처 차트/ })).toBeInTheDocument();
    expect(within(panel).getByText("성과·ROI는 운영 실행만 집계합니다. 시험 실행은 포함하지 않습니다.")).toBeInTheDocument();
    expect(within(panel).getByRole("img", { name: /ROI 단계 구성 차트/ })).toBeInTheDocument();
    expect(within(panel).getByRole("img", { name: /모델 비용 추이 차트/ })).toBeInTheDocument();
    expect(within(panel).getByRole("table", { name: "모델 비용 일별 추이" })).toBeInTheDocument();
    expect(within(panel).getByText("2026-06-03")).toBeInTheDocument();
    expect(within(panel).getAllByText("보류").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("순가치").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("프로세스 마이닝 1 · 수기 등록 1").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("부서 Finance, Procurement · 오너 Mina Kim, Joon Park").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("98/110건").length).toBeGreaterThan(0);
    expect(within(panel).getByText("18.5h")).toBeInTheDocument();
    expect(within(panel).getAllByText("75%").length).toBeGreaterThan(0);

    fireEvent.click(within(panel).getByRole("button", { name: "CSV" }));

    await waitFor(() => expect(csvExports).toEqual(["2026-06:prod"]));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:performance-csv");
    expect(await within(panel).findByText("성과 리포트 CSV를 준비했습니다.")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "PoC 문서" }));

    await waitFor(() => expect(pocExports).toEqual(["2026-06:prod"]));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(await within(panel).findByText(/POC_MARKDOWN/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "XLSX" }));

    await waitFor(() => expect(xlsxExports).toEqual(["2026-06:prod"]));
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
