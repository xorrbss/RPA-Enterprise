import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import {
  ApiError,
  type GatewayPolicy,
  type GatewayPolicyUpdate,
} from "../api/types";
import { errorLabel } from "./badges";

// 예산/한도 수치에 단위를 붙여 운영자에게 의미를 명확히 한다(계약: 토큰 한도=tokens, maxCost=USD).
// 미설정 값엔 단위를 붙이지 않는다("미지정") — 없는 값을 0이나 단위로 위장하지 않는다(조용한 false 금지).
function numberSetting(
  record: Record<string, unknown> | undefined,
  key: string,
  unit: "토큰" | "USD",
): string {
  const value = record?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return "미지정";
  return unit === "USD" ? `$${value} USD` : `${value.toLocaleString("ko-KR")} 토큰`;
}

function booleanSetting(
  record: Record<string, unknown> | undefined,
  key: string,
): string {
  return record?.[key] === true ? "지원" : "미지원";
}

function policyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function PolicyReadout({
  policy,
}: {
  policy: GatewayPolicy;
}): JSX.Element {
  return (
    <dl className="metrics" style={{ margin: 0 }}>
      <div className="metric">
        <div className="label">AI 모델</div>
        <div className="value" style={{ fontSize: 18 }}>
          {policy.model}
        </div>
      </div>
      <div className="metric">
        <div className="label">상태</div>
        <div className="value" style={{ fontSize: 18 }}>
          {policy.is_default ? "기본 정책" : "일반 정책"}
        </div>
      </div>
      <div className="metric">
        <div className="label">컨텍스트 한도</div>
        <div className="value" style={{ fontSize: 18 }}>
          {numberSetting(policy.capabilities, "maxContextTokens", "토큰")}
        </div>
      </div>
      <div className="metric">
        <div className="label">지원 기능</div>
        <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
          <span className="badge blue">
            구조화 응답 {booleanSetting(policy.capabilities, "jsonMode")}
          </span>
          <span className="badge blue">
            화면 이미지 입력 {booleanSetting(policy.capabilities, "vision")}
          </span>
        </div>
      </div>
      <div className="metric">
        <div className="label">사용량 한도</div>
        <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
          <span>입력 {numberSetting(policy.budget, "maxInputTokens", "토큰")}</span>
          <span>출력 {numberSetting(policy.budget, "maxOutputTokens", "토큰")}</span>
        </div>
      </div>
      <div className="metric">
        <div className="label">비용 한도 (실행당)</div>
        <div className="value" style={{ fontSize: 18 }}>
          {numberSetting(policy.budget, "maxCost", "USD")}
        </div>
      </div>
      <div className="metric">
        <div className="label">상세 설정</div>
        <details className="developer-details">
          <summary>상세 설정 원문 보기</summary>
          <pre style={{ marginTop: 8, fontSize: 12 }}>
            {policyJson({
              capabilities: policy.capabilities ?? {},
              budget: policy.budget ?? {},
            })}
          </pre>
        </details>
      </div>
    </dl>
  );
}

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

function StructuredPolicyFields(props: {
  jsonMode: boolean;
  setJsonMode: (v: boolean) => void;
  vision: boolean;
  setVision: (v: boolean) => void;
  maxContextTokens: string;
  setMaxContextTokens: (v: string) => void;
  maxInputTokens: string;
  setMaxInputTokens: (v: string) => void;
  maxOutputTokens: string;
  setMaxOutputTokens: (v: string) => void;
  maxCost: string;
  setMaxCost: (v: string) => void;
  fallbackModel: string;
  setFallbackModel: (v: string) => void;
}): JSX.Element {
  return (
    <div className="policy-fields">
      <label>
        <span className="label">컨텍스트 한도</span>
        <input
          value={props.maxContextTokens}
          onChange={(e) => props.setMaxContextTokens(e.target.value)}
          inputMode="numeric"
        />
      </label>
      <label>
        <span className="label">입력 토큰 한도</span>
        <input
          value={props.maxInputTokens}
          onChange={(e) => props.setMaxInputTokens(e.target.value)}
          inputMode="numeric"
        />
      </label>
      <label>
        <span className="label">출력 토큰 한도</span>
        <input
          value={props.maxOutputTokens}
          onChange={(e) => props.setMaxOutputTokens(e.target.value)}
          inputMode="numeric"
        />
      </label>
      <label>
        <span className="label">비용 한도</span>
        <input
          value={props.maxCost}
          onChange={(e) => props.setMaxCost(e.target.value)}
          inputMode="decimal"
        />
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={props.jsonMode}
          onChange={(e) => props.setJsonMode(e.target.checked)}
        />{" "}
        구조화 응답 지원
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={props.vision}
          onChange={(e) => props.setVision(e.target.checked)}
        />{" "}
        화면 이미지 입력 지원
      </label>
      <label>
        <span className="label">대체 모델</span>
        <input
          value={props.fallbackModel}
          onChange={(e) => props.setFallbackModel(e.target.value)}
          placeholder="선택: 예비 AI 모델"
        />
      </label>
    </div>
  );
}

