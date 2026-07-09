import type { UseQueryResult } from "@tanstack/react-query";

import { navigate, type ViewKey } from "../../router";
import type {
  AuditLogItem,
  AuthReadiness,
  ConnectorCatalogItem,
  Paginated,
  ProductionReadiness,
  RunArtifactItem,
  RunItem,
  RunSummary,
  ScenarioItem,
  ScimProviderItem,
  SiteItem,
} from "../../api/types";

type SetupStatus = "ready" | "needs" | "blocked" | "deferred";

interface SetupAction {
  readonly label: string;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
  readonly requiredAction?: string;
}

interface SetupItem {
  readonly key: string;
  readonly label: string;
  readonly status: SetupStatus;
  readonly detail: string;
  readonly action: SetupAction;
}

const STATUS_LABELS: Readonly<Record<SetupStatus, string>> = {
  ready: "준비됨",
  needs: "확인 필요",
  blocked: "차단",
  deferred: "보류",
};

function statusTone(status: SetupStatus): "green" | "amber" | "red" | "muted" {
  if (status === "ready") return "green";
  if (status === "blocked") return "red";
  if (status === "needs") return "amber";
  return "muted";
}

function productionStatus(production: ProductionReadiness): SetupStatus {
  if (production.summary.controlled_prod_ready) return "ready";
  if (production.summary.blocker_count > 0 || production.status === "blocked") return "blocked";
  if (production.summary.warning_count > 0 || production.status === "warning") return "needs";
  return "deferred";
}

function productionDetail(production: ProductionReadiness): string {
  return `controlled-prod gate: 차단 ${production.summary.blocker_count}건, 경고 ${production.summary.warning_count}건, 보류 ${production.summary.deferred_count}건.`;
}

function summarizeSecretAudit(items: readonly AuditLogItem[]): {
  readonly total: number;
  readonly allowed: number;
  readonly deniedOrBlocked: number;
  readonly errors: number;
} {
  let allowed = 0;
  let deniedOrBlocked = 0;
  let errors = 0;
  for (const item of items) {
    if (item.outcome === "allow") allowed += 1;
    if (item.outcome === "deny" || item.outcome === "blocked") deniedOrBlocked += 1;
    if (item.outcome === "error") errors += 1;
  }
  return { total: items.length, allowed, deniedOrBlocked, errors };
}

function countConnectorSecretRefs(items: readonly ConnectorCatalogItem[]): number {
  const refs = new Set<string>();
  for (const item of items) {
    for (const ref of item.required_secret_refs) {
      if (ref.trim().length > 0) refs.add(ref);
    }
    for (const ref of item.manifest_permissions.secret_refs) {
      if (ref.trim().length > 0) refs.add(ref);
    }
  }
  return refs.size;
}

