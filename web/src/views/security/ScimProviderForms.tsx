import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { ScimProviderItem, ScimProviderSecretRotationPolicy } from "../../api/types";
import { errorLabel } from "../../components/badges";
import {
  DEFAULT_SECRET_ROTATION_POLICY,
  PROVIDERS_KEY,
  SECRET_ROTATION_POLICIES,
  formatProviderTime,
  isProviderDecommissioned,
  mappingKey,
  rotationStatusLabel,
  rotationStatusTone,
  secretRotationPolicyLabel,
} from "./scim-labels";

export function ScimProviderCreateForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [providerKey, setProviderKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [rotationPolicy, setRotationPolicy] = useState<ScimProviderSecretRotationPolicy>(DEFAULT_SECRET_ROTATION_POLICY);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createScimProvider(
        {
          provider_key: providerKey.trim(),
          display_name: displayName.trim(),
          signature_secret_ref: secretRef.trim(),
          secret_rotation_policy: rotationPolicy,
          clock_skew_seconds: 300,
        },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "SCIM 연결이 등록되었습니다." });
      setProviderKey("");
      setDisplayName("");
      setSecretRef("");
      setRotationPolicy(DEFAULT_SECRET_ROTATION_POLICY);
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  const invalid = providerKey.trim() === "" || displayName.trim() === "" || secretRef.trim() === "";
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 1080 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(160px, 1fr) minmax(240px, 2fr) minmax(150px, 1fr) auto", gap: 8, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">연결 키 <span aria-hidden="true">(provider_key)</span></span>
          <input value={providerKey} onChange={(e) => setProviderKey(e.target.value)} placeholder="okta" />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">표시 이름</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Okta" />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">서명 SecretRef</span>
          <input value={secretRef} onChange={(e) => setSecretRef(e.target.value)} placeholder="secret://tenant/scim/okta/signing" />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">키 교체 주기</span>
          <select
            aria-label="새 SCIM 연결의 키 교체 주기"
            value={rotationPolicy}
            onChange={(e) => setRotationPolicy(e.target.value as ScimProviderSecretRotationPolicy)}
          >
            {SECRET_ROTATION_POLICIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <button
          aria-label="SCIM 연결 등록"
          className="btn primary"
          title="SCIM 연결 등록"
          type="button"
          disabled={invalid || create.isPending}
          onClick={() => create.mutate()}
        >
          등록
        </button>
      </div>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
    </div>
  );
}

