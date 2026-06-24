import { isRecord } from "./command";
import { ApiResponseError } from "./errors";

type BusinessFormFieldType = "text" | "textarea" | "number" | "boolean" | "date" | "select";
type ResolutionDecision = "approve" | "reject" | "correct" | "retry";

interface BusinessFormField {
  readonly key: string;
  readonly label: string;
  readonly type: BusinessFormFieldType;
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly help_text?: string;
}

interface BusinessFormSchema {
  readonly version: "business_form_v1";
  readonly fields: readonly BusinessFormField[];
}

interface HumanTaskResolutionForForm {
  readonly decision: ResolutionDecision;
  readonly corrections?: Record<string, unknown>;
}

const FIELD_TYPES: ReadonlySet<string> = new Set(["text", "textarea", "number", "boolean", "date", "select"]);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateResolutionAgainstBusinessForm(
  resultSchema: unknown,
  resolution: HumanTaskResolutionForForm | undefined,
): void {
  const schema = parseBusinessFormSchema(resultSchema);
  if (schema === null || resolution === undefined) return;

  const corrections = resolution.corrections ?? {};
  const fieldByKey = new Map(schema.fields.map((field) => [field.key, field]));

  for (const key of Object.keys(corrections)) {
    const field = fieldByKey.get(key);
    if (field === undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_unknown_field", field: key });
    }
    validateFieldValue(field, corrections[key]);
  }

  if (resolution.decision === "correct") {
    for (const field of schema.fields) {
      if (field.required && !Object.prototype.hasOwnProperty.call(corrections, field.key)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_required_field_missing", field: field.key });
      }
    }
  }
}

function parseBusinessFormSchema(value: unknown): BusinessFormSchema | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  if (value.version === undefined) return null;
  if (value.version !== "business_form_v1") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_schema_version" });
  }
  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_fields" });
  }

  const seen = new Set<string>();
  const fields = value.fields.map((raw) => parseField(raw, seen));
  return { version: "business_form_v1", fields };
}

function parseField(value: unknown, seen: Set<string>): BusinessFormField {
  if (!isRecord(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_field" });
  }
  for (const key of Object.keys(value)) {
    if (!["key", "label", "type", "required", "options", "help_text"].includes(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_field_key", field: key });
    }
  }

  const key = stringProp(value, "key");
  if (!KEY_RE.test(key)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_field_key", field: key });
  }
  if (seen.has(key)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "duplicate_business_form_field", field: key });
  }
  seen.add(key);

  const label = stringProp(value, "label");
  const type = stringProp(value, "type");
  if (!FIELD_TYPES.has(type)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_field_type", field: key });
  }
  const required = value.required === undefined ? false : value.required;
  if (typeof required !== "boolean") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_required", field: key });
  }

  const helpText = value.help_text;
  if (helpText !== undefined && typeof helpText !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_help_text", field: key });
  }

  const options = parseOptions(value.options, key, type);
  return {
    key,
    label,
    type: type as BusinessFormFieldType,
    required,
    ...(options !== undefined ? { options } : {}),
    ...(helpText !== undefined ? { help_text: helpText } : {}),
  };
}

function parseOptions(value: unknown, key: string, type: string): readonly string[] | undefined {
  if (type !== "select") {
    if (value !== undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_options_without_select", field: key });
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_options", field: key });
  }
  return value;
}

function stringProp(value: Record<string, unknown>, prop: string): string {
  const raw = value[prop];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_business_form_field_property", prop });
  }
  return raw;
}

function validateFieldValue(field: BusinessFormField, value: unknown): void {
  if (value === null || value === undefined || value === "") {
    if (field.required) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_required_field_empty", field: field.key });
    }
    return;
  }

  switch (field.type) {
    case "text":
    case "textarea":
      if (typeof value !== "string") {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_value_type_mismatch", field: field.key });
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_value_type_mismatch", field: field.key });
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_value_type_mismatch", field: field.key });
      }
      return;
    case "date":
      if (typeof value !== "string" || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_value_type_mismatch", field: field.key });
      }
      return;
    case "select":
      if (typeof value !== "string" || field.options === undefined || !field.options.includes(value)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "business_form_select_value_invalid", field: field.key });
      }
      return;
    default:
      assertNever(field.type);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled business form field type: ${String(value)}`);
}
