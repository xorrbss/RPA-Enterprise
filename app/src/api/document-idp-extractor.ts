export type DocumentFieldType = "text" | "number" | "date" | "boolean";
export type DocumentFieldStatus = "extracted" | "missing" | "low_confidence";
export type DocumentFieldSource = "json" | "csv" | "pattern" | "label" | "missing";
export type DocumentExtractionStatus = "completed" | "validation_required";

export interface DocumentFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: DocumentFieldType;
  readonly aliases: readonly string[];
  readonly patterns: readonly string[];
  readonly minConfidence: number;
}

export interface DocumentExtractionField {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly confidence: number;
  readonly status: DocumentFieldStatus;
  readonly source: DocumentFieldSource;
}

export interface DocumentExtractionResult {
  readonly engine: "built_in_deterministic_text_v1";
  readonly status: DocumentExtractionStatus;
  readonly fields: readonly DocumentExtractionField[];
  readonly missingFields: readonly string[];
}

const FIELD_KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const FIELD_TYPES = new Set<DocumentFieldType>(["text", "number", "date", "boolean"]);

export function parseDocumentFieldSchema(value: unknown): readonly DocumentFieldSchema[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DocumentExtractorInputError("field_schema must contain at least one field");
  }
  return value.map((item, index) => parseField(item, index));
}

export function extractDocumentFields(content: string, schema: readonly DocumentFieldSchema[]): DocumentExtractionResult {
  const json = parseJsonRecord(content);
  const csv = parseCsvRecord(content);
  const fields = schema.map((field) => extractField(content, json, csv, field));
  const missingFields = fields
    .filter((field, index) => field.status === "low_confidence" || (field.status === "missing" && schema[index]?.required === true))
    .map((field) => field.key);
  return {
    engine: "built_in_deterministic_text_v1",
    status: missingFields.length > 0 ? "validation_required" : "completed",
    fields,
    missingFields,
  };
}

export class DocumentExtractorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractorInputError";
  }
}

function parseField(value: unknown, index: number): DocumentFieldSchema {
  if (!isRecord(value)) throw new DocumentExtractorInputError(`field_schema[${index}] must be an object`);
  const key = stringField(value, "key", index);
  if (!FIELD_KEY_RE.test(key)) throw new DocumentExtractorInputError(`field_schema[${index}].key is invalid`);
  const label = optionalString(value.label, key);
  const type = optionalType(value.type);
  const aliases = stringArray(value.aliases);
  const patterns = stringArray(value.patterns);
  validatePatterns(patterns, index);
  const minConfidence = optionalConfidence(value.min_confidence);
  return {
    key,
    label,
    required: value.required === true,
    type,
    aliases,
    patterns,
    minConfidence,
  };
}

function stringField(value: Record<string, unknown>, key: string, index: number): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new DocumentExtractorInputError(`field_schema[${index}].${key} is required`);
  }
  return raw.trim();
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalType(value: unknown): DocumentFieldType {
  if (value === undefined) return "text";
  if (typeof value === "string" && FIELD_TYPES.has(value as DocumentFieldType)) return value as DocumentFieldType;
  throw new DocumentExtractorInputError("field type is invalid");
}

function optionalConfidence(value: unknown): number {
  if (value === undefined) return 0.8;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DocumentExtractorInputError("min_confidence must be between 0 and 1");
  }
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DocumentExtractorInputError("string array expected");
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function validatePatterns(patterns: readonly string[], index: number): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "iu");
    } catch {
      throw new DocumentExtractorInputError(`field_schema[${index}].patterns contains an invalid regex`);
    }
  }
}

function extractField(
  content: string,
  json: Record<string, unknown> | null,
  csv: Record<string, string> | null,
  field: DocumentFieldSchema,
): DocumentExtractionField {
  const names = [field.key, field.label, ...field.aliases];
  const jsonValue = lookupRecord(json, names);
  if (jsonValue !== null) return completed(field, jsonValue, 0.98, "json");
  const csvValue = lookupRecord(csv, names);
  if (csvValue !== null) return completed(field, csvValue, 0.93, "csv");
  const patternValue = lookupPatterns(content, field.patterns);
  if (patternValue !== null) return completed(field, patternValue, 0.86, "pattern");
  const labelValue = lookupLabel(content, names);
  if (labelValue !== null) return completed(field, labelValue, 0.78, "label");
  return { key: field.key, label: field.label, value: null, confidence: 0, status: "missing", source: "missing" };
}

function completed(
  field: DocumentFieldSchema,
  rawValue: unknown,
  confidence: number,
  source: DocumentFieldSource,
): DocumentExtractionField {
  const value = normalizeValue(rawValue);
  const status: DocumentFieldStatus = confidence >= field.minConfidence ? "extracted" : "low_confidence";
  return { key: field.key, label: field.label, value, confidence, status, source };
}

function lookupRecord(record: Record<string, unknown> | null, names: readonly string[]): unknown | null {
  if (record === null) return null;
  const entries = Object.entries(record);
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match !== undefined) return match[1];
  }
  return null;
}

function lookupPatterns(content: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    const match = new RegExp(pattern, "iu").exec(content);
    const value = match?.[1] ?? match?.[0];
    if (value !== undefined && value.trim().length > 0) return trimValue(value);
  }
  return null;
}

function lookupLabel(content: string, names: readonly string[]): string | null {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:=]\\s*([^\\n\\r]+)`, "iu").exec(content);
    const value = match?.[1];
    if (value !== undefined && value.trim().length > 0) return trimValue(value);
  }
  return null;
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCsvRecord(content: string): Record<string, string> | null {
  const rows = parseCsvRows(content);
  if (rows === null) return null;
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length < 2) return null;
  const headers = nonEmptyRows[0] ?? [];
  const values = nonEmptyRows[1] ?? [];
  if (headers.length < 2 || headers.length !== values.length) return null;
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
}

function parseCsvRows(content: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldQuoted = false;

  function pushField(): void {
    row.push(fieldQuoted ? field : trimValue(field));
    field = "";
    fieldQuoted = false;
  }

  function pushRow(): void {
    pushField();
    rows.push(row);
    row = [];
  }

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inQuotes) {
      if (char === "\"") {
        if (content[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"" && field.trim().length === 0) {
      inQuotes = true;
      fieldQuoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (content[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      field += char;
    }
  }

  if (inQuotes) return null;
  if (field.length > 0 || fieldQuoted || row.length > 0) pushRow();
  return rows;
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return trimValue(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function trimValue(value: string): string {
  return value.trim().replace(/^["']|["']$/gu, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
