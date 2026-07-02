import type { UseQueryResult } from "@tanstack/react-query";

import type {
  AuthReadiness,
  Paginated,
  ProductionReadiness,
  RunArtifactItem,
  RunItem,
  RunSummary,
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
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly artifacts: UseQueryResult<Paginated<RunArtifactItem>>;
}): JSX.Element {
  const lines = buildEvidenceLines(props);
  const attention = lines.filter((line) => line.status !== "ready").length;
  return (
    <section className="panel adoption-evidence-packet" aria-label="도입 증빙 패킷">
      <div className="panel-head">
        <div>
          <h2>도입 증빙 패킷</h2>
          <p className="subtle">원문 시크릿, 감사 원문, artifact 본문 없이 상태와 근거 화면만 묶습니다.</p>
        </div>
        <span className={`badge ${attention === 0 ? "green" : "amber"}`}>
          {attention === 0 ? "제출 가능" : `${attention}개 확인 필요`}
        </span>
      </div>
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
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly artifacts: UseQueryResult<Paginated<RunArtifactItem>>;
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

  return [
    {
      key: "least-privilege",
      label: "최소권한 접근",
      status: props.auth.isError ? "needs" : props.auth.data === undefined ? "deferred" : props.auth.data.role_mapping.configured ? "ready" : "needs",
      detail: props.auth.data === undefined
        ? "확인 중입니다."
        : props.auth.data.role_mapping.configured
          ? "SSO/RBAC 매핑이 구성되어 있으며 쓰기 작업은 can() 게이트 뒤에 있습니다."
          : "역할 매핑 확인이 필요합니다.",
      action: { label: "권한 근거 열기", view: "security", params: { section: "access" } },
    },
    {
      key: "session-encryption",
      label: "세션 저장 암호화",
      status: props.sites.isError ? "needs" : props.sites.data === undefined ? "deferred" : plaintextSites.length > 0 ? "blocked" : encryptedSites.length > 0 ? "ready" : "deferred",
      detail: props.sites.data === undefined
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
      status: production === undefined ? "deferred" : auditVerifier?.latest_status === "valid" ? "ready" : "needs",
      detail: production === undefined
        ? "확인 중입니다."
        : auditVerifier?.latest_status === "valid"
          ? `최근 검증 ${auditVerifier.rows_checked ?? 0}행, 기간 CSV는 cursor로 전체 이어받기 가능합니다.`
          : "감사 체인 검증 이력은 확인 필요입니다. 기간 CSV는 감사 이력 화면에서 생성합니다.",
      action: { label: "감사 이력 열기", view: "auditExplorer" },
    },
    {
      key: "artifact-redaction",
      label: "artifact redaction 상태",
      status: props.recent.data === undefined || props.artifacts.data === undefined ? "deferred" : artifacts.length === 0 ? "deferred" : artifactPending === 0 ? "ready" : "needs",
      detail: props.recent.data === undefined || props.artifacts.data === undefined
        ? "확인 중입니다."
        : artifacts.length === 0
          ? "최근 실행 artifact가 없어 확인 필요입니다."
          : `${artifactReady}/${artifacts.length}개 artifact가 redacted/not_required 메타 상태입니다.`,
      action: { label: "최근 실행 열기", view: "runTrace" },
    },
    {
      key: "ai-egress",
      label: "AI 데이터 반출 경계",
      status: props.summary.data === undefined ? "deferred" : "ready",
      detail: props.summary.data === undefined
        ? "확인 중입니다."
        : "Gateway는 전송 전 마스킹 경계를 사용하고, 시크릿 값은 LLM으로 보내지 않고 CDP 주입 경로를 탑니다. 실행별 redaction proof는 S11 범위입니다.",
      action: { label: "AI 정책 열기", view: "llmGateway" },
    },
  ];
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
