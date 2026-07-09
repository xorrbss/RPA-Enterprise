export function JsonTextArea({
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

export function StructuredPolicyFields(props: {
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
        <span className="label">컨텍스트 한도 (토큰)</span>
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
        {/* 단위 명시(T3) — 계약 어휘: budget.maxCost = USD, run 단위 누계 상한(ops-defaults llm.budget.max_cost_per_run). */}
        <span className="label">비용 한도 (USD/실행)</span>
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
