import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { useHashParam } from "../../router";
import type { ConcurrencyPolicy } from "../../api/types";
import { ActionButton } from "../../components/ActionButton";
import { errorLabel } from "../../components/badges";

const ROTATION_POLICIES = [
  { value: "manual", label: "수동" },
  { value: "periodic_30d", label: "30일" },
  { value: "periodic_60d", label: "60일" },
  { value: "periodic_90d", label: "90일" },
] as const;

export function ConcurrencyPolicyPanel(): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const focusCredential = useHashParam("credential");
  const focusCredentialSite = useHashParam("credential_site");
  const focusRef = useRef<HTMLTableRowElement | null>(null);
  const q = useQuery({
    queryKey: ["concurrency-policies"],
    queryFn: () => api.listConcurrencyPolicies(),
    refetchInterval: 15_000,
  });
  const canManage = can("credential.manage");
  const items = q.data?.items ?? [];

  useEffect(() => {
    if (focusCredential !== null) focusRef.current?.scrollIntoView?.({ block: "center" });
  }, [focusCredential, focusCredentialSite, items.length]);

  if (q.isLoading || q.data === undefined) return null;

  return (
    <section className="panel" aria-label="자격증명 동시성 정책" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>Credential 운영</h2>
        <span className="badge blue">{items.length}개 정책</span>
      </div>
      <p className="subtle">
        SecretRef 경로, 사이트별 동시 실행 한도, 소유자, 회전 정책, 사용 이력을 관리합니다. 민감값은 콘솔에 입력하거나 표시하지 않습니다.
      </p>
      {canManage && <CredentialRegisterForm />}
      {items.length === 0 ? (
        <p className="subtle">설정된 Credential 정책이 없습니다. 정책이 없으면 런타임 기본 동시성 1이 적용됩니다.</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">사이트</th>
                <th scope="col">Credential</th>
                <th scope="col">상태</th>
                <th scope="col">한도</th>
                <th scope="col">사용</th>
                {canManage && <th scope="col">관리</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const status = p.status ?? "active";
                const free = p.max_concurrency - p.active_leases;
                const saturated = free <= 0;
                const focused =
                  focusCredential === p.credential_ref &&
                  (focusCredentialSite === null || focusCredentialSite === p.site_profile_id);
                return (
                  <tr
                    key={`${p.credential_ref}:${p.site_profile_id}`}
                    ref={focused ? focusRef : undefined}
                    aria-current={focused ? "true" : undefined}
                    style={focused ? { outline: "2px solid var(--accent, #2563eb)", outlineOffset: -2 } : undefined}
                  >
                    <td>{p.site_name ?? <code className="subtle">{p.site_profile_id}</code>}</td>
                    <td>
                      {p.label != null && p.label !== "" && <div>{p.label}</div>}
                      <code className="subtle">{p.credential_ref}</code>
                      <div className="subtle" style={{ fontSize: 11 }}>
                        소유자: {p.owner_sub ?? "-"} · 등록: {p.registered_by ?? "-"}
                        {p.registered_at != null ? ` · ${dateShort(p.registered_at)}` : ""}
                      </div>
                      <div className="subtle" style={{ fontSize: 11 }}>
                        회전: {rotationLabel(p.rotation_policy)} · 마지막 사용: {dateShort(p.last_used_at)}
                      </div>
                      {p.replaced_by_credential_ref != null && (
                        <div className="subtle" style={{ fontSize: 11 }}>
                          대체 ref: <code>{p.replaced_by_credential_ref}</code>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${statusTone(status)}`}>{statusLabel(status)}</span>
                    </td>
                    <td>{p.max_concurrency}</td>
                    <td>
                      <span className={`badge ${saturated ? "amber" : "green"}`}>
                        {p.active_leases} 사용 · {saturated ? "포화" : `${free} 여유`}
                      </span>
                    </td>
                    {canManage && (
                      <td>
                        <div style={{ display: "grid", gap: 8, minWidth: 240 }}>
                          <CredentialRotateForm policy={p} />
                          <ActionButton
                            label="폐기"
                            confirmText="이 Credential 참조를 폐기하시겠습니까? Secret 값은 Vault/KMS에 그대로 남고, 콘솔에서는 상태와 감사 이력만 갱신됩니다."
                            action="credential.manage"
                            inputLabel="폐기 사유"
                            inputOptional
                            disabled={status === "revoked" || p.active_leases > 0}
                            successText="폐기됨"
                            invalidateKeys={[["concurrency-policies"]]}
                            run={(key, reason) =>
                              api.decommissionCredentialBinding(
                                {
                                  credential_ref: p.credential_ref,
                                  site_profile_id: p.site_profile_id,
                                  ...(reason != null && reason.trim() !== "" ? { reason: reason.trim() } : {}),
                                },
                                key,
                              )
                            }
                          />
                        </div>
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

function CredentialRegisterForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [credentialRef, setCredentialRef] = useState("");
  const [siteId, setSiteId] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [label, setLabel] = useState("");
  const [ownerSub, setOwnerSub] = useState("");
  const [rotationPolicy, setRotationPolicy] = useState<(typeof ROTATION_POLICIES)[number]["value"]>("manual");
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
          ...(ownerSub.trim() !== "" ? { owner_sub: ownerSub.trim() } : {}),
          ...(rotationPolicy !== "manual" ? { rotation_policy: rotationPolicy } : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "등록됨" });
      setCredentialRef("");
      setSiteId("");
      setMaxConcurrency(1);
      setLabel("");
      setOwnerSub("");
      setRotationPolicy("manual");
      void qc.invalidateQueries({ queryKey: ["concurrency-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const refTrim = credentialRef.trim();
  const refLooksValid = looksLikeCredentialRef(refTrim);
  const invalid = !refLooksValid || siteId === "" || !(maxConcurrency >= 1);

  return (
    <section className="panel" style={{ padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>Credential 참조 등록</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
          <button
            className="btn"
            type="button"
            onClick={() => {
              setMsg(null);
              setOpen((v) => !v);
            }}
          >
            {open ? "닫기" : "참조 등록"}
          </button>
        </span>
      </div>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 680 }}>
          <p className="subtle" style={{ margin: 0 }}>
            비밀번호나 토큰 값은 입력하지 않습니다. Vault/KMS에 저장된 값을 가리키는 SecretRef 경로와 운영 메타데이터만 관리합니다.
          </p>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">Credential 경로 (SecretRef)</span>
            <input
              value={credentialRef}
              onChange={(e) => setCredentialRef(e.target.value)}
              placeholder="예: rpa/prod/runtime-worker/executor/hiworks_password"
              style={{ fontFamily: "monospace" }}
            />
            <span className="subtle">형식: rpa/&lt;env&gt;/runtime-worker/executor/&lt;name&gt;</span>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">사이트</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">사이트 선택</option>
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
            <span className="subtle">소유자 subject (선택)</span>
            <input value={ownerSub} onChange={(e) => setOwnerSub(e.target.value)} placeholder="예: rpa-ops-admin" />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">회전 정책</span>
            <select value={rotationPolicy} onChange={(e) => setRotationPolicy(e.target.value as typeof rotationPolicy)}>
              {ROTATION_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">표시명 (선택)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 하이웍스 운영 계정" />
          </label>
          <div>
            <button className="btn primary" type="button" disabled={invalid || register.isPending} onClick={() => register.mutate()}>
              {register.isPending ? "등록 중..." : "등록"}
            </button>
            {invalid && (
              <span className="subtle" style={{ marginLeft: 8 }}>
                executor purpose의 SecretRef 경로, 사이트, 1 이상의 한도를 입력하세요.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function CredentialRotateForm(props: { policy: ConcurrencyPolicy }): JSX.Element {
  const { policy } = props;
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newRef, setNewRef] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const status = policy.status ?? "active";
  const rotate = useMutation({
    mutationFn: () =>
      api.rotateCredentialBinding(
        {
          credential_ref: policy.credential_ref,
          new_credential_ref: newRef.trim(),
          site_profile_id: policy.site_profile_id,
          ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "회전됨" });
      setNewRef("");
      setReason("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["concurrency-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });
  const disabled = status !== "active" || policy.active_leases > 0;
  const invalid = !looksLikeCredentialRef(newRef.trim()) || newRef.trim() === policy.credential_ref;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn"
          type="button"
          disabled={disabled}
          onClick={() => {
            setMsg(null);
            setOpen((v) => !v);
          }}
        >
          회전
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </span>
      {open && (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            placeholder="새 SecretRef 경로"
            style={{ fontFamily: "monospace" }}
          />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="회전 사유 (선택)" />
          <button className="btn primary" type="button" disabled={invalid || rotate.isPending} onClick={() => rotate.mutate()}>
            {rotate.isPending ? "회전 중..." : "확인"}
          </button>
        </div>
      )}
    </div>
  );
}

function looksLikeCredentialRef(value: string): boolean {
  return value.startsWith("rpa/") && value.split("/").length >= 5 && !value.includes("%");
}

function dateShort(value: string | null | undefined): string {
  return value == null || value === "" ? "-" : value.slice(0, 10);
}

function rotationLabel(value: ConcurrencyPolicy["rotation_policy"]): string {
  return ROTATION_POLICIES.find((p) => p.value === (value ?? "manual"))?.label ?? "수동";
}

function statusLabel(status: NonNullable<ConcurrencyPolicy["status"]>): string {
  if (status === "active") return "활성";
  if (status === "deprecated") return "교체됨";
  return "폐기됨";
}

function statusTone(status: NonNullable<ConcurrencyPolicy["status"]>): "green" | "amber" | "red" {
  if (status === "active") return "green";
  if (status === "deprecated") return "amber";
  return "red";
}
