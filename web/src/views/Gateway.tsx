import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type { GatewayPolicy } from "../api/types";
import { GatewayCreateForm, GatewayEditForm, PolicyReadout } from "../components/GatewayPolicyForms";
import { errorLabel } from "../components/badges";
import { ErrorState, Loading } from "../components/states";

export function GatewayView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["gateway-policies"],
    queryFn: () => api.listGatewayPolicies(),
    retry: false,
  });
  const policies = query.data?.items ?? [];
  const selected = useMemo(
    () => policies.find((p) => p.model === selectedModel) ?? policies.find((p) => p.is_default) ?? policies[0] ?? null,
    [policies, selectedModel],
  );

  useEffect(() => {
    if (query.data === undefined) return;
    if (policies.length === 0) {
      if (selectedModel !== null) setSelectedModel(null);
      return;
    }
    if (selectedModel === null || !policies.some((p) => p.model === selectedModel)) {
      const next = policies.find((p) => p.is_default) ?? policies[0];
      if (next !== undefined) setSelectedModel(next.model);
    }
  }, [policies, query.data, selectedModel]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI 모델 정책</h2>
      </div>
      <div className="panel-body" style={{ padding: 16, display: "grid", gap: 16 }}>
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState message={errorLabel(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <GatewayPolicyList policies={policies} selectedModel={selected?.model ?? null} onSelect={setSelectedModel} />
            {selected !== null ? (
              <PolicyReadout policy={selected} />
            ) : (
              <p style={{ color: "var(--muted)", margin: 0 }}>등록된 모델 정책이 없습니다.</p>
            )}
            {can("gateway_policy.edit") && (
              <div style={{ display: "grid", gap: 18 }}>
                {selected !== null && <GatewayEditForm key={selected.model} policy={selected} />}
                <GatewayCreateForm />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function GatewayPolicyList({
  policies,
  selectedModel,
  onSelect,
}: {
  policies: readonly GatewayPolicy[];
  selectedModel: string | null;
  onSelect: (model: string) => void;
}): JSX.Element {
  if (policies.length === 0) {
    return <p style={{ color: "var(--muted)", margin: 0 }}>정책 목록이 비어 있습니다.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>AI 모델</th>
            <th>기본</th>
            <th>변경 번호</th>
            <th>선택</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((policy) => (
            <tr key={policy.model}>
              <td>{policy.model}</td>
              <td>{policy.is_default ? <span className="badge green">기본 정책</span> : <span className="badge">-</span>}</td>
              <td>{policy.version ?? "-"}</td>
              <td>
                <button
                  className="btn"
                  type="button"
                  disabled={policy.model === selectedModel}
                  onClick={() => onSelect(policy.model)}
                >
                  {policy.model === selectedModel ? "선택됨" : "선택"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
