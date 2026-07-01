import { useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import { mergeParams, useHashParam } from "../router";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { CaptureGuide } from "../components/CaptureGuide";
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

type SecuritySectionKey = "sites" | "access" | "secrets" | "ai" | "infra";

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
];

function isSecuritySection(value: string | null): value is SecuritySectionKey {
  return value === "sites" || value === "access" || value === "secrets" || value === "ai" || value === "infra";
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

export function SecurityView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const [guideSite, setGuideSite] = useState<SiteItem | null>(null);
  const lv = useListView<SiteItem>(["sites"], (p) => api.listSites(p), { refetchInterval: 10_000 });
  const sites = lv.query.data?.items ?? [];
  // 사이트 서킷 차단 안내: 로드된 목록에서 circuit_status='open'(차단) 건수만 센다(실 필드 기반, 데이터 창작 금지).
  const circuitOpenCount = sites.filter((s) => s.circuit_status === "open").length;
  // 실행 패널 '세션 등록하러 가기' 딥링크(#security?site=<id>)로 들어오면 해당 사이트 세션 등록을 상단에 직행 노출.
  const explicitSection = useHashParam("section");
  const focusSiteId = useHashParam("site");
  const focusPrincipalId = useHashParam("principal");
  const focus = useHashParam("focus");
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
          {can("site.create") ? <SiteCreateForm /> : <SectionAccessNotice title="사이트 등록" />}
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
              { header: "승인", render: (r) => <StatusBadge status={r.approval_status} /> },
              { header: "자동 차단", render: (r) => <StatusBadge status={r.circuit_status} kind="circuit" /> },
              {
                header: "작업",
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
                        <span className={`badge ${r.session_ready === true ? "green" : "amber"}`}>
                          {r.session_ready === true ? "세션 등록됨" : "세션 미등록"}
                        </span>
                      )}
                      {r.login_capable === true && (
                        <ActionButton
                          label="세션 등록"
                          action="session.capture"
                          confirmText={`${label}에 로그인 창을 엽니다. 창에서 직접 로그인하시면 세션이 저장되어 이후 자동 실행이 재사용합니다.`}
                          run={(key) => api.captureSession(r.site_profile_id, key)}
                          invalidateKeys={[["sites"], ["capture-sessions", r.site_profile_id]]}
                        />
                      )}
                      {r.login_capable === true && can("session.capture") && (
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

      {guideSite !== null && <CaptureGuide site={guideSite} onClose={() => setGuideSite(null)} />}
    </div>
  );
}
