import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { parseAiRuntimePolicyRequest, readAiRuntimePolicy, upsertAiRuntimePolicy } from "./ai-governance-enforcement";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";

type AiGovernanceEvidenceType = "model_registry" | "prompt_registry" | "eval_result" | "cost_control" | "human_override";
type AiGovernanceEvidenceStatus = "valid" | "failed" | "deferred";

interface AiGovernanceEvidenceRow {
  readonly id: string;
  readonly evidence_type: AiGovernanceEvidenceType;
  readonly subject_ref: string;
  readonly status: AiGovernanceEvidenceStatus;
  readonly evidence_at: Date;
  readonly expires_at: Date | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly policy_decision_ref: string | null;
  readonly audit_correlation_id: string | null;
  readonly metadata: unknown;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly legal_hold: boolean;
}

interface AiGovernanceEvidenceInput {
  readonly evidenceType: AiGovernanceEvidenceType;
  readonly subjectRef: string;
  readonly status: AiGovernanceEvidenceStatus;
  readonly evidenceAt: Date;
  readonly expiresAt: Date | null;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly policyDecisionRef: string | null;
  readonly auditCorrelationId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

interface AiGovernanceEvidenceSummaryRow {
  readonly total_count: number;
  readonly valid_count: number;
  readonly deferred_count: number;
  readonly failed_count: number;
  readonly expired_valid_count: number;
  readonly latest_evidence_type: AiGovernanceEvidenceType | null;
  readonly latest_status: AiGovernanceEvidenceStatus | null;
  readonly latest_subject_ref: string | null;
  readonly latest_evidence_at: Date | null;
  readonly latest_recorded_at: Date | null;
}

interface AiGovernanceEvidenceTypeSummaryRow {
  readonly evidence_type: AiGovernanceEvidenceType;
  readonly total_count: number;
  readonly valid_count: number;
  readonly deferred_count: number;
  readonly failed_count: number;
}

const AI_GOVERNANCE_EVIDENCE_RETENTION_DAYS = 365;

export function registerAiGovernanceEvidenceRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/ai-governance/runtime-policy", { config: { rbacAction: "ai_governance.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const policy = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      readAiRuntimePolicy(client, principal.tenantId),
    );
    reply.code(200).send(policy === null ? { configured: false } : { configured: true, policy });
  });

  app.put("/v1/ai-governance/runtime-policy", { config: { rbacAction: "ai_governance.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseAiRuntimePolicyRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "upsertAiRuntimePolicy",
      "/v1/ai-governance/runtime-policy",
      (client, tenantId) => upsertAiRuntimePolicy(client, tenantId, principal.subjectId, body),
    );
    reply.code(response.status).send(response.body);
  });

  app.get("/v1/ai-governance/evidence", { config: { rbacAction: "ai_governance.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const evidenceType = parseEvidenceTypeQuery(query.evidence_type);
    const status = parseEvidenceStatusQuery(query.status);
    const subjectRef = parseSubjectRefQuery(query.subject_ref);
    const limit = parseLimit(query.limit);
    const items = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listAiGovernanceEvidence(client, { evidenceType, status, subjectRef, limit }),
    );
    reply.code(200).send({ items, next_cursor: null });
  });

  app.get("/v1/ai-governance/evidence/summary", { config: { rbacAction: "ai_governance.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const evidenceType = parseEvidenceTypeQuery(query.evidence_type);
    const status = parseEvidenceStatusQuery(query.status);
    const subjectRef = parseSubjectRefQuery(query.subject_ref);
    const summary = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      summarizeAiGovernanceEvidence(client, { evidenceType, status, subjectRef }),
    );
    reply.code(200).send(summary);
  });

  app.post("/v1/ai-governance/evidence", { config: { rbacAction: "ai_governance.manage" } }, async (request, reply) => {
    const body = parseAiGovernanceEvidenceRequest(request.body);
    const principal = requirePrincipal(request);
    const response = await runIdempotentCommand(
      deps,
      request,
      "recordAiGovernanceEvidence",
      "/v1/ai-governance/evidence",
      (client, tenantId) => recordAiGovernanceEvidence(client, tenantId, request, principal.subjectId, body),
    );
    reply.code(response.status).send(response.body);
  });
}

