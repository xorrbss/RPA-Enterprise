import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import type {
  RoleAssignmentRole,
  ScimGroupRoleMappingImportBody,
  ScimGroupRoleMappingImportResult,
  ScimGroupRoleMappingItem,
  ScimProviderItem,
  ScimProviderSecretRotationPolicy,
} from "../../api/types";
import { errorLabel } from "../../components/badges";

const PROVIDERS_KEY = ["scim-providers"];
const ROLES = ["viewer", "operator", "reviewer", "approver", "admin"] as const;
const DEFAULT_SECRET_ROTATION_POLICY: ScimProviderSecretRotationPolicy = "periodic_90d";
const SECRET_ROTATION_POLICIES: readonly { readonly value: ScimProviderSecretRotationPolicy; readonly label: string }[] = [
  { value: "manual", label: "수동" },
  { value: "periodic_30d", label: "30일마다" },
  { value: "periodic_60d", label: "60일마다" },
  { value: "periodic_90d", label: "90일마다" },
];
const IMPORT_MODES: readonly { readonly value: ScimGroupRoleMappingImportBody["mode"]; readonly label: string }[] = [
  { value: "upsert_only", label: "추가/갱신만" },
  { value: "replace_active", label: "현재 목록 교체" },
];
const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  viewer: "보기 전용",
  operator: "운영자",
  reviewer: "검토자",
  approver: "승인자",
  admin: "관리자",
};

export function ScimProviderPanel(): JSX.Element | null {
  const can = useCan();
  if (!can("scim.sync")) return null;
  return <ScimProviderPanelInner />;
}

