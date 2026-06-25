import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ROLE_LABELS, useCan } from "../api/permissions";
import { QueryPanel } from "./QueryPanel";
import { errorLabel } from "./badges";
import type { PrincipalItem, RoleAssignmentItem, RoleAssignmentRole } from "../api/types";

const ROLES: readonly RoleAssignmentRole[] = ["viewer", "operator", "reviewer", "approver", "admin"];

export function RoleAssignmentPanel(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const principals = useQuery({ queryKey: ["principals"], queryFn: () => api.listPrincipals({ limit: 100 }) });
  const assignments = useQuery({ queryKey: ["role-assignments"], queryFn: () => api.listRoleAssignments({ limit: 100 }) });
  const principalItems = principals.data?.items ?? [];
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<RoleAssignmentRole>("operator");
  const [reason, setReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("role review");
  const [message, setMessage] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const selectedPrincipal = useMemo(
    () => principalItems.find((p) => p.principal_id === principalId) ?? null,
    [principalItems, principalId],
  );
  const canGrant = can("rbac.grant");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["role-assignments"] });
    if (principalId !== "") void qc.invalidateQueries({ queryKey: ["principal-role-assignments", principalId] });
  };

  const grant = useMutation({
    mutationFn: () => api.grantPrincipalRole(principalId, { role, reason: reason.trim() || null }, crypto.randomUUID()),
    onSuccess: () => {
      setMessage({ tone: "green", text: "역할 부여 완료" });
      invalidate();
    },
    onError: (err) => setMessage({ tone: "red", text: errorLabel(err) }),
  });
  const revoke = useMutation({
    mutationFn: (assignmentId: string) => api.revokeRoleAssignment(assignmentId, revokeReason.trim() || "role review", crypto.randomUUID()),
    onSuccess: () => {
      setMessage({ tone: "green", text: "역할 회수 완료" });
      invalidate();
    },
    onError: (err) => setMessage({ tone: "red", text: errorLabel(err) }),
  });

  return (
    <>
    <section className="panel" style={{ marginBottom: 12, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>역할 부여</h2>
          <p className="subtle" style={{ margin: "4px 0 0" }}>토큰 역할과 수동 부여 역할은 합산되어 적용됩니다.</p>
        </div>
        {!canGrant && <span className="badge muted">읽기 전용</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginTop: 12, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="label">대상</span>
          <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)} disabled={!canGrant}>
            <option value="">선택</option>
            {principalItems.map((p) => (
              <option key={p.principal_id} value={p.principal_id}>
                {principalLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="label">역할</span>
          <select value={role} onChange={(event) => setRole(event.target.value as RoleAssignmentRole)} disabled={!canGrant}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="label">사유</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canGrant} />
        </label>
        <button
          className="btn"
          type="button"
          disabled={!canGrant || selectedPrincipal === null || grant.isPending}
          onClick={() => grant.mutate()}
        >
          {grant.isPending ? "처리 중…" : "부여"}
        </button>
      </div>
      <label style={{ display: "grid", gap: 4, maxWidth: 360, marginTop: 8 }}>
        <span className="label">회수 사유</span>
        <input value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} disabled={!canGrant} />
      </label>
      {message !== null && <p className={`badge ${message.tone}`} role={message.tone === "red" ? "alert" : "status"}>{message.text}</p>}
    </section>
      <QueryPanel<RoleAssignmentItem>
        title="역할 이력"
        query={assignments}
        rowKey={(r) => r.assignment_id}
        emptyMessage="수동 역할 부여 이력이 없습니다."
        columns={[
          { header: "대상", render: (r) => <code className="subtle">{r.principal_sub}</code> },
          { header: "역할", render: (r) => ROLE_LABELS[r.role] ?? r.role },
          { header: "상태", render: (r) => <span className={`badge ${r.status === "active" ? "green" : "muted"}`}>{r.status === "active" ? "활성" : "회수됨"}</span> },
          { header: "부여자", render: (r) => <code className="subtle">{r.granted_by}</code> },
          { header: "부여", render: (r) => new Date(r.granted_at).toLocaleString() },
          {
            header: "작업",
            render: (r) => (
              <button
                className="btn"
                type="button"
                disabled={!canGrant || r.status !== "active" || revoke.isPending}
                onClick={() => revoke.mutate(r.assignment_id)}
              >
                회수
              </button>
            ),
          },
        ]}
      />
    </>
  );
}

function principalLabel(p: PrincipalItem): string {
  return `${p.display_name} (${p.sub})`;
}
