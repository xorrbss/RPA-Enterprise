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
  { value: "manual", label: "manual" },
  { value: "periodic_30d", label: "periodic_30d" },
  { value: "periodic_60d", label: "periodic_60d" },
  { value: "periodic_90d", label: "periodic_90d" },
];

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
        <span className="subtle">provider SecretRef와 외부 그룹 역할 매핑</span>
      </div>
      <ScimProviderCreateForm />
      {providers.isError && <p className="badge red">{errorLabel(providers.error)}</p>}
      {items.length === 0 ? (
        <p className="subtle" style={{ marginTop: 10 }}>등록된 SCIM provider가 없습니다.</p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>상태</th>
                <th>SecretRef</th>
                <th>Skew</th>
                <th>Evidence</th>
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
                  <td>{provider.clock_skew_seconds}s</td>
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
      setMsg({ tone: "green", text: "provider 등록됨" });
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
          <span className="subtle">provider_key</span>
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
          <span className="subtle">rotation policy</span>
          <select
            aria-label="Rotation policy for new SCIM provider"
            value={rotationPolicy}
            onChange={(e) => setRotationPolicy(e.target.value as ScimProviderSecretRotationPolicy)}
          >
            {SECRET_ROTATION_POLICIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <button
          aria-label="SCIM provider 등록"
          className="btn primary"
          title="Create SCIM provider"
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
          rotation {rotationStatusLabel(rotationStatus)}
        </span>
        <div className="subtle" style={{ fontSize: 11 }}>
          policy: {secretRotationPolicyLabel(provider.secret_rotation_policy)} / due: {formatProviderTime(provider.rotation_due_at)}
        </div>
      </div>
      {hasRotation && (
        <div>
          <span className="badge blue">SecretRef rotation</span>
          <div className="subtle" style={{ fontSize: 11 }}>
            {formatProviderTime(provider.last_secret_rotated_at)} / {provider.last_secret_rotated_by ?? "-"}
          </div>
        </div>
      )}
      {hasDecommission && (
        <div>
          <span className="badge red">Provider decommission</span>
          <div className="subtle" style={{ fontSize: 11 }}>
            {formatProviderTime(provider.decommissioned_at)} / {provider.decommissioned_by ?? "-"}
          </div>
          {provider.decommission_reason !== null && provider.decommission_reason.trim() !== "" && (
            <div className="subtle" style={{ fontSize: 11 }}>
              reason: {provider.decommission_reason}
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
      setMsg({ tone: "green", text: "rotation policy updated" });
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1fr) auto", gap: 6, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">rotation policy</span>
          <select
            aria-label={`Secret rotation policy for ${provider.provider_key}`}
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
          aria-label={`Update rotation policy for ${provider.provider_key}`}
          disabled={policy === provider.secret_rotation_policy || update.isPending}
          onClick={() => update.mutate()}
        >
          update
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
      <button className="btn" type="button" disabled aria-label={`Status locked for ${provider.provider_key}`}>
        decommissioned
      </button>
    );
  }
  return (
    <button
      className="btn"
      type="button"
      aria-label={`${next === "disabled" ? "Disable" : "Activate"} ${provider.provider_key}`}
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
      setMsg({ tone: "green", text: "SecretRef rotated" });
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
          aria-label={`Rotate SecretRef for ${provider.provider_key}`}
          disabled={decommissioned || rotate.isPending}
          onClick={() => {
            setMsg(null);
            setOpen((value) => !value);
          }}
        >
          Rotate SecretRef
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </span>
      {open && (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            aria-label={`New SecretRef for ${provider.provider_key}`}
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
            placeholder="secret://tenant/scim/provider/signing-v2"
            style={{ fontFamily: "monospace" }}
          />
          <button
            className="btn primary"
            type="button"
            aria-label={`Confirm SecretRef rotation for ${provider.provider_key}`}
            disabled={invalid || rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            confirm rotation
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
        text: `decommissioned: ${result.disabled_mappings} mappings, ${result.revoked_assignments} assignments`,
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
          aria-label={`Decommission ${provider.provider_key}`}
          disabled={decommissioned || decommission.isPending}
          onClick={() => {
            setMsg(null);
            setOpen((value) => !value);
          }}
        >
          Decommission
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </span>
      {open && (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            aria-label={`Decommission reason for ${provider.provider_key}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="reason"
          />
          <button
            className="btn primary"
            type="button"
            aria-label={`Confirm decommission for ${provider.provider_key}`}
            disabled={invalid || decommission.isPending}
            onClick={() => decommission.mutate()}
          >
            confirm decommission
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
        <strong>{provider.provider_key} group mapping</strong>
        {locked && <span className="badge red">mapping mutations locked</span>}
      </div>
      <ScimMappingCreateForm provider={provider} />
      <ScimMappingImportForm provider={provider} />
      {mappings.isError && <span className="badge red">{errorLabel(mappings.error)}</span>}
      {items.length === 0 ? (
        <p className="subtle">등록된 group mapping이 없습니다.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>External group</th>
              <th>Role</th>
              <th>상태</th>
              <th>설명</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {items.map((mapping) => (
              <tr key={mapping.mapping_id}>
                <td>{mapping.external_group}</td>
                <td>{mapping.role}</td>
                <td><span className={`badge ${mapping.status === "active" ? "green" : "amber"}`}>{mapping.status}</span></td>
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
      setMsg({ tone: "green", text: "mapping 등록됨" });
      setExternalGroup("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: mappingKey(providerKey) });
    },
    onError: (err) => setMsg({ tone: "red", text: errorLabel(err) }),
  });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 2fr) minmax(120px, 1fr) minmax(180px, 2fr) auto", gap: 8, alignItems: "end" }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="subtle">external_group</span>
        <input
          value={externalGroup}
          onChange={(e) => setExternalGroup(e.target.value)}
          placeholder="grp-rpa-operators"
          disabled={locked}
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="subtle">role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])} disabled={locked}>
          {ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="subtle">설명</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" disabled={locked} />
      </label>
      <button
        aria-label="Create SCIM group mapping"
        className="btn"
        type="button"
        disabled={locked || externalGroup.trim() === "" || create.isPending}
        onClick={() => create.mutate()}
      >
        {locked ? "locked" : "추가"}
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
      setMsg({ tone: "green", text: "mapping import completed" });
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
          <span className="subtle">import mode</span>
          <select
            aria-label={`Mapping import mode for ${providerKey}`}
            value={mode}
            disabled={locked || importMappings.isPending}
            onChange={(e) => setMode(e.target.value as ScimGroupRoleMappingImportBody["mode"])}
          >
            <option value="upsert_only">upsert_only</option>
            <option value="replace_active">replace_active</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">mapping import/reconcile</span>
          <textarea
            aria-label={`Mapping import CSV for ${providerKey}`}
            value={csv}
            disabled={locked}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"external_group,role,description\ngrp-rpa-operators,operator,Ops group"}
            rows={3}
            style={{ fontFamily: "monospace", resize: "vertical" }}
          />
        </label>
        <button
          aria-label={`Import SCIM group mappings for ${providerKey}`}
          className="btn"
          type="button"
          disabled={locked || csv.trim() === "" || importMappings.isPending}
          onClick={runImport}
        >
          {locked ? "locked" : importMappings.isPending ? "importing" : "import"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
        {result !== null && (
          <span aria-label={`Mapping import result for ${providerKey}`} style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            <span className="badge blue">imported {result.imported}</span>
            <span className="badge blue">updated {result.updated}</span>
            <span className="badge blue">unchanged {result.unchanged}</span>
            <span className="badge amber">disabled {result.disabled}</span>
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
      aria-label={locked ? `Mapping status locked for ${mapping.external_group}` : undefined}
      className="btn"
      type="button"
      disabled={locked || update.isPending}
      onClick={() => update.mutate()}
    >
      {locked ? "locked" : next === "disabled" ? "비활성" : "활성"}
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
  if (rows.length === 0) return { ok: false, error: "mapping import requires at least one row" };

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
      return { ok: false, error: `Line ${row.lineNo}: expected external_group,role,description` };
    }
    const externalGroup = columns[0] ?? "";
    const role = (columns[1] ?? "").toLowerCase();
    const description = columns[2] ?? "";
    if (externalGroup === "") return { ok: false, error: `Line ${row.lineNo}: external_group is required` };
    if (!isScimRole(role)) return { ok: false, error: `Line ${row.lineNo}: invalid role ${columns[1] ?? ""}` };
    if (seen.has(externalGroup)) return { ok: false, error: `Line ${row.lineNo}: duplicate external_group ${externalGroup}` };
    seen.add(externalGroup);
    mappings.push({
      external_group: externalGroup,
      role,
      description: description === "" ? null : description,
    });
  }
  if (mappings.length === 0) return { ok: false, error: "mapping import requires at least one row" };
  if (mappings.length > 500) return { ok: false, error: "mapping import supports up to 500 rows" };
  return { ok: true, mappings };
}

function isScimRole(value: string): value is RoleAssignmentRole {
  return (ROLES as readonly string[]).includes(value);
}

function isProviderDecommissioned(provider: ScimProviderItem): boolean {
  return provider.decommissioned_at !== null;
}

function providerStatusLabel(provider: ScimProviderItem): string {
  if (isProviderDecommissioned(provider)) return "decommissioned";
  return provider.status;
}

function providerStatusTone(provider: ScimProviderItem): "green" | "amber" | "red" {
  if (isProviderDecommissioned(provider)) return "red";
  return provider.status === "active" ? "green" : "amber";
}

function secretRotationPolicyLabel(policy: ScimProviderSecretRotationPolicy | undefined): string {
  return policy ?? DEFAULT_SECRET_ROTATION_POLICY;
}

function rotationStatusLabel(status: ScimProviderItem["rotation_status"] | undefined): string {
  return status ?? "manual";
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
