import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { GatewayPolicyUpdate } from "../../api/types";
import { JsonTextArea, StructuredPolicyFields } from "./PolicyFormFields";
import { applyStructuredPolicy, errorText, parsePolicyJson } from "./policy-model";

export function GatewayCreateForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [model, setModel] = useState("");
  const [capabilities, setCapabilities] = useState(
    '{\n  "maxContextTokens": 8000\n}',
  );
  const [budget, setBudget] = useState(
    '{\n  "maxInputTokens": 1000,\n  "maxOutputTokens": 1000,\n  "maxCost": 1\n}',
  );
  const [fallback, setFallback] = useState("null");
  const [isDefault, setIsDefault] = useState(false);
  const [jsonMode, setJsonMode] = useState(true);
  const [vision, setVision] = useState(false);
  const [maxContextTokens, setMaxContextTokens] = useState("8000");
  const [maxInputTokens, setMaxInputTokens] = useState("1000");
  const [maxOutputTokens, setMaxOutputTokens] = useState("1000");
  const [maxCost, setMaxCost] = useState("1");
  const [fallbackModel, setFallbackModel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [msg, setMsg] = useState<{
    tone: "green" | "red";
    text: string;
  } | null>(null);

  const create = useMutation({
    mutationFn: (body: GatewayPolicyUpdate) =>
      api.createGatewayPolicy(body, crypto.randomUUID()),
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
      setMsg({ tone: "red", text: "AI 모델을 입력하세요." });
      return;
    }
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
    create.mutate({
      model: nextModel,
      ...structured.body,
      is_default: isDefault,
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ display: "grid", gap: 10, maxWidth: 640 }}
    >
      <h3 style={{ margin: "8px 0 0" }}>새 AI 정책</h3>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">AI 모델</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="예: gpt-4.1-mini"
        />
      </label>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        <span className="label">기본 정책으로 생성</span>
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
            rows={4}
          />
          <JsonTextArea
            label="예산 세부 설정"
            value={budget}
            onChange={setBudget}
            rows={4}
          />
          <JsonTextArea
            label="대체 모델 세부 설정"
            value={fallback}
            onChange={setFallback}
            rows={3}
          />
        </>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn" type="submit" disabled={create.isPending}>
          {create.isPending ? "생성 중..." : "정책 생성"}
        </button>
        {msg !== null && (
          <span className={`badge ${msg.tone}`}>{msg.text}</span>
        )}
      </div>
    </form>
  );
}
