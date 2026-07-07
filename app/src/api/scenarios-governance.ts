import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { runIdempotentCommand } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps, UUID_RE } from "./server-shared";
import { isRecord, mapScenarioVersion, parseVersionParam, type ScenarioVersionDetailRow } from "./scenarios-support";

interface CertificationBody {
  readonly reason: string;
  readonly expiresAt: string | null;
}

type GovernanceStageUpdate = "review" | "pilot" | "deprecated";

interface GovernanceStageBody {
  readonly stage: GovernanceStageUpdate;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export function registerScenarioGovernanceRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/certify",
    { config: { rbacAction: "scenario.certify" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const body = parseCertificationBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "certifyScenarioVersion",
        `/v1/scenarios/${scenarioId}/versions/${version}/certify`,
        (c, tenantId) => certifyScenarioVersion(c, request, tenantId, scenarioId, version, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/revoke-certification",
    { config: { rbacAction: "scenario.certify" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const reason = parseRequiredReasonBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "revokeScenarioCertification",
        `/v1/scenarios/${scenarioId}/versions/${version}/revoke-certification`,
        (c, tenantId) => revokeScenarioCertification(c, request, tenantId, scenarioId, version, reason),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/governance-stage",
    { config: { rbacAction: "scenario.certify" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const body = parseGovernanceStageBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "setScenarioVersionGovernanceStage",
        `/v1/scenarios/${scenarioId}/versions/${version}/governance-stage`,
        (c, tenantId) => setScenarioVersionGovernanceStage(c, request, tenantId, scenarioId, version, body),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function certifyScenarioVersion(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  version: number,
  body: CertificationBody,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const actor = requirePrincipal(request);
  const result = await client.query<ScenarioVersionDetailRow>(
    `UPDATE scenario_versions sv
        SET certification_status='certified',
            certified_by=$1,
            certified_at=now(),
            certification_expires_at=$2::timestamptz,
            certification_reason=$3,
            certification_revoked_by=NULL,
            certification_revoked_at=NULL,
            certification_revoke_reason=NULL,
            governance_stage='certified',
            governance_reason=$3,
            governance_evidence_ref=concat('certification:', $5::text, ':', $6::text),
            governance_metadata='{}'::jsonb,
            governance_updated_by=$1,
            governance_updated_at=now()
       FROM scenarios s
      WHERE sv.tenant_id=$4::uuid
        AND sv.scenario_id=$5::uuid
        AND sv.version=$6
        AND s.tenant_id=sv.tenant_id
        AND s.id=sv.scenario_id
        AND s.archived_at IS NULL
      RETURNING s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                sv.created_at::text AS created_at,
                sv.promoted_at::text AS promoted_at, sv.ir`,
    [actor.subjectId, body.expiresAt, body.reason, tenantId, scenarioId, version],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  await appendGovernanceAudit(client, request, "scenario.certify", "allow", "scenario_version_certified", {
    scenario_id: scenarioId,
    scenario_version_id: row.version_id,
    version,
    certification_status: row.certification_status,
    certification_expires_at: row.certification_expires_at,
  });
  return { status: 200, body: mapScenarioVersion(row) };
}

async function revokeScenarioCertification(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  version: number,
  reason: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const actor = requirePrincipal(request);
  const result = await client.query<ScenarioVersionDetailRow>(
    `UPDATE scenario_versions sv
        SET certification_status='revoked',
            certification_revoked_by=$1,
            certification_revoked_at=now(),
            certification_revoke_reason=$2,
            governance_stage='deprecated',
            governance_reason=$2,
            governance_evidence_ref=concat('revocation:', $4::text, ':', $5::text),
            governance_metadata='{}'::jsonb,
            governance_updated_by=$1,
            governance_updated_at=now()
       FROM scenarios s
      WHERE sv.tenant_id=$3::uuid
        AND sv.scenario_id=$4::uuid
        AND sv.version=$5
        AND sv.certification_status='certified'
        AND s.tenant_id=sv.tenant_id
        AND s.id=sv.scenario_id
        AND s.archived_at IS NULL
      RETURNING s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                sv.created_at::text AS created_at,
                sv.promoted_at::text AS promoted_at, sv.ir`,
    [actor.subjectId, reason, tenantId, scenarioId, version],
  );
  const row = result.rows[0];
  if (row === undefined) {
    const existing = await client.query<{ certification_status: string }>(
      `SELECT sv.certification_status
         FROM scenario_versions sv
         JOIN scenarios s ON s.tenant_id=sv.tenant_id AND s.id=sv.scenario_id
        WHERE sv.tenant_id=$1::uuid AND sv.scenario_id=$2::uuid AND sv.version=$3 AND s.archived_at IS NULL`,
      [tenantId, scenarioId, version],
    );
    const current = existing.rows[0]?.certification_status;
    if (current === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_not_certified", certification_status: current });
  }
  await appendGovernanceAudit(client, request, "scenario.decertify", "allow", "scenario_version_certification_revoked", {
    scenario_id: scenarioId,
    scenario_version_id: row.version_id,
    version,
    certification_status: row.certification_status,
  });
  return { status: 200, body: mapScenarioVersion(row) };
}

async function setScenarioVersionGovernanceStage(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  version: number,
  body: GovernanceStageBody,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const actor = requirePrincipal(request);
  const result = await client.query<ScenarioVersionDetailRow>(
    `UPDATE scenario_versions sv
        SET governance_stage=$1,
            governance_reason=$2,
            governance_evidence_ref=$3,
            governance_metadata=$4::jsonb,
            governance_updated_by=$5,
            governance_updated_at=now()
       FROM scenarios s
      WHERE sv.tenant_id=$6::uuid
        AND sv.scenario_id=$7::uuid
        AND sv.version=$8
        AND s.tenant_id=sv.tenant_id
        AND s.id=sv.scenario_id
        AND s.archived_at IS NULL
      RETURNING s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                sv.created_at::text AS created_at,
                sv.promoted_at::text AS promoted_at, sv.ir`,
    [
      body.stage,
      body.reason,
      body.evidenceRef,
      JSON.stringify({ ...body.metadata, legal_hold: body.legalHold }),
      actor.subjectId,
      tenantId,
      scenarioId,
      version,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  await appendGovernanceAudit(client, request, "scenario.certify", "allow", "scenario_version_governance_stage_set", {
    scenario_id: scenarioId,
    scenario_version_id: row.version_id,
    version,
    governance_stage: row.governance_stage,
    governance_evidence_ref: row.governance_evidence_ref,
  });
  return { status: 200, body: mapScenarioVersion(row) };
}

function parseCertificationBody(raw: unknown): CertificationBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason" && key !== "expires_at") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  return {
    reason: parseRequiredReason(raw.reason),
    expiresAt: parseOptionalFutureInstant(raw.expires_at),
  };
}

function parseRequiredReasonBody(raw: unknown): string {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  return parseRequiredReason(raw.reason);
}

function parseGovernanceStageBody(raw: unknown): GovernanceStageBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "stage" && key !== "reason" && key !== "evidence_ref" && key !== "metadata" && key !== "legal_hold") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  return {
    stage: parseGovernanceStage(raw.stage),
    reason: parseSafeGovernanceString(raw.reason, "reason", 1, 500),
    evidenceRef: parseSafeGovernanceString(raw.evidence_ref, "evidence_ref", 1, 500),
    metadata: parseGovernanceMetadata(raw.metadata),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseGovernanceStage(raw: unknown): GovernanceStageUpdate {
  if (raw === "review" || raw === "pilot" || raw === "deprecated") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_governance_stage" });
}

function parseRequiredReason(raw: unknown): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required" });
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required" });
  return trimmed.slice(0, 500);
}

function parseOptionalFutureInstant(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
  if (parsed <= Date.now()) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  return new Date(parsed).toISOString();
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseSafeGovernanceString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
  const trimmed = raw.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeGovernanceString(trimmed, field);
  return trimmed;
}

function parseGovernanceMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeGovernanceMetadata(raw, "metadata", 0);
  return raw;
}

function assertSafeGovernanceMetadata(value: unknown, path: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", path });
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeGovernanceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", path });
    value.forEach((item, index) => assertSafeGovernanceMetadata(item, `${path}.${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  const entries = Object.entries(value);
  if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", path });
  for (const [key, child] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenGovernanceEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeGovernanceMetadata(child, `${path}.${key}`, depth + 1);
  }
}

function assertSafeGovernanceString(value: string, path: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", path });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenGovernanceEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_approval_packet|approval_packet|raw_roster|participant_list|full_text|payload|body)([_.-]|$)/i.test(key);
}
