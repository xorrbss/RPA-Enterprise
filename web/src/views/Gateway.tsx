import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ErrorState, Loading } from "../components/states";
import { useCan } from "../api/permissions";
import { ApiError, type GatewayPolicy } from "../api/types";

export function GatewayView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const query = useQuery({ queryKey: ["gateway-policy"], queryFn: () => api.getGatewayPolicy(), retry: false });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI 모델 정책</h2>
      </div>
      <div className="panel-body" style={{ padding: 16 }}>
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          query.error instanceof ApiError && query.error.code === "IR_SCHEMA_INVALID" ? (
            <p style={{ color: "var(--muted)" }}>여러 모델 정책이 있습니다. 모델을 선택하면 상세가 표시됩니다.</p>
          ) : (
            <ErrorState message={messageOf(query.error)} onRetry={() => void query.refetch()} />
          )
        ) : query.data !== undefined ? (
          <>
            <dl className="metrics" style={{ margin: 0 }}>
              <div className="metric">
                <div className="label">모델</div>
                <div className="value" style={{ fontSize: 18 }}>{query.data.model}</div>
              </div>
              <div className="metric">
                <div className="label">capabilities</div>
                <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(query.data.capabilities ?? {}, null, 2)}</pre>
              </div>
              <div className="metric">
                <div className="label">budget</div>
                <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(query.data.budget ?? {}, null, 2)}</pre>
              </div>
            </dl>
            {/* admin만 편집 폼 노출(RBAC UI 게이팅; 최종 강제는 백엔드 gateway_policy.edit). */}
            {can("gateway_policy.edit") && <GatewayEditForm policy={query.data} />}
          </>
        ) : null}
      </div>
    </section>
  );
}

// admin 정책 편집: 현재 정책을 prefill → capabilities/budget/fallback JSON 편집 → PUT If-Match(version)+Idempotency-Key.
// 동시성 충돌·예산 위반·권한 거부를 명시 코드로 표면화(조용한 실패 금지). version 부재 시 편집 차단(낙관적 토큰 없음).
function GatewayEditForm({ policy }: { policy: GatewayPolicy }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [capabilities, setCapabilities] = useState(() => JSON.stringify(policy.capabilities ?? {}, null, 2));
  const [budget, setBudget] = useState(() => JSON.stringify(policy.budget ?? {}, null, 2));
  const [fallback, setFallback] = useState(() => JSON.stringify(policy.fallback ?? {}, null, 2));
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const mut = useMutation({
    mutationFn: (body: Parameters<typeof api.updateGatewayPolicy>[1]) =>
      api.updateGatewayPolicy(policy.version as number, body, crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "저장됨" });
      void qc.invalidateQueries({ queryKey: ["gateway-policy"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorText(e) }),
  });

  if (policy.version === undefined) {
    return <p style={{ color: "var(--muted)", marginTop: 16 }}>버전 정보를 불러오지 못해 편집할 수 없습니다.</p>;
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setMsg(null);
    let caps: Record<string, unknown>;
    let bud: Record<string, unknown>;
    let fb: Record<string, unknown>;
    try {
      caps = JSON.parse(capabilities) as Record<string, unknown>;
      bud = JSON.parse(budget) as Record<string, unknown>;
      fb = JSON.parse(fallback) as Record<string, unknown>;
    } catch {
      setMsg({ tone: "red", text: "유효한 JSON이 아닙니다(capabilities/budget/fallback 확인)." });
      return;
    }
    mut.mutate({ model: policy.model, capabilities: caps, budget: bud, fallback_config: fb });
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 16, display: "grid", gap: 10, maxWidth: 560 }}>
      <h3 style={{ margin: "8px 0 0" }}>정책 편집 (모델 {policy.model} · v{policy.version})</h3>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">capabilities (JSON)</span>
        <textarea value={capabilities} onChange={(e) => setCapabilities(e.target.value)} rows={5} style={{ fontFamily: "monospace", fontSize: 12 }} />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">budget (JSON)</span>
        <textarea value={budget} onChange={(e) => setBudget(e.target.value)} rows={5} style={{ fontFamily: "monospace", fontSize: 12 }} />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">fallback (JSON)</span>
        <textarea value={fallback} onChange={(e) => setFallback(e.target.value)} rows={3} style={{ fontFamily: "monospace", fontSize: 12 }} />
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn" type="submit" disabled={mut.isPending}>
          {mut.isPending ? "저장 중…" : "정책 저장"}
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </div>
    </form>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "POLICY_VERSION_CONFLICT") return "다른 사용자가 먼저 수정했습니다. 새로고침 후 재시도하세요.";
    if (err.code === "LLM_CAPABILITY_MISMATCH") return "예산(토큰)이 모델 컨텍스트 한도를 초과합니다.";
    if (err.code === "AUTHZ_FORBIDDEN") return "권한이 없습니다.";
    return `${err.code} (${err.httpStatus})`;
  }
  return "저장 실패";
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.code} (${err.httpStatus})`;
  return err instanceof Error ? err.message : "오류";
}
