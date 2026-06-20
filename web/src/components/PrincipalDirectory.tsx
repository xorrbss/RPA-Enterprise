import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type { PrincipalItem } from "../api/types";
import { ActionButton } from "./ActionButton";
import { errorLabel } from "./badges";

// 담당자 디렉터리 관리(admin=principal.manage) — api-surface §3 POST/PATCH/DELETE /v1/principals.
// 디렉터리 조회는 principal.read(viewer+)지만 본 관리 패널은 쓰기 권한이 있을 때만 노출(읽기전용 소음 회피).
// sub=배정값(PrincipalId, 불변), display_name=표시이름. source=jwt(로그인 자동)/manual(여기서 수동 등록).
const KEY = ["principals"];

export function PrincipalDirectory(): JSX.Element | null {
  const can = useCan();
  // 관리(쓰기) 권한이 없으면 패널 자체를 숨긴다 — 디렉터리 조회는 담당자 picker(HumanTasks)가 이미 소비한다.
  if (!can("principal.manage")) return null;
  return <PrincipalDirectoryPanel />;
}

function PrincipalDirectoryPanel(): JSX.Element {
  const api = useApiClient();
  const list = useQuery({ queryKey: KEY, queryFn: () => api.listPrincipals({ limit: 200 }), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  return (
    <section className="panel" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong>담당자 디렉터리</strong>
        <span className="subtle">이름으로 배정할 담당자 목록 — 미로그인 담당자를 사전 등록할 수 있습니다.</span>
      </div>
      <PrincipalCreateForm />
      {items.length === 0 ? (
        <p className="subtle" style={{ marginTop: 10 }}>등록된 담당자가 없습니다. 로그인한 사용자는 자동 등록되며, 위에서 수동으로 추가할 수 있습니다.</p>
      ) : (
        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>이름</th><th>식별자(sub)</th><th>이메일</th><th>출처</th><th>작업</th></tr>
          </thead>
          <tbody>
            {items.map((p) =>
              editing === p.principal_id ? (
                <PrincipalEditRow key={p.principal_id} principal={p} onDone={() => setEditing(null)} />
              ) : (
                <tr key={p.principal_id}>
                  <td>{p.display_name}</td>
                  <td style={{ fontFamily: "monospace" }}>{p.sub}</td>
                  <td>{p.email ?? <span className="subtle">—</span>}</td>
                  <td><span className={`badge ${p.source === "manual" ? "" : "green"}`}>{p.source === "manual" ? "수동" : "자동"}</span></td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 8 }}>
                      <button className="btn" type="button" onClick={() => setEditing(p.principal_id)}>수정</button>
                      <ActionButton
                        label="삭제"
                        action="principal.manage"
                        confirmText={`'${p.display_name}'을(를) 디렉터리에서 삭제할까요? 기존 배정에는 영향이 없습니다.`}
                        run={(key) => api.deletePrincipal(p.principal_id, key)}
                        invalidateKeys={[KEY]}
                      />
                    </span>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PrincipalCreateForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createPrincipal(
        { sub: sub.trim(), display_name: name.trim(), ...(email.trim() !== "" ? { email: email.trim() } : {}) },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "담당자 등록됨" });
      setSub(""); setName(""); setEmail(""); setOpen(false);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const invalid = sub.trim() === "" || name.trim() === "";
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((o) => !o); }}>
          {open ? "닫기" : "+ 담당자 등록"}
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </div>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 480 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">식별자(sub) — JWT subject. 로그인 ID와 동일</span>
            <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="예: auth0|abc123" style={{ fontFamily: "monospace" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">이름(표시명)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 홍길동" />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">이메일 (선택)</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="예: hong@company.com" />
          </label>
          <div>
            <button className="btn primary" type="button" disabled={invalid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "등록 중…" : "등록"}
            </button>
            {invalid && <span className="subtle" style={{ marginLeft: 8 }}>식별자(sub)와 이름을 입력하세요.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function PrincipalEditRow({ principal, onDone }: { principal: PrincipalItem; onDone: () => void }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [name, setName] = useState(principal.display_name);
  const [email, setEmail] = useState(principal.email ?? "");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    // email은 빈 값이면 null(제거)로 보낸다 — 백엔드가 null=제거로 해석(조용한 무시 금지).
    mutationFn: () => api.updatePrincipal(principal.principal_id, { display_name: name.trim(), email: email.trim() === "" ? null : email.trim() }, crypto.randomUUID()),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); onDone(); },
    onError: (e) => setErr(errorLabel(e)),
  });

  return (
    <tr>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td style={{ fontFamily: "monospace" }}>{principal.sub}</td>
      <td><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="(비우면 제거)" /></td>
      <td><span className={`badge ${principal.source === "manual" ? "" : "green"}`}>{principal.source === "manual" ? "수동" : "자동"}</span></td>
      <td>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <button className="btn primary" type="button" disabled={name.trim() === "" || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "저장 중…" : "저장"}
          </button>
          <button className="btn" type="button" onClick={onDone}>취소</button>
          {err !== null && <span className="badge red">{err}</span>}
        </span>
      </td>
    </tr>
  );
}
