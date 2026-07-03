import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { parseKnownBody } from "./automation-ideas";

type ProcessMiningImportSourceType = "process_mining" | "task_mining" | "monitoring_export" | "api_import";
type ProcessMiningImportStatus = "received" | "processed" | "blocked";
type AnonymizationMode = "aggregated_alias" | "pseudonymized" | "not_applicable";

interface ProcessMiningImportRow {
  id: string;
  source_type: ProcessMiningImportSourceType;
  source_system: string;
  source_owner_ref: string;
  schema_version: string;
  import_evidence_ref: string;
  lineage_ref: string;
  row_count: number;
  candidate_count: number;
  anonymization_mode: AnonymizationMode;
  schema_mapping: unknown;
  import_summary: string;
  status: ProcessMiningImportStatus;
  blocked_reason: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface ProcessMiningImportCreateBody {
  source_type: ProcessMiningImportSourceType;
  source_system: string;
  source_owner_ref: string;
  schema_version: string;
  import_evidence_ref: string;
  lineage_ref: string;
  row_count: number;
  candidate_count: number;
  anonymization_mode: AnonymizationMode;
  schema_mapping: Readonly<Record<string, unknown>>;
  import_summary: string;
  status: ProcessMiningImportStatus;
  blocked_reason: string | null;
}

const REQUIRED_MAPPING_KEYS: Readonly<Record<ProcessMiningImportSourceType, readonly string[]>> = {
  process_mining: ["case_id", "activity", "timestamp"],
  task_mining: ["task_name", "application_alias", "timestamp"],
  monitoring_export: ["case_id", "activity", "timestamp"],
  api_import: ["case_id", "activity", "timestamp"],
};

export function registerProcessMiningImportRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/process-mining/imports", { config: { rbacAction: "automation_idea.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const sourceType = optionalSourceType(query.source_type);
    const status = optionalStatus(query.status);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<ProcessMiningImportRow>(
        `SELECT id, source_type, source_system, source_owner_ref, schema_version, import_evidence_ref,
                lineage_ref, row_count, candidate_count, anonymization_mode, schema_mapping,
                import_summary, status, blocked_reason, created_by, created_at, updated_at,
                created_at::text AS cursor_at
           FROM process_mining_imports
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR source_type = $2)
            AND ($3::text IS NULL OR status = $3)
            AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $6`,
        [principal.tenantId, sourceType ?? null, status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapImport));
  });

  app.post("/v1/process-mining/imports", { config: { rbacAction: "automation_idea.manage" } }, async (request, reply) => {
    const body = parseCreateBody(request.body);
    const result = await runIdempotentCommand(deps, request, "createProcessMiningImport", "/v1/process-mining/imports", (client, tenantId) =>
      createProcessMiningImport(client, tenantId, request, body),
    );
    reply.code(result.status).send(result.body);
  });
}

async function createProcessMiningImport(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  body: ProcessMiningImportCreateBody,
): Promise<CommandResponse> {
  const result = await client.query<ProcessMiningImportRow>(
    `INSERT INTO process_mining_imports
       (id, tenant_id, source_type, source_system, source_owner_ref, schema_version,
        import_evidence_ref, lineage_ref, row_count, candidate_count, anonymization_mode,
        schema_mapping, import_summary, status, blocked_reason, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
     RETURNING id, source_type, source_system, source_owner_ref, schema_version, import_evidence_ref,
               lineage_ref, row_count, candidate_count, anonymization_mode, schema_mapping,
               import_summary, status, blocked_reason, created_by, created_at, updated_at,
               created_at::text AS cursor_at`,
    [
      randomUUID(),
      tenantId,
      body.source_type,
      body.source_system,
      body.source_owner_ref,
      body.schema_version,
      body.import_evidence_ref,
      body.lineage_ref,
      body.row_count,
      body.candidate_count,
      body.anonymization_mode,
      JSON.stringify(body.schema_mapping),
      body.import_summary,
      body.status,
      body.blocked_reason,
      requirePrincipal(request).subjectId,
    ],
  );
  return { status: 201, body: mapImport(result.rows[0]) };
}

