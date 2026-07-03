// 실행 파라미터 입력 필드 — params_schema 기반 kind(text/number/checkbox/select)별 입력 렌더.

import type { ScenarioParamField } from "../../api/scenario-params";

export function ParamFieldInput({
  field,
  value,
  onChange,
}: {
  field: ScenarioParamField;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const label = field.required ? `${field.label} *` : field.label;
  const commonStyle = { width: "100%", padding: 8, boxSizing: "border-box" } as const;
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {/* params_schema title/description 을 우선 사용하고, 미정의 키는 운영자용 라벨로 폴백한다. */}
      <span style={{ display: "block", fontSize: 13, marginBottom: 2 }}>{label}</span>
      {field.kind === "checkbox" ? (
        <span className="checkbox-inline">
          <input
            type="checkbox"
            checked={value === "true"}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
            aria-label={field.label}
          />
          <span>{value === "true" ? "사용" : "사용 안 함"}</span>
        </span>
      ) : field.kind === "select" ? (
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={field.label}
          style={commonStyle}
        >
          <option value="">선택하세요</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === "number" ? "number" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          aria-label={field.label}
          style={{
            ...commonStyle,
            fontFamily: field.kind === "text" && field.placeholder?.startsWith("https://") ? "monospace" : undefined,
            fontSize: 13,
          }}
        />
      )}
      {field.description !== undefined && (
        <span className="subtle" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
          {field.description}
        </span>
      )}
    </label>
  );
}
