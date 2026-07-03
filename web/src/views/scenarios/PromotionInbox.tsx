import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ActionButton } from "../../components/ActionButton";

// approver 운영 기준 인박스(maker-checker, D4) — pending 운영 기준 요청을 승인/반려. 요청자≠승인자는 백엔드가 강제(SoD).
export function PromotionInbox(): JSX.Element | null {
  const api = useApiClient();
  const inbox = useQuery({ queryKey: ["promotion-requests"], queryFn: () => api.listPromotionRequests(), refetchInterval: 15_000 });
  if (inbox.isLoading || inbox.data === undefined) return null;
  const items = inbox.data.items;
  return (
    <section
      aria-label="운영 기준 승인 대기"
      style={{ border: "1px solid var(--border, #e2e8f0)", borderRadius: 8, padding: 12, marginBottom: 12 }}
    >
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>운영 기준 승인 대기{items.length > 0 ? ` (${items.length})` : ""}</h2>
      <p className="subtle" style={{ margin: "0 0 8px" }}>
        운영자가 요청한 운영 기준 변경입니다. 요청자와 다른 승인자가 승인해야 실제로 적용됩니다.
      </p>
      {items.length === 0 ? (
        <p className="subtle" style={{ margin: 0 }}>대기 중인 운영 기준 요청이 없습니다.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {items.map((req) => (
            <li
              key={req.request_id}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <div>
                <strong>{req.scenario_name}</strong> <span className="badge muted">v{req.version}</span>
                <div className="subtle">요청자 {req.requested_by} · 사유: {req.reason}</div>
              </div>
              <span style={{ display: "inline-flex", gap: 6 }}>
                <ActionButton
                  label="승인"
                  action="scenario.promote.approve"
                  confirmText={`${req.scenario_name} v${req.version}을(를) 운영 기준으로 지정할까요? 요청자: ${req.requested_by}`}
                  run={(key) => api.decidePromotionRequest(req.scenario_id, req.request_id, "approve", undefined, key)}
                  invalidateKeys={[["promotion-requests"], ["scenarios"]]}
                  successText="승인됨"
                />
                <ActionButton
                  label="반려"
                  action="scenario.promote.approve"
                  inputLabel="반려 사유(선택)"
                  inputOptional={true}
                  confirmText={`${req.scenario_name} v${req.version} 운영 기준 요청을 반려할까요?`}
                  run={(key, reason) => api.decidePromotionRequest(req.scenario_id, req.request_id, "reject", reason, key)}
                  invalidateKeys={[["promotion-requests"]]}
                  successText="반려됨"
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