function setupItems(args: {
  readonly auth: UseQueryResult<AuthReadiness>;
  readonly production: UseQueryResult<ProductionReadiness>;
  readonly sites: UseQueryResult<Paginated<SiteItem>>;
  readonly scenarios: UseQueryResult<Paginated<ScenarioItem>>;
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly artifacts: UseQueryResult<Paginated<RunArtifactItem>>;
  readonly scimProviders: UseQueryResult<Paginated<ScimProviderItem>>;
  readonly secretAudit: UseQueryResult<Paginated<AuditLogItem>>;
  readonly connectors: UseQueryResult<Paginated<ConnectorCatalogItem>>;
}): readonly SetupItem[] {
  const auth = args.auth.data;
  const sites = args.sites.data?.items ?? [];
  const loginSites = sites.filter((site) => site.login_capable === true);
  const missingSession = loginSites.find((site) => site.session_ready !== true);
  const scenarios = args.scenarios.data?.items ?? [];
  const scimCount = args.scimProviders.data?.items.length ?? 0;
  const latestArtifacts = args.artifacts.data?.items ?? [];
  const secretAudit = summarizeSecretAudit(args.secretAudit.data?.items ?? []);
  const connectorSecretRefCount = countConnectorSecretRefs(args.connectors.data?.items ?? []);

  return [
    {
      key: "access",
      label: "접속과 역할",
      status: args.auth.isError
        ? "needs"
        : auth === undefined
          ? "deferred"
          : auth.enterprise_sso_ready && auth.role_mapping.configured && auth.role_mapping.mapped_values > 0
            ? "ready"
            : auth.status === "blocked"
              ? "blocked"
              : "needs",
      detail: auth === undefined
        ? "SSO, JWT claim mapping, RBAC matrix를 확인 중입니다."
        : auth.enterprise_sso_ready && auth.role_mapping.configured
          ? `${auth.role_mapping.mapped_values}개 역할 매핑이 준비되어 있습니다.`
          : "SSO, claim mapping, RBAC matrix, 첫 관리자 bootstrap runbook 확인이 필요합니다.",
      action: { label: "접속·권한 열기", view: "security", params: { section: "access" }, requiredAction: "rbac.grant" },
    },
    {
      key: "people",
      label: "사람과 조직",
      status: args.scimProviders.isError ? "needs" : args.scimProviders.data === undefined ? "deferred" : scimCount > 0 ? "ready" : "needs",
      detail: args.scimProviders.data === undefined
        ? "Principal directory, SCIM provider, group-role mapping을 확인 중입니다."
        : scimCount > 0
          ? `${scimCount}개 SCIM provider metadata가 있습니다. 그룹 의미는 추정하지 않고 매핑 행만 신뢰합니다.`
          : "SCIM provider와 group-role mapping metadata가 필요합니다.",
      action: { label: "SCIM 설정 열기", view: "security", params: { section: "access" }, requiredAction: "scim.sync" },
    },
    {
      key: "secrets",
      label: "비밀과 연결",
      status: args.secretAudit.isError || args.connectors.isError
        ? "needs"
        : args.secretAudit.data === undefined || args.connectors.data === undefined
          ? "deferred"
          : secretAudit.deniedOrBlocked > 0 || secretAudit.errors > 0
            ? "blocked"
            : secretAudit.total > 0 && connectorSecretRefCount > 0
              ? "ready"
              : connectorSecretRefCount > 0
                ? "needs"
                : "deferred",
      detail: args.secretAudit.data === undefined || args.connectors.data === undefined
        ? "SecretRef audit, credential registration, connector profile metadata를 확인 중입니다. 비밀값 입력·표시는 제공하지 않습니다."
        : `SecretRef audit ${secretAudit.total} rows, allow ${secretAudit.allowed}, deny/block ${secretAudit.deniedOrBlocked}, error ${secretAudit.errors}, connector SecretRefs ${connectorSecretRefCount}. 비밀값 입력·표시는 제공하지 않습니다.`,
      action: { label: "SecretRef 감사 열기", view: "security", params: { section: "secrets" }, requiredAction: "credential.manage" },
    },
    {
      key: "sites",
      label: "사이트와 세션",
      status: args.sites.isError
        ? "needs"
        : args.sites.data === undefined
          ? "deferred"
          : sites.length === 0
            ? "needs"
            : missingSession === undefined
              ? "ready"
              : "needs",
      detail: args.sites.data === undefined
        ? "사이트 등록과 브라우저 세션 준비 상태를 확인 중입니다."
        : sites.length === 0
          ? "파일럿 사이트 등록이 필요합니다."
          : missingSession === undefined
            ? `${sites.length}개 사이트와 필요한 세션이 준비되어 있습니다.`
            : `${missingSession.name ?? "대상 사이트"} 세션 등록이 필요합니다.`,
      action: { label: "사이트·세션 열기", view: "security", params: { section: "sites" }, requiredAction: "session.capture" },
    },
    {
      key: "first-automation",
      label: "첫 자동화",
      status: args.scenarios.isError || args.summary.isError
        ? "needs"
        : args.scenarios.data === undefined || args.summary.data === undefined
          ? "deferred"
          : scenarios.length > 0 && args.summary.data.total > 0
            ? "ready"
            : "needs",
      detail: args.scenarios.data === undefined || args.summary.data === undefined
        ? "scenario draft, validation, test run을 확인 중입니다."
        : scenarios.length > 0 && args.summary.data.total > 0
          ? `${scenarios.length}개 자동화와 ${args.summary.data.total}건 실행 기록이 있습니다.`
          : "scenario draft와 test run 증빙이 필요합니다.",
      action: { label: "자동화 만들기", view: "scenarioStudio", requiredAction: "scenario.create" },
    },
    {
      key: "readiness",
      label: "운영 준비 증빙",
      status: args.production.isError ? "needs" : args.production.data === undefined ? "deferred" : productionStatus(args.production.data),
      detail: args.production.data === undefined ? "controlled-prod readiness owner evidence를 확인 중입니다." : productionDetail(args.production.data),
      action: { label: "운영 증빙 열기", view: "automationOps", params: { section: "readiness" }, requiredAction: "ops_readiness.manage" },
    },
    {
      key: "packet",
      label: "증빙 패킷",
      status: args.recent.data === undefined || args.artifacts.data === undefined
        ? "deferred"
        : args.recent.data.items.length > 0 && latestArtifacts.length > 0
          ? "ready"
          : "deferred",
      detail: args.recent.data === undefined || args.artifacts.data === undefined
        ? "audit, readiness, ROI, support evidence metadata packet을 확인 중입니다."
        : args.recent.data.items.length > 0 && latestArtifacts.length > 0
          ? `최근 실행 ${args.recent.data.items.length}건과 artifact metadata ${latestArtifacts.length}건을 도입 증빙 패킷에서 묶습니다.`
          : "최근 실행과 artifact metadata가 생기면 도입 증빙 패킷에 연결됩니다.",
      action: { label: "증빙 패킷 보기", view: "adoptionEvidence" },
    },
  ];
}