export function ScimProviderEvidence({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const hasRotation = provider.last_secret_rotated_at !== null;
  const hasDecommission = provider.decommissioned_at !== null;
  const rotationStatus: ScimProviderItem["rotation_status"] = hasDecommission ? "decommissioned" : provider.rotation_status;
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 220 }}>
      <div>
        <span className={`badge ${rotationStatusTone(rotationStatus)}`}>
          서명 키 교체: {rotationStatusLabel(rotationStatus)}
        </span>
        <div className="subtle" style={{ fontSize: 11 }}>
          주기: {secretRotationPolicyLabel(provider.secret_rotation_policy)} / 다음 교체: {formatProviderTime(provider.rotation_due_at)}
        </div>
      </div>
      {hasRotation && (
        <div>
          <span className="badge blue">서명 경로 교체 완료</span>
          <div className="subtle" style={{ fontSize: 11 }}>
            {formatProviderTime(provider.last_secret_rotated_at)} / {provider.last_secret_rotated_by ?? "-"}
          </div>
        </div>
      )}
      {hasDecommission && (
        <div>
          <span className="badge red">연결 사용 중지</span>
          <div className="subtle" style={{ fontSize: 11 }}>
            {formatProviderTime(provider.decommissioned_at)} / {provider.decommissioned_by ?? "-"}
          </div>
          {provider.decommission_reason !== null && provider.decommission_reason.trim() !== "" && (
            <div className="subtle" style={{ fontSize: 11 }}>
              사유: {provider.decommission_reason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ScimProviderActions({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const decommissioned = isProviderDecommissioned(provider);
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 260 }}>
      <ScimProviderStatusButton provider={provider} />
      {!decommissioned && <ScimSecretRotationPolicyForm provider={provider} />}
      {!decommissioned && <ScimSecretRefRotateForm provider={provider} />}
      <ScimProviderDecommissionForm provider={provider} />
    </div>
  );
}

function ScimSecretRotationPolicyForm({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [policy, setPolicy] = useState<ScimProviderSecretRotationPolicy>(provider.secret_rotation_policy);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  useEffect(() => {
    setPolicy(provider.secret_rotation_policy);
  }, [provider.secret_rotation_policy]);
  const update = useMutation({
    mutationFn: () =>
      api.updateScimProvider(
        provider.provider_key,
        { secret_rotation_policy: policy },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "키 교체 주기가 저장되었습니다." });
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1fr) auto", gap: 6, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">키 교체 주기</span>
          <select
            aria-label={`${provider.provider_key} 키 교체 주기`}
            value={policy}
            disabled={update.isPending}
            onChange={(e) => {
              setMsg(null);
              setPolicy(e.target.value as ScimProviderSecretRotationPolicy);
            }}
          >
            {SECRET_ROTATION_POLICIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <button
          className="btn"
          type="button"
          aria-label={`${provider.provider_key} 키 교체 주기 저장`}
          disabled={policy === provider.secret_rotation_policy || update.isPending}
          onClick={() => update.mutate()}
        >
          저장
        </button>
      </div>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
    </div>
  );
}

function ScimProviderStatusButton({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const next = provider.status === "active" ? "disabled" : "active";
  const update = useMutation({
    mutationFn: () => api.updateScimProvider(provider.provider_key, { status: next }, crypto.randomUUID()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PROVIDERS_KEY }),
  });
  if (isProviderDecommissioned(provider)) {
    return (
      <button className="btn" type="button" disabled aria-label={`${provider.provider_key} 상태는 사용 중지되어 잠김`}>
        사용 중지됨
      </button>
    );
  }
  return (
    <button
      className="btn"
      type="button"
      aria-label={`${provider.provider_key} ${next === "disabled" ? "비활성화" : "활성화"}`}
      disabled={update.isPending}
      onClick={() => update.mutate()}
    >
      {next === "disabled" ? "비활성" : "활성"}
    </button>
  );
}

function ScimSecretRefRotateForm({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [secretRef, setSecretRef] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const decommissioned = isProviderDecommissioned(provider);
  const rotate = useMutation({
    mutationFn: () =>
      api.updateScimProvider(
        provider.provider_key,
        { signature_secret_ref: secretRef.trim() },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "서명 SecretRef가 교체되었습니다." });
      setSecretRef("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  const trimmed = secretRef.trim();
  const invalid = trimmed === "" || trimmed === provider.signature_secret_ref;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn"
          type="button"
          aria-label={`${provider.provider_key} 서명 SecretRef 바꾸기`}
          disabled={decommissioned || rotate.isPending}
          onClick={() => {
            setMsg(null);
            setOpen((value) => !value);
          }}
        >
          서명 SecretRef 바꾸기
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </span>
      {open && (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            aria-label={`${provider.provider_key} 새 서명 SecretRef`}
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
            placeholder="secret://tenant/scim/provider/signing-v2"
            style={{ fontFamily: "monospace" }}
          />
          <button
            className="btn primary"
            type="button"
            aria-label={`${provider.provider_key} 서명 SecretRef 교체 확정`}
            disabled={invalid || rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            교체 확정
          </button>
        </div>
      )}
    </div>
  );
}

function ScimProviderDecommissionForm({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const decommissioned = isProviderDecommissioned(provider);
  const decommission = useMutation({
    mutationFn: () =>
      api.decommissionScimProvider(
        provider.provider_key,
        { reason: reason.trim() },
        crypto.randomUUID(),
      ),
    onSuccess: (result) => {
      setMsg({
        tone: "green",
        text: `연결 사용 중지: 그룹 연결 ${result.disabled_mappings}개 비활성, 역할 부여 ${result.revoked_assignments}개 회수`,
      });
      setReason("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      void qc.invalidateQueries({ queryKey: mappingKey(provider.provider_key) });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  const invalid = reason.trim() === "";
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn"
          type="button"
          aria-label={`${provider.provider_key} 연결 사용 중지`}
          disabled={decommissioned || decommission.isPending}
          onClick={() => {
            setMsg(null);
            setOpen((value) => !value);
          }}
        >
          연결 사용 중지
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </span>
      {open && (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            aria-label={`${provider.provider_key} 사용 중지 사유`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="사용 중지 사유"
          />
          <button
            className="btn primary"
            type="button"
            aria-label={`${provider.provider_key} 사용 중지 확정`}
            disabled={invalid || decommission.isPending}
            onClick={() => decommission.mutate()}
          >
            사용 중지 확정
          </button>
        </div>
      )}
    </div>
  );
}
