import type { UseQueryResult } from "@tanstack/react-query";

import { desktopStateForError } from "../../components/states";
import { navigate, type ViewKey } from "../../router";
import type {
  AutomationPerformanceReport,
  AuthReadiness,
  Paginated,
  ProductionReadiness,
  RunItem,
  RunSummary,
  ScenarioItem,
  SiteItem,
} from "../../api/types";

type GateStatus = "ready" | "needs" | "blocked" | "deferred";

interface ReadinessAction {
  readonly label: string;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
  readonly requiredAction?: string;
}

interface ReadinessGate {
  readonly key: string;
  readonly label: string;
  readonly status: GateStatus;
  readonly detail: string;
  readonly action?: ReadinessAction;
}

const GATE_LABELS: Readonly<Record<GateStatus, string>> = {
  ready: "준비됨",
  needs: "확인 필요",
  blocked: "차단",
  deferred: "보류",
};

function gateTone(status: GateStatus): "green" | "amber" | "red" | "muted" {
  if (status === "ready") return "green";
  if (status === "blocked") return "red";
  if (status === "needs") return "amber";
  return "muted";
}

function queryPendingDetail(query: { readonly isFetching: boolean; readonly data: unknown }): string {
  return query.isFetching && query.data === undefined ? "확인 중입니다." : "아직 판단할 수 있는 데이터가 없습니다.";
}

function queryErrorDetail(error: unknown): string {
  const state = desktopStateForError(error);
  return `${state.title}: ${state.message}`;
}

function productionGateStatus(production: ProductionReadiness): GateStatus {
  if (production.summary.controlled_prod_ready) return "ready";
  if (production.summary.blocker_count > 0 || production.status === "blocked") return "blocked";
  if (production.summary.warning_count > 0 || production.status === "warning") return "needs";
  if (production.summary.deferred_count > 0) return "deferred";
  return "needs";
}

function productionGateDetail(production: ProductionReadiness): string {
  const counts = `차단 ${production.summary.blocker_count}건, 경고 ${production.summary.warning_count}건, 보류 ${production.summary.deferred_count}건`;
  if (production.summary.controlled_prod_ready) return `summary.controlled_prod_ready=true. ${counts}.`;
  if (production.summary.warning_count > 0 || production.status === "warning") return `${counts}. 운영 전 경고 해소 필요.`;
  if (production.summary.deferred_count > 0) return `${counts}. 담당자 증빙이 남아 있어 운영 전환은 보류입니다.`;
  if (production.summary.blocker_count > 0 || production.status === "blocked") return `${counts}. 운영 전환 차단 항목을 먼저 해소해야 합니다.`;
  return `${counts}. summary.controlled_prod_ready=false이므로 운영 전환 준비로 표시하지 않습니다.`;
}

