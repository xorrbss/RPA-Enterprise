import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { SiteCreateForm } from "../components/SiteCreateForm";
import { SiteNameEditor } from "../components/SiteNameEditor";
import { StatusBadge } from "../components/badges";
import { SITE_RISKS } from "./filters";
import type { SiteItem } from "../api/types";

export function SecurityView(): JSX.Element {
  const api = useApiClient();
  const lv = useListView<SiteItem>(["sites"], (p) => api.listSites(p), { refetchInterval: 10_000 });
  return (
    <>
    <SiteCreateForm />
    <QueryPanel<SiteItem>
      title="사이트 접근 정책"
      query={lv.query}
      pager={lv.pager}
      actions={<FilterSelect label="위험도" value={lv.filter.risk} options={SITE_RISKS} onChange={(v) => lv.setFilter({ risk: v })} />}
      rowKey={(r) => r.site_profile_id}
      emptyMessage="조건에 맞는 사이트 프로파일이 없습니다."
      columns={[
        { header: "사이트", render: (r) => <SiteNameEditor site={r} /> },
        { header: "위험도", render: (r) => <StatusBadge status={r.risk} /> },
        { header: "승인", render: (r) => <StatusBadge status={r.approval_status} /> },
        { header: "서킷", render: (r) => <StatusBadge status={r.circuit_status} kind="circuit" /> },
        {
          header: "작업",
          // 승인(검토 대기 사이트)·세션 등록(로그인 URL 설정 사이트)은 상호배타가 아니다 — 각각 독립 노출.
          // 검토 대기인 green 사이트도 세션 등록 가능(승인 게이트는 red 사이트 실행 차단 전용, 서버가 강제).
          render: (r) => {
            const label = r.name ?? r.site_profile_id.slice(0, 8);
            return (
              <span style={{ display: "inline-flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {r.approval_status === "pending" && (
                  <ActionButton
                    label="승인"
                    action="site.approve"
                    confirmText={`${label} (위험도 ${r.risk})을(를) 실행 승인할까요? risk=red 사이트의 실행 차단(SITE_PROFILE_BLOCKED)이 해제됩니다.`}
                    run={(key) => api.approveSite(r.site_profile_id, key)}
                    invalidateKeys={[["sites"]]}
                  />
                )}
                {r.login_capable === true && (
                  // 운영자-보조 세션 등록: 로그인창(headful)을 띄워 운영자가 직접 로그인 → 세션 저장(이후 자동 실행이 재사용).
                  // login_capable(=loginUrl 설정) 사이트만 노출 — 미설정 사이트의 412 클릭을 사전에 차단.
                  <ActionButton
                    label="세션 등록"
                    action="session.capture"
                    confirmText={`${label}에 로그인 창을 엽니다. 창에서 직접 로그인하시면 세션이 저장되어 이후 자동 실행이 재사용합니다.`}
                    run={(key) => api.captureSession(r.site_profile_id, key)}
                    invalidateKeys={[["capture-sessions", r.site_profile_id]]}
                  />
                )}
              </span>
            );
          },
        },
      ]}
    />
    </>
  );
}
