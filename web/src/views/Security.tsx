import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { mergeParams, useHashParam } from "../router";
import { useCan, useRoles } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { CaptureGuide } from "../components/CaptureGuide";
import { OffboardingPanel } from "../components/OffboardingPanel";
import { FilterSelect } from "../components/FilterSelect";
import { PrincipalDirectory } from "../components/PrincipalDirectory";
import { RoleAssignmentPanel } from "../components/RoleAssignmentPanel";
import { SitePageStateEditor } from "../components/SitePageStateEditor";
import { SiteCircuitNotice } from "../components/SiteCircuitNotice";
import { SiteCreateForm } from "../components/SiteCreateForm";
import { SiteNameEditor } from "../components/SiteNameEditor";
import { StatusBadge, statusLabel } from "../components/badges";
import { SITE_RISKS } from "./filters";
import type { SiteItem } from "../api/types";
import { AuthReadinessPanel } from "./security/AuthReadinessPanel";
import { AiGovernanceEvidencePanel } from "./security/AiGovernanceEvidencePanel";
import { AiGovernanceRuntimePolicyPanel } from "./security/AiGovernanceRuntimePolicyPanel";
import { RbacMatrixPanel } from "./security/RbacMatrixPanel";
import { ConcurrencyPolicyPanel } from "./security/ConcurrencyPolicyPanel";
import { WorkerPoolPanel } from "./security/WorkerPoolPanel";
import { SecurityConnectionsPanel } from "./security/SecurityConnectionsPanel";
import { ScimProviderPanel } from "./security/ScimProviderPanel";
import { SecretRefAuditPanel } from "./security/SecretRefAuditPanel";
import { SessionCaptureStatus } from "./security/SessionCaptureStatus";
import { SessionRenewalQueue, collectSessionRenewalQueue } from "./security/SessionRenewalQueue";
import { SiteApprovalControls } from "./security/SiteApprovalControls";

type SecuritySectionKey = "sites" | "access" | "secrets" | "ai" | "infra" | "offboarding";

const SECURITY_SECTIONS: readonly {
  readonly key: SecuritySectionKey;
  readonly label: string;
  readonly purpose: string;
}[] = [
  { key: "sites", label: "사이트·브라우저 세션", purpose: "파일럿 대상 사이트와 운영자 PC 로그인 세션 준비" },
  { key: "access", label: "접속·권한", purpose: "SSO, RBAC, 담당자, SCIM 역할 매핑 확인" },
  { key: "secrets", label: "비밀·연결·감사", purpose: "SecretRef, Credential, 보안 연결, 감사 증거 점검" },
  { key: "ai", label: "AI 거버넌스", purpose: "AI 정책, 런타임 통제, 증거 장부 확인" },
  { key: "infra", label: "운영 인프라", purpose: "워커 풀과 실행 인프라 운영 상태 확인" },
  { key: "offboarding", label: "오프보딩", purpose: "데이터 반출과 승인 게이트 영구 삭제 관리" },
];

function isSecuritySection(value: string | null): value is SecuritySectionKey {
  return value === "sites" || value === "access" || value === "secrets" || value === "ai" || value === "infra" || value === "offboarding";
}

function resolveSecuritySection(args: {
  readonly explicit: string | null;
  readonly site: string | null;
  readonly principal: string | null;
  readonly focus: string | null;
  readonly credential: string | null;
  readonly credentialSite: string | null;
}): SecuritySectionKey {
  if (isSecuritySection(args.explicit)) return args.explicit;
  if (args.principal !== null) return "access";
  if (args.credential !== null || args.credentialSite !== null || args.focus === "credentials") return "secrets";
  if (args.focus === "worker-pools") return "infra";
  if (args.site !== null) return "sites";
  return "sites";
}

