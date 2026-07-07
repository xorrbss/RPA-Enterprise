import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type {
  ScimGroupRoleMappingImportBody,
  ScimGroupRoleMappingImportResult,
  ScimGroupRoleMappingItem,
  ScimProviderItem,
} from "../../api/types";
import { errorLabel } from "../../components/badges";
import {
  IMPORT_MODES,
  ROLES,
  isProviderDecommissioned,
  mappingKey,
  mappingStatusLabel,
  parseScimMappingCsv,
  roleLabel,
} from "./scim-labels";

export function ScimMappingPanel({ provider }: { provider: ScimProviderItem }): JSX.Element {
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