function buildReadinessGates(args: {
  readonly auth: UseQueryResult<AuthReadiness>;
  readonly production: UseQueryResult<ProductionReadiness>;
  readonly sites: UseQueryResult<Paginated<SiteItem>>;
  readonly scenarios: UseQueryResult<Paginated<ScenarioItem>>;
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly performance: UseQueryResult<AutomationPerformanceReport>;
}): readonly ReadinessGate[] {
  const gates: ReadinessGate[] = [];
  const auth = args.auth.data;
  const sites = args.sites.data?.items ?? [];
  const scenarios = args.scenarios.data?.items ?? [];
  const loginSites = sites.filter((site) => site.login_capable === true);
  const missingSession = loginSites.find((site) => site.session_ready !== true);
  const roiEvidenceCount = args.performance.data?.summary.roi_actuals.evidence_count ?? 0;

  gates.push(
    args.auth.isError
      ? { key: "sso", label: "SSO", status: "needs", detail: queryErrorDetail(args.auth.error), action: { label: "접속 설정 확인", view: "security", params: { section: "access" }, requiredAction: "rbac.grant" } }
      : auth === undefined
        ? { key: "sso", label: "SSO", status: "deferred", detail: queryPendingDetail(args.auth) }
        : auth.enterprise_sso_ready
          ? { key: "sso", label: "SSO", status: "ready", detail: "엔터프라이즈 SSO 설정이 준비되어 있습니다." }
          : {
              key: "sso",
              label: "SSO",
              status: auth.status === "blocked" ? "blocked" : "needs",
              detail: auth.operational_gaps.length > 0 ? auth.operational_gaps.join(", ") : "SSO 설정 확인이 필요합니다.",
              action: { label: "접속 설정 확인", view: "security", params: { section: "access" }, requiredAction: "rbac.grant" },
            },
  );

  gates.push(
    args.auth.isError
      ? { key: "rbac", label: "RBAC", status: "needs", detail: queryErrorDetail(args.auth.error), action: { label: "역할 매핑 확인", view: "security", params: { section: "access" }, requiredAction: "rbac.grant" } }
      : auth === undefined
        ? { key: "rbac", label: "RBAC", status: "deferred", detail: queryPendingDetail(args.auth) }
        : auth.role_mapping.configured && auth.role_mapping.mapped_values > 0
          ? { key: "rbac", label: "RBAC", status: "ready", detail: `${auth.role_mapping.mapped_values}개 역할 매핑이 적용되어 있습니다.` }
          : {
              key: "rbac",
              label: "RBAC",
              status: "needs",
              detail: "역할 매핑 또는 현재 사용자 역할 확인이 필요합니다.",
              action: { label: "역할 매핑 확인", view: "security", params: { section: "access" }, requiredAction: "rbac.grant" },
            },
  );

  gates.push(
    args.sites.isError
      ? { key: "sites", label: "사이트", status: "needs", detail: queryErrorDetail(args.sites.error), action: { label: "사이트 등록", view: "security", params: { section: "sites" }, requiredAction: "site.create" } }
      : args.sites.data === undefined
        ? { key: "sites", label: "사이트", status: "deferred", detail: queryPendingDetail(args.sites) }
        : sites.length > 0
          ? { key: "sites", label: "사이트", status: "ready", detail: `${sites.length}개 사이트가 등록되어 있습니다.` }
          : {
              key: "sites",
              label: "사이트",
              status: "needs",
              detail: "파일럿 대상 사이트를 등록해야 합니다.",
              action: { label: "사이트 등록", view: "security", params: { section: "sites" }, requiredAction: "site.create" },
            },
  );

  gates.push(
    args.sites.isError
      ? { key: "sessions", label: "브라우저 세션", status: "needs", detail: queryErrorDetail(args.sites.error), action: { label: "세션 확인", view: "security", params: { section: "sites" }, requiredAction: "session.capture" } }
      : args.sites.data === undefined
        ? { key: "sessions", label: "브라우저 세션", status: "deferred", detail: queryPendingDetail(args.sites) }
        : sites.length === 0
          ? { key: "sessions", label: "브라우저 세션", status: "deferred", detail: "사이트 등록 후 확인합니다.", action: { label: "사이트 등록", view: "security", params: { section: "sites" }, requiredAction: "site.create" } }
          : loginSites.length === 0
            ? { key: "sessions", label: "브라우저 세션", status: "deferred", detail: "로그인 세션이 필요한 사이트가 아직 없습니다." }
            : missingSession === undefined
              ? { key: "sessions", label: "브라우저 세션", status: "ready", detail: "로그인 필요 사이트의 세션이 준비되어 있습니다." }
              : {
                  key: "sessions",
                  label: "브라우저 세션",
                  status: "needs",
                  detail: `${missingSession.name ?? "대상 사이트"} 세션 등록이 필요합니다.`,
                  action: { label: "세션 등록", view: "security", params: { section: "sites", site: missingSession.site_profile_id }, requiredAction: "session.capture" },
                },
  );

  gates.push(
    args.scenarios.isError
      ? { key: "automation", label: "첫 자동화", status: "needs", detail: queryErrorDetail(args.scenarios.error), action: { label: "자동화 초안 만들기", view: "scenarioStudio", requiredAction: "scenario.create" } }
      : args.scenarios.data === undefined
        ? { key: "automation", label: "첫 자동화", status: "deferred", detail: queryPendingDetail(args.scenarios) }
        : scenarios.length > 0
          ? { key: "automation", label: "첫 자동화", status: "ready", detail: `${scenarios.length}개 자동화가 등록되어 있습니다.` }
          : {
              key: "automation",
              label: "첫 자동화",
              status: "needs",
              detail: "첫 자동화 초안이 아직 없습니다.",
              action: { label: "자동화 초안 만들기", view: "scenarioStudio", requiredAction: "scenario.create" },
            },
  );

  gates.push(
    args.summary.isError
      ? { key: "test-run", label: "테스트 실행", status: "needs", detail: queryErrorDetail(args.summary.error), action: { label: "테스트 실행", view: "scenarioStudio", params: { focus: "test" }, requiredAction: "run.create" } }
      : args.summary.data === undefined
        ? { key: "test-run", label: "테스트 실행", status: "deferred", detail: queryPendingDetail(args.summary) }
        : args.summary.data.total > 0
          ? { key: "test-run", label: "테스트 실행", status: "ready", detail: `${args.summary.data.total}건의 실행 기록이 있습니다.` }
          : {
              key: "test-run",
              label: "테스트 실행",
              status: "deferred",
              detail: "자동화 초안 생성 후 테스트 실행을 시작합니다.",
              action: { label: "테스트 실행", view: "scenarioStudio", params: { focus: "test" }, requiredAction: "run.create" },
            },
  );

  gates.push(
    args.recent.isError
      ? { key: "evidence", label: "증거", status: "needs", detail: queryErrorDetail(args.recent.error), action: { label: "실행 증거 보기", view: "runTrace" } }
      : args.recent.data === undefined
        ? { key: "evidence", label: "증거", status: "deferred", detail: queryPendingDetail(args.recent) }
        : args.recent.data.items.length > 0
          ? { key: "evidence", label: "증거", status: "ready", detail: "최근 실행 증거가 연결되어 있습니다.", action: { label: "실행 증거 보기", view: "runTrace" } }
          : { key: "evidence", label: "증거", status: "deferred", detail: "실행이 생기면 증거를 확인합니다.", action: { label: "실행 증거 보기", view: "runTrace" } },
  );

  gates.push(
    args.production.isError
      ? { key: "support", label: "지원 체계", status: "needs", detail: queryErrorDetail(args.production.error), action: { label: "운영 증빙 확인", view: "automationOps", params: { section: "readiness" }, requiredAction: "ops_readiness.manage" } }
      : args.production.data === undefined
        ? { key: "support", label: "지원 체계", status: "deferred", detail: queryPendingDetail(args.production) }
        : {
            key: "support",
            label: "지원 체계",
            status: productionGateStatus(args.production.data),
            detail: productionGateDetail(args.production.data),
            action:
              args.production.data.summary.controlled_prod_ready
                ? { label: "운영 증빙 보기", view: "automationOps", params: { section: "readiness" } }
                : { label: "운영 증빙 확인", view: "automationOps", params: { section: "readiness" }, requiredAction: "ops_readiness.manage" },
          },
  );

  gates.push(
    args.performance.isError
      ? { key: "roi", label: "ROI", status: "needs", detail: queryErrorDetail(args.performance.error), action: { label: "성과 리포트 보기", view: "dashboard", params: { focus: "automation-report" } } }
      : args.performance.data === undefined
        ? { key: "roi", label: "ROI", status: "deferred", detail: queryPendingDetail(args.performance) }
        : roiEvidenceCount > 0
          ? { key: "roi", label: "ROI", status: "ready", detail: `${roiEvidenceCount}건의 ROI 실적 증거가 있습니다.`, action: { label: "성과 리포트 보기", view: "dashboard", params: { focus: "automation-report" } } }
          : { key: "roi", label: "ROI", status: "deferred", detail: "실적 증거가 없어 확장 판단은 보류입니다.", action: { label: "성과 리포트 보기", view: "dashboard", params: { focus: "automation-report" } } },
  );

  return gates;
}

