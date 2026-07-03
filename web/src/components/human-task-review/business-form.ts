import type { HumanTaskBusinessFormField, HumanTaskBusinessFormSchema, HumanTaskResolution } from "../../api/types";

export type FormValue = string | boolean | undefined;
export type BusinessFormParseResult = {
  readonly schema: HumanTaskBusinessFormSchema | null;
  readonly error: string | null;
};

export function businessFormSchema(value: unknown): BusinessFormParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { schema: null, error: null };
  const candidate = value as { version?: unknown; fields?: unknown };
  if (candidate.version === undefined) return { schema: null, error: null };
  if (candidate.version !== "business_form_v1") return { schema: null, error: "지원하지 않는 입력 양식입니다." };
  if (!Array.isArray(candidate.fields) || candidate.fields.length === 0) return { schema: null, error: "입력 양식 필드가 올바르지 않습니다." };

  const seen = new Set<string>();
  const fields: HumanTaskBusinessFormField[] = [];
  for (const field of candidate.fields) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) return { schema: null, error: "입력 양식 필드가 올바르지 않습니다." };
    const item = field as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!["key", "label", "type", "required", "options", "help_text"].includes(key)) return { schema: null, error: "입력 양식 필드가 올바르지 않습니다." };
    }
    const key = item.key;
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return { schema: null, error: "입력 양식 필드 키가 올바르지 않습니다." };
    if (seen.has(key)) return { schema: null, error: `중복된 입력 양식 필드입니다: ${key}` };
    seen.add(key);
    const label = item.label;
    if (typeof label !== "string" || label.length === 0) return { schema: null, error: "입력 양식 라벨이 올바르지 않습니다." };
    const type = item.type;
    if (!["text", "textarea", "number", "boolean", "date", "select"].includes(String(type))) return { schema: null, error: "입력 양식 타입이 올바르지 않습니다." };
    const required = item.required;
    if (required !== undefined && typeof required !== "boolean") return { schema: null, error: "입력 양식 필수 여부가 올바르지 않습니다." };
    const helpText = item.help_text;
    if (helpText !== undefined && typeof helpText !== "string") return { schema: null, error: "입력 양식 도움말이 올바르지 않습니다." };
    const options = item.options;
    if (type === "select") {
      if (!Array.isArray(options) || options.length === 0 || options.some((option) => typeof option !== "string" || option.length === 0)) {
        return { schema: null, error: "선택형 입력 양식 옵션이 올바르지 않습니다." };
      }
    } else if (options !== undefined) {
      return { schema: null, error: "선택형이 아닌 필드에 옵션이 있습니다." };
    }
    fields.push({
      key,
      label,
      type: type as HumanTaskBusinessFormField["type"],
      ...(required !== undefined ? { required } : {}),
      ...(type === "select" ? { options: options as string[] } : {}),
      ...(helpText !== undefined ? { help_text: helpText } : {}),
    });
  }

  return { schema: { version: "business_form_v1", fields }, error: null };
}

export function initialFormValues(
  schema: HumanTaskBusinessFormSchema | null,
  corrections: Record<string, unknown> | undefined,
  payload: unknown,
): Record<string, FormValue> {
  if (schema === null) return {};
  const payloadValues = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  return Object.fromEntries(schema.fields.map((field) => {
    const value = corrections?.[field.key] ?? payloadValues[field.key];
    if (field.type === "boolean") return [field.key, typeof value === "boolean" ? String(value) : ""];
    if (value === undefined || value === null) return [field.key, ""];
    return [field.key, String(value)];
  }));
}

function typedFieldError(field: HumanTaskBusinessFormField, value: FormValue): string | null {
  if (field.type === "number" && !Number.isFinite(Number(value))) {
    return `${field.label} 값은 숫자여야 합니다.`;
  }
  if (field.type === "date" && (typeof value !== "string" || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
    return `${field.label} 값은 YYYY-MM-DD 형식이어야 합니다.`;
  }
  if (field.type === "select" && (typeof value !== "string" || !(field.options ?? []).includes(value))) {
    return `${field.label} 값은 선택지 중 하나여야 합니다.`;
  }
  if (field.type === "boolean" && value !== "true" && value !== "false") {
    return `${field.label} 값은 예/아니오 중 하나여야 합니다.`;
  }
  return null;
}

export function formError(
  schema: HumanTaskBusinessFormSchema,
  values: Record<string, FormValue>,
  decision: HumanTaskResolution["decision"],
): string | null {
  for (const field of schema.fields) {
    const value = values[field.key];
    const empty = value === undefined || value === "";
    if (decision === "correct" && field.required === true && empty) {
      return `${field.label} 값이 필요합니다.`;
    }
    if (empty) continue;
    const typedError = typedFieldError(field, value);
    if (typedError !== null) return typedError;
    if (field.type === "number" && value !== undefined && value !== "" && !Number.isFinite(Number(value))) {
      return `${field.label}은 숫자여야 합니다.`;
    }
  }
  return null;
}

export function buildFormCorrections(schema: HumanTaskBusinessFormSchema, values: Record<string, FormValue>): Record<string, unknown> | undefined {
  const entries: Array<readonly [string, unknown]> = [];
  for (const field of schema.fields) {
    const value = values[field.key];
    if (value === undefined || value === "") continue;
    if (field.type === "number") entries.push([field.key, Number(value)]);
    else if (field.type === "boolean") entries.push([field.key, value === "true"]);
    else entries.push([field.key, value]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
