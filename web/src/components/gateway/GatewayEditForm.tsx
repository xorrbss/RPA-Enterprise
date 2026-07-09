import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type {
  GatewayPolicy,
  GatewayPolicyUpdate,
} from "../../api/types";
import { JsonTextArea, StructuredPolicyFields } from "./PolicyFormFields";
import { applyStructuredPolicy, errorText, parsePolicyJson } from "./policy-model";

export function GatewayEditForm({
  policy,
}: {
  policy: GatewayPolicy;
}): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [capabilities, setCapabilities] = useState(() =>
    JSON.stringify(policy.capabilities ?? {}, null, 2),
  );
  const [budget, setBudget] = useState(() =>
    JSON.stringify(policy.budget ?? {}, null, 2),
  );
  const [fallback, setFallback] = useState(() =>
    JSON.stringify(policy.fallback ?? null, null, 2),
  );
  const [isDefault, setIsDefault] = useState(() => policy.is_default === true);
  const [jsonMode, setJsonMode] = useState(
    () => policy.capabilities?.jsonMode === true,
  );
  const [vision, setVision] = useState(
    () => policy.capabilities?.vision === true,
  );
  const [maxContextTokens, setMaxContextTokens] = useState(() =>
    String(policy.capabilities?.maxContextTokens ?? 8000),
  );
  const [maxInputTokens, setMaxInputTokens] = useState(() =>
    String(policy.budget?.maxInputTokens ?? 1000),
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(() =>
    String(policy.budget?.maxOutputTokens ?? 1000),
  );
  const [maxCost, setMaxCost] = useState(() =>
    String(policy.budget?.maxCost ?? 1),
  );
  const [fallbackModel, setFallbackModel] = useState(() =>
    typeof policy.fallback?.model === "string" ? policy.fallback.model : "",
  );
  const [advanced, setAdvanced] = useState(false);
  const [msg, setMsg] = useState<{
    tone: "green" | "red";
    text: string;
  } | null>(null);

  const save = useMutation({
    mutationFn: (body: GatewayPolicyUpdate) =>
      api.updateGatewayPolicy(
        policy.version as number,
        body,
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "저장됨" });
      void qc.invalidateQueries({ queryKey: ["gateway-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorText(e) }),
  });
  const remove = useMutation({
    mutationFn: () =>
      api.deleteGatewayPolicy(
        policy.model,
        policy.version as number,
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "삭제됨" });
      void qc.invalidateQueries({ queryKey: ["gateway-policies"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorText(e) }),
  });

  if (policy.version === undefined) {
    return (
      <p style={{ color: "var(--muted)", marginTop: 16 }}>
        변경 번호를 불러오지 못해 편집할 수 없습니다.
      </p>
    );
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setMsg(null);
    const parsed = parsePolicyJson(capabilities, budget, fallback);
    if (parsed.kind === "error") {
      setMsg({ tone: "red", text: parsed.message });
      return;
    }
    const structured = applyStructuredPolicy(parsed.body, {
      jsonMode,
      vision,
      maxContextTokens,
      maxInputTokens,
      maxOutputTokens,
      maxCost,
      fallbackModel,
    });
    if (structured.kind === "error") {
      setMsg({ tone: "red", text: structured.message });
      return;
    }
    save.mutate({
      model: policy.model,
      ...structured.body,
      is_default: isDefault,
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ display: "grid", gap: 10, maxWidth: 640 }}
    >
      <h3 style={{ margin: "8px 0 0" }}>
        정책 편집 (AI 모델 {policy.model} · 변경 {policy.version})
      </h3>
      {/* 저장값-편집값 구분(T3) — 위 요약 타일은 저장된 정책, 이 폼은 저장 전 입력값. 둘이 달라 보이는 혼동 방지. */}
      <p className="subtle" style={{ margin: 0 }}>
        아래는 저장 전 입력값입니다. 저장된 정책은 위 요약에 표시되며, [저장]을 눌러야 반영됩니다.
      </p>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        <span className="label">기본 정책으로 지정</span>
      </label>
      <StructuredPolicyFields
        jsonMode={jsonMode}
        setJsonMode={setJsonMode}
        vision={vision}
        setVision={setVision}
        maxContextTokens={maxContextTokens}
        setMaxContextTokens={setMaxContextTokens}
        maxInputTokens={maxInputTokens}
        setMaxInputTokens={setMaxInputTokens}
        maxOutputTokens={maxOutputTokens}
        setMaxOutputTokens={setMaxOutputTokens}
        maxCost={maxCost}
        setMaxCost={setMaxCost}
        fallbackModel={fallbackModel}
        setFallbackModel={setFallbackModel}
      />
      <button
        className="btn"
        type="button"
        onClick={() => setAdvanced((v) => !v)}
      >
        {advanced ? "상세 설정 닫기" : "상세 설정 원문 보기"}
      </button>
      {advanced && (
        <>
          <JsonTextArea
            label="기능 세부 설정"
            value={capabilities}
            onChange={setCapabilities}
            rows={5}
          />
          <JsonTextArea
            label="예산 세부 설정"
            value={budget}
            onChange={setBudget}
            rows={5}
          />
          <JsonTextArea
            label="대체 모델 세부 설정"
            value={fallback}
            onChange={setFallback}
            rows={3}
          />
        </>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          className="btn"
          type="submit"
          disabled={save.isPending || remove.isPending}
        >
          {save.isPending ? "저장 중..." : "정책 저장"}
        </button>
        <button
          className="btn"
          type="button"
          disabled={save.isPending || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? "삭제 중..." : "정책 삭제"}
        </button>
        {msg !== null && (
          <span className={`badge ${msg.tone}`}>{msg.text}</span>
        )}
      </div>
    </form>
  );
}
