import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ALL_RBAC_ACTIONS, RBAC_ROLE_ACTIONS } from "../../../ts/rbac-policy";

import { useApiClient } from "../api/context";
import { useHashParam } from "../router";
import { ROLE_LABELS, useCan, useRoles } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { CaptureGuide } from "../components/CaptureGuide";
import { FilterSelect } from "../components/FilterSelect";
import { PrincipalDirectory } from "../components/PrincipalDirectory";
import { SitePageStateEditor } from "../components/SitePageStateEditor";
import { SiteCircuitNotice } from "../components/SiteCircuitNotice";
import { SiteCreateForm } from "../components/SiteCreateForm";
import { SiteNameEditor } from "../components/SiteNameEditor";
import { StatusBadge, statusLabel } from "../components/badges";
import { SITE_RISKS } from "./filters";
import type {
  AuditLogItem,
  AuditOutcome,
  AuthReadiness,
  CaptureSessionItem,
  ConnectorCatalogItem,
  RunTriggerItem,
  SiteItem,
  TemplateCatalogItem,
} from "../api/types";

export function SecurityView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const [guideSite, setGuideSite] = useState<SiteItem | null>(null);
  const lv = useListView<SiteItem>(["sites"], (p) => api.listSites(p), { refetchInterval: 10_000 });
  const sites = lv.query.data?.items ?? [];
  // 사이트 서킷 차단 안내: 로드된 목록에서 circuit_status='open'(차단) 건수만 센다(실 필드 기반, 데이터 창작 금지).
  const circuitOpenCount = sites.filter((s) => s.circuit_status === "open").length;
  // 실행 패널 '세션 등록하러 가기' 딥링크(#security?site=<id>)로 들어오면 해당 사이트 세션 등록을 상단에 직행 노출.
  const focusSiteId = useHashParam("site");
  const focusSite = focusSiteId !== null ? sites.find((s) => s.site_profile_id === focusSiteId) ?? null : null;
  const focusNeedsSession = focusSite !== null && focusSite.login_capable === true && focusSite.session_ready !== true;
  const sessionQueue = useMemo(() => collectSessionRenewalQueue(sites), [sites]);
  return (
    <>
    <AuthReadinessPanel />
    <RbacMatrixPanel />
    <SecurityConnectionsPanel />
    <SecretRefAuditPanel />
    <PrincipalDirectory />
    <SiteCircuitNotice openCount={circuitOpenCount} />
    {focusSite !== null && focusNeedsSession && (
      <section className="panel" style={{ marginBottom: 12, padding: 12 }} role="status" aria-label="세션 등록 안내">
        <strong>{focusSite.name ?? "선택한 사이트"} — 로그인 세션을 등록하세요</strong>
        <p className="subtle" style={{ margin: "4px 0 8px" }}>
          이 사이트는 로그인이 필요합니다. 아래 버튼으로 로그인 창을 열어 직접 로그인하면 세션이 저장되어 이후 자동 실행이 재사용합니다.
        </p>
        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
          <ActionButton
            label="세션 등록"
            action="session.capture"
            confirmText={`${focusSite.name ?? "사이트"}에 로그인 창을 엽니다. 창에서 직접 로그인하시면 세션이 저장됩니다.`}
            run={(key) => api.captureSession(focusSite.site_profile_id, key)}
            invalidateKeys={[["sites"], ["capture-sessions", focusSite.site_profile_id]]}
          />
          {can("session.capture") && (
            <button className="btn" type="button" onClick={() => setGuideSite(focusSite)}>
              운영자 PC 등록
            </button>
          )}
        </span>
      </section>
    )}
    {sessionQueue.length > 0 && (
      <SessionRenewalQueue
        items={sessionQueue}
        canCapture={can("session.capture")}
        onOpenGuide={setGuideSite}
        captureSession={(siteId, key) => api.captureSession(siteId, key)}
      />
    )}
    <SiteCreateForm />
    <QueryPanel<SiteItem>
      title="사이트 접근 정책"
      query={lv.query}
      pager={lv.pager}
      actions={<FilterSelect label="위험도" value={lv.filter.risk} options={SITE_RISKS} labelFor={statusLabel} onChange={(v) => lv.setFilter({ risk: v })} />}
      rowKey={(r) => r.site_profile_id}
      emptyMessage="조건에 맞는 등록된 사이트가 없습니다."
      columns={[
        { header: "사이트", render: (r) => <SiteNameEditor site={r} /> },
        { header: "위험도", render: (r) => <StatusBadge status={r.risk} /> },
        { header: "승인", render: (r) => <StatusBadge status={r.approval_status} /> },
        { header: "자동 차단", render: (r) => <StatusBadge status={r.circuit_status} kind="circuit" /> },
        {
          header: "작업",
          // 승인(검토 대기 사이트)·세션 등록(로그인 URL 설정 사이트)은 상호배타가 아니다 — 각각 독립 노출.
          // 검토 대기인 낮은 위험 사이트도 세션 등록 가능(승인 게이트는 고위험 사이트 실행 차단 전용, 서버가 강제).
          render: (r) => {
            const label = r.name ?? "사이트명 미정";
            return (
              <span style={{ display: "inline-flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {r.approval_status === "pending" && (
                  <ActionButton
                    label="승인"
                    action="site.approve"
                    confirmText={`${label} 고위험 사이트의 실행 차단을 해제하고 승인할까요? 승인 후 이 사이트 자동화를 실행할 수 있습니다.`}
                    run={(key) => api.approveSite(r.site_profile_id, key)}
                    invalidateKeys={[["sites"]]}
                  />
                )}
                {r.login_capable === true && (
                  // 세션 등록 상태 배지 — 운영자가 미등록 사이트를 한눈에 식별(session_ready 는 reads 투영).
                  <span className={`badge ${r.session_ready === true ? "green" : "amber"}`}>
                    {r.session_ready === true ? "세션 등록됨" : "세션 미등록"}
                  </span>
                )}
                {r.login_capable === true && (
                  // 운영자-보조 세션 등록: 로그인창(headful)을 띄워 운영자가 직접 로그인 → 세션 저장(이후 자동 실행이 재사용).
                  // login_capable(=loginUrl 설정) 사이트만 노출 — 미설정 사이트의 412 클릭을 사전에 차단.
                  <ActionButton
                    label="세션 등록"
                    action="session.capture"
                    confirmText={`${label}에 로그인 창을 엽니다. 창에서 직접 로그인하시면 세션이 저장되어 이후 자동 실행이 재사용합니다.`}
                    run={(key) => api.captureSession(r.site_profile_id, key)}
                    invalidateKeys={[["sites"], ["capture-sessions", r.site_profile_id]]}
                  />
                )}
                {r.login_capable === true && can("session.capture") && (
                  // 운영(prod) 환경에선 서버가 로그인창을 띄울 수 없어 운영자 PC 에서 캡처 도구를 실행한다 — 그 명령을 안내.
                  <button className="btn" type="button" onClick={() => setGuideSite(r)}>
                    운영자 PC 등록
                  </button>
                )}
                {r.login_capable === true && <SessionCaptureStatus site={r} />}
                <SitePageStateEditor site={r} />
              </span>
            );
          },
        },
      ]}
    />
    {guideSite !== null && <CaptureGuide site={guideSite} onClose={() => setGuideSite(null)} />}
    </>
  );
}

