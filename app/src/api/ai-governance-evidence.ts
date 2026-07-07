import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { parseAiRuntimePolicyRequest, readAiRuntimePolicy, upsertAiRuntimePolicy } from "./ai-governance-policy";
import {
  parseAiGovernanceEvidenceRequest,
  parseEvidenceStatusQuery,
  parseEvidenceTypeQuery,
  parseSubjectRefQuery,
  type AiGovernanceEvidenceInput,
  type AiGovernanceEvidenceStatus,
  type AiGovernanceEvidenceType,
} from "./ai-governance-evidence-parse";
import { ApiResponseError } from "../runtime/errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

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
      (client, tenantId) => recordAiGovernanceEvidence(client, tenantId, principal.subjectId, body),
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