function ScimProviderPanelInner(): JSX.Element {
  const api = useApiClient();
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: () => api.listScimProviders(), refetchInterval: 15_000 });
  const items = providers.data?.items ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = useMemo(
    () => items.find((item) => item.provider_key === selectedKey) ?? items[0] ?? null,
    [items, selectedKey],
  );

  return (
    <section className="panel" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <strong>SCIM IdP 연결</strong>
        <span className="subtle">IdP 서명 경로와 외부 그룹 역할 연결을 관리합니다. 계약 키(provider_key)는 세부 정보에 보존됩니다.</span>
      </div>
      <ScimProviderCreateForm />
      {providers.isError && <p className="badge red">{errorLabel(providers.error)}</p>}
      {items.length === 0 ? (
        <p className="subtle" style={{ marginTop: 10 }}>등록된 SCIM 연결이 없습니다.</p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>연결</th>
                <th>상태</th>
                <th>서명 SecretRef</th>
                <th>허용 시계 차이</th>
                <th>근거</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {items.map((provider) => (
                <tr key={provider.provider_id} aria-current={selected?.provider_key === provider.provider_key ? "true" : undefined}>
                  <td>
                    <button className="link-button" type="button" onClick={() => setSelectedKey(provider.provider_key)}>
                      {provider.display_name}
                    </button>
                    <div className="subtle">{provider.provider_key}</div>
                  </td>
                  <td><span className={`badge ${providerStatusTone(provider)}`}>{providerStatusLabel(provider)}</span></td>
                  <td><code>{provider.signature_secret_ref}</code></td>
                  <td>{provider.clock_skew_seconds}초</td>
                  <td><ScimProviderEvidence provider={provider} /></td>
                  <td><ScimProviderActions provider={provider} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected !== null && <ScimMappingPanel provider={selected} />}
        </div>
      )}
    </section>
  );
}

function ScimProviderCreateForm(): JSX.Element {
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

function ScimProviderEvidence({ provider }: { provider: ScimProviderItem }): JSX.Element {
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

function ScimProviderActions({ provider }: { provider: ScimProviderItem }): JSX.Element {
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

function ScimMappingPanel({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const mappings = useQuery({
    queryKey: mappingKey(provider.provider_key),
    queryFn: () => api.listScimGroupRoleMappings(provider.provider_key),
  });
  const items = mappings.data?.items ?? [];
  const locked = isProviderDecommissioned(provider);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{provider.provider_key} 외부 그룹 역할 연결</strong>
        {locked && <span className="badge red">연결이 잠겨 변경할 수 없음</span>}
      </div>
      <ScimMappingCreateForm provider={provider} />
      <ScimMappingImportForm provider={provider} />
      {mappings.isError && <span className="badge red">{errorLabel(mappings.error)}</span>}
      {items.length === 0 ? (
        <p className="subtle">등록된 외부 그룹 연결이 없습니다.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>외부 그룹</th>
              <th>역할</th>
              <th>상태</th>
              <th>설명</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {items.map((mapping) => (
              <tr key={mapping.mapping_id}>
                <td>{mapping.external_group}</td>
                <td>{roleLabel(mapping.role)}</td>
                <td><span className={`badge ${mapping.status === "active" ? "green" : "amber"}`}>{mappingStatusLabel(mapping.status)}</span></td>
                <td>{mapping.description ?? <span className="subtle">-</span>}</td>
                <td><ScimMappingStatusButton provider={provider} mapping={mapping} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ScimMappingCreateForm({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const providerKey = provider.provider_key;
  const locked = isProviderDecommissioned(provider);
  const [externalGroup, setExternalGroup] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("viewer");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createScimGroupRoleMapping(
        providerKey,
        { external_group: externalGroup.trim(), role, description: description.trim() === "" ? null : description.trim() },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "외부 그룹 연결이 추가되었습니다." });
      setExternalGroup("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: mappingKey(providerKey) });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 2fr) minmax(120px, 1fr) minmax(180px, 2fr) auto", gap: 8, alignItems: "end" }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="subtle">외부 그룹 <span aria-hidden="true">(external_group)</span></span>
        <input
          value={externalGroup}
          onChange={(e) => setExternalGroup(e.target.value)}
          placeholder="grp-rpa-operators"
          disabled={locked}
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="subtle">부여할 역할</span>
        <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])} disabled={locked}>
          {ROLES.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="subtle">설명</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="선택 사항" disabled={locked} />
      </label>
      <button
        aria-label="SCIM 외부 그룹 연결 추가"
        className="btn"
        type="button"
        disabled={locked || externalGroup.trim() === "" || create.isPending}
        onClick={() => create.mutate()}
      >
        {locked ? "잠김" : "추가"}
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
    </div>
  );
}

function ScimMappingImportForm({ provider }: { provider: ScimProviderItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const providerKey = provider.provider_key;
  const locked = isProviderDecommissioned(provider);
  const [mode, setMode] = useState<ScimGroupRoleMappingImportBody["mode"]>("upsert_only");
  const [csv, setCsv] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const [result, setResult] = useState<ScimGroupRoleMappingImportResult | null>(null);
  const importMappings = useMutation({
    mutationFn: (body: ScimGroupRoleMappingImportBody) =>
      api.importScimGroupRoleMappings(providerKey, body, crypto.randomUUID()),
    onSuccess: (nextResult) => {
      setResult(nextResult);
      setMsg({ tone: "green", text: "외부 그룹 연결 가져오기가 완료되었습니다." });
      void qc.invalidateQueries({ queryKey: mappingKey(providerKey) });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  const runImport = (): void => {
    setResult(null);
    const parsed = parseScimMappingCsv(csv);
    if (!parsed.ok) {
      setMsg({ tone: "red", text: parsed.error });
      return;
    }
    setMsg(null);
    importMappings.mutate({ mode, mappings: parsed.mappings });
  };
  return (
    <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 180px) minmax(260px, 1fr) auto", gap: 8, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">가져오기 방식</span>
          <select
            aria-label={`${providerKey} 외부 그룹 가져오기 방식`}
            value={mode}
            disabled={locked || importMappings.isPending}
            onChange={(e) => setMode(e.target.value as ScimGroupRoleMappingImportBody["mode"])}
          >
            {IMPORT_MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">CSV로 그룹 연결 가져오기</span>
          <textarea
            aria-label={`${providerKey} 외부 그룹 연결 CSV`}
            value={csv}
            disabled={locked}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"external_group,role,description\ngrp-rpa-operators,operator,운영 그룹"}
            rows={3}
            style={{ fontFamily: "monospace", resize: "vertical" }}
          />
        </label>
        <button
          aria-label={`${providerKey} SCIM 외부 그룹 연결 가져오기`}
          className="btn"
          type="button"
          disabled={locked || csv.trim() === "" || importMappings.isPending}
          onClick={runImport}
        >
          {locked ? "잠김" : importMappings.isPending ? "가져오는 중" : "가져오기"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
        {result !== null && (
          <span aria-label={`${providerKey} 외부 그룹 가져오기 결과`} style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            <span className="badge blue">가져옴 {result.imported}</span>
            <span className="badge blue">업데이트 {result.updated}</span>
            <span className="badge blue">변경 없음 {result.unchanged}</span>
            <span className="badge amber">비활성 {result.disabled}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ScimMappingStatusButton({ provider, mapping }: { provider: ScimProviderItem; mapping: ScimGroupRoleMappingItem }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const next = mapping.status === "active" ? "disabled" : "active";
  const locked = isProviderDecommissioned(provider);
  const update = useMutation({
    mutationFn: () => api.updateScimGroupRoleMapping(mapping.provider_key, mapping.mapping_id, { status: next }, crypto.randomUUID()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mappingKey(mapping.provider_key) }),
  });
  return (
    <button
      aria-label={locked ? `${mapping.external_group} 외부 그룹 연결은 잠김` : undefined}
      className="btn"
      type="button"
      disabled={locked || update.isPending}
      onClick={() => update.mutate()}
    >
      {locked ? "잠김" : next === "disabled" ? "비활성" : "활성"}
    </button>
  );
}

type ParsedScimMappingCsv =
  | { readonly ok: true; readonly mappings: readonly ScimGroupRoleMappingImportBody["mappings"][number][] }
  | { readonly ok: false; readonly error: string };

function parseScimMappingCsv(input: string): ParsedScimMappingCsv {
  const rows = input
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNo: index + 1 }))
    .filter((row) => row.line !== "");
  if (rows.length === 0) return { ok: false, error: "가져올 행이 1개 이상 필요합니다." };

  const mappings: ScimGroupRoleMappingImportBody["mappings"][number][] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const columns = row.line.split(",").map((column) => column.trim());
    if (
      row.lineNo === 1 &&
      columns[0]?.toLowerCase() === "external_group" &&
      columns[1]?.toLowerCase() === "role"
    ) {
      continue;
    }
    if (columns.length < 2 || columns.length > 3) {
      return { ok: false, error: `${row.lineNo}행: external_group,role,description 형식이어야 합니다.` };
    }
    const externalGroup = columns[0] ?? "";
    const role = (columns[1] ?? "").toLowerCase();
    const description = columns[2] ?? "";
    if (externalGroup === "") return { ok: false, error: `${row.lineNo}행: external_group 값이 필요합니다.` };
    if (!isScimRole(role)) return { ok: false, error: `${row.lineNo}행: 허용되지 않은 역할 ${columns[1] ?? ""}` };
    if (seen.has(externalGroup)) return { ok: false, error: `${row.lineNo}행: external_group ${externalGroup}가 중복되었습니다.` };
    seen.add(externalGroup);
    mappings.push({
      external_group: externalGroup,
      role,
      description: description === "" ? null : description,
    });
  }
  if (mappings.length === 0) return { ok: false, error: "가져올 행이 1개 이상 필요합니다." };
  if (mappings.length > 500) return { ok: false, error: "가져오기는 최대 500행까지 지원합니다." };
  return { ok: true, mappings };
}

function isScimRole(value: string): value is RoleAssignmentRole {
  return (ROLES as readonly string[]).includes(value);
}

function isProviderDecommissioned(provider: ScimProviderItem): boolean {
  return provider.decommissioned_at !== null;
}

function providerStatusLabel(provider: ScimProviderItem): string {
  if (isProviderDecommissioned(provider)) return "사용 중지됨";
  return provider.status === "active" ? "활성" : "비활성";
}

function providerStatusTone(provider: ScimProviderItem): "green" | "amber" | "red" {
  if (isProviderDecommissioned(provider)) return "red";
  return provider.status === "active" ? "green" : "amber";
}

function secretRotationPolicyLabel(policy: ScimProviderSecretRotationPolicy | undefined): string {
  const value = policy ?? DEFAULT_SECRET_ROTATION_POLICY;
  return SECRET_ROTATION_POLICIES.find((item) => item.value === value)?.label ?? value;
}

function rotationStatusLabel(status: ScimProviderItem["rotation_status"] | undefined): string {
  if (status === "current") return "정상";
  if (status === "due_soon") return "곧 필요";
  if (status === "overdue") return "기한 초과";
  if (status === "decommissioned") return "사용 중지됨";
  return "수동";
}

function rotationStatusTone(status: ScimProviderItem["rotation_status"] | undefined): "green" | "amber" | "red" | "blue" {
  if (status === "current") return "green";
  if (status === "due_soon") return "amber";
  if (status === "overdue" || status === "decommissioned") return "red";
  return "blue";
}

function formatProviderTime(value: string | null): string {
  if (value === null || value === "") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function mappingKey(providerKey: string): readonly string[] {
  return ["scim-provider-mappings", providerKey];
}

function roleLabel(role: RoleAssignmentRole): string {
  return `${ROLE_LABELS[role] ?? role} (${role})`;
}

function mappingStatusLabel(status: ScimGroupRoleMappingItem["status"]): string {
  return status === "active" ? "활성" : "비활성";
}