export function AdminAdoptionSetup(props: {
  readonly roles: readonly string[];
  readonly can: (action: string) => boolean;
  readonly auth: UseQueryResult<AuthReadiness>;
  readonly production: UseQueryResult<ProductionReadiness>;
  readonly sites: UseQueryResult<Paginated<SiteItem>>;
  readonly scenarios: UseQueryResult<Paginated<ScenarioItem>>;
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly artifacts: UseQueryResult<Paginated<RunArtifactItem>>;
  readonly scimProviders: UseQueryResult<Paginated<ScimProviderItem>>;
  readonly secretAudit: UseQueryResult<Paginated<AuditLogItem>>;
  readonly connectors: UseQueryResult<Paginated<ConnectorCatalogItem>>;
}): JSX.Element | null {
  if (!props.roles.includes("admin")) return null;
  const items = setupItems(props);
  const unresolved = items.filter((item) => item.status !== "ready").length;
  return (
    <section className="panel admin-adoption-setup" aria-label="관리자 도입 설정">
      <div className="panel-head">
        <div>
          <h2>관리자 도입 설정</h2>
          <p className="subtle">SSO, RBAC, SCIM, SecretRef, 사이트·세션, 운영 증빙을 한 번에 추적합니다. 쓰기 화면은 기존 보안/운영 route로만 연결합니다.</p>
        </div>
        <span className={`badge ${unresolved === 0 ? "green" : "amber"}`}>{unresolved === 0 ? "관리 준비됨" : `${unresolved}개 미해소`}</span>
      </div>
      <ul className="adoption-gates">
        {items.map((item) => {
          const allowed = item.action.requiredAction === undefined || props.can(item.action.requiredAction);
          return (
            <li key={item.key}>
              <span className={`badge ${statusTone(item.status)}`}>{STATUS_LABELS[item.status]}</span>
              <div>
                <strong>{item.label}</strong>
                <span className="subtle">{item.detail}</span>
              </div>
              {allowed ? (
                <button className="btn" type="button" onClick={() => navigate(item.action.view, item.action.params)}>
                  {item.action.label}
                </button>
              ) : (
                <span className="subtle">권한 있는 담당자에게 요청</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
