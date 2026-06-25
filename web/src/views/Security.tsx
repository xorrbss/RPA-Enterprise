import { useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import { useHashParam } from "../router";
import { useCan } from "../api/permissions";
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
import type { SiteItem } from "../api/types";
import { AuthReadinessPanel } from "./security/AuthReadinessPanel";
import { RbacMatrixPanel } from "./security/RbacMatrixPanel";
import { ConcurrencyPolicyPanel } from "./security/ConcurrencyPolicyPanel";
import { WorkerPoolPanel } from "./security/WorkerPoolPanel";
import { SecurityConnectionsPanel } from "./security/SecurityConnectionsPanel";
import { SecretRefAuditPanel } from "./security/SecretRefAuditPanel";
import { SessionCaptureStatus } from "./security/SessionCaptureStatus";
import { SessionRenewalQueue, collectSessionRenewalQueue } from "./security/SessionRenewalQueue";

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
    {can("ops_alert.read") && <ConcurrencyPolicyPanel />}
    {can("worker_pool.manage") && <WorkerPoolPanel />}
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