function parsePolicyJson(
  capabilities: string,
  budget: string,
  fallback: string,
):
  | {
      kind: "ok";
      body: Pick<
        GatewayPolicyUpdate,
        "capabilities" | "budget" | "fallback_config"
      >;
    }
  | { kind: "error"; message: string } {
  try {
    const caps = JSON.parse(capabilities) as unknown;
    const bud = JSON.parse(budget) as unknown;
    const fb = JSON.parse(fallback) as unknown;
    if (!isObject(caps) || !isObject(bud) || !(isObject(fb) || fb === null)) {
      return {
        kind: "error",
        message:
          "기능/예산 설정은 객체 형태, 대체 모델 설정은 객체 또는 null이어야 합니다.",
      };
    }
    return {
      kind: "ok",
      body: { capabilities: caps, budget: bud, fallback_config: fb },
    };
  } catch {
    return {
      kind: "error",
      message: "상세 설정 형식이 올바르지 않습니다(기능/예산/대체 모델 설정 확인).",
    };
  }
}

function parseNonNegative(
  value: string,
  label: string,
): number | { error: string } {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    return { error: `${label}은 0 이상의 숫자여야 합니다.` };
  return n;
}

function applyStructuredPolicy(
  body: Pick<
    GatewayPolicyUpdate,
    "capabilities" | "budget" | "fallback_config"
  >,
  fields: {
    jsonMode: boolean;
    vision: boolean;
    maxContextTokens: string;
    maxInputTokens: string;
    maxOutputTokens: string;
    maxCost: string;
    fallbackModel: string;
  },
):
  | {
      kind: "ok";
      body: Pick<
        GatewayPolicyUpdate,
        "capabilities" | "budget" | "fallback_config"
      >;
    }
  | { kind: "error"; message: string } {
  const maxContextTokens = parseNonNegative(
    fields.maxContextTokens,
    "컨텍스트 한도",
  );
  const maxInputTokens = parseNonNegative(
    fields.maxInputTokens,
    "입력 토큰 한도",
  );
  const maxOutputTokens = parseNonNegative(
    fields.maxOutputTokens,
    "출력 토큰 한도",
  );
  const maxCost = parseNonNegative(fields.maxCost, "비용 한도");
  if (typeof maxContextTokens !== "number")
    return { kind: "error", message: maxContextTokens.error };
  if (typeof maxInputTokens !== "number")
    return { kind: "error", message: maxInputTokens.error };
  if (typeof maxOutputTokens !== "number")
    return { kind: "error", message: maxOutputTokens.error };
  if (typeof maxCost !== "number")
    return { kind: "error", message: maxCost.error };
  const fallbackName = fields.fallbackModel.trim();
  const fallback_config =
    fallbackName.length > 0
      ? { ...(body.fallback_config ?? {}), model: fallbackName }
      : (body.fallback_config ?? null);
  return {
    kind: "ok",
    body: {
      capabilities: {
        ...body.capabilities,
        maxContextTokens,
        jsonMode: fields.jsonMode,
        vision: fields.vision,
      },
      budget: { ...body.budget, maxInputTokens, maxOutputTokens, maxCost },
      fallback_config,
    },
  };
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
