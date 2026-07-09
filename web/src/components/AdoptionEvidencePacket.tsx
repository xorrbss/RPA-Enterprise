import type { UseQueryResult } from "@tanstack/react-query";

import type {
  AiGovernanceEvidenceSummary,
  AuditLogSummary,
  AuthReadiness,
  AutomationPerformanceReport,
  Paginated,
  ProductionReadiness,
  RunArtifactItem,
  RunItem,
  RunSummary,
  ScenarioItem,
  SiteItem,
} from "../api/types";
import { navigate } from "../router";

type EvidenceStatus = "ready" | "needs" | "blocked" | "deferred";

interface EvidenceLine {
  readonly key: string;
  readonly label: string;
  readonly status: EvidenceStatus;
  readonly detail: string;
  readonly action: { readonly label: string; readonly view: Parameters<typeof navigate>[0]; readonly params?: Record<string, string> };
}

export function AdoptionEvidencePacket(props: {
  readonly auth: UseQueryResult<AuthReadiness>;
  readonly production: UseQueryResult<ProductionReadiness>;
  readonly sites: UseQueryResult<Paginated<SiteItem>>;
  readonly scenarios: UseQueryResult<Paginated<ScenarioItem>>;
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly artifacts: UseQueryResult<Paginated<RunArtifactItem>>;
  readonly performance: UseQueryResult<AutomationPerformanceReport>;
  readonly secretAuditSummary: UseQueryResult<AuditLogSummary>;
  readonly aiGovernanceEvidenceSummary: UseQueryResult<AiGovernanceEvidenceSummary>;
}): JSX.Element {
  const lines = buildEvidenceLines(props);
  const attention = lines.filter((line) => line.status !== "ready").length;
  return (
    <section className="panel adoption-evidence-packet" aria-label="도입 증빙 패킷">
      <div className="panel-head">
        <div>
          <h2>도입 증빙 패킷</h2>
          <p className="subtle">metadata-only 증빙과 기존 route 링크를 묶습니다. 원문 본문과 SecretRef 값은 포함하지 않습니다.</p>
        </div>
        <span className={`badge ${attention === 0 ? "green" : "amber"}`}>
          {attention === 0 ? "제출 가능" : `${attention}개 확인 필요`}
        </span>
      </div>
      <p className="form-alert amber" role="note">
        Negative proof: raw audit body, artifact body, raw URLs, endpoint/webhook URLs, token/password, resolved SecretRef material, raw roster/training document는 이 패킷에 포함하지 않습니다.
      </p>
      <p className="subtle" style={{ margin: "0 16px 12px" }}>
        연결 route: auditExplorer · automationOps?section=readiness · security?section=access/secrets/sites · runTrace · dashboard?focus=automation-report
      </p>
      <ul className="adoption-gates">
        {lines.map((line) => (
          <li key={line.key}>
            <span className={`badge ${tone(line.status)}`}>{statusLabel(line.status)}</span>
            <div>
              <strong>{line.label}</strong>
              <p className="subtle">{line.detail}</p>
              <button className="btn" type="button" onClick={() => navigate(line.action.view, line.action.params)}>
                {line.action.label}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function buildEvidenceLines(props: {
  readonly auth: UseQueryResult<AuthReadiness>;
  readonly production: UseQueryResult<ProductionReadiness>;
  readonly sites: UseQueryResult<Paginated<SiteItem>>;
  readonly scenarios: UseQueryResult<Paginated<ScenarioItem>>;
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly artifacts: UseQueryResult<Paginated<RunArtifactItem>>;
  readonly performance: UseQueryResult<AutomationPerformanceReport>;
  readonly secretAuditSummary: UseQueryResult<AuditLogSummary>;
  readonly aiGovernanceEvidenceSummary: UseQueryResult<AiGovernanceEvidenceSummary>;
}): readonly EvidenceLine[] {
  const sites = props.sites.data?.items ?? [];
  const loginSites = sites.filter((site) => site.login_capable === true);
  const encryptedSites = loginSites.filter((site) => site.enc_kid !== undefined && site.enc_kid !== null && !isPlaintextKid(site.enc_kid));
  const plaintextSites = loginSites.filter((site) => isPlaintextKid(site.enc_kid));
  const artifacts = props.artifacts.data?.items ?? [];
  const artifactReady = artifacts.filter((artifact) => artifact.redaction_status === "redacted" || artifact.redaction_status === "not_required").length;
  const artifactPending = artifacts.length - artifactReady;
  const production = props.production.data;
  const auditVerifier = production?.signals?.audit_verifier;
  const roiEvidenceCount = props.performance.data?.summary.roi_actuals.evidence_count ?? 0;
  const scenarioSummary = summarizeScenarioCertification(props.scenarios.data?.items ?? []);
  const secretAuditSummary = props.secretAuditSummary.data;
  const aiEvidenceSummary = props.aiGovernanceEvidenceSummary.data;
  const secretDeniedOrBlocked = (secretAuditSummary?.outcome_counts.deny ?? 0) + (secretAuditSummary?.outcome_counts.blocked ?? 0);
  const secretErrors = secretAuditSummary?.outcome_counts.error ?? 0;
  const secretAllows = secretAuditSummary?.outcome_counts.allow ?? 0;
  const latestRunId = props.recent.data?.items[0]?.run_id;
  const latestRunArtifactParams = latestRunId === undefined ? undefined : { run: latestRunId, focus: "artifacts" };

  return [
    {
      key: "packet-scope",
      label: "패킷 범위",
      status: props.production.isError ? "needs" : production === undefined ? "deferred" : "ready",
      detail: props.production.isError
        ? evidenceErrorDetail("운영 전환 스냅샷")
        : production === undefined
        ? "tenant, environment, generated_at metadata를 확인 중입니다."
        : `tenant=${production.environment.tenant_id}, environment=${production.environment.target}, generated_at=${production.evaluated_at}. 값은 metadata만 사용합니다.`,
      action: { label: "운영 증빙 열기", view: "automationOps", params: { section: "readiness" } },
    },
    {
      key: "least-privilege",
      label: "최소권한 접근",
      status: props.auth.isError ? "needs" : props.auth.data === undefined ? "deferred" : props.auth.data.role_mapping.configured && props.auth.data.role_mapping.mapped_values > 0 ? "ready" : "needs",
      detail: props.auth.isError
        ? evidenceErrorDetail("SSO/RBAC readiness")
        : props.auth.data === undefined
        ? "확인 중입니다."
        : props.auth.data.role_mapping.configured && props.auth.data.role_mapping.mapped_values > 0
          ? `${props.auth.data.role_mapping.mapped_values}개 SSO/RBAC 매핑이 구성되어 있으며 쓰기 작업은 can() 게이트 뒤에 있습니다.`
          : "역할 매핑 확인이 필요합니다.",
      action: { label: "권한 근거 열기", view: "security", params: { section: "access" } },
    },
    {
      key: "session-encryption",
      label: "세션 저장 암호화",
      status: props.sites.isError ? "needs" : props.sites.data === undefined ? "deferred" : plaintextSites.length > 0 ? "blocked" : encryptedSites.length > 0 ? "ready" : "deferred",
      detail: props.sites.isError
        ? evidenceErrorDetail("사이트/세션 metadata")
        : props.sites.data === undefined
        ? "확인 중입니다."
        : plaintextSites.length > 0
          ? `dev/plaintext 세션 ${plaintextSites.length}개가 구분되어 있습니다.`
          : encryptedSites.length > 0
            ? `KMS envelope kid가 있는 세션 ${encryptedSites.length}개를 확인했습니다.`
            : "로그인 세션이 필요한 사이트가 없거나 아직 세션 kid가 없습니다.",
      action: { label: "세션 증빙 열기", view: "security", params: { section: "sites" } },
    },
    {
      key: "audit-export",
      label: "감사 이력/기간 export",
      status: props.production.isError ? "needs" : production === undefined ? "deferred" : auditVerifier?.latest_status === "valid" ? "ready" : "needs",
      detail: props.production.isError
        ? evidenceErrorDetail("감사 체인 검증 metadata")
        : production === undefined
        ? "확인 중입니다."
        : auditVerifier?.latest_status === "valid"
          ? `최근 검증 ${auditVerifier.rows_checked ?? 0}행, 기간 CSV는 cursor로 전체 이어받기 가능합니다.`
          : "감사 체인 검증 이력은 확인 필요입니다. 기간 CSV는 감사 이력 화면에서 생성합니다.",
      action: { label: "감사 이력 열기", view: "auditExplorer" },
    },
    {
      key: "secretref-audit",
      label: "SecretRef 감사 요약",
      status: props.secretAuditSummary.isError
        ? "needs"
        : secretAuditSummary === undefined
          ? "deferred"
          : secretAuditSummary.total_count === 0
            ? "deferred"
            : secretDeniedOrBlocked > 0 || secretErrors > 0
              ? "blocked"
              : secretAuditSummary.hash_linked_count === secretAuditSummary.total_count
                ? "ready"
                : "needs",
      detail: props.secretAuditSummary.isError
        ? evidenceErrorDetail("SecretRef resolve 감사 metadata")
        : secretAuditSummary === undefined
        ? "SecretRef resolve 감사 metadata를 확인 중입니다. resolved SecretRef material은 표시하지 않습니다."
        : secretAuditSummary.total_count === 0
          ? "SecretRef audit summary: 0 metadata rows. 실제 SecretRef 사용 감사가 생기기 전까지 증거는 보류입니다."
          : `SecretRef audit summary: ${secretAuditSummary.total_count} metadata rows, allow ${secretAllows}, deny/block ${secretDeniedOrBlocked}, error ${secretErrors}, hash-linked ${secretAuditSummary.hash_linked_count}/${secretAuditSummary.total_count}. latest sequence ${secretAuditSummary.latest?.sequence_no ?? "none"}.`,
      action: { label: "SecretRef 감사 열기", view: "security", params: { section: "secrets" } },
    },
    {
      key: "artifact-redaction",
      label: "artifact redaction 상태",
      status: props.recent.isError || props.artifacts.isError ? "needs" : props.recent.data === undefined || props.artifacts.data === undefined ? "deferred" : artifacts.length === 0 ? "deferred" : artifactPending === 0 ? "ready" : "needs",
      detail: props.recent.isError || props.artifacts.isError
        ? evidenceErrorDetail("최근 실행 artifact redaction metadata")
        : props.recent.data === undefined || props.artifacts.data === undefined
        ? "확인 중입니다."
        : artifacts.length === 0
          ? "최근 실행 artifact가 없어 확인 필요입니다."
          : `${artifactReady}/${artifacts.length}개 artifact가 redacted/not_required 메타 상태입니다.`,
      action: { label: latestRunId === undefined ? "실행 기록 열기" : "최근 실행 증빙 열기", view: "runTrace", params: latestRunArtifactParams },
    },
    {
      key: "scenario-certification",
      label: "scenario certification/release",
      status: props.scenarios.isError
        ? "needs"
        : props.scenarios.data === undefined
          ? "deferred"
          : scenarioSummary.total === 0
            ? "deferred"
            : scenarioSummary.prodValid > 0
            ? "ready"
            : "needs",
      detail: props.scenarios.isError
        ? evidenceErrorDetail("scenario certification metadata")
        : props.scenarios.data === undefined
        ? "scenario certification metadata를 확인 중입니다."
        : scenarioSummary.total === 0
          ? "scenario certification: 0 scenarios. 인증/릴리스 증거는 첫 자동화 이후 연결됩니다."
          : `scenario certification: ${scenarioSummary.prodValid}/${scenarioSummary.total} prod-valid, certified ${scenarioSummary.certified}, released/promoted ${scenarioSummary.releasedOrPromoted}.`,
      action: { label: "scenario 근거 열기", view: "scenarioStudio" },
    },
    {
      key: "ai-egress",
      label: "AI 데이터 반출 경계",
      status: props.aiGovernanceEvidenceSummary.isError
        ? "needs"
        : aiEvidenceSummary === undefined
          ? "deferred"
          : aiEvidenceSummary.status_counts.failed > 0
            ? "blocked"
            : aiEvidenceSummary.status_counts.valid > 0 && aiEvidenceSummary.status_counts.deferred === 0 && aiEvidenceSummary.expired_valid_count === 0
              ? "ready"
              : aiEvidenceSummary.status_counts.valid > 0
                ? "needs"
                : "deferred",
      detail: props.aiGovernanceEvidenceSummary.isError
        ? evidenceErrorDetail("AI governance evidence metadata")
        : aiEvidenceSummary === undefined
        ? "AI governance evidence metadata를 확인 중입니다."
        : aiEvidenceSummary.total_count === 0
          ? "AI governance evidence: 0 metadata rows. model/prompt/eval/cost/human override 증거가 필요합니다."
          : `AI governance evidence: valid ${aiEvidenceSummary.status_counts.valid}, deferred ${aiEvidenceSummary.status_counts.deferred}, failed ${aiEvidenceSummary.status_counts.failed}, expired-valid ${aiEvidenceSummary.expired_valid_count}. Gateway와 S11 redaction proof 범위만 연결하고 prompt/body 원문은 표시하지 않습니다.`,
      action: { label: "AI 증거 열기", view: "security", params: { section: "ai" } },
    },
    {
      key: "production-readiness",
      label: "controlled-prod gate summary",
      status: props.production.isError
        ? "needs"
        : production === undefined
        ? "deferred"
        : production.summary.controlled_prod_ready
          ? "ready"
          : production.summary.blocker_count > 0 || production.status === "blocked"
            ? "blocked"
            : production.summary.warning_count > 0 || production.status === "warning"
              ? "needs"
              : "deferred",
      detail: props.production.isError
        ? evidenceErrorDetail("controlled-prod readiness summary")
        : production === undefined
        ? "운영 전환 gate summary를 확인 중입니다."
        : production.summary.controlled_prod_ready
          ? "summary.controlled_prod_ready=true일 때만 controlled production 준비로 제출합니다."
          : `summary.controlled_prod_ready=false. 차단 ${production.summary.blocker_count}건, 경고 ${production.summary.warning_count}건, 보류 ${production.summary.deferred_count}건은 모두 미해소로 패킷에 기록합니다.`,
      action: { label: "운영 readiness 열기", view: "automationOps", params: { section: "readiness" } },
    },
    {
      key: "roi-actuals",
      label: "ROI 실제 증빙",
      status: props.performance.isError ? "needs" : props.performance.data === undefined ? "deferred" : roiEvidenceCount > 0 ? "ready" : "deferred",
      detail: props.performance.isError
        ? evidenceErrorDetail("ROI actual evidence metadata")
        : props.performance.data === undefined
        ? "ROI estimate vs actual evidence metadata를 확인 중입니다."
        : roiEvidenceCount > 0
          ? `${roiEvidenceCount}건의 ROI actual evidence metadata가 성과 리포트에 연결되어 있습니다.`
          : "ROI actual evidence metadata가 없어 확장 판단 증빙은 보류입니다.",
      action: { label: "성과 리포트 열기", view: "dashboard", params: { focus: "automation-report" } },
    },
  ];
}

function evidenceErrorDetail(label: string): string {
  return `${label}를 불러오지 못했습니다. 이 항목은 준비로 표시하지 않습니다.`;
}

function summarizeScenarioCertification(items: readonly ScenarioItem[]): {
  readonly total: number;
  readonly certified: number;
  readonly prodValid: number;
  readonly releasedOrPromoted: number;
} {
  let certified = 0;
  let prodValid = 0;
  let releasedOrPromoted = 0;
  for (const item of items) {
    if (item.certification?.status === "certified") certified += 1;
    if (item.certification?.valid_for_prod === true) prodValid += 1;
    if (item.promotion_status === "approved" || item.promotion_status === "deployed" || item.certification?.governance_stage === "certified") {
      releasedOrPromoted += 1;
    }
  }
  return { total: items.length, certified, prodValid, releasedOrPromoted };
}

function isPlaintextKid(kid: string | null | undefined): boolean {
  return kid === "dev-plaintext" || kid === "plaintext";
}

function statusLabel(status: EvidenceStatus): string {
  if (status === "ready") return "확인됨";
  if (status === "blocked") return "차단";
  if (status === "needs") return "확인 필요";
  return "보류";
}

function tone(status: EvidenceStatus): "green" | "amber" | "red" | "muted" {
  if (status === "ready") return "green";
  if (status === "blocked") return "red";
  if (status === "needs") return "amber";
  return "muted";
}
