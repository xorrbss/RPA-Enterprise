import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { useApiClient } from "../api/context";
import { useCan, useRoles } from "../api/permissions";
import { OnboardingBanner } from "../components/OnboardingBanner";
import { AdoptionEvidencePacket } from "../components/AdoptionEvidencePacket";
import { DashboardEnvironmentState, environmentErrorKind, type DashboardEnvironmentError } from "../components/DashboardEnvironmentState";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import { navigate, useHashParam } from "../router";
import { isActiveHumanTask } from "./humanTaskFilters";
import { ActionQueue, collectActionItems } from "./dashboard/ActionQueue";
import { AdminAdoptionSetup } from "./dashboard/AdminAdoptionSetup";
import { AdoptionReadinessPanel } from "./dashboard/AdoptionReadinessPanel";
import { AutomationPerformancePanel } from "./dashboard/AutomationPerformancePanel";
import { OpsSignalPanel } from "./dashboard/OpsSignalPanel";
import { RoleWorkbench } from "./dashboard/RoleWorkbench";
import { RunTrendsPanel } from "./dashboard/RunTrendsPanel";
import { DASHBOARD_RUN_MODE, Metric, cacheHitRateLabel, exactCount, pageCount, successRateLabel } from "./dashboard/metrics";
import { currentReportMonth, type ReportExportFormat, type ReportExportState } from "./dashboard/report-format";
import type {
  AutomationPerformanceRunMode,
  Paginated,
  RunArtifactItem,
  RunItem,
} from "../api/types";

// 첫-실행 안내 배너 — 권한별(RBAC) 안내문/CTA. cta 없으면 viewer 안내문만(없는 권한 동선 창작 금지).
// 입력은 부모가 실 응답으로 판정한 '진짜 빈 테넌트' 여부 + useCan뿐(데이터 미창작).
// 분기는 2가지뿐: 현 RBAC 매트릭스(permissions.ts)상 scenario.create 보유 역할은 예외 없이 run.create도
// 보유하므로(viewer만 둘 다 없음), run.create 유무가 곧 '명령 권한자 vs 뷰어' 경계다.
// 문구는 시나리오 존재를 단정하지 않는다 — 부모는 listScenarios를 조회하지 않아 '준비된 자동화'가 있는지
// 관찰한 적이 없다(데이터 미창작). CTA 라벨('자동화 화면으로 가기')은 동작 그대로의 안내문이고, 이동 대상은
// scenarioStudio(meta.ts title='자동화 만들기')다 — 라벨은 대상 title을 그대로 쓰지 않는다.
function onboardingProps(can: (a: string) => boolean, roles: readonly string[]): ComponentProps<typeof OnboardingBanner> {
  // 역할 미확인(roles 없음)은 '데이터 없음'이 아니라 '권한/설정 문제'일 수 있다 — 빈 화면의 원인을 구분해
  // 운영자가 IT 담당자에게 접근 권한을 요청하도록 안내한다(Topbar '권한 미확인 · 읽기 전용'과 일관).
  if (roles.length === 0) return { message: "현재 역할을 확인할 수 없어 화면이 비어 보일 수 있습니다. IT 담당자에게 접근 권한을 요청하세요." };
  if (can("run.create")) return { message: "첫 실행을 시작해 보세요.", cta: { label: "자동화 화면으로 가기", view: "scenarioStudio" } };
  return { message: "아직 등록된 실행이 없습니다. 권한이 있는 담당자가 첫 실행을 시작할 수 있습니다." };
}

function downloadCsv(csv: string, filename: string): void {
  // BOM 없으면 Windows Excel 이 CP949 로 열어 한글이 깨진다. 서버 export 가 이미 붙였으면 중복 방지.
  downloadBlob(new Blob([csv.startsWith("\uFEFF") ? csv : "\uFEFF" + csv], { type: "text/csv;charset=utf-8" }), filename);
}