export function AdoptionReadinessPanel(props: {
  readonly auth: UseQueryResult<AuthReadiness>;
  readonly production: UseQueryResult<ProductionReadiness>;
  readonly sites: UseQueryResult<Paginated<SiteItem>>;
  readonly scenarios: UseQueryResult<Paginated<ScenarioItem>>;
  readonly summary: UseQueryResult<RunSummary>;
  readonly recent: UseQueryResult<Paginated<RunItem>>;
  readonly performance: UseQueryResult<AutomationPerformanceReport>;
  readonly can: (action: string) => boolean;
}): JSX.Element {
  const gates = buildReadinessGates(props);
  const readyCount = gates.filter((gate) => gate.status === "ready").length;
  const blockedCount = gates.filter((gate) => gate.status === "blocked").length;
  const needsCount = gates.filter((gate) => gate.status === "needs").length;
  const allReady = readyCount === gates.length;
  return (
    <section className="panel adoption-readiness" aria-label="파일럿 준비 상태">
      <div className="panel-head">
        <div>
          <h2>파일럿 준비 상태</h2>
          <p className="subtle">필수 관문은 실제 응답 기준으로만 표시합니다. 알 수 없는 항목은 준비로 간주하지 않습니다.</p>
        </div>
        <span className={`badge ${blockedCount > 0 ? "red" : needsCount > 0 ? "amber" : "green"}`}>
          {readyCount}/{gates.length} 준비
        </span>
      </div>
      {allReady ? (
        <p className="form-alert green" role="status">
          모든 필수 관문이 준비되었습니다. 운영 전환 패킷과 최근 실행 증거를 기준으로 계속 모니터링하세요.
        </p>
      ) : (
        <ul className="adoption-gates">
          {gates.map((gate) => {
            const actionAllowed = gate.action !== undefined && (gate.action.requiredAction === undefined || props.can(gate.action.requiredAction));
            return (
              <li key={gate.key}>
                <span className={`badge ${gateTone(gate.status)}`}>{GATE_LABELS[gate.status]}</span>
                <div>
                  <strong>{gate.label}</strong>
                  <span className="subtle">{gate.detail}</span>
                </div>
                {actionAllowed ? (
                  <button className="btn" type="button" onClick={() => navigate(gate.action!.view, gate.action!.params)}>
                    {gate.action!.label}
                  </button>
                ) : gate.action !== undefined ? (
                  <span className="subtle">권한 있는 담당자에게 요청</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
