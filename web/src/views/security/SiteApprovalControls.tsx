import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import type { SiteItem } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { errorLabel } from "../../components/badges";

// 고위험 사이트 승인 컨트롤(A3-3/A3-7): 사유·만료 입력 승인 다이얼로그 + 승인 이력 열람.
// - 만료(expires_at)는 datetime-local 입력을 UTC ISO로 변환해 전송(서버 로컬 TZ 해석 어긋남 방지).
// - 만료 경과(approval_status=expired) 사이트는 런타임이 다시 차단하므로 '재승인' 버튼을 노출.
// - 이력은 site_profile_approvals 불변 원장(GET /v1/sites/{id}/approvals) — 누가/언제/왜/만료.
const dateTimeText = (iso: string): string => new Date(iso).toLocaleString();

export function SiteApprovalControls({ site }: { readonly site: SiteItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [approving, setApproving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expiresLocal, setExpiresLocal] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const needsApproval = site.approval_status === "pending" || site.approval_status === "expired";
  const canApprove = can("site.approve") && needsApproval;
  const hasHistory = site.approval_status !== "pending";

  const mut = useMutation({
    mutationFn: () =>
      api.approveSite(site.site_profile_id, crypto.randomUUID(), {
        ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
        ...(expiresLocal !== "" ? { expires_at: new Date(expiresLocal).toISOString() } : {}),
      }),
    onSuccess: () => {
      setMsg({ tone: "green", text: "승인됨" });
      void qc.invalidateQueries({ queryKey: ["sites"] });
      void qc.invalidateQueries({ queryKey: ["site-approvals", site.site_profile_id] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const history = useQuery({
    queryKey: ["site-approvals", site.site_profile_id],
    queryFn: () => api.listSiteApprovals(site.site_profile_id),
    enabled: historyOpen,
  });

  // 과거 만료 시각은 승인 즉시 다시 차단되는 자기모순 입력 — 다이얼로그에서 선차단.
  const expiresInPast = expiresLocal !== "" && new Date(expiresLocal).getTime() <= Date.now();

  if (!canApprove && !hasHistory) return null;
  const label = site.name ?? "사이트명 미정";

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {canApprove && (
        <button
          className="btn"
          type="button"
          disabled={mut.isPending}
          onClick={() => {
            setReason("");
            setExpiresLocal("");
            setApproving(true);
          }}
        >
          {mut.isPending ? "처리 중…" : site.approval_status === "expired" ? "재승인" : "승인"}
        </button>
      )}
      {hasHistory && (
        <button className="btn" type="button" onClick={() => setHistoryOpen(true)}>
          승인 이력
        </button>
      )}
      {msg !== null && (
        <span className={`badge ${msg.tone}`} role={msg.tone === "green" ? "status" : "alert"}>
          {msg.text}
        </span>
      )}
      {approving && (
        <ConfirmDialog
          title={
            site.approval_status === "expired"
              ? `${label} 사이트의 승인이 만료되어 실행이 다시 차단되었습니다. 재승인할까요?`
              : `${label} 고위험 사이트의 실행 차단을 해제하고 승인할까요? 승인 후 이 사이트 자동화를 실행할 수 있습니다.`
          }
          confirmLabel="승인"
          confirmDisabled={expiresInPast}
          onCancel={() => setApproving(false)}
          onConfirm={() => {
            setApproving(false);
            mut.mutate();
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span className="label">승인 사유 (선택)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 보안 검토 완료" autoFocus />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="label">승인 만료 시각 (선택 — 지나면 실행이 다시 차단됩니다)</span>
            <input type="datetime-local" value={expiresLocal} onChange={(e) => setExpiresLocal(e.target.value)} />
            {expiresInPast && (
              <span className="badge red" role="alert">
                만료 시각이 이미 지났습니다 — 미래 시각을 선택하세요.
              </span>
            )}
          </label>
        </ConfirmDialog>
      )}
      {historyOpen && (
        <ConfirmDialog
          title={`${label} 승인 이력`}
          hideConfirm
          cancelLabel="닫기"
          onConfirm={() => setHistoryOpen(false)}
          onCancel={() => setHistoryOpen(false)}
        >
          {history.isLoading && <p style={{ margin: 0 }}>불러오는 중…</p>}
          {history.isError && (
            <span className="badge red" role="alert">
              {errorLabel(history.error)}
            </span>
          )}
          {history.data !== undefined &&
            (history.data.items.length === 0 ? (
              <p style={{ margin: 0 }}>기록된 승인 이력이 없습니다.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, maxHeight: 280, overflowY: "auto" }}>
                {history.data.items.map((h) => (
                  <li key={`${h.created_at}-${h.approved_by}`}>
                    <div>
                      <strong>{h.approved_by}</strong> · {dateTimeText(h.created_at)}
                    </div>
                    <div style={{ color: "var(--muted, #667085)" }}>
                      {h.reason !== null && h.reason !== "" ? `사유: ${h.reason}` : "사유 미입력"}
                      {" · "}
                      {h.expires_at !== null ? `만료: ${dateTimeText(h.expires_at)}` : "만료 없음(상시)"}
                    </div>
                  </li>
                ))}
              </ul>
            ))}
        </ConfirmDialog>
      )}
    </span>
  );
}
