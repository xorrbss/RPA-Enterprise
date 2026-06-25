import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { ActionButton } from "../../components/ActionButton";
import { errorLabel } from "../../components/badges";

// 자격증명 동시성 정책 가시화(D5) + 참조 등록/삭제(DG-4). 사이트·자격증명별 max_concurrency 와 현재 사용
// 슬롯(active_leases). credential.manage(admin)만 등록/삭제. ⛔ 시크릿 값은 다루지 않는다 — SecretRef 경로
// 식별자 + 한도만(값은 Vault/KMS out-of-band). ops_alert.read 게이트는 SecurityView 에서 적용.
export function ConcurrencyPolicyPanel(): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const q = useQuery({
    queryKey: ["concurrency-policies"],
    queryFn: () => api.listConcurrencyPolicies(),
    refetchInterval: 15_000,
  });
  const canManage = can("credential.manage");
  if (q.isLoading || q.data === undefined) return null;
  const items = q.data.items;
  return (
    <section className="panel" aria-label="자격증명 동시성 정책" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>자격증명 동시성 정책</h2>
        <span className="badge blue">{items.length}개 정책</span>
      </div>
      <p className="subtle">
        사이트·자격증명별 동시 실행 한도와 현재 사용 중인 슬롯입니다. 정책이 없으면 기본 동시성 1이 적용됩니다.
      </p>
      {canManage && <CredentialRegisterForm />}
      {items.length === 0 ? (
        <p className="subtle">설정된 동시성 정책이 없습니다(모든 자격증명에 기본 동시성 1 적용).</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">사이트</th>
                <th scope="col">자격증명</th>
                <th scope="col">최대 동시 실행</th>
                <th scope="col">현재 사용</th>
                <th scope="col">여유</th>
                {canManage && <th scope="col">관리</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const free = p.max_concurrency - p.active_leases;
                const saturated = free <= 0;
                return (
                  <tr key={`${p.credential_ref}:${p.site_profile_id}`}>
                    <td>{p.site_name ?? <code className="subtle">{p.site_profile_id}</code>}</td>
                    <td>
                      {p.label != null && p.label !== "" && <div>{p.label}</div>}
                      <code className="subtle">{p.credential_ref}</code>
                      {p.registered_by != null && (
                        <div className="subtle" style={{ fontSize: 11 }}>
                          등록: {p.registered_by}
                          {p.registered_at != null ? ` · ${p.registered_at.slice(0, 10)}` : ""}
                        </div>
                      )}
                    </td>
                    <td>{p.max_concurrency}</td>
                    <td>{p.active_leases}</td>
                    <td>
                      <span className={`badge ${saturated ? "amber" : "green"}`}>
                        {saturated ? "포화" : `${free} 여유`}
                      </span>
                    </td>
                    {canManage && (
                      <td>
                        <ActionButton
                          label="삭제"
                          confirmText="이 자격증명 바인딩을 삭제할까요? (Vault 값은 그대로 유지됩니다)"
                          action="credential.manage"
                          successText="삭제됨"
                          invalidateKeys={[["concurrency-policies"]]}
                          run={(key) => api.deleteCredentialBinding(p.credential_ref, p.site_profile_id, key)}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// 자격증명 *참조* 등록 폼(DG-4) — credential.manage(admin). ⛔ 값 입력란 없음: SecretRef 경로 + 사이트 + 한도만.
function CredentialRegisterForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [credentialRef, setCredentialRef] = useState("");
  const [siteId, setSiteId] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const sites = useQuery({
    queryKey: ["sites", "for-credential-register"],
    queryFn: () => api.listSites({ limit: 200 }),
    enabled: open,
  });

  const register = useMutation({
    mutationFn: () =>
      api.registerCredentialBinding(
        {
          credential_ref: credentialRef.trim(),
          site_profile_id: siteId,
          max_concurrency: Math.max(1, Math.floor(maxConcurrency)),
          ...(label.trim() !== "" ? { label: label.trim() } : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "등록됨" });
      setCredentialRef("");
      setSiteId("");
      setMaxConcurrency(1);
      setLabel("");
      void qc.invalidateQueries({ queryKey: ["concurrency-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const refTrim = credentialRef.trim();
  const refLooksValid = refTrim.startsWith("rpa/") && refTrim.split("/").length >= 5 && !refTrim.includes("%");
  const invalid = !refLooksValid || siteId === "" || !(maxConcurrency >= 1);

  return (
    <section className="panel" style={{ padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>자격증명 참조 등록</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
          <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((v) => !v); }}>
            {open ? "닫기" : "참조 등록"}
          </button>
        </span>
      </div>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 560 }}>
          <p className="subtle" style={{ margin: 0 }}>
            ⛔ 비밀번호 등 <strong>값은 여기에 입력하지 않습니다.</strong> 값은 Vault/KMS에 운영자가 직접 넣고,
            콘솔에서는 그 값을 가리키는 <strong>경로(참조)</strong>와 동시 실행 한도만 등록합니다.
          </p>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">자격증명 경로 (SecretRef)</span>
            <input
              value={credentialRef}
              onChange={(e) => setCredentialRef(e.target.value)}
              placeholder="예: rpa/prod/runtime-worker/executor/hiworks_password"
              style={{ fontFamily: "monospace" }}
            />
            <span className="subtle">형식: rpa/&lt;환경&gt;/runtime-worker/executor/&lt;이름&gt;</span>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">사이트</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">사이트 선택…</option>
              {(sites.data?.items ?? []).map((s) => (
                <option key={s.site_profile_id} value={s.site_profile_id}>
                  {s.name ?? s.site_profile_id}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">최대 동시 실행</span>
            <input
              type="number"
              min={1}
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(Number(e.target.value))}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">표시명 (선택)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 하이웍스 운영 계정" />
          </label>
          <div>
            <button className="btn primary" type="button" disabled={invalid || register.isPending} onClick={() => register.mutate()}>
              {register.isPending ? "등록 중…" : "등록"}
            </button>
            {invalid && (
              <span className="subtle" style={{ marginLeft: 8 }}>
                rpa/…/executor/… 형식의 경로와 사이트, 1 이상의 한도를 입력하세요.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
