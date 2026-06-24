// 시나리오 IR에서 실행에 필요한 파라미터 키를 도출한다.
// navigate.url_ref 는 run params 의 키(런타임 v2.11) — 실행 전 운영자가 그 값(URL)을 공급해야 한다.
// 목록(ScenarioItem)엔 IR이 없으므로 실행 시 getScenario(detail.ir)로 받아 추출한다.

// url_ref 키(navigate 대상의 심볼릭 키) → 운영자용 한국어 라벨. 시드/위저드가 쓰는 알려진 키만 매핑하고,
// 미매핑 키는 원본 그대로 폴백(조용한 공백 금지) — raw "entry_url" 직노출 대신 의미를 보여준다.
const URL_REF_LABELS: Record<string, string> = {
  entry_url: "접속 주소 (시작 주소)",
  orders_url: "주문 페이지 주소",
  login_url: "로그인 페이지 주소",
  start_url: "시작 주소",
  max_pages: "최대 페이지 수",
};
export function urlRefLabel(key: string): string {
  return URL_REF_LABELS[key] ?? key;
}

export type ScenarioParamFieldKind = "text" | "number" | "checkbox" | "select";

export interface ScenarioParamOption {
  readonly value: string;
  readonly label: string;
}

export interface ScenarioParamField {
  readonly key: string;
  readonly label: string;
  readonly kind: ScenarioParamFieldKind;
  readonly required: boolean;
  readonly defaultValue: string;
  readonly description?: string;
  readonly options?: readonly ScenarioParamOption[];
  readonly placeholder?: string;
  readonly source: "params_schema" | "url_ref";
}

/** ir.nodes 의 모든 navigate.url_ref(=params 키)를 등장 순서로 중복 없이 반환. */
export function extractUrlRefKeys(ir: unknown): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const nodes = (ir as { nodes?: unknown } | null)?.nodes;
  if (nodes === null || typeof nodes !== "object") return keys;
  for (const node of Object.values(nodes as Record<string, unknown>)) {
    const what = (node as { what?: unknown } | null)?.what;
    if (!Array.isArray(what)) continue;
    for (const action of what) {
      if (action !== null && typeof action === "object" && (action as { action?: unknown }).action === "navigate") {
        const ref = (action as { url_ref?: unknown }).url_ref;
        if (typeof ref === "string" && ref.length > 0 && !seen.has(ref)) {
          seen.add(ref);
          keys.push(ref);
        }
      }
    }
  }
  return keys;
}

// ir.params_schema.properties[key].default 를 키→기본값(string) 맵으로 반환한다.
// '쉬운 만들기'가 입력 URL을 params 키의 default 로 실으므로, 실행 대화상자가 이 값으로 입력을 prefill한다.
// (url_ref 는 리터럴 URL이 아니라 키 — 런타임 site-resolution 계약. default 는 string 값만 채택.)
export function extractParamDefaults(ir: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const props = (ir as { params_schema?: { properties?: unknown } | null } | null)?.params_schema?.properties;
  if (props === null || typeof props !== "object") return out;
  for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
    const d = (def as { default?: unknown } | null)?.default;
    if (typeof d === "string" && d.length > 0) out[key] = d;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function schemaRequired(schema: unknown): Set<string> {
  const required = isRecord(schema) && Array.isArray(schema.required) ? schema.required : [];
  return new Set(required.filter((item): item is string => typeof item === "string" && item.length > 0));
}

function schemaProperties(ir: unknown): Record<string, unknown> {
  const schema = (ir as { params_schema?: unknown } | null)?.params_schema;
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  return schema.properties;
}

function defaultToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function fieldKind(def: Record<string, unknown>): ScenarioParamFieldKind {
  if (Array.isArray(def.enum) && def.enum.length > 0) return "select";
  const type = def.type;
  if (type === "boolean") return "checkbox";
  if (type === "number" || type === "integer") return "number";
  return "text";
}

function enumOptions(def: Record<string, unknown>): readonly ScenarioParamOption[] | undefined {
  if (!Array.isArray(def.enum)) return undefined;
  const options = def.enum
    .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    .map((item) => ({ value: String(item), label: String(item) }));
  return options.length > 0 ? options : undefined;
}

function placeholderFor(key: string, def: Record<string, unknown>, kind: ScenarioParamFieldKind): string | undefined {
  if (kind === "number") return "0";
  if (kind === "select" || kind === "checkbox") return undefined;
  const format = stringField(def.format);
  if (format === "uri" || format === "url" || key.endsWith("_url") || key.includes("url")) return "https://…";
  return undefined;
}

function fieldFromSchema(key: string, def: unknown, requiredKeys: ReadonlySet<string>): ScenarioParamField {
  const record = isRecord(def) ? def : {};
  const kind = fieldKind(record);
  return {
    key,
    label: stringField(record.title) ?? urlRefLabel(key),
    kind,
    required: requiredKeys.has(key),
    defaultValue: defaultToString(record.default),
    description: stringField(record.description),
    options: enumOptions(record),
    placeholder: placeholderFor(key, record, kind),
    source: "params_schema",
  };
}

/** params_schema 기반 실행 폼 필드를 반환하고, navigate.url_ref 키는 누락 없이 병합한다. */
export function extractScenarioParamFields(ir: unknown): ScenarioParamField[] {
  const props = schemaProperties(ir);
  const required = schemaRequired((ir as { params_schema?: unknown } | null)?.params_schema);
  const fields = Object.entries(props).map(([key, def]) => fieldFromSchema(key, def, required));
  const seen = new Set(fields.map((field) => field.key));
  for (const key of extractUrlRefKeys(ir)) {
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({
      key,
      label: urlRefLabel(key),
      kind: "text",
      required: true,
      defaultValue: "",
      placeholder: "https://…",
      source: "url_ref",
    });
  }
  return fields;
}

export function isParamFieldMissing(field: ScenarioParamField, value: string): boolean {
  if (!field.required || field.kind === "checkbox") return false;
  return value.trim().length === 0;
}

export function isParamFieldInvalid(field: ScenarioParamField, value: string): boolean {
  if (field.kind !== "number" || value.trim().length === 0) return false;
  return !Number.isFinite(Number(value));
}

export function coerceParamValue(field: ScenarioParamField, value: string): unknown {
  if (field.kind === "checkbox") return value === "true";
  if (field.kind === "number") return Number(value);
  return value.trim();
}

export function shouldIncludeParam(field: ScenarioParamField, value: string): boolean {
  if (field.required || field.kind === "checkbox") return true;
  return value.trim().length > 0;
}