async function listAiGovernanceEvidence(
  client: PoolClient,
  filter: {
    readonly evidenceType: AiGovernanceEvidenceType | undefined;
    readonly status: AiGovernanceEvidenceStatus | undefined;
    readonly subjectRef: string | undefined;
    readonly limit: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query<AiGovernanceEvidenceRow>(
    `SELECT id::text, evidence_type, subject_ref, status, evidence_at, expires_at,
            summary, evidence_ref, policy_decision_ref, audit_correlation_id::text,
            metadata, recorded_by, recorded_at, legal_hold
       FROM ai_governance_evidence
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR evidence_type = $1::text)
        AND ($2::text IS NULL OR status = $2::text)
        AND ($3::text IS NULL OR subject_ref = $3::text)
      ORDER BY evidence_at DESC, recorded_at DESC, id DESC
      LIMIT $4`,
    [filter.evidenceType ?? null, filter.status ?? null, filter.subjectRef ?? null, filter.limit],
  );
  return result.rows.map(mapAiGovernanceEvidence);
}

async function summarizeAiGovernanceEvidence(
  client: PoolClient,
  filter: {
    readonly evidenceType: AiGovernanceEvidenceType | undefined;
    readonly status: AiGovernanceEvidenceStatus | undefined;
    readonly subjectRef: string | undefined;
  },
): Promise<Record<string, unknown>> {
  const params = [filter.evidenceType ?? null, filter.status ?? null, filter.subjectRef ?? null];
  const summary = await client.query<AiGovernanceEvidenceSummaryRow>(
    `WITH filtered AS (
       SELECT evidence_type, subject_ref, status, evidence_at, expires_at, recorded_at
         FROM ai_governance_evidence
        WHERE deleted_at IS NULL
          AND ($1::text IS NULL OR evidence_type = $1::text)
          AND ($2::text IS NULL OR status = $2::text)
          AND ($3::text IS NULL OR subject_ref = $3::text)
     ),
     latest AS (
       SELECT evidence_type AS latest_evidence_type,
              status AS latest_status,
              subject_ref AS latest_subject_ref,
              evidence_at AS latest_evidence_at,
              recorded_at AS latest_recorded_at
         FROM filtered
        ORDER BY evidence_at DESC, recorded_at DESC
        LIMIT 1
     )
     SELECT count(*)::int AS total_count,
            count(*) FILTER (WHERE status = 'valid')::int AS valid_count,
            count(*) FILTER (WHERE status = 'deferred')::int AS deferred_count,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
            count(*) FILTER (WHERE status = 'valid' AND expires_at IS NOT NULL AND expires_at <= now())::int AS expired_valid_count,
            latest.latest_evidence_type,
            latest.latest_status,
            latest.latest_subject_ref,
            latest.latest_evidence_at,
            latest.latest_recorded_at
       FROM filtered
       LEFT JOIN latest ON true
      GROUP BY latest.latest_evidence_type, latest.latest_status, latest.latest_subject_ref, latest.latest_evidence_at, latest.latest_recorded_at`,
    params,
  );
  const byType = await client.query<AiGovernanceEvidenceTypeSummaryRow>(
    `SELECT evidence_type,
            count(*)::int AS total_count,
            count(*) FILTER (WHERE status = 'valid')::int AS valid_count,
            count(*) FILTER (WHERE status = 'deferred')::int AS deferred_count,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_count
       FROM ai_governance_evidence
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR evidence_type = $1::text)
        AND ($2::text IS NULL OR status = $2::text)
        AND ($3::text IS NULL OR subject_ref = $3::text)
      GROUP BY evidence_type
      ORDER BY evidence_type`,
    params,
  );
  const row = summary.rows[0] ?? {
    total_count: 0,
    valid_count: 0,
    deferred_count: 0,
    failed_count: 0,
    expired_valid_count: 0,
    latest_evidence_type: null,
    latest_status: null,
    latest_subject_ref: null,
    latest_evidence_at: null,
    latest_recorded_at: null,
  };
  return {
    total_count: row.total_count,
    status_counts: {
      valid: row.valid_count,
      deferred: row.deferred_count,
      failed: row.failed_count,
    },
    expired_valid_count: row.expired_valid_count,
    latest: row.latest_evidence_type === null ? null : {
      evidence_type: row.latest_evidence_type,
      status: row.latest_status,
      subject_ref: row.latest_subject_ref,
      evidence_at: row.latest_evidence_at?.toISOString() ?? null,
      recorded_at: row.latest_recorded_at?.toISOString() ?? null,
    },
    type_status_counts: byType.rows.map((item) => ({
      evidence_type: item.evidence_type,
      total_count: item.total_count,
      valid: item.valid_count,
      deferred: item.deferred_count,
      failed: item.failed_count,
    })),
    filters: {
      evidence_type: filter.evidenceType ?? null,
      status: filter.status ?? null,
      subject_ref: filter.subjectRef ?? null,
    },
  };
}

async function recordAiGovernanceEvidence(
  client: PoolClient,
  tenantId: string,
  _request: FastifyRequest,
  recordedBy: string,
  input: AiGovernanceEvidenceInput,
): Promise<CommandResponse> {
  if (input.auditCorrelationId !== null) {
    await assertAuditCorrelationExists(client, tenantId, input.auditCorrelationId);
  }
  const retentionUntil = new Date(Date.now() + AI_GOVERNANCE_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<AiGovernanceEvidenceRow>(
    `INSERT INTO ai_governance_evidence (
       id, tenant_id, evidence_type, subject_ref, status, evidence_at, expires_at,
       summary, evidence_ref, policy_decision_ref, audit_correlation_id, metadata,
       recorded_by, retention_until, legal_hold
     )
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$7::timestamptz,
             $8,$9,$10,$11::uuid,$12::jsonb,$13,$14::timestamptz,$15)
     RETURNING id::text, evidence_type, subject_ref, status, evidence_at, expires_at,
               summary, evidence_ref, policy_decision_ref, audit_correlation_id::text,
               metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      input.evidenceType,
      input.subjectRef,
      input.status,
      input.evidenceAt.toISOString(),
      input.expiresAt?.toISOString() ?? null,
      input.summary,
      input.evidenceRef,
      input.policyDecisionRef,
      input.auditCorrelationId,
      JSON.stringify(input.metadata),
      recordedBy,
      retentionUntil.toISOString(),
      input.legalHold,
    ],
  );
  return { status: 201, body: mapAiGovernanceEvidence(result.rows[0]) };
}

async function assertAuditCorrelationExists(client: PoolClient, tenantId: string, correlationId: string): Promise<void> {
  const result = await client.query<{ found: number }>(
    `SELECT 1 AS found
       FROM audit_log
      WHERE tenant_id = $1::uuid
        AND correlation_id = $2::uuid
      LIMIT 1`,
    [tenantId, correlationId],
  );
  if (result.rowCount === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "audit_correlation_not_found", field: "audit_correlation_id" });
  }
}

function mapAiGovernanceEvidence(row: AiGovernanceEvidenceRow): Record<string, unknown> {
  return {
    evidence_id: row.id,
    evidence_type: row.evidence_type,
    subject_ref: row.subject_ref,
    status: row.status,
    evidence_at: row.evidence_at.toISOString(),
    expires_at: row.expires_at?.toISOString() ?? null,
    summary: row.summary,
    evidence_ref: row.evidence_ref,
    policy_decision_ref: row.policy_decision_ref,
    audit_correlation_id: row.audit_correlation_id,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function parseAiGovernanceEvidenceRequest(raw: unknown): AiGovernanceEvidenceInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_governance_evidence_body_expected_object" });
  const allowed = new Set([
    "evidence_type",
    "subject_ref",
    "status",
    "evidence_at",
    "expires_at",
    "summary",
    "evidence_ref",
    "policy_decision_ref",
    "audit_correlation_id",
    "metadata",
    "legal_hold",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_governance_evidence_unknown_field", field: key });
  }
  const evidenceType = parseEvidenceType(raw.evidence_type);
  const status = parseEvidenceStatus(raw.status);
  const evidenceAt = parseIsoDate(raw.evidence_at, "evidence_at");
  const expiresAt = raw.expires_at === undefined || raw.expires_at === null ? null : parseIsoDate(raw.expires_at, "expires_at");
  const now = Date.now();
  if (evidenceAt.getTime() > now + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "evidence_at_in_future" });
  }
  if (expiresAt !== null && expiresAt.getTime() <= evidenceAt.getTime()) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_after_evidence_at" });
  }
  if (status === "valid" && evidenceType !== "human_override") {
    if (expiresAt === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_required_for_valid_ai_governance_evidence" });
    if (expiresAt.getTime() <= now) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  }
  const subjectRef = parseSafeText(raw.subject_ref, "subject_ref", 1, 300);
  const summary = parseSafeText(raw.summary, "summary", 1, 1000);
  const evidenceRef = raw.evidence_ref === undefined || raw.evidence_ref === null || raw.evidence_ref === ""
    ? null
    : parseSafeText(raw.evidence_ref, "evidence_ref", 1, 500);
  const policyDecisionRef = raw.policy_decision_ref === undefined || raw.policy_decision_ref === null || raw.policy_decision_ref === ""
    ? null
    : parseSafeText(raw.policy_decision_ref, "policy_decision_ref", 1, 300);
  const auditCorrelationId = raw.audit_correlation_id === undefined || raw.audit_correlation_id === null || raw.audit_correlation_id === ""
    ? null
    : parseUuid(raw.audit_correlation_id, "audit_correlation_id");
  const metadata = parseEvidenceMetadata(raw.metadata);
  if (status === "valid") {
    if (evidenceRef === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_ai_governance_evidence_ref_required" });
    if (policyDecisionRef === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_ai_governance_policy_decision_ref_required" });
    if (auditCorrelationId === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_ai_governance_audit_correlation_required" });
    assertTypeMetadata(evidenceType, metadata);
  }
  return {
    evidenceType,
    subjectRef,
    status,
    evidenceAt,
    expiresAt,
    summary,
    evidenceRef,
    policyDecisionRef,
    auditCorrelationId,
    metadata,
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseEvidenceTypeQuery(raw: unknown): AiGovernanceEvidenceType | undefined {
  if (raw === undefined) return undefined;
  return parseEvidenceType(raw);
}

function parseEvidenceType(raw: unknown): AiGovernanceEvidenceType {
  if (
    raw === "model_registry" ||
    raw === "prompt_registry" ||
    raw === "eval_result" ||
    raw === "cost_control" ||
    raw === "human_override"
  ) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_governance_evidence_type" });
}

function parseEvidenceStatusQuery(raw: unknown): AiGovernanceEvidenceStatus | undefined {
  if (raw === undefined) return undefined;
  return parseEvidenceStatus(raw);
}

function parseEvidenceStatus(raw: unknown): AiGovernanceEvidenceStatus {
  if (raw === "valid" || raw === "failed" || raw === "deferred") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_governance_evidence_status" });
}

function parseSubjectRefQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  return parseSafeText(raw, "subject_ref", 1, 300);
}

function parseIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  return date;
}

function parseUuid(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}`, field });
  }
  return raw.toLowerCase();
}

