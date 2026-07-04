import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { UUID_RE } from "./server-shared";

export type IdeaStage = "intake" | "assess" | "approved" | "build" | "operate" | "rejected" | "archived";
export type IdeaPriority = "low" | "medium" | "high" | "critical";
export type IdeaSource = "manual" | "process_mining" | "task_mining" | "imported";

export interface IdeaCreateBody {
  title: string;
  description: string;
  business_owner: string;
  department: string;
  source: IdeaSource;
  priority: IdeaPriority;
  score: number;
  source_import_id: string | null;
  source_item_ref: string | null;
  source_lineage: Readonly<Record<string, unknown>>;
}

export interface IdeaUpdateBody {
  title?: string;
  description?: string;
  business_owner?: string;
  department?: string;
  priority?: IdeaPriority;
  score?: number;
  scenario_id?: string | null;
  run_trigger_id?: string | null;
}

export function parseCreateBody(raw: unknown): IdeaCreateBody {
  const body = parseKnownBody(raw, [
    "title",
    "description",
    "business_owner",
    "department",
    "source",
    "priority",
    "score",
    "source_import_id",
    "source_item_ref",
    "source_lineage",
  ]);
  const source = optionalSource(body.source) ?? "manual";
  const sourceImportId = optionalUuid(body.source_import_id, "source_import_id") ?? null;
  const sourceItemRef = body.source_item_ref === undefined ? null : requireSafeText(body.source_item_ref, "source_item_ref", 1, 200);
  const sourceLineage = parseSourceLineage(body.source_lineage);
  assertLineageMatchesSource(source, sourceImportId, sourceItemRef, sourceLineage);
  return {
    title: requireText(body.title, "title"),
    description: requireText(body.description, "description"),
    business_owner: requireText(body.business_owner, "business_owner"),
    department: requireText(body.department, "department"),
    source,
    priority: optionalPriority(body.priority) ?? "medium",
    score: optionalScore(body.score) ?? 0,
    source_import_id: sourceImportId,
    source_item_ref: sourceItemRef,
    source_lineage: sourceLineage,
  };
}

export function parseUpdateBody(raw: unknown): IdeaUpdateBody {
  const body = parseKnownBody(raw, ["title", "description", "business_owner", "department", "priority", "score", "scenario_id", "run_trigger_id"]);
  if (Object.keys(body).length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  return {
    title: body.title === undefined ? undefined : requireText(body.title, "title"),
    description: body.description === undefined ? undefined : requireText(body.description, "description"),
    business_owner: body.business_owner === undefined ? undefined : requireText(body.business_owner, "business_owner"),
    department: body.department === undefined ? undefined : requireText(body.department, "department"),
    priority: optionalPriority(body.priority),
    score: optionalScore(body.score),
    scenario_id: optionalUuidOrNull(body.scenario_id, "scenario_id"),
    run_trigger_id: optionalUuidOrNull(body.run_trigger_id, "run_trigger_id"),
  };
}

export function parseTransitionBody(raw: unknown): IdeaStage {
  const body = parseKnownBody(raw, ["stage"]);
  return requireStage(body.stage);
}

export function parseKnownBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
  return raw;
}

export function validateIdeaId(value: unknown): string {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

function requireText(value: unknown, field: string): string {
  return requireSafeText(value, field, 1, field === "description" ? 2000 : 240);
}

function requireStage(value: unknown): IdeaStage {
  if (value === "intake" || value === "assess" || value === "approved" || value === "build" || value === "operate" || value === "rejected" || value === "archived") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_stage" });
}

export function optionalStage(value: unknown): IdeaStage | undefined {
  if (value === undefined) return undefined;
  return requireStage(value);
}

function optionalPriority(value: unknown): IdeaPriority | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_priority" });
}

function optionalSource(value: unknown): IdeaSource | undefined {
  if (value === undefined) return undefined;
  if (value === "manual" || value === "process_mining" || value === "task_mining" || value === "imported") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source" });
}

function optionalScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_score" });
}

function optionalUuidOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

export function optionalStringFilter(value: unknown, reason: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const text = value.trim();
    assertSafeEvidenceString(text, reason);
    return text;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function requireSafeText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
  const text = value.trim();
  if (text.length < min || text.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(text, field);
  return text;
}

function parseSourceLineage(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_lineage_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_lineage_too_large" });
  assertSafeMetadata(raw, "source_lineage", 0);
  return raw;
}

function assertLineageMatchesSource(
  source: IdeaSource,
  sourceImportId: string | null,
  sourceItemRef: string | null,
  sourceLineage: Readonly<Record<string, unknown>>,
): void {
  const hasLineage = Object.keys(sourceLineage).length > 0;
  if (source === "manual" && (sourceImportId !== null || sourceItemRef !== null || hasLineage)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "manual_source_must_not_have_import_lineage" });
  }
  if ((source === "process_mining" || source === "task_mining") && (sourceImportId === null || sourceItemRef === null || !hasLineage)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "import_lineage_required_for_mining_source" });
  }
  if (source === "imported") {
    const hasAnyImportLineage = sourceImportId !== null || sourceItemRef !== null || hasLineage;
    const hasCompleteImportLineage = sourceImportId !== null && sourceItemRef !== null && hasLineage;
    if (hasAnyImportLineage && !hasCompleteImportLineage) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "imported_lineage_incomplete" });
    }
  }
}

function assertSafeMetadata(value: unknown, path: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", path });
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeEvidenceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", path });
    value.forEach((item, index) => assertSafeMetadata(item, `${path}.${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  const entries = Object.entries(value);
  if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", path });
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(item, `${path}.${key}`, depth + 1);
  }
}

function assertSafeEvidenceString(value: string, path: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", path });
  }
  if (/\bauthorization\b/i.test(value) || /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|auth_header|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_payload|raw_activity|payload|body|host|hostname|agent_id|device_id)([_.-]|$)/i.test(key);
}
