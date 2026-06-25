import { useMemo } from "react";

import { paramsFieldsFromText, paramsTextWithField } from "./helpers";

export function ExecutionParamsEditor({
  paramsText,
  onChange,
}: {
  paramsText: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const { fields, invalid } = useMemo(() => paramsFieldsFromText(paramsText), [paramsText]);
  if (invalid) {
    return (
      <p className="form-alert red" role="status">
        실행 입력값 형식이 올바르지 않습니다. 고급/원문 입력값 보기에서 여러 항목을 담은 형태로 수정하세요.
      </p>
    );
  }
  if (fields.length === 0) {
    return <p className="empty-state">추가 실행 입력값이 없습니다. 필요한 경우 고급/원문 입력값 보기에서 값을 추가하세요.</p>;
  }
  return (
    <div className="params-field-editor" aria-label="실행 입력값">
      {fields.map((field) => (
        <label className="field" key={field.key}>
          <span>{field.label}</span>
          <input
            aria-label={field.label}
            value={field.value}
            onChange={(event) => onChange(paramsTextWithField(paramsText, field.key, event.target.value))}
            placeholder={field.valueType === "숫자" ? "예: 3" : "값 입력"}
          />
          <small className="field-help">{field.valueType}</small>
        </label>
      ))}
    </div>
  );
}