function parseSafeText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(value, field);
  return value;
}

function parseEvidenceMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 5000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertTypeMetadata(evidenceType: AiGovernanceEvidenceType, metadata: Readonly<Record<string, unknown>>): void {
  if (evidenceType === "model_registry") {
    assertModelRegistryMetadata(metadata);
    return;
  }
  if (evidenceType === "prompt_registry") {
    assertPromptRegistryMetadata(metadata);
    return;
  }
  if (evidenceType === "eval_result") {
    assertEvalResultMetadata(metadata);
    return;
  }
  if (evidenceType === "cost_control") {
    assertCostControlMetadata(metadata);
    return;
  }
  assertHumanOverrideMetadata(metadata);
}

function assertModelRegistryMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "provider_alias", "model_registry_metadata_required");
  assertRequiredMetadataString(metadata, "model_alias", "model_registry_metadata_required");
  assertRequiredMetadataString(metadata, "model_version", "model_registry_metadata_required");
  const riskTier = assertRequiredMetadataString(metadata, "risk_tier", "model_registry_metadata_required");
  if (!["low", "medium", "high"].includes(riskTier)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_registry_risk_tier_invalid", field: "metadata.risk_tier" });
  assertRequiredMetadataString(metadata, "data_retention_policy_ref", "model_registry_metadata_required");
  assertRequiredMetadataString(metadata, "tenant_allowlist_ref", "model_registry_metadata_required");
  assertPastMetadataDate(metadata, "approved_at", "model_registry_metadata_required", "model_registry_approved_at_in_future");
}

function assertPromptRegistryMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "prompt_template_id", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "prompt_template_version", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "owner_ref", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "eval_suite_ref", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "rollback_target_ref", "prompt_registry_metadata_required");
  assertPastMetadataDate(metadata, "approved_at", "prompt_registry_metadata_required", "prompt_registry_approved_at_in_future");
}

function assertEvalResultMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "eval_suite_ref", "eval_result_metadata_required");
  assertRequiredMetadataString(metadata, "dataset_ref", "eval_result_metadata_required");
  assertPastMetadataDate(metadata, "sampled_at", "eval_result_metadata_required", "eval_result_sampled_at_in_future");
  const passRate = assertRequiredMetadataFiniteNumber(metadata, "pass_rate", "eval_result_metadata_required");
  if (passRate < 0 || passRate > 1) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "eval_result_pass_rate_invalid", field: "metadata.pass_rate" });
  for (const key of ["prompt_injection_passed", "data_leakage_passed", "hallucination_passed", "policy_block_passed"] as const) {
    if (assertRequiredMetadataBoolean(metadata, key, "eval_result_metadata_required") !== true) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "eval_result_required_check_failed", field: `metadata.${key}` });
    }
  }
}

function assertCostControlMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "budget_ref", "cost_control_metadata_required");
  assertRequiredMetadataString(metadata, "scope_ref", "cost_control_metadata_required");
  assertRequiredMetadataString(metadata, "anomaly_alert_ref", "cost_control_metadata_required");
  const monthlyLimit = assertRequiredMetadataFiniteNumber(metadata, "monthly_limit", "cost_control_metadata_required");
  const perRunCap = assertRequiredMetadataFiniteNumber(metadata, "per_run_cap", "cost_control_metadata_required");
  if (monthlyLimit <= 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cost_control_monthly_limit_invalid", field: "metadata.monthly_limit" });
  if (perRunCap <= 0 || perRunCap > monthlyLimit) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cost_control_per_run_cap_invalid", field: "metadata.per_run_cap" });
  assertPastMetadataDate(metadata, "effective_at", "cost_control_metadata_required", "cost_control_effective_at_in_future");
}

function assertHumanOverrideMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "override_actor_ref", "human_override_metadata_required");
  const action = assertRequiredMetadataString(metadata, "override_action", "human_override_metadata_required");
  if (!["accepted_ai_output", "rejected_ai_output", "corrected_ai_output", "escalated_to_human", "rolled_back_prompt"].includes(action)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "human_override_action_invalid", field: "metadata.override_action" });
  }
  assertRequiredMetadataString(metadata, "reason_code", "human_override_metadata_required");
  assertRequiredMetadataString(metadata, "audit_event_ref", "human_override_metadata_required");
  assertPastMetadataDate(metadata, "occurred_at", "human_override_metadata_required", "human_override_occurred_at_in_future");
}

function assertPastMetadataDate(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  missingReason: string,
  futureReason: string,
): void {
  const raw = assertRequiredMetadataString(metadata, key, missingReason);
  const date = parseIsoDate(raw, `metadata.${key}`);
  if (date.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: futureReason, field: `metadata.${key}` });
  }
}

function assertRequiredMetadataString(metadata: Readonly<Record<string, unknown>>, key: string, reason: string): string {
  const value = metadata[key];
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason, field: `metadata.${key}` });
  return parseSafeText(value, `metadata.${key}`, 1, 300);
}

function assertRequiredMetadataFiniteNumber(metadata: Readonly<Record<string, unknown>>, key: string, reason: string): number {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason, field: `metadata.${key}` });
  }
  return value;
}

function assertRequiredMetadataBoolean(metadata: Readonly<Record<string, unknown>>, key: string, reason: string): boolean {
  const value = metadata[key];
  if (typeof value !== "boolean") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason, field: `metadata.${key}` });
  return value;
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
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_raw_value_key_forbidden", path: `${path}.${key}` });
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
  if (/\b(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S{4,}/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_prompt|prompt_text|prompt_body|raw_output|output_text|output_body|raw_document|document_body|training_roster|participant_list|full_text|payload|body)([_.-]|$)/i.test(key);
}