function downloadMarkdown(markdown: string, filename: string): void {
  downloadBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), filename);
}

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function DashboardView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const roles = useRoles();
  const focusTarget = useHashParam("focus");
  const evidencePacketRef = useRef<HTMLDivElement | null>(null);
  const automationReportRef = useRef<HTMLDivElement | null>(null);
  const [reportMonth, setReportMonth] = useState(currentReportMonth);
  const [reportRunMode, setReportRunMode] = useState<AutomationPerformanceRunMode>("prod");
  const [reportExportState, setReportExportState] = useState<ReportExportState>("idle");
  const [reportExportFormat, setReportExportFormat] = useState<ReportExportFormat | null>(null);
  // '실행 중'은 서버 status 필터로 정확히 집계(이전: 전체 50건을 클라에서 status==='running' 필터 → 50건 초과 시 구조적 오집계).
  const running = useQuery({ queryKey: ["runs", "running", DASHBOARD_RUN_MODE], queryFn: () => api.listRuns({ status: "running", run_mode: DASHBOARD_RUN_MODE, limit: 50 }), refetchInterval: 5_000 });
  const recent = useQuery({ queryKey: ["runs", DASHBOARD_RUN_MODE], queryFn: () => api.listRuns({ run_mode: DASHBOARD_RUN_MODE, limit: 50 }), refetchInterval: 5_000 });
  const anyRecent = useQuery({ queryKey: ["runs", "any", "empty-tenant-check"], queryFn: () => api.listRuns({ limit: 1 }), refetchInterval: 30_000 });
  const human = useQuery({ queryKey: ["human-tasks", "active"], queryFn: () => api.listHumanTasks({ terminal: "false", limit: 50 }), refetchInterval: 5_000 });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 5_000 });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: 5_000 });
  // 실패 터미널(failed_business/failed_system)을 서버 status 필터로 각각 정확 집계(클라 필터 아님).
  // 카드를 status별로 분리한다: 합산 단일 카드는 카운트(business+system)와 드릴다운 해시(단일 status)의 모집단이
  // 어긋나(RunTrace는 단일 status만 시드) 실패 총량을 오표상했다. 카드별 단일-status 카운트↔단일-status 해시로
  // '실행 중' 카드와 동일하게 카운트·목록 모집단 정합을 정확히 만족시킨다(조용한 false 인접 오표상 제거).
  const failedBiz = useQuery({ queryKey: ["runs", "failed_business", DASHBOARD_RUN_MODE], queryFn: () => api.listRuns({ status: "failed_business", run_mode: DASHBOARD_RUN_MODE, limit: 50 }), refetchInterval: 5_000 });
  const failedSys = useQuery({ queryKey: ["runs", "failed_system", DASHBOARD_RUN_MODE], queryFn: () => api.listRuns({ status: "failed_system", run_mode: DASHBOARD_RUN_MODE, limit: 50 }), refetchInterval: 5_000 });
  const redSites = useQuery({ queryKey: ["sites", "red"], queryFn: () => api.listSites({ risk: "red", limit: 50 }), refetchInterval: 10_000 });
  // 관찰성 집계(§E run_success_rate + status별 정확 카운트). 서버 GROUP BY 라 카드가 '50+' 근사 대신 정확 총계.
  // run_mode=prod 고정 — 카드/스파크라인 집계와 드릴다운 목록(runTrace?run_mode=prod)의 모집단 통일(A1-1).
  const summary = useQuery({ queryKey: ["runs", "summary", DASHBOARD_RUN_MODE], queryFn: () => api.getRunSummary(DASHBOARD_RUN_MODE), refetchInterval: 5_000 });
  const trends = useQuery({ queryKey: ["runs", "trends", DASHBOARD_RUN_MODE], queryFn: () => api.getRunTrends(30, DASHBOARD_RUN_MODE), refetchInterval: 30_000 });
  const performanceReport = useQuery({
    queryKey: ["automation-performance-report", reportMonth, reportRunMode],
    queryFn: () => api.getAutomationPerformanceReport(reportMonth, reportRunMode),
    refetchInterval: 60_000,
  });
  const opsHealth = useQuery({ queryKey: ["ops-health", "dashboard"], queryFn: () => api.getOpsHealth(), refetchInterval: 5_000 });
  const opsAlerts = useQuery({ queryKey: ["ops-alerts", "dashboard"], queryFn: () => api.listOpsAlerts({ limit: 3 }), refetchInterval: 5_000 });
  const readinessSites = useQuery({ queryKey: ["sites", "adoption-readiness"], queryFn: () => api.listSites({ limit: 50 }), refetchInterval: 30_000 });
  const readinessScenarios = useQuery({ queryKey: ["scenarios", "adoption-readiness"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 30_000 });
  const authReadiness = useQuery({ queryKey: ["auth-readiness", "dashboard"], queryFn: () => api.getAuthReadiness(), refetchInterval: 60_000 });
  const productionReadiness = useQuery({ queryKey: ["production-readiness", "dashboard"], queryFn: () => api.getProductionReadiness(), refetchInterval: 60_000 });
  const scimProviders = useQuery({ queryKey: ["scim-providers", "dashboard-admin"], queryFn: () => api.listScimProviders(), enabled: roles.includes("admin"), refetchInterval: 60_000 });
  const secretAudit = useQuery({ queryKey: ["audit-log", "secret-resolve", "dashboard-evidence"], queryFn: () => api.listAuditLog({ action: "secret.resolve", limit: 100 }), enabled: roles.includes("admin"), refetchInterval: 30_000 });
  const secretAuditSummary = useQuery({
    queryKey: ["audit-log-summary", "secret-resolve", "dashboard-evidence"],
    queryFn: () => api.getAuditLogSummary({ action: "secret.resolve" }),
    refetchInterval: 30_000,
  });
  const aiGovernanceEvidenceSummary = useQuery({
    queryKey: ["ai-governance-evidence-summary", "dashboard-evidence"],
    queryFn: () => api.getAiGovernanceEvidenceSummary(),
    refetchInterval: 60_000,
  });
  const connectorCatalog = useQuery({ queryKey: ["connectors", "dashboard-admin-setup"], queryFn: () => api.listConnectors({ limit: 100 }), enabled: roles.includes("admin"), refetchInterval: 60_000 });
  const latestRunId = recent.data?.items[0]?.run_id;
  const latestRunArtifacts = useQuery<Paginated<RunArtifactItem>>({
    queryKey: ["run-artifacts", "adoption-evidence", latestRunId],
    queryFn: () => api.listRunArtifacts(latestRunId as string, { limit: 50 }),
    enabled: latestRunId !== undefined,
    refetchInterval: 30_000,
  });

  async function exportPerformanceReportCsv(): Promise<void> {
    setReportExportState("pending");
    setReportExportFormat("csv");
    try {
      const csv = await api.exportAutomationPerformanceReportCsv(reportMonth, reportRunMode);
      downloadCsv(csv, `automation-performance-${reportRunMode}-${reportMonth}.csv`);
      setReportExportState("success");
    } catch {
      setReportExportState("error");
    }
  }

  async function exportPerformanceReportXlsx(): Promise<void> {
    setReportExportState("pending");
    setReportExportFormat("xlsx");
    try {
      if (api.exportAutomationPerformanceReportXlsx === undefined) throw new Error("xlsx export is not available");
      const xlsx = await api.exportAutomationPerformanceReportXlsx(reportMonth, reportRunMode);
      downloadBlob(xlsx, `automation-performance-${reportRunMode}-${reportMonth}.xlsx`);
      setReportExportState("success");
    } catch {
      setReportExportState("error");
    }
  }

  async function exportPerformanceReportPocMarkdown(): Promise<void> {
    setReportExportState("pending");
    setReportExportFormat("poc_markdown");
    try {
      if (api.exportAutomationPerformanceReportPocMarkdown === undefined) throw new Error("PoC Markdown export is not available");
      const markdown = await api.exportAutomationPerformanceReportPocMarkdown(reportMonth, reportRunMode);
      downloadMarkdown(markdown, `automation-performance-poc-${reportRunMode}-${reportMonth}.md`);
      setReportExportState("success");
    } catch {
      setReportExportState("error");
    }
  }

  // 첫-실행 안내 배너: '진짜 빈 테넌트'(실행 0건)일 때만. recent(무필터 listRuns)의 실 필드로만 판정.
  // length===0 && next_cursor===null → 절단된 0(더 있을 수 있음)이 아닌 진짜 0(조용한 false 금지).
  // isLoading/isError 중에는 미표시(데이터 도착 전 단정 금지). 실행이 1건이라도 생기면 자동 소멸.
  const isEmptyTenant = anyRecent.isSuccess && anyRecent.data.items.length === 0 && anyRecent.data.next_cursor === null;
  const dashboardErrors: DashboardEnvironmentError[] = [];
  if (summary.isError) dashboardErrors.push({ label: "실행 요약", error: summary.error, onRetry: () => void summary.refetch() });
  if (recent.isError) dashboardErrors.push({ label: "최근 실행", error: recent.error, onRetry: () => void recent.refetch() });
  if (human.isError) dashboardErrors.push({ label: "사람 확인", error: human.error, onRetry: () => void human.refetch() });
  if (wiDlq.isError) dashboardErrors.push({ label: "작업 항목 재처리", error: wiDlq.error, onRetry: () => void wiDlq.refetch() });
  if (sinkDlq.isError) dashboardErrors.push({ label: "외부 전달 재처리", error: sinkDlq.error, onRetry: () => void sinkDlq.refetch() });
  if (opsHealth.isError) dashboardErrors.push({ label: "운영 헬스", error: opsHealth.error, onRetry: () => void opsHealth.refetch() });
  if (opsAlerts.isError) dashboardErrors.push({ label: "운영 알림", error: opsAlerts.error, onRetry: () => void opsAlerts.refetch() });
  if (secretAudit.isError) dashboardErrors.push({ label: "SecretRef 감사 요약", error: secretAudit.error, onRetry: () => void secretAudit.refetch() });
  if (secretAuditSummary.isError) dashboardErrors.push({ label: "SecretRef 감사 summary", error: secretAuditSummary.error, onRetry: () => void secretAuditSummary.refetch() });
  if (aiGovernanceEvidenceSummary.isError) dashboardErrors.push({ label: "AI 거버넌스 summary", error: aiGovernanceEvidenceSummary.error, onRetry: () => void aiGovernanceEvidenceSummary.refetch() });
  if (latestRunArtifacts.isError) dashboardErrors.push({ label: "최근 실행 artifact 증거", error: latestRunArtifacts.error, onRetry: () => void latestRunArtifacts.refetch() });
  if (scimProviders.isError) dashboardErrors.push({ label: "SCIM 도입 설정", error: scimProviders.error, onRetry: () => void scimProviders.refetch() });
  if (connectorCatalog.isError) dashboardErrors.push({ label: "커넥터 SecretRef 카탈로그", error: connectorCatalog.error, onRetry: () => void connectorCatalog.refetch() });
  const dashboardErrorKind = environmentErrorKind(dashboardErrors);

  useEffect(() => {
    const target =
      focusTarget === "evidence-packet"
        ? evidencePacketRef.current
        : focusTarget === "automation-report"
          ? automationReportRef.current
          : null;
    if (target === null) return;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
  }, [focusTarget]);

  return (
    <>
      {isEmptyTenant && <OnboardingBanner {...onboardingProps(can, roles)} />}
      <DashboardEnvironmentState
        isEmptyTenant={isEmptyTenant}
        errors={dashboardErrors}
        emptyAction={
          can("scenario.create") ? (
            <button className="btn primary" type="button" onClick={() => navigate("scenarioStudio")}>
              자동화 초안 만들기
            </button>
          ) : undefined
        }
      />
      <AdoptionReadinessPanel
        auth={authReadiness}
        production={productionReadiness}
        sites={readinessSites}
        scenarios={readinessScenarios}
        summary={summary}
        recent={recent}
        performance={performanceReport}
        can={can}
      />
      <AdminAdoptionSetup
        roles={roles}
        can={can}
        auth={authReadiness}
        production={productionReadiness}
        sites={readinessSites}
        scenarios={readinessScenarios}
        summary={summary}
        recent={recent}
        artifacts={latestRunArtifacts}
        scimProviders={scimProviders}
        secretAudit={secretAudit}
        connectors={connectorCatalog}
      />
      <div id="dashboard-focus-evidence-packet" ref={evidencePacketRef} tabIndex={-1} data-dashboard-focus="evidence-packet">
        <AdoptionEvidencePacket
          auth={authReadiness}
          production={productionReadiness}
          sites={readinessSites}
          scenarios={readinessScenarios}
          summary={summary}
          recent={recent}
          artifacts={latestRunArtifacts}
          performance={performanceReport}
          secretAuditSummary={secretAuditSummary}
          aiGovernanceEvidenceSummary={aiGovernanceEvidenceSummary}
        />
      </div>
      <RoleWorkbench roles={roles} can={can} />
      <OpsSignalPanel
        health={opsHealth.data}
        alerts={opsAlerts.data?.items ?? []}
        isLoading={(opsHealth.data === undefined && opsHealth.isFetching) || (opsAlerts.data === undefined && opsAlerts.isFetching)}
        isError={opsHealth.isError || opsAlerts.isError}
        error={opsHealth.error ?? opsAlerts.error}
      />
      <div className="metrics">
        <Metric label="실행 성공률" value={successRateLabel(summary.data)} view="runTrace" params={{ status: "completed", run_mode: DASHBOARD_RUN_MODE }} hint="완료 실행" />
        <Metric label="캐시 재사용률" value={cacheHitRateLabel(summary.data)} view="runTrace" params={{ run_mode: DASHBOARD_RUN_MODE }} hint="실행 기록" />
        <Metric label="실행 중" value={exactCount(summary.data, "running")} view="runTrace" params={{ status: "running", run_mode: DASHBOARD_RUN_MODE }} hint="실행 기록" />
        <Metric label="사람 확인 대기" value={pageCount(human.data === undefined ? undefined : { ...human.data, items: human.data.items.filter(isActiveHumanTask) })} view="humanTasks" params={{ terminal: "false" }} hint="사람 확인" />
        <Metric label="업무 실패" value={exactCount(summary.data, "failed_business")} view="runTrace" params={{ status: "failed_business", run_mode: DASHBOARD_RUN_MODE }} hint="실행 기록" />
        <Metric label="시스템 실패" value={exactCount(summary.data, "failed_system")} view="runTrace" params={{ status: "failed_system", run_mode: DASHBOARD_RUN_MODE }} hint="실행 기록" />
        <Metric label="작업 항목 재처리 대기" value={pageCount(wiDlq.data)} view="workitems" hint="작업 목록" />
        <Metric label="외부 전달 재처리 대기" value={pageCount(sinkDlq.data)} view="workitems" hint="작업 목록" />
      </div>
      <p className="subtle" style={{ margin: "0 2px" }}>
        실행 성공률·캐시 재사용률·실행 중·업무 실패·시스템 실패는 전체 기간 정확 집계입니다. 사람 확인·재처리 대기는 최신 50건 기준이며 <strong>+</strong>는 표시 한도를 넘겨 더 있음을 뜻합니다(예: <code>50+</code> = 50건 이상).
      </p>
      <RunTrendsPanel
        trends={trends.data}
        isLoading={trends.data === undefined && trends.isFetching}
        isError={trends.isError}
        error={trends.error}
      />
      <div id="dashboard-focus-automation-report" ref={automationReportRef} tabIndex={-1} data-dashboard-focus="automation-report">
        <AutomationPerformancePanel
          report={performanceReport.data}
          month={reportMonth}
          runMode={reportRunMode}
          exportState={reportExportState}
          exportFormat={reportExportFormat}
          isLoading={performanceReport.data === undefined && performanceReport.isFetching}
          isError={performanceReport.isError}
          error={performanceReport.error}
          onMonthChange={(month) => {
            setReportMonth(month);
            setReportExportState("idle");
            setReportExportFormat(null);
          }}
          onRunModeChange={(runMode) => {
            setReportRunMode(runMode);
            setReportExportState("idle");
            setReportExportFormat(null);
          }}
          onRetry={() => void performanceReport.refetch()}
          onExportCsv={() => void exportPerformanceReportCsv()}
          onExportXlsx={() => void exportPerformanceReportXlsx()}
          onExportPocMarkdown={() => void exportPerformanceReportPocMarkdown()}
          canExportXlsx={api.exportAutomationPerformanceReportXlsx !== undefined}
          canExportPocMarkdown={api.exportAutomationPerformanceReportPocMarkdown !== undefined}
        />
      </div>
      <ActionQueue
        items={collectActionItems({
          failedBiz: failedBiz.data?.items ?? [],
          failedSys: failedSys.data?.items ?? [],
          running: running.data?.items ?? [],
          human: human.data?.items ?? [],
          wiDlq: wiDlq.data?.items ?? [],
          sinkDlq: sinkDlq.data?.items ?? [],
          redSites: redSites.data?.items ?? [],
        })}
      />
      {/* 빈 테넌트(실행 0건)일 때는 위 OnboardingBanner 가 '실행 없음' + CTA 로 그 상태를 온전히 안내하므로,
          같은 사실을 반복하는 패널 EmptyState('아직 실행이 없습니다.')는 숨긴다(중복 메시지·중복 role='status' 제거).
          실행이 1건이라도 생기면 isEmptyTenant=false 가 되어 패널이 즉시 복귀한다(기능 손실 없음). */}
      {!isEmptyTenant && (
      <QueryPanel<RunItem>
        title="최근 실행"
        query={recent}
        rowKey={(r) => r.run_id}
        collapsedErrorKind={dashboardErrorKind}
        emptyTitle="첫 실행 전"
        emptyMessage="아직 실행이 없습니다."
        columns={[
          {
            // 식별은 업무 언어(자동화 이름)로 — 원시 추적 번호 미노출 정책 유지(툴팁·상세 분석에서만).
            header: "자동화",
            render: (r) => (
              <button
                type="button"
                className="linklike"
                aria-label="실행 추적 상세 보기"
                title={`실행 추적 번호: ${r.run_id}`}
                onClick={() => navigate("runTrace", { run: r.run_id })}
              >
                {r.scenario_name ?? "상세 보기"}
              </button>
            ),
          },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      )}
    </>
  );
}
