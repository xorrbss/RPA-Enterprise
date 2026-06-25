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
    <>
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
      <GatewayUsagePanel />
    </>
  );
}

function formatUsageTokens(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("ko-KR");
}

function formatUsageCost(cost: string | null): string {
  return cost === null ? "—" : `$${cost}`;
}

// AI 사용량·비용 패널 — stagehand_calls 모델별 집계(GET /v1/gateway/call-summary). 데이터 미도착/오류/빈 호출을
// 정직 구분(단정 금지). 토큰/비용 null 은 '—'(0 단정 금지).
function GatewayUsagePanel(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["gateway-call-summary"],
    queryFn: () => api.getGatewayCallSummary(30),
    refetchInterval: 30_000,
    retry: false,
  });
  const data = query.data;
  // by_model 이 배열이 아니면(미도착/계약 위반 응답) 빈 목록으로 — 패널 크래시 대신 정직한 빈 상태(white-screen 방지).
  const byModel = Array.isArray(data?.by_model) ? data.by_model : [];
  return (
    <section className="panel" aria-label="AI 사용량·비용">
      <div className="panel-head">
        <h2>사용량·비용</h2>
        {data !== undefined && <span className="subtle">최근 {data.window_days}일</span>}
      </div>
      <div className="panel-body" style={{ padding: 16 }}>
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState message={errorLabel(query.error)} onRetry={() => void query.refetch()} />
        ) : data === undefined || byModel.length === 0 ? (
          <p className="empty-state">기간 내 AI 호출 기록이 없습니다.</p>
        ) : (
          <>
            <p className="subtle" style={{ marginTop: 0 }}>
              전체 {data.total.calls.toLocaleString("ko-KR")}회 · 입력 {formatUsageTokens(data.total.input_tokens)} · 출력 {formatUsageTokens(data.total.output_tokens)} · 비용 {formatUsageCost(data.total.cost)}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>AI 모델</th>
                    <th>호출</th>
                    <th>입력 토큰</th>
                    <th>출력 토큰</th>
                    <th>비용</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td>{m.calls.toLocaleString("ko-KR")}</td>
                      <td>{formatUsageTokens(m.input_tokens)}</td>
                      <td>{formatUsageTokens(m.output_tokens)}</td>
                      <td>{formatUsageCost(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
