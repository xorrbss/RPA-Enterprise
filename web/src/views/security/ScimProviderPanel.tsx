import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { errorLabel } from "../../components/badges";
import { ScimMappingPanel } from "./ScimMappingSection";
import { ScimProviderActions, ScimProviderCreateForm, ScimProviderEvidence } from "./ScimProviderForms";
import { PROVIDERS_KEY, providerStatusLabel, providerStatusTone } from "./scim-labels";

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