type SessionRenewalStatus = "missing" | "expiring" | "expired";

interface SessionRenewalQueueItem {
  readonly site: SiteItem;
  readonly status: SessionRenewalStatus;
  readonly detail: string;
}

function SessionRenewalQueue({
  items,
  canCapture,
  onOpenGuide,
  captureSession,
}: {
  items: readonly SessionRenewalQueueItem[];
  canCapture: boolean;
  onOpenGuide: (site: SiteItem) => void;
  captureSession: (siteId: string, key: string) => Promise<unknown>;
}): JSX.Element {
  return (
    <section className="panel session-renewal-queue" aria-label="로그인 세션 갱신 큐">
      <div className="panel-head">
        <h2>로그인 세션 갱신 큐</h2>
        <span className="badge amber">{items.length}건 확인 필요</span>
      </div>
      <div className="session-renewal-list">
        {items.map((item) => {
          const label = item.site.name ?? "사이트명 미정";
          return (
            <article key={item.site.site_profile_id} className="session-renewal-item">
              <div>
                <strong>{label}</strong>
                <span className="subtle">{item.detail}</span>
              </div>
              <span className={`badge ${item.status === "expired" ? "red" : "amber"}`}>{sessionRenewalStatusLabel(item.status)}</span>
              <div className="inline-actions">
                <ActionButton
                  label="세션 등록"
                  action="session.capture"
                  confirmText={`${label}에 로그인 창을 엽니다. 창에서 직접 로그인하시면 세션이 저장되어 이후 자동 실행이 재사용합니다.`}
                  run={(key) => captureSession(item.site.site_profile_id, key)}
                  invalidateKeys={[["sites"], ["capture-sessions", item.site.site_profile_id]]}
                />
                {canCapture && (
                  <button className="btn" type="button" onClick={() => onOpenGuide(item.site)}>
                    운영자 PC 등록
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function collectSessionRenewalQueue(sites: readonly SiteItem[]): SessionRenewalQueueItem[] {
  return sites
    .map((site) => sessionRenewalItem(site))
    .filter((item): item is SessionRenewalQueueItem => item !== null)
    .sort((a, b) => sessionRenewalRank(a.status) - sessionRenewalRank(b.status) || siteLabel(a.site).localeCompare(siteLabel(b.site), "ko-KR"));
}

function sessionRenewalItem(site: SiteItem): SessionRenewalQueueItem | null {
  if (site.login_capable !== true) return null;
  if (site.session_ready !== true) {
    return { site, status: "missing", detail: "로그인 세션이 없어 브라우저 실행 전에 등록이 필요합니다." };
  }
  if (site.session_expires_at === null || site.session_expires_at === undefined) return null;

  const expiresAt = Date.parse(site.session_expires_at);
  if (Number.isNaN(expiresAt)) return null;
  const remainingMs = expiresAt - Date.now();
  const thresholdMs = 24 * 60 * 60 * 1000;
  if (remainingMs <= 0) return { site, status: "expired", detail: `세션이 만료되었습니다. 만료 시각 ${formatDateTime(site.session_expires_at)}` };
  if (remainingMs <= thresholdMs) return { site, status: "expiring", detail: `세션 만료 임박 · ${formatDateTime(site.session_expires_at)}` };
  return null;
}

function sessionRenewalStatusLabel(status: SessionRenewalStatus): string {
  if (status === "missing") return "세션 미등록";
  if (status === "expired") return "세션 만료";
  return "만료 임박";
}

function sessionRenewalRank(status: SessionRenewalStatus): number {
  if (status === "expired") return 0;
  if (status === "missing") return 1;
  return 2;
}

function siteLabel(site: SiteItem): string {
  return site.name ?? site.url_pattern ?? site.site_profile_id;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

type SecurityConnectionStatus = "required" | "in_use";

interface SecurityConnectionSummary {
  readonly key: string;
  readonly label: string;
  readonly purpose: string;
  readonly status: SecurityConnectionStatus;
  readonly sources: readonly string[];
  readonly technicalRefs: readonly string[];
}

type RbacRoleKey = keyof typeof RBAC_ROLE_ACTIONS;
type RbacActionKey = (typeof ALL_RBAC_ACTIONS)[number];

const RBAC_ROLES = Object.keys(RBAC_ROLE_ACTIONS) as RbacRoleKey[];

const RBAC_ACTION_LABELS: Partial<Record<RbacActionKey, string>> = {
  "run.create": "자동화 실행 시작",
  "run.abort": "실행 중단",
  "trigger.manage": "스케줄·이벤트 트리거 관리",
  "automation_idea.manage": "업무 후보·ROI 관리",
  "automation_idea.approve": "업무 후보 승인·반려",
  "document_job.manage": "문서 자동화 작업",
  "human_task.assign": "확인 업무 배정",
  "human_task.escalate": "확인 업무 에스컬레이션",
  "human_task.resolve.validation": "검증 업무 완료",
  "human_task.resolve.approval": "승인 업무 완료",
  "site.approve": "고위험 사이트 승인",
  "approval.decide": "결재 인박스 처리",
  "scenario.create": "시나리오 작성",
  "scenario.promote": "운영 버전 승격",
  "connector.read": "커넥터 카탈로그 조회",
  "connector.enable": "커넥터 활성화",
  "session.capture": "로그인 세션 등록",
  "audit.read": "감사 로그 조회",
  "secret.resolve": "SecretRef 사용",
  "gateway_policy.edit": "AI 게이트웨이 정책 편집",
  "principal.manage": "담당자 디렉터리 관리",
  "rbac.grant": "RBAC 역할 부여",
};

const RBAC_MATRIX_ACTIONS = [
  "run.create",
  "run.abort",
  "trigger.manage",
  "automation_idea.manage",
  "automation_idea.approve",
  "document_job.manage",
  "human_task.assign",
  "human_task.escalate",
  "human_task.resolve.validation",
  "human_task.resolve.approval",
  "site.approve",
  "approval.decide",
  "scenario.create",
  "scenario.promote",
  "connector.read",
  "connector.enable",
  "session.capture",
  "audit.read",
  "secret.resolve",
  "gateway_policy.edit",
  "principal.manage",
  "rbac.grant",
] as const satisfies readonly RbacActionKey[];

function RbacMatrixPanel(): JSX.Element {
  const rawRoles = useRoles();
  const currentRoles = rawRoles.filter((role): role is RbacRoleKey => isKnownRole(role));
  const unknownRoles = rawRoles.filter((role) => !isKnownRole(role));
  const currentAllowed = ALL_RBAC_ACTIONS.filter((action) => rolesAllowAction(currentRoles, action));
  const adminOnlyCount = ALL_RBAC_ACTIONS.filter((action) => {
    const allowed = allowedRolesForAction(action);
    return allowed.length === 1 && allowed[0] === "admin";
  }).length;

  return (
    <section className="panel" aria-label="RBAC 역할 권한 매트릭스" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>RBAC 역할 권한 매트릭스</h2>
        <span className="badge blue">{RBAC_ROLES.length}개 역할</span>
      </div>
      <div className="rbac-matrix">
        <div className="summary-grid">
          <ReadinessMetric label="현재 토큰 역할" value={currentRoleLabel(currentRoles, unknownRoles)} tone={currentRoles.length > 0 ? "blue" : "amber"} />
          <ReadinessMetric label="허용 권한" value={`${currentAllowed.length}/${ALL_RBAC_ACTIONS.length}개`} tone={currentAllowed.length > 0 ? "green" : "amber"} />
          <ReadinessMetric label="관리자 전용" value={`${adminOnlyCount}개`} tone="amber" />
          <ReadinessMetric label="권한 원천" value="계약 매트릭스" tone="blue" />
        </div>
        {unknownRoles.length > 0 && (
          <ul className="notice-list" aria-label="미등록 RBAC 역할">
            {unknownRoles.map((role) => <li key={role}>토큰에 미등록 역할이 포함되어 있습니다: {role}</li>)}
          </ul>
        )}
        <p className="subtle rbac-matrix-note">미허용 액션은 백엔드 RBAC에서 차단되며, 이 표는 같은 권한 매트릭스를 화면에 표시합니다.</p>
        <div className="table-wrap">
          <table className="ops-table rbac-table">
            <thead>
              <tr>
                <th scope="col">권한</th>
                {RBAC_ROLES.map((role) => <th key={role} scope="col">{ROLE_LABELS[role]}</th>)}
                <th scope="col">내 토큰</th>
              </tr>
            </thead>
            <tbody>
              {RBAC_MATRIX_ACTIONS.map((action) => (
                <tr key={action}>
                  <th scope="row">
                    <span>{rbacActionLabel(action)}</span>
                    <details className="audit-technical-details">
                      <summary>액션명 보기</summary>
                      <code>{action}</code>
                    </details>
                  </th>
                  {RBAC_ROLES.map((role) => (
                    <td key={`${action}-${role}`}>
                      <RbacDecisionBadge allowed={roleAllowsAction(role, action)} />
                    </td>
                  ))}
                  <td>
                    <RbacDecisionBadge allowed={rolesAllowAction(currentRoles, action)} deniedLabel="차단" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RbacDecisionBadge({ allowed, deniedLabel = "—" }: { allowed: boolean; deniedLabel?: string }): JSX.Element {
  return allowed ? <span className="badge green">허용</span> : <span className="badge muted">{deniedLabel}</span>;
}

function SecurityConnectionsPanel(): JSX.Element {
  const api = useApiClient();
  const connectors = useQuery({ queryKey: ["security-connections", "connectors"], queryFn: () => api.listConnectors({ limit: 100 }), refetchInterval: 60_000 });
  const templates = useQuery({ queryKey: ["security-connections", "templates"], queryFn: () => api.listTemplates({ limit: 100 }), refetchInterval: 60_000 });
  const triggers = useQuery({ queryKey: ["security-connections", "run-triggers"], queryFn: () => api.listRunTriggers({ limit: 100 }), refetchInterval: 60_000 });
  const connections = useMemo(
    () => collectSecurityConnections(connectors.data?.items ?? [], templates.data?.items ?? [], triggers.data?.items ?? []),
    [connectors.data?.items, templates.data?.items, triggers.data?.items],
  );
  const hasMoreConnections =
    (connectors.data?.next_cursor ?? null) !== null ||
    (templates.data?.next_cursor ?? null) !== null ||
    (triggers.data?.next_cursor ?? null) !== null;
  const isLoading = connectors.isLoading || templates.isLoading || triggers.isLoading;
  const isError = connectors.isError || templates.isError || triggers.isError;

  return (
    <section className="panel" aria-label="보안 연결 사용 현황" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>보안 연결 사용 현황</h2>
        <span className="badge blue">{connections.length}{hasMoreConnections ? "+" : ""}개 연결</span>
      </div>
      {hasMoreConnections && <p className="subtle security-connection-state">현재 로드된 100건 단위 목록 기준입니다.</p>}
      {isLoading ? (
        <p className="subtle security-connection-state">보안 연결 참조를 확인하는 중입니다.</p>
      ) : isError ? (
        <p className="form-alert red" role="alert">보안 연결 사용 현황을 불러오지 못했습니다.</p>
      ) : connections.length === 0 ? (
        <p className="empty-state">등록된 보안 연결 참조가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">연결</th>
                <th scope="col">용도</th>
                <th scope="col">상태</th>
                <th scope="col">사용처</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.key}>
                  <th scope="row">{connection.label}</th>
                  <td>{connection.purpose}</td>
                  <td>
                    <span className={`badge ${connection.status === "in_use" ? "green" : "amber"}`}>
                      {connection.status === "in_use" ? "운영 사용 중" : "템플릿 요구"}
                    </span>
                  </td>
                  <td>
                    <span>{connection.sources.join(", ")}</span>
                    <details className="audit-technical-details">
                      <summary>참조 세부 정보 보기</summary>
                      <ul>
                        {connection.technicalRefs.map((ref) => <li key={ref}><code>{ref}</code></li>)}
                      </ul>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface SecretRefAuditSummary {
  readonly total: number;
  readonly allowed: number;
  readonly deniedOrBlocked: number;
  readonly errors: number;
  readonly latestAt: string | null;
  readonly latestOutcome: AuditOutcome | null;
  readonly actorCount: number;
  readonly hashLinked: number;
}

function secretAuditActorLabel(value: string | null): string {
  return value === null ? "처리자 미확인" : "처리자 확인됨";
}

function secretAuditRoleLabel(roles: readonly string[]): string {
  const labels = roles.map((role) => ROLE_LABELS[role] ?? "등록 외 역할");
  return labels.length > 0 ? labels.join(", ") : "역할 미확인";
}

function SecretRefAuditPanel(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["secret-ref-audit-summary"],
    queryFn: () => api.listAuditLog({ action: "secret.resolve", limit: 100 }),
    refetchInterval: 30_000,
  });
  const items = query.data?.items ?? [];
  const summary = useMemo(() => summarizeSecretRefAudit(items), [items]);
  const recent = items.slice(0, 5);

  return (
    <section className="panel" aria-label="SecretRef 감사 요약" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>SecretRef 감사 요약</h2>
        <div className="inline-actions">
          <span className={`badge ${summary.deniedOrBlocked > 0 || summary.errors > 0 ? "amber" : "blue"}`}>
            최근 {summary.total}건
          </span>
          <button className="btn" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
            새로고침
          </button>
          <a className="btn" href="#auditExplorer?action=secret.resolve">
            감사 이력
          </a>
        </div>
      </div>
      {query.isLoading ? (
        <p className="subtle security-connection-state">SecretRef 사용 감사 기록을 확인하는 중입니다.</p>
      ) : query.isError ? (
        <p className="form-alert red" role="alert">SecretRef 감사 요약을 불러오지 못했습니다.</p>
      ) : summary.total === 0 ? (
        <p className="empty-state">최근 SecretRef 사용 감사 기록이 없습니다.</p>
      ) : (
        <div className="secret-audit">
          <div className="summary-grid">
            <ReadinessMetric label="허용" value={`${summary.allowed}건`} tone="green" />
            <ReadinessMetric label="거부·차단" value={`${summary.deniedOrBlocked}건`} tone={summary.deniedOrBlocked > 0 ? "red" : "green"} />
            <ReadinessMetric label="오류" value={`${summary.errors}건`} tone={summary.errors > 0 ? "red" : "green"} />
            <ReadinessMetric label="마지막 사용" value={summary.latestAt === null ? "-" : formatAuditTime(summary.latestAt)} tone={summary.latestOutcome === "allow" ? "green" : "amber"} />
            <ReadinessMetric label="처리자 범위" value={`${summary.actorCount}명`} tone="blue" />
            <ReadinessMetric label="무결성" value={`${summary.hashLinked}/${summary.total}건`} tone={summary.hashLinked === summary.total ? "green" : "amber"} />
          </div>
          <p className="subtle secret-audit-note">평문 비밀값과 audit payload 본문은 표시하지 않습니다.</p>
          <div className="table-wrap">
            <table className="ops-table audit-table">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">결과</th>
                  <th scope="col">처리자</th>
                  <th scope="col">추적 번호</th>
                  <th scope="col">무결성</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((item) => (
                  <tr key={item.audit_id}>
                    <th scope="row">
                      <span>{formatAuditTime(item.occurred_at)}</span>
                    </th>
                    <td><span className={`badge ${secretAuditOutcomeTone(item.outcome)}`}>{secretAuditOutcomeLabel(item.outcome)}</span></td>
                    <td>
                      <span>{secretAuditActorLabel(item.actor.subject_id)}</span>
                      <span className="subtle">{secretAuditRoleLabel(item.actor.roles)}</span>
                    </td>
                    <td><span title={`요청 추적 번호: ${item.correlation_id}`}>요청 추적 가능</span></td>
                    <td>
                      <span>{item.previous_hash === null ? "첫 감사 기록" : "이전 기록과 연결됨"}</span>
                      <details className="audit-technical-details">
                        <summary>검증값 보기</summary>
                        <dl>
                          <dt>현재 검증값</dt>
                          <dd><code>{item.hash}</code></dd>
                          <dt>이전 검증값</dt>
                          <dd>{item.previous_hash === null ? "첫 기록" : <code>{item.previous_hash}</code>}</dd>
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function AuthReadinessPanel(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["auth-readiness"],
    queryFn: () => api.getAuthReadiness(),
    refetchInterval: 60_000,
  });

  return (
    <section className="panel" aria-label="SSO/IdP 준비도" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>SSO/IdP 준비도</h2>
        {query.data !== undefined && (
          <span className={`badge ${authReadinessTone(query.data)}`}>
            {query.data.enterprise_sso_ready ? "운영 SSO 준비됨" : "보강 필요"}
          </span>
        )}
      </div>
      {query.isLoading ? (
        <p className="subtle">인증 설정을 확인하는 중입니다.</p>
      ) : query.isError ? (
        <p className="form-alert red" role="alert">인증 준비도를 불러오지 못했습니다.</p>
      ) : query.data !== undefined ? (
        <div className="auth-readiness">
          <div className="summary-grid">
            <ReadinessMetric label="서명 검증" value={providerModeLabel(query.data)} tone={query.data.provider.mode === "jwks" ? "green" : "amber"} />
            <ReadinessMetric label="발급자 검증" value={configuredLabel(query.data.provider.issuer_configured)} tone={query.data.provider.issuer_configured ? "green" : "amber"} />
            <ReadinessMetric label="대상 검증" value={configuredLabel(query.data.provider.audience_configured)} tone={query.data.provider.audience_configured ? "green" : "amber"} />
            <ReadinessMetric label="현재 역할" value={query.data.current_principal.roles.join(", ") || "역할 없음"} tone="blue" />
            <ReadinessMetric label="역할 매핑" value={roleMappingLabel(query.data)} tone={query.data.role_mapping.configured ? "green" : "blue"} />
          </div>

          {query.data.operational_gaps.length > 0 && (
            <ul className="notice-list" aria-label="SSO 보강 항목">
              {query.data.operational_gaps.map((gap) => <li key={gap}>{gap}</li>)}
            </ul>
          )}

          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">필수 매핑</th>
                  <th scope="col">JWT 클레임</th>
                  <th scope="col">상태</th>
                  <th scope="col">사용 위치</th>
                </tr>
              </thead>
              <tbody>
                {query.data.required_claims.filter((claim) => claim.required).map((claim) => (
                  <tr key={claim.claim}>
                    <th scope="row">{claim.label}</th>
                    <td><code>{claim.claim}</code></td>
                    <td><span className={`badge ${claim.present ? "green" : "red"}`}>{claim.present ? "확인됨" : "누락"}</span></td>
                    <td>{claim.mapped_to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="audit-technical-details">
            <summary>인증 설정 세부 정보 보기</summary>
            <dl>
              <dt>JWKS 호스트</dt>
              <dd>{query.data.provider.jwks_host ?? "미설정"}</dd>
              <dt>Issuer</dt>
              <dd>{query.data.provider.issuer ?? "미설정"}</dd>
              <dt>Audience</dt>
              <dd>{query.data.provider.audience ?? "미설정"}</dd>
              <dt>현재 처리자</dt>
              <dd>{query.data.current_principal.display_name ?? query.data.current_principal.subject_id}</dd>
            </dl>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function ReadinessMetric({ label, value, tone }: { label: string; value: string; tone: "green" | "amber" | "blue" | "red" }): JSX.Element {
  return (
    <div className="metric-card">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{tone === "green" ? "정상" : tone === "red" ? "확인 필요" : tone === "amber" ? "보강" : "정보"}</span>
    </div>
  );
}

function authReadinessTone(readiness: AuthReadiness): "green" | "amber" | "red" {
  if (readiness.status === "ok") return "green";
  if (readiness.status === "blocked") return "red";
  return "amber";
}

function providerModeLabel(readiness: AuthReadiness): string {
  if (readiness.provider.mode === "jwks") return "RS256 / JWKS";
  return "HS256 공유키";
}

function configuredLabel(configured: boolean): string {
  return configured ? "검증 중" : "미설정";
}

function roleMappingLabel(readiness: AuthReadiness): string {
  return readiness.role_mapping.configured ? `${readiness.role_mapping.mapped_values}개 적용` : "기본 역할명";
}

function collectSecurityConnections(
  connectors: readonly ConnectorCatalogItem[],
  templates: readonly TemplateCatalogItem[],
  triggers: readonly RunTriggerItem[],
): SecurityConnectionSummary[] {
  const map = new Map<string, {
    label: string;
    purpose: string;
    status: SecurityConnectionStatus;
    sources: Set<string>;
    technicalRefs: Set<string>;
  }>();

  function add(ref: string, source: string, status: SecurityConnectionStatus): void {
    const normalized = normalizeSecretRef(ref);
    const existing = map.get(normalized);
    if (existing === undefined) {
      map.set(normalized, {
        label: securityConnectionLabel(normalized),
        purpose: securityConnectionPurpose(normalized),
        status,
        sources: new Set([source]),
        technicalRefs: new Set([ref]),
      });
      return;
    }
    existing.sources.add(source);
    existing.technicalRefs.add(ref);
    if (status === "in_use") existing.status = "in_use";
  }

  for (const connector of connectors) {
    for (const ref of connector.required_secret_refs) add(ref, `커넥터 ${connector.name}`, "required");
    for (const ref of connector.manifest_permissions.secret_refs) add(ref, `커넥터 ${connector.name}`, "required");
  }
  for (const template of templates) {
    for (const ref of template.required_secret_refs) add(ref, `템플릿 ${template.name}`, "required");
  }
  for (const trigger of triggers) {
    if (trigger.webhook_secret_ref !== null) add(trigger.webhook_secret_ref, `외부 이벤트 ${trigger.trigger_id.slice(0, 8)}`, "in_use");
  }

  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      label: value.label,
      purpose: value.purpose,
      status: value.status,
      sources: [...value.sources].sort(),
      technicalRefs: [...value.technicalRefs].sort(),
    }))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.label.localeCompare(b.label, "ko-KR"));
}

function normalizeSecretRef(ref: string): string {
  return ref.trim().replace(/^secret:\/\//, "").replace(/\/+$/g, "");
}

function securityConnectionLabel(ref: string): string {
  const parts = ref.split("/").filter((part) => part.length > 0 && part !== "*");
  if (parts.includes("run-triggers")) return "외부 이벤트 서명 키";
  const siteIndex = parts.indexOf("sites");
  const sitePart = siteIndex >= 0 ? parts[siteIndex + 1] : undefined;
  if (sitePart !== undefined) return `${humanizeRefPart(sitePart)} 로그인 세션`;
  const connectorIndex = parts.indexOf("connectors");
  const connectorPart = connectorIndex >= 0 ? parts[connectorIndex + 1] : undefined;
  if (connectorPart !== undefined) return `${humanizeRefPart(connectorPart)} 보안 연결`;
  const last = parts[parts.length - 1];
  return last !== undefined ? `${humanizeRefPart(last)} 보안 연결` : "보안 연결";
}

function securityConnectionPurpose(ref: string): string {
  if (ref.includes("run-triggers") || ref.includes("webhook")) return "외부 이벤트 서명 검증";
  if (ref.includes("sites") || ref.includes("session")) return "브라우저 로그인 세션";
  if (ref.includes("connectors")) return "커넥터 인증";
  return "자동화 보안 연결";
}

function humanizeRefPart(part: string): string {
  const acronyms = new Set(["api", "erp", "http", "idp", "ocr", "sap", "sso"]);
  return part
    .split(/[-_]+/g)
    .filter((word) => word.length > 0)
    .map((word) => acronyms.has(word.toLowerCase()) ? word.toUpperCase() : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function statusRank(status: SecurityConnectionStatus): number {
  return status === "in_use" ? 0 : 1;
}

function isKnownRole(role: string): role is RbacRoleKey {
  return Object.prototype.hasOwnProperty.call(RBAC_ROLE_ACTIONS, role);
}

function roleAllowsAction(role: RbacRoleKey, action: RbacActionKey): boolean {
  return RBAC_ROLE_ACTIONS[role].includes(action);
}

function rolesAllowAction(roles: readonly RbacRoleKey[], action: RbacActionKey): boolean {
  return roles.some((role) => roleAllowsAction(role, action));
}

function allowedRolesForAction(action: RbacActionKey): RbacRoleKey[] {
  return RBAC_ROLES.filter((role) => roleAllowsAction(role, action));
}

function rbacActionLabel(action: RbacActionKey): string {
  return RBAC_ACTION_LABELS[action] ?? action;
}

function currentRoleLabel(currentRoles: readonly RbacRoleKey[], unknownRoles: readonly string[]): string {
  if (currentRoles.length === 0 && unknownRoles.length === 0) return "권한 미확인";
  const knownLabels = currentRoles.map((role) => ROLE_LABELS[role]);
  if (unknownRoles.length === 0) return knownLabels.join(", ");
  return [...knownLabels, `미등록 ${unknownRoles.length}개`].join(", ");
}

function summarizeSecretRefAudit(items: readonly AuditLogItem[]): SecretRefAuditSummary {
  const actors = new Set<string>();
  let allowed = 0;
  let deniedOrBlocked = 0;
  let errors = 0;
  let hashLinked = 0;
  let latestAt: string | null = null;
  let latestOutcome: AuditOutcome | null = null;

  for (const item of items) {
    if (item.actor.subject_id !== null) actors.add(item.actor.subject_id);
    if (item.outcome === "allow") allowed += 1;
    if (item.outcome === "deny" || item.outcome === "blocked") deniedOrBlocked += 1;
    if (item.outcome === "error") errors += 1;
    if (item.hash.length > 0) hashLinked += 1;
    if (latestAt === null || new Date(item.occurred_at).getTime() > new Date(latestAt).getTime()) {
      latestAt = item.occurred_at;
      latestOutcome = item.outcome;
    }
  }

  return {
    total: items.length,
    allowed,
    deniedOrBlocked,
    errors,
    latestAt,
    latestOutcome,
    actorCount: actors.size,
    hashLinked,
  };
}

function secretAuditOutcomeTone(outcome: AuditOutcome): string {
  if (outcome === "allow") return "green";
  if (outcome === "deny" || outcome === "blocked") return "red";
  return "amber";
}

function secretAuditOutcomeLabel(outcome: AuditOutcome): string {
  if (outcome === "allow") return "허용";
  if (outcome === "deny") return "거부";
  if (outcome === "blocked") return "차단";
  return "오류";
}

function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function SessionCaptureStatus({ site }: { site: SiteItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["capture-sessions", site.site_profile_id],
    queryFn: () => api.listSessionCaptures(site.site_profile_id),
    enabled: open && can("session.capture"),
    refetchInterval: open ? 5_000 : false,
  });

  if (!can("session.capture")) return null;
  const name = site.name ?? "사이트명 미정";
  return (
    <span className="capture-status">
      <button className="btn" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "상태 닫기" : "상태 보기"}
      </button>
      {open && (
        <span className="capture-status-panel" role="region" aria-label={`세션 등록 상태 — ${name}`}>
          <span className="capture-status-head">
            <strong>최근 세션 등록</strong>
            <button className="btn" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
              새로고침
            </button>
          </span>
          {query.isLoading ? (
            <span className="subtle">상태를 불러오는 중…</span>
          ) : query.isError ? (
            <span className="badge red" role="alert">상태를 불러오지 못했습니다</span>
          ) : (query.data?.items.length ?? 0) === 0 ? (
            <span className="subtle">최근 세션 등록 이력이 없습니다.</span>
          ) : (
            <span className="capture-status-list">
              {(query.data?.items ?? []).slice(0, 5).map((item) => (
                <CaptureSessionRow key={item.capture_session_id} item={item} />
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function CaptureSessionRow({ item }: { item: CaptureSessionItem }): JSX.Element {
  const detailSummary = captureDetailSummary(item);
  return (
    <span className="capture-status-row">
      <span className={`badge ${captureStatusTone(item.status)}`}>{captureStatusLabel(item.status)}</span>
      <span className="subtle">등록 요청</span>
      <span className="subtle">{formatCaptureTime(item.updated_at)}</span>
      {detailSummary !== null && <span className="subtle" title={item.detail ?? undefined}>{detailSummary}</span>}
    </span>
  );
}

function captureDetailSummary(item: CaptureSessionItem): string | null {
  if (item.detail === null || item.detail.trim() === "") return null;
  switch (item.status) {
    case "launching":
      return "로그인 창을 여는 중입니다.";
    case "awaiting_login":
      return "운영자 로그인을 기다리는 중입니다.";
    case "capturing":
      return "로그인 세션을 저장하는 중입니다.";
    case "captured":
      return "저장된 세션을 실행에 사용할 수 있습니다.";
    case "failed":
      return "등록 실패 사유를 확인하세요.";
    case "expired":
      return "등록 시간이 만료됐습니다.";
  }
}

function captureStatusTone(status: CaptureSessionItem["status"]): "green" | "amber" | "red" | "blue" {
  if (status === "captured") return "green";
  if (status === "failed" || status === "expired") return "red";
  if (status === "awaiting_login") return "amber";
  return "blue";
}

function captureStatusLabel(status: CaptureSessionItem["status"]): string {
  switch (status) {
    case "launching":
      return "창 여는 중";
    case "awaiting_login":
      return "로그인 대기";
    case "capturing":
      return "저장 중";
    case "captured":
      return "등록 완료";
    case "failed":
      return "실패";
    case "expired":
      return "만료";
  }
}

function formatCaptureTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}