function parseCreateBody(raw: unknown): ProcessMiningImportCreateBody {
  const body = parseKnownBody(raw, [
    "source_type",
    "source_system",
    "source_owner_ref",
    "schema_version",
    "import_evidence_ref",
    "lineage_ref",
    "row_count",
    "candidate_count",
    "anonymization_mode",
    "schema_mapping",
    "import_summary",
    "status",
    "blocked_reason",
  ]);
  const sourceType = requireSourceType(body.source_type);
  const rowCount = parsePositiveInteger(body.row_count, "row_count", 1_000_000_000);
  const candidateCount = parseNonNegativeInteger(body.candidate_count, "candidate_count", rowCount);
  const status = optionalStatus(body.status) ?? "received";
  const blockedReason = body.blocked_reason === undefined || body.blocked_reason === null
    ? null
    : parseSafeString(body.blocked_reason, "blocked_reason", 1, 1000);
  if (status === "blocked" && blockedReason === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "blocked_reason_required" });
  }
  if (status !== "blocked" && blockedReason !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "blocked_reason_requires_blocked_status" });
  }
  return {
    source_type: sourceType,
    source_system: parseSafeString(body.source_system, "source_system", 1, 120),
    source_owner_ref: parseSafeString(body.source_owner_ref, "source_owner_ref", 1, 160),
    schema_version: parseSafeString(body.schema_version, "schema_version", 1, 80),
    import_evidence_ref: parseSafeString(body.import_evidence_ref, "import_evidence_ref", 1, 500),
    lineage_ref: parseSafeString(body.lineage_ref, "lineage_ref", 1, 500),
    row_count: rowCount,
    candidate_count: candidateCount,
    anonymization_mode: optionalAnonymizationMode(body.anonymization_mode) ?? "aggregated_alias",
    schema_mapping: parseSchemaMapping(body.schema_mapping, sourceType),
    import_summary: parseSafeString(body.import_summary, "import_summary", 1, 1000),
    status,
    blocked_reason: blockedReason,
  };
}

function requireSourceType(value: unknown): ProcessMiningImportSourceType {
  const parsed = optionalSourceType(value);
  if (parsed !== undefined) return parsed;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source_type" });
}

function optionalSourceType(value: unknown): ProcessMiningImportSourceType | undefined {
  if (value === undefined) return undefined;
  if (value === "process_mining" || value === "task_mining" || value === "monitoring_export" || value === "api_import") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source_type" });
}

function optionalStatus(value: unknown): ProcessMiningImportStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "received" || value === "processed" || value === "blocked") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_import_status" });
}

function optionalAnonymizationMode(value: unknown): AnonymizationMode | undefined {
  if (value === undefined) return undefined;
  if (value === "aggregated_alias" || value === "pseudonymized" || value === "not_applicable") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_anonymization_mode" });
}

function parsePositiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseNonNegativeInteger(value: unknown, field: string, max: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseSchemaMapping(value: unknown, sourceType: ProcessMiningImportSourceType): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "schema_mapping_required" });
  if (JSON.stringify(value).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "schema_mapping_too_large" });
  assertSafeMetadata(value, "schema_mapping", 0);
  for (const key of REQUIRED_MAPPING_KEYS[sourceType]) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "schema_mapping_required_key_missing", key });
    }
  }
  return value;
}

function parseSafeString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const text = value.trim();
  if (text.length < min || text.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(text, field);
  return text;
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
  for (const [key, child] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(child, `${path}.${key}`, depth + 1);
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

function mapImport(row: ProcessMiningImportRow): Record<string, unknown> {
  return {
    import_id: row.id,
    source_type: row.source_type,
    source_system: row.source_system,
    source_owner_ref: row.source_owner_ref,
    schema_version: row.schema_version,
    import_evidence_ref: row.import_evidence_ref,
    lineage_ref: row.lineage_ref,
    row_count: row.row_count,
    candidate_count: row.candidate_count,
    anonymization_mode: row.anonymization_mode,
    schema_mapping: isRecord(row.schema_mapping) ? row.schema_mapping : {},
    import_summary: row.import_summary,
    status: row.status,
    blocked_reason: row.blocked_reason,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
