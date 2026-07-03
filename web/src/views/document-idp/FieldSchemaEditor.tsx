import type { DocumentFieldSchema, DocumentFieldType } from "../../api/types";
import { fieldTypeLabel, requiredFieldCount } from "./helpers";

const FIELD_TYPES: readonly DocumentFieldType[] = ["text", "number", "date", "boolean"];

export function FieldSchemaEditor(props: {
  fields: readonly DocumentFieldSchema[];
  onChange: (fields: DocumentFieldSchema[]) => void;
}): JSX.Element {
  const updateField = (index: number, patch: Partial<DocumentFieldSchema>): void => {
    props.onChange(props.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  };
  const addField = (): void => {
    props.onChange([
      ...props.fields,
      {
        key: `field_${props.fields.length + 1}`,
        label: "새 필드",
        type: "text",
        required: false,
        min_confidence: 0.8,
      },
    ]);
  };
  const removeField = (index: number): void => {
    props.onChange(props.fields.filter((_field, fieldIndex) => fieldIndex !== index));
  };

  return (
    <div className="document-field-editor" aria-label="추출 필드 편집">
      <div className="document-field-editor-head">
        <div>
          <strong>추출 필드</strong>
          <span className="subtle">{requiredFieldCount(props.fields)}개 필수 · {props.fields.length}개 전체</span>
        </div>
        <button className="btn" type="button" onClick={addField}>필드 추가</button>
      </div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th scope="col">필드 키</th>
              <th scope="col">표시 이름</th>
              <th scope="col">유형</th>
              <th scope="col">필수</th>
              <th scope="col">신뢰도</th>
              <th scope="col">별칭</th>
              <th scope="col">작업</th>
            </tr>
          </thead>
          <tbody>
            {props.fields.map((field, index) => (
              <tr key={`${field.key}-${index}`}>
                <td>
                  <input
                    aria-label={`필드 키 ${index + 1}`}
                    value={field.key}
                    onChange={(event) => updateField(index, { key: event.target.value })}
                    placeholder="invoice_id"
                  />
                </td>
                <td>
                  <input
                    aria-label={`표시 이름 ${index + 1}`}
                    value={field.label ?? ""}
                    onChange={(event) => updateField(index, { label: event.target.value })}
                    placeholder="송장 번호"
                  />
                </td>
                <td>
                  <select
                    aria-label={`필드 유형 ${index + 1}`}
                    value={field.type ?? "text"}
                    onChange={(event) => updateField(index, { type: event.target.value as DocumentFieldType })}
                  >
                    {FIELD_TYPES.map((type) => <option key={type} value={type}>{fieldTypeLabel(type)}</option>)}
                  </select>
                </td>
                <td>
                  <label className="checkbox-inline">
                    <input
                      aria-label={`필수 필드 ${index + 1}`}
                      type="checkbox"
                      checked={field.required === true}
                      onChange={(event) => updateField(index, { required: event.target.checked })}
                    />
                    <span>{field.required === true ? "필수" : "선택"}</span>
                  </label>
                </td>
                <td>
                  <input
                    aria-label={`신뢰도 기준 ${index + 1}`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={field.min_confidence ?? 0.8}
                    onChange={(event) => updateField(index, { min_confidence: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`별칭 ${index + 1}`}
                    value={(field.aliases ?? []).join(", ")}
                    onChange={(event) => updateField(index, { aliases: splitAliases(event.target.value) })}
                    placeholder="Invoice ID, Total"
                  />
                </td>
                <td>
                  <button className="btn" type="button" onClick={() => removeField(index)} disabled={props.fields.length <= 1}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function splitAliases(value: string): readonly string[] | undefined {
  const aliases = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return aliases.length > 0 ? aliases : undefined;
}
