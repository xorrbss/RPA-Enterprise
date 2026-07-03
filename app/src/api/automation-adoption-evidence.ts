import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { assertIdeaExists, parseKnownBody, validateIdeaId } from "./automation-ideas";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

type AdoptionEvidenceType = "pilot_charter_signoff" | "raci_signoff" | "training_completion" | "support_model_signoff";
type AdoptionEvidenceStatus = "valid" | "failed" | "deferred";

interface AdoptionEvidenceRow {
  readonly id: string;
  readonly automation_idea_id: string;
  readonly evidence_type: AdoptionEvidenceType;
  readonly status: AdoptionEvidenceStatus;
  readonly evidence_at: Date;
  readonly expires_at: Date | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: unknown;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly legal_hold: boolean;
}

interface AdoptionEvidenceInput {
  readonly evidence_type: AdoptionEvidenceType;
  readonly status: AdoptionEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at: string | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legal_hold: boolean;
}

const ADOPTION_EVIDENCE_RETENTION_DAYS = 365;

export function registerAutomationAdoptionEvidenceRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/adoption-evidence",
    { config: { rbacAction: "automation_idea.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const ideaId = validateIdeaId(request.params.ideaId);
      const query = request.query as Record<string, unknown>;
      const limit = parseLimit(query.limit);
      const evidenceType = optionalEvidenceType(query.evidence_type);
      const status = optionalEvidenceStatus(query.status);
      const items = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertIdeaExists(client, ideaId);
        return listAutomationAdoptionEvidence(client, ideaId, { evidenceType, status, limit });
      });
      reply.code(200).send({ items, next_cursor: null });
    },
  );

  app.post<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/adoption-evidence",
    { config: { rbacAction: "automation_idea.manage" } },
    async (request, reply) => {
      const ideaId = validateIdeaId(request.params.ideaId);
      const body = parseAdoptionEvidenceBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "recordAutomationAdoptionEvidence",
        `/v1/automation-ideas/${ideaId}/adoption-evidence`,
        (client, tenantId) => recordAutomationAdoptionEvidence(client, tenantId, request, ideaId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function listAutomationAdoptionEvidence(
  client: PoolClient,
  ideaId: string,
  filter: {
    readonly evidenceType: AdoptionEvidenceType | undefined;
    readonly status: AdoptionEvidenceStatus | undefined;
    readonly limit: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query<AdoptionEvidenceRow>(
    `SELECT id::text, automation_idea_id::text, evidence_type, status, evidence_at, expires_at,
            summary, evidence_ref, metadata, recorded_by, recorded_at, legal_hold
       FROM automation_adoption_evidence
      WHERE automation_idea_id=$1::uuid
        AND deleted_at IS NULL
        AND ($2::text IS NULL OR evidence_type=$2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY recorded_at DESC, id DESC
      LIMIT $4`,
    [ideaId, filter.evidenceType ?? null, filter.status ?? null, filter.limit],
  );
  return result.rows.map(mapAutomationAdoptionEvidence);
}

async function recordAutomationAdoptionEvidence(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  ideaId: string,
  body: AdoptionEvidenceInput,
): Promise<CommandResponse> {
  await assertIdeaExists(client, ideaId);
  const retentionUntil = new Date(Date.now() + ADOPTION_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<AdoptionEvidenceRow>(
    `INSERT INTO automation_adoption_evidence
       (id, tenant_id, automation_idea_id, evidence_type, status, evidence_at, expires_at,
        summary, evidence_ref, metadata, recorded_by, retention_until, legal_hold)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7::timestamptz,
             $8, $9, $10::jsonb, $11, $12::timestamptz, $13)
     RETURNING id::text, automation_idea_id::text, evidence_type, status, evidence_at, expires_at,
               summary, evidence_ref, metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      ideaId,
      body.evidence_type,
      body.status,
      body.evidence_at,
      body.expires_at,
      body.summary,
      body.evidence_ref,
      JSON.stringify(body.metadata),
      requirePrincipal(request).subjectId,
      retentionUntil.toISOString(),
      body.legal_hold,
    ],
  );
  return { status: 201, body: mapAutomationAdoptionEvidence(result.rows[0]) };
}

function parseAdoptionEvidenceBody(raw: unknown): AdoptionEvidenceInput {
  const body = parseKnownBody(raw, [
    "evidence_type",
    "status",
    "evidence_at",
    "expires_at",
    "summary",
    "evidence_ref",
    "metadata",
    "legal_hold",
  ]);
  const status = requireEvidenceStatus(body.status);
  const evidenceAt = parseIsoDateTime(body.evidence_at, "evidence_at");
  const expiresAt = body.expires_at === undefined || body.expires_at === null ? null : parseIsoDateTime(body.expires_at, "expires_at");
  const evidenceRef = body.evidence_ref === undefined || body.evidence_ref === null ? null : parseEvidenceRef(body.evidence_ref);
  if (expiresAt !== null && Date.parse(expiresAt) < Date.parse(evidenceAt)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_before_evidence_at" });
  }
  if (status === "valid" && evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_adoption_evidence_ref_required" });
  }
  if (status === "valid" && (expiresAt === null || Date.parse(expiresAt) <= Date.now())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_adoption_evidence_future_expiry_required" });
  }
  return {
    evidence_type: requireEvidenceType(body.evidence_type),
    status,
    evidence_at: evidenceAt,
    expires_at: expiresAt,
    summary: parseSafeText(body.summary, "summary", 1, 1000),
    evidence_ref: evidenceRef,
    metadata: parseMetadata(body.metadata),
    legal_hold: body.legal_hold === undefined ? false : parseBoolean(body.legal_hold, "legal_hold"),
  };
}

function mapAutomationAdoptionEvidence(row: AdoptionEvidenceRow): Record<string, unknown> {
  return {
    evidence_id: row.id,
    idea_id: row.automation_idea_id,
    evidence_type: row.evidence_type,
    status: row.status,
    evidence_at: row.evidence_at.toISOString(),
    expires_at: row.expires_at === null ? null : row.expires_at.toISOString(),
    summary: row.summary,
    evidence_ref: row.evidence_ref,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function optionalEvidenceType(value: unknown): AdoptionEvidenceType | undefined {
  if (value === undefined) return undefined;
  return requireEvidenceType(value);
}

function requireEvidenceType(value: unknown): AdoptionEvidenceType {
  if (
    value === "pilot_charter_signoff" ||
    value === "raci_signoff" ||
    value === "training_completion" ||
    value === "support_model_signoff"
  ) {
    return value;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_adoption_evidence_type" });
}

function optionalEvidenceStatus(value: unknown): AdoptionEvidenceStatus | undefined {
  if (value === undefined) return undefined;
  return requireEvidenceStatus(value);
}

function requireEvidenceStatus(value: unknown): AdoptionEvidenceStatus {
  if (value === "valid" || value === "failed" || value === "deferred") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_adoption_evidence_status" });
}

function parseIsoDateTime(raw: unknown, field: string): string {
  const value = parseSafeText(raw, field, 1, 80);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return value;
}

function parseEvidenceRef(raw: unknown): string {
  return parseSafeText(raw, "evidence_ref", 1, 500);
}

function parseSafeText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(value, field);
  return value;
}

function parseMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
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
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_document|document_body|training_roster|participant_list|full_text|payload|body)([_.-]|$)/i.test(key);
}
