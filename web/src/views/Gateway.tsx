import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ErrorState, Loading } from "../components/states";
import { errorLabel } from "../components/badges";
import { useCan } from "../api/permissions";
import { ApiError, type GatewayPolicy } from "../api/types";

export function GatewayView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  // 다중 정책 테넌트는 model 미지정 시 백엔드가 422(model_required)로 거부한다(reads.ts §gateway, 임의선택 금지).
  // 선택한 모델을 쿼리 키에 실어 getGatewayPolicy(model)로 정책을 특정 → 다중정책 dead-end 해소(RQ-027).
  const [model, setModel] = useState<string | undefined>(undefined);
  const query = useQuery({
    queryKey: ["gateway-policy", model ?? null],
    queryFn: () => api.getGatewayPolicy(model),
    retry: false,
  });

  const err = query.error;
  // model 미지정 + 다건 → IR_SCHEMA_INVALID{reason:model_required}. 모델을 입력해 특정하라는 선택 UI를 띄운다.
  const needsModel =
    err instanceof ApiError && err.code === "IR_SCHEMA_INVALID" && err.body?.details?.reason === "model_required";
  // 선택한 모델 정책 미존재 → 404. 조용한 빈화면 금지: 어떤 모델이 없는지 명시하고 재입력을 허용한다.
  const modelNotFound = model !== undefined && err instanceof ApiError && err.code === "RESOURCE_NOT_FOUND";

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI 모델 정책</h2>
      </div>
      <div className="panel-body" style={{ padding: 16 }}>
        {query.isLoading ? (
          <Loading />
        ) : needsModel || modelNotFound ? (
          <ModelPicker current={model} notFound={modelNotFound ? model : undefined} onPick={setModel} />
        ) : query.isError ? (
          <ErrorState message={errorLabel(query.error)} onRetry={() => void query.refetch()} />
        ) : query.data !== undefined ? (
          <>
            {model !== undefined && (
              <button className="btn" style={{ marginBottom: 12 }} onClick={() => setModel(undefined)}>
                ← 다른 모델
              </button>
            )}
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

// 다중 정책 테넌트의 모델 선택(RQ-027). 백엔드가 모델 목록을 노출하지 않으므로(422는 건수만 반환) 모델명을 입력받아
// getGatewayPolicy(model)을 특정한다 — 가정 없는 console-only 해소. 빈 입력은 가드(조회 비활성).
function ModelPicker({
  current,
  notFound,
  onPick,
}: {
  current?: string;
  notFound?: string;
  onPick: (model: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(current ?? "");

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const next = draft.trim();
    if (next.length > 0) onPick(next);
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
      <p style={{ color: "var(--muted)", margin: 0 }}>
        {notFound !== undefined
          ? `‘${notFound}’ 모델 정책을 찾을 수 없습니다. 모델명을 확인하세요.`
          : "이 테넌트에는 여러 모델 정책이 있습니다. 모델명을 입력해 정책을 조회하세요."}
      </p>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">모델명</span>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="예: gpt-4o" />
      </label>
      <div>
        <button className="btn" type="submit" disabled={draft.trim().length === 0}>
          조회
        </button>
      </div>
    </form>
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
  // web-고유 행동지향 분기 보존(계약 userMessage '모델 미지원 작업.'보다 편집 맥락이 구체적): 예산-한도 초과 안내.
  // POLICY_VERSION_CONFLICT(이전 손작성 '다른 사용자가 먼저 수정…')·AUTHZ_FORBIDDEN은 errorLabel(계약 미러)로 통일 — 드리프트 소거.
  if (err instanceof ApiError && err.code === "LLM_CAPABILITY_MISMATCH") {
    return "예산(토큰)이 모델 컨텍스트 한도를 초과합니다.";
  }
  return errorLabel(err);
}
