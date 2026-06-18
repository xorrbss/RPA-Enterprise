import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ErrorState, Loading } from "../components/states";
import { errorLabel } from "../components/badges";
import { useCan } from "../api/permissions";
import { ApiError, type GatewayPolicy, type GatewayPolicyUpdate } from "../api/types";

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
            <th>모델</th>
            <th>기본</th>
            <th>버전</th>
            <th>작업</th>
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

function PolicyReadout({ policy }: { policy: GatewayPolicy }): JSX.Element {
  return (
    <dl className="metrics" style={{ margin: 0 }}>
      <div className="metric">
        <div className="label">모델</div>
        <div className="value" style={{ fontSize: 18 }}>{policy.model}</div>
      </div>
      <div className="metric">
        <div className="label">상태</div>
        <div className="value" style={{ fontSize: 18 }}>{policy.is_default ? "기본 정책" : "일반 정책"}</div>
      </div>
      <div className="metric">
        <div className="label">capabilities</div>
        <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(policy.capabilities ?? {}, null, 2)}</pre>
      </div>
      <div className="metric">
        <div className="label">budget</div>
        <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(policy.budget ?? {}, null, 2)}</pre>
      </div>
    </dl>
  );
}

function GatewayEditForm({ policy }: { policy: GatewayPolicy }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [capabilities, setCapabilities] = useState(() => JSON.stringify(policy.capabilities ?? {}, null, 2));
  const [budget, setBudget] = useState(() => JSON.stringify(policy.budget ?? {}, null, 2));
  const [fallback, setFallback] = useState(() => JSON.stringify(policy.fallback ?? {}, null, 2));
  const [isDefault, setIsDefault] = useState(() => policy.is_default === true);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const save = useMutation({
    mutationFn: (body: GatewayPolicyUpdate) =>
      api.updateGatewayPolicy(policy.version as number, body, crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "저장됨" });
      void qc.invalidateQueries({ queryKey: ["gateway-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorText(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGatewayPolicy(policy.model, policy.version as number, crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "삭제됨" });
      void qc.invalidateQueries({ queryKey: ["gateway-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorText(e) }),
  });

  if (policy.version === undefined) {
    return <p style={{ color: "var(--muted)", marginTop: 16 }}>버전 정보를 불러오지 못해 편집할 수 없습니다.</p>;
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setMsg(null);
    const parsed = parsePolicyJson(capabilities, budget, fallback);
    if (parsed.kind === "error") {
      setMsg({ tone: "red", text: parsed.message });
      return;
    }
    save.mutate({ model: policy.model, ...parsed.body, is_default: isDefault });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 10, maxWidth: 640 }}>
      <h3 style={{ margin: "8px 0 0" }}>정책 편집 (모델 {policy.model} · v{policy.version})</h3>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <span className="label">기본 정책으로 지정</span>
      </label>
      <JsonTextArea label="capabilities (JSON)" value={capabilities} onChange={setCapabilities} rows={5} />
      <JsonTextArea label="budget (JSON)" value={budget} onChange={setBudget} rows={5} />
      <JsonTextArea label="fallback (JSON 또는 null)" value={fallback} onChange={setFallback} rows={3} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" type="submit" disabled={save.isPending || remove.isPending}>
          {save.isPending ? "저장 중..." : "정책 저장"}
        </button>
        <button className="btn" type="button" disabled={save.isPending || remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? "삭제 중..." : "정책 삭제"}
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </div>
    </form>
  );
}

function GatewayCreateForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [model, setModel] = useState("");
  const [capabilities, setCapabilities] = useState('{\n  "maxContextTokens": 8000\n}');
  const [budget, setBudget] = useState('{\n  "maxInputTokens": 1000,\n  "maxOutputTokens": 1000,\n  "maxCost": 1\n}');
  const [fallback, setFallback] = useState("null");
  const [isDefault, setIsDefault] = useState(false);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const create = useMutation({
    mutationFn: (body: GatewayPolicyUpdate) => api.createGatewayPolicy(body, crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "생성됨" });
      setModel("");
      void qc.invalidateQueries({ queryKey: ["gateway-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorText(e) }),
  });

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setMsg(null);
    const nextModel = model.trim();
    if (nextModel.length === 0) {
      setMsg({ tone: "red", text: "모델명을 입력하세요." });
      return;
    }
    const parsed = parsePolicyJson(capabilities, budget, fallback);
    if (parsed.kind === "error") {
      setMsg({ tone: "red", text: parsed.message });
      return;
    }
    create.mutate({ model: nextModel, ...parsed.body, is_default: isDefault });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 10, maxWidth: 640 }}>
      <h3 style={{ margin: "8px 0 0" }}>새 정책</h3>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">모델명</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="예: gpt-4.1-mini" />
      </label>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <span className="label">기본 정책으로 생성</span>
      </label>
      <JsonTextArea label="capabilities (JSON)" value={capabilities} onChange={setCapabilities} rows={4} />
      <JsonTextArea label="budget (JSON)" value={budget} onChange={setBudget} rows={4} />
      <JsonTextArea label="fallback (JSON 또는 null)" value={fallback} onChange={setFallback} rows={3} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn" type="submit" disabled={create.isPending}>
          {create.isPending ? "생성 중..." : "정책 생성"}
        </button>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      </div>
    </form>
  );
}

function JsonTextArea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}): JSX.Element {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span className="label">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        style={{ fontFamily: "monospace", fontSize: 12 }}
      />
    </label>
  );
}

function parsePolicyJson(
  capabilities: string,
  budget: string,
  fallback: string,
):
  | { kind: "ok"; body: Pick<GatewayPolicyUpdate, "capabilities" | "budget" | "fallback_config"> }
  | { kind: "error"; message: string } {
  try {
    const caps = JSON.parse(capabilities) as unknown;
    const bud = JSON.parse(budget) as unknown;
    const fb = JSON.parse(fallback) as unknown;
    if (!isObject(caps) || !isObject(bud) || !(isObject(fb) || fb === null)) {
      return { kind: "error", message: "capabilities/budget는 JSON 객체, fallback은 객체 또는 null이어야 합니다." };
    }
    return { kind: "ok", body: { capabilities: caps, budget: bud, fallback_config: fb } };
  } catch {
    return { kind: "error", message: "유효한 JSON이 아닙니다(capabilities/budget/fallback 확인)." };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.code === "LLM_CAPABILITY_MISMATCH") {
    return "예산(토큰)이 모델 컨텍스트 한도를 초과합니다.";
  }
  return errorLabel(err);
}