function SecuritySectionSelector({ active }: { active: SecuritySectionKey }): JSX.Element {
  return (
    <section className="panel security-hub" aria-label="보안 운영 허브">
      <div className="panel-head">
        <div>
          <h2>보안 운영 허브</h2>
          <p className="subtle">목적별 섹션만 펼쳐서 봅니다. 메뉴 노출은 UX 정책이며 실제 허용은 백엔드 RBAC가 최종 판정합니다.</p>
        </div>
      </div>
      <div className="section-tabs" role="list" aria-label="보안/개인정보 섹션">
        {SECURITY_SECTIONS.map((section) => (
          <button
            key={section.key}
            type="button"
            className={`section-tab${section.key === active ? " active" : ""}`}
            aria-pressed={section.key === active}
            aria-current={section.key === active ? "true" : undefined}
            onClick={() => mergeParams({ section: section.key })}
          >
            <strong>{section.label}</strong>
            <span>{section.purpose}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SectionAccessNotice({ title }: { title: string }): JSX.Element {
  return (
    <section className="panel section-access-notice" role="status" aria-label={`${title} 권한 안내`}>
      <strong>권한 확인 필요</strong>
      <p className="subtle">이 섹션의 세부 관리 기능은 현재 역할에서 표시되지 않습니다. 권한 있는 담당자 또는 관리자가 확인할 수 있습니다.</p>
    </section>
  );
}

function securitySectionMeta(key: SecuritySectionKey): (typeof SECURITY_SECTIONS)[number] {
  return SECURITY_SECTIONS.find((section) => section.key === key) ?? SECURITY_SECTIONS[0]!;
}

function SecurityReadOnlySummary(props: {
  readonly active: SecuritySectionKey;
  readonly sites: readonly SiteItem[];
  readonly sitesLoading: boolean;
  readonly sitesError: boolean;
  readonly focusSiteId: string | null;
}): JSX.Element {
  const section = securitySectionMeta(props.active);
  const pendingApprovals = props.sites.filter((site) => site.approval_status === "pending").length;
  const missingSessions = props.sites.filter((site) => site.login_capable === true && site.session_ready !== true).length;
  const openCircuits = props.sites.filter((site) => site.circuit_status === "open").length;
  const focusSite = props.focusSiteId !== null ? props.sites.find((site) => site.site_profile_id === props.focusSiteId) ?? null : null;
  const suggestedSite =
    focusSite ??
    props.sites.find((site) => site.login_capable === true && site.session_ready !== true) ??
    props.sites.find((site) => site.approval_status === "pending") ??
    props.sites.find((site) => site.circuit_status === "open") ??
    null;
  const nextRequests =
    suggestedSite === null
      ? []
      : [
          suggestedSite.approval_status === "pending" ? "approver 또는 admin 담당자에게 사이트 승인을 요청하세요." : null,
          suggestedSite.login_capable === true && suggestedSite.session_ready !== true
            ? "session.capture 권한 담당자에게 운영자 PC 등록 또는 서버 캡처를 요청하세요."
            : null,
          suggestedSite.circuit_status === "open" ? "운영 정책 담당자에게 차단 회로 상태 확인을 요청하세요." : null,
        ].filter((item): item is string => item !== null);

  return (
    <div className="security-view">
      <section className="panel security-hub" aria-label="보안 읽기 전용 요약">
        <div className="panel-head">
          <div>
            <h2>보안 읽기 전용 요약</h2>
            <p className="subtle">직접 링크 접근에서는 허용된 상태 요약만 제공합니다. 관리 작업은 admin 역할에서만 열립니다.</p>
          </div>
          <span className="badge amber">읽기 전용</span>
        </div>
      </section>

      <section className="panel security-section-summary" aria-label={`${section.label} 읽기 전용 섹션 요약`}>
        <strong>{section.label}</strong>
        <p className="subtle">{section.purpose}</p>
        {props.sitesLoading ? (
          <p className="subtle">사이트 보안 요약을 확인하는 중입니다.</p>
        ) : props.sitesError ? (
          <p className="form-alert red" role="alert">사이트 보안 요약을 불러오지 못했습니다.</p>
        ) : (
          <p className="subtle">
            등록 사이트 {props.sites.length}개 · 승인 대기 {pendingApprovals}개 · 세션 미등록 {missingSessions}개 · 차단 회로 {openCircuits}개
          </p>
        )}
      </section>

      {props.active === "sites" && (
        <section className="panel security-readonly-workbench" aria-label="사이트 세션 준비 읽기 전용 안내">
          <div className="panel-head">
            <div>
              <h2>사이트·세션 준비 안내</h2>
              <p className="subtle">SecretRef 값과 세션 본문 없이 파일럿 대상 사이트의 준비 신호만 확인합니다.</p>
            </div>
            {props.focusSiteId !== null && <span className="badge blue">딥링크</span>}
          </div>
          <div className="security-readonly-body">
            {props.sitesLoading ? (
              <p className="subtle">사이트 준비 상태를 확인하는 중입니다.</p>
            ) : props.sitesError ? (
              <p className="form-alert red" role="alert">사이트 준비 상태를 불러오지 못했습니다.</p>
            ) : suggestedSite !== null ? (
              <div className="security-readonly-site-card">
                <div className="security-readonly-site-head">
                  <div>
                    <strong>{suggestedSite.name ?? "선택한 사이트"}</strong>
                    <p className="subtle">{focusSite !== null ? "요청한 사이트의 준비 상태입니다." : "우선 확인할 사이트 준비 항목입니다."}</p>
                  </div>
                  {suggestedSite.login_capable === true ? (
                    <span className={`badge ${suggestedSite.session_ready === true ? "green" : "amber"}`}>
                      {suggestedSite.session_ready === true ? "세션 준비됨" : "세션 미등록"}
                    </span>
                  ) : (
                    <span className="badge muted">세션 불필요</span>
                  )}
                </div>
                <div className="security-readonly-statuses" aria-label="사이트 준비 상태">
                  <span>
                    <small>위험도</small>
                    <StatusBadge status={suggestedSite.risk} />
                  </span>
                  <span>
                    <small>승인</small>
                    <StatusBadge status={suggestedSite.approval_status} />
                  </span>
                  <span>
                    <small>자동 차단</small>
                    <StatusBadge status={suggestedSite.circuit_status} kind="circuit" />
                  </span>
                  <span>
                    <small>세션 저장 암호화</small>
                    {sessionEncryptionBadge(suggestedSite)}
                  </span>
                </div>
                <div>
                  <strong>다음 요청</strong>
                  <ul className="security-readonly-next">
                    {(nextRequests.length > 0 ? nextRequests : ["추가 관리 요청 없이 실행 전 준비 상태를 다시 확인하세요."]).map((request) => (
                      <li key={request}>{request}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : props.focusSiteId !== null ? (
              <p className="subtle">요청한 사이트를 현재 목록에서 찾지 못했습니다. 권한 있는 담당자에게 사이트 등록 상태를 확인해 달라고 요청하세요.</p>
            ) : (
              <p className="subtle">등록된 사이트가 없습니다. 사이트 등록 권한이 있는 담당자에게 파일럿 대상 사이트 등록을 요청하세요.</p>
            )}
          </div>
        </section>
      )}

      <section className="panel section-access-notice" role="status" aria-label="보안 deep link 권한 안내">
        <strong>관리자 권한 필요</strong>
        <p className="subtle">
          security 메뉴는 admin-only 정책을 유지합니다. 현재 역할에서는 등록, 승인, 동기화, 정책 변경 같은 관리 기능을 표시하지 않습니다.
        </p>
        <p className="subtle">비밀값, 토큰, 비밀번호, 해석된 비밀 자료, 감사 원문 본문, 세션 본문은 표시하지 않습니다.</p>
      </section>
    </div>
  );
}

function sessionEncryptionBadge(site: SiteItem): JSX.Element {
  const kid = site.enc_kid ?? null;
  if (kid === "dev-plaintext" || kid === "plaintext") {
    return <span className="badge red">평문(dev)</span>;
  }
  if (kid !== null && kid.trim().length > 0) {
    return <span className="badge green">KMS 봉투암호화({kid})</span>;
  }
  return <span className="badge muted">확인 필요</span>;
}

export function SecurityView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const roles = useRoles();
  const isSecurityAdmin = roles.includes("admin");
  const [guideSite, setGuideSite] = useState<SiteItem | null>(null);
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: () => api.getCapabilities(), retry: false });
  const serverCaptureEnabled = capabilities.data?.session_capture?.server?.enabled === true;
  const lv = useListView<SiteItem>(["sites"], (p) => api.listSites(p), { refetchInterval: 10_000 });
  const sites = lv.query.data?.items ?? [];
  // 사이트 서킷 차단 안내: 로드된 목록에서 circuit_status='open'(차단) 건수만 센다(실 필드 기반, 데이터 창작 금지).
  const circuitOpenCount = sites.filter((s) => s.circuit_status === "open").length;
  // 실행 패널 '세션 등록하러 가기' 딥링크(#security?site=<id>)로 들어오면 해당 사이트 세션 등록을 상단에 직행 노출.
  const explicitSection = useHashParam("section");
  const focusSiteId = useHashParam("site");
  const focusPrincipalId = useHashParam("principal");
  const focus = useHashParam("focus");
  const intent = useHashParam("intent");
  const focusCredential = useHashParam("credential");
  const focusCredentialSite = useHashParam("credential_site");
  const activeSection = resolveSecuritySection({
    explicit: explicitSection,
    site: focusSiteId,
    principal: focusPrincipalId,
    focus,
    credential: focusCredential,
    credentialSite: focusCredentialSite,
  });
  const focusSite = focusSiteId !== null ? sites.find((s) => s.site_profile_id === focusSiteId) ?? null : null;
  const focusNeedsSession = focusSite !== null && focusSite.login_capable === true && focusSite.session_ready !== true;
  const sessionQueue = useMemo(() => collectSessionRenewalQueue(sites), [sites]);

  if (!isSecurityAdmin) {
    return (
      <SecurityReadOnlySummary
        active={activeSection}
        sites={sites}
        sitesLoading={lv.query.isLoading}
        sitesError={lv.query.isError}
        focusSiteId={focusSiteId}
      />
    );
  }

  return (
    <div className="security-view">
      <SecuritySectionSelector active={activeSection} />

      {activeSection === "sites" && (
        <>
          <section className="panel security-section-summary" aria-label="사이트·브라우저 세션 요약">
            <strong>사이트·브라우저 세션</strong>
            <p className="subtle">사이트 등록, 고위험 승인, 로그인 세션 등록, 운영자 PC 등록 순서로 파일럿 실행 대상을 준비합니다.</p>
          </section>
          <SiteCircuitNotice openCount={circuitOpenCount} />
          {focusSite !== null && focusNeedsSession && (
            <section className="panel" style={{ marginBottom: 12, padding: 12 }} role="status" aria-label="세션 등록 안내">
              <strong>{focusSite.name ?? "선택한 사이트"} — 로그인 세션을 등록하세요</strong>
              <p className="subtle" style={{ margin: "4px 0 8px" }}>
                {serverCaptureEnabled
                  ? "이 사이트는 로그인이 필요합니다. 서버 캡처 또는 운영자 PC 등록으로 로그인 세션을 저장하면 이후 자동 실행이 재사용합니다."
                  : "이 배포는 서버에서 로그인 창을 열 수 없습니다. 운영자 PC 등록으로 로그인 세션을 저장하면 이후 자동 실행이 재사용합니다."}
              </p>
              <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                {serverCaptureEnabled && (
                  <ActionButton
                    label="세션 등록"
                    action="session.capture"
                    confirmText={`${focusSite.name ?? "사이트"}에 서버 캡처용 로그인 창을 요청합니다. 창에서 직접 로그인하시면 세션이 저장됩니다.`}
                    run={(key) => api.captureSession(focusSite.site_profile_id, key)}
                    invalidateKeys={[["sites"], ["capture-sessions", focusSite.site_profile_id]]}
                  />
                )}
                {can("session.capture") && (
                  <button className={serverCaptureEnabled ? "btn" : "btn primary"} type="button" onClick={() => setGuideSite(focusSite)}>
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
              serverCaptureEnabled={serverCaptureEnabled}
              onOpenGuide={setGuideSite}
              captureSession={(siteId, key) => api.captureSession(siteId, key)}
            />
          )}
          {can("site.create") ? <SiteCreateForm openSignal={intent === "site-create" ? 1 : 0} /> : <SectionAccessNotice title="사이트 등록" />}
          <QueryPanel<SiteItem>
            title="사이트 접근 정책"
            query={lv.query}
            pager={lv.pager}
            actions={<FilterSelect label="위험도" value={lv.filter.risk} options={SITE_RISKS} labelFor={statusLabel} onChange={(v) => lv.setFilter({ risk: v })} />}
            rowKey={(r) => r.site_profile_id}
            emptyTitle="설정 필요"
            emptyMessage="조건에 맞는 등록된 사이트가 없습니다. 파일럿 대상 사이트를 먼저 등록하세요."
            columns={[
              { header: "사이트", render: (r) => <SiteNameEditor site={r} /> },
              { header: "위험도", render: (r) => <StatusBadge status={r.risk} /> },
              {
                header: "승인",
                render: (r) => (
                  <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                    <StatusBadge status={r.approval_status} />
                    {/* 기간 한정 승인 표면화(A3-3) — 만료 경과 시 배지가 '만료'로 바뀌고 실행이 다시 차단된다. */}
                    {r.approval_status === "approved" && typeof r.approval_expires_at === "string" && (
                      <span className="label">{new Date(r.approval_expires_at).toLocaleString()} 까지</span>
                    )}
                  </span>
                ),
              },
              { header: "자동 차단", render: (r) => <StatusBadge status={r.circuit_status} kind="circuit" /> },
              { header: "세션 저장 암호화", render: (r) => sessionEncryptionBadge(r) },
              {
                header: "작업",
                render: (r) => {
                  const label = r.name ?? "사이트명 미정";
                  return (
                    <span style={{ display: "inline-flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      <SiteApprovalControls site={r} />
                      {r.login_capable === true && (
                        <span className={`badge ${r.session_ready === true ? "green" : "amber"}`}>
                          {r.session_ready === true ? "세션 등록됨" : "세션 미등록"}
                        </span>
                      )}
                      {r.login_capable === true && serverCaptureEnabled && (
                        <ActionButton
                          label="세션 등록"
                          action="session.capture"
                          confirmText={`${label}에 서버 캡처용 로그인 창을 요청합니다. 창에서 직접 로그인하시면 세션이 저장되어 이후 자동 실행이 재사용합니다.`}
                          run={(key) => api.captureSession(r.site_profile_id, key)}
                          invalidateKeys={[["sites"], ["capture-sessions", r.site_profile_id]]}
                        />
                      )}
                      {r.login_capable === true && can("session.capture") && (
                        <button className={serverCaptureEnabled ? "btn" : "btn primary"} type="button" onClick={() => setGuideSite(r)}>
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
        </>
      )}

      {activeSection === "access" && (
        <>
          <AuthReadinessPanel />
          <RbacMatrixPanel />
          <PrincipalDirectory />
          {can("rbac.grant") ? <RoleAssignmentPanel /> : <SectionAccessNotice title="역할 이력" />}
          <ScimProviderPanel />
        </>
      )}

      {activeSection === "secrets" && (
        <>
          <SecurityConnectionsPanel />
          <SecretRefAuditPanel />
          {can("credential.manage") ? <ConcurrencyPolicyPanel /> : <SectionAccessNotice title="Credential 운영" />}
        </>
      )}

      {activeSection === "ai" && (
        can("ai_governance.read") ? (
          <>
            <AiGovernanceRuntimePolicyPanel />
            <AiGovernanceEvidencePanel />
          </>
        ) : (
          <SectionAccessNotice title="AI 거버넌스" />
        )
      )}

      {activeSection === "infra" && (
        can("worker_pool.manage") ? <WorkerPoolPanel /> : <SectionAccessNotice title="운영 인프라" />
      )}

      {activeSection === "offboarding" && (
        can("tenant_data.export") ? <OffboardingPanel /> : <SectionAccessNotice title="오프보딩" />
      )}

      {guideSite !== null && <CaptureGuide site={guideSite} onClose={() => setGuideSite(null)} />}
    </div>
  );
}
