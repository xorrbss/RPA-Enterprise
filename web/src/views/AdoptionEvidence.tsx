import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan, useRoles } from "../api/permissions";
import type { Paginated, RunArtifactItem } from "../api/types";
import { AdoptionEvidencePacket } from "../components/AdoptionEvidencePacket";
import { navigate } from "../router";
import { AdminAdoptionSetup } from "./dashboard/AdminAdoptionSetup";
import { AdoptionReadinessPanel } from "./dashboard/AdoptionReadinessPanel";
import { DASHBOARD_RUN_MODE } from "./dashboard/metrics";
import { currentReportMonth } from "./dashboard/report-format";

export function AdoptionEvidenceView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const roles = useRoles();
  const reportMonth = currentReportMonth();
  const authReadiness = useQuery({ queryKey: ["auth-readiness", "adoption-evidence"], queryFn: () => api.getAuthReadiness(), refetchInterval: 60_000 });
  const productionReadiness = useQuery({ queryKey: ["production-readiness", "adoption-evidence"], queryFn: () => api.getProductionReadiness(), refetchInterval: 60_000 });
  const sites = useQuery({ queryKey: ["sites", "adoption-evidence"], queryFn: () => api.listSites({ limit: 50 }), refetchInterval: 30_000 });
  const scenarios = useQuery({ queryKey: ["scenarios", "adoption-evidence"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 30_000 });
  const summary = useQuery({ queryKey: ["runs", "summary", DASHBOARD_RUN_MODE, "adoption-evidence"], queryFn: () => api.getRunSummary(DASHBOARD_RUN_MODE), refetchInterval: 30_000 });
  const recent = useQuery({ queryKey: ["runs", DASHBOARD_RUN_MODE, "adoption-evidence"], queryFn: () => api.listRuns({ run_mode: DASHBOARD_RUN_MODE, limit: 50 }), refetchInterval: 30_000 });
  const performance = useQuery({
    queryKey: ["automation-performance-report", reportMonth, DASHBOARD_RUN_MODE, "adoption-evidence"],
    queryFn: () => api.getAutomationPerformanceReport(reportMonth, DASHBOARD_RUN_MODE),
    refetchInterval: 60_000,
  });
  const secretAuditSummary = useQuery({
    queryKey: ["audit-log-summary", "secret-resolve", "adoption-evidence"],
    queryFn: () => api.getAuditLogSummary({ action: "secret.resolve" }),
    refetchInterval: 30_000,
  });
  const aiGovernanceEvidenceSummary = useQuery({
    queryKey: ["ai-governance-evidence-summary", "adoption-evidence"],
    queryFn: () => api.getAiGovernanceEvidenceSummary(),
    refetchInterval: 60_000,
  });
  const scimProviders = useQuery({
    queryKey: ["scim-providers", "adoption-evidence-admin"],
    queryFn: () => api.listScimProviders(),
    enabled: roles.includes("admin"),
    refetchInterval: 60_000,
  });
  const secretAudit = useQuery({
    queryKey: ["audit-log", "secret-resolve", "adoption-evidence-admin"],
    queryFn: () => api.listAuditLog({ action: "secret.resolve", limit: 100 }),
    enabled: roles.includes("admin"),
    refetchInterval: 30_000,
  });
  const connectorCatalog = useQuery({
    queryKey: ["connectors", "adoption-evidence-admin"],
    queryFn: () => api.listConnectors({ limit: 100 }),
    enabled: roles.includes("admin"),
    refetchInterval: 60_000,
  });
  const latestRunId = recent.data?.items[0]?.run_id;
  const latestRunPending = recent.data === undefined && !recent.isError;
  const latestRunArtifacts = useQuery<Paginated<RunArtifactItem>>({
    queryKey: ["run-artifacts", "adoption-evidence-route", latestRunId],
    queryFn: () => api.listRunArtifacts(latestRunId as string, { limit: 50 }),
    enabled: latestRunId !== undefined,
    refetchInterval: 30_000,
  });

  return (
    <div className="adoption-evidence-view">
      <section className="panel adoption-evidence-workbench" aria-label="도입 증빙 작업대">
        <div className="panel-head">
          <div>
            <h2>도입 증빙 작업대</h2>
            <p className="subtle">준비도, 운영 전환 증빙, 감사·보안 metadata를 한 화면에서 확인합니다.</p>
          </div>
          <span className="badge blue">메타데이터 전용</span>
        </div>
        <div className="adoption-evidence-actions">
          <button className="btn primary" type="button" onClick={() => navigate("automationOps", { section: "readiness" })}>
            운영 전환 증빙
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => navigate("runTrace", latestRunId === undefined ? undefined : { run: latestRunId, focus: "artifacts" })}
            disabled={latestRunPending}
            aria-busy={latestRunPending}
          >
            {latestRunPending ? "최근 실행 확인 중" : "최근 실행 증빙"}
          </button>
          <button className="btn" type="button" onClick={() => navigate("auditExplorer")}>
            감사 이력
          </button>
          {roles.includes("admin") ? (
            <button className="btn" type="button" onClick={() => navigate("security", { section: "ai" })}>
              AI·SecretRef 근거
            </button>
          ) : (
            <span className="subtle">보안 설정 변경은 권한 있는 담당자가 처리합니다.</span>
          )}
        </div>
      </section>
      <AdoptionReadinessPanel
        auth={authReadiness}
        production={productionReadiness}
        sites={sites}
        scenarios={scenarios}
        summary={summary}
        recent={recent}
        performance={performance}
        can={can}
      />
      <AdminAdoptionSetup
        roles={roles}
        can={can}
        auth={authReadiness}
        production={productionReadiness}
        sites={sites}
        scenarios={scenarios}
        summary={summary}
        recent={recent}
        artifacts={latestRunArtifacts}
        scimProviders={scimProviders}
        secretAudit={secretAudit}
        connectors={connectorCatalog}
      />
      <AdoptionEvidencePacket
        auth={authReadiness}
        production={productionReadiness}
        sites={sites}
        scenarios={scenarios}
        summary={summary}
        recent={recent}
        artifacts={latestRunArtifacts}
        performance={performance}
        secretAuditSummary={secretAuditSummary}
        aiGovernanceEvidenceSummary={aiGovernanceEvidenceSummary}
      />
    </div>
  );
}
