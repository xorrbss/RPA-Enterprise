import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { verifyAuditChainInTenantTx } from "./audit-record-hash";
import { csvCell, csvWithBom } from "./csv";
import {
  insertAuditVerificationRun,
  mapAuditVerificationRunRow,
  type AuditVerifierRunRow,
  type AuditVerificationRunStatus,
} from "./audit-verification-runs";
import { runIdempotentCommand, isRecord } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams, principalIdFilter, uuidFilter } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { UUID_RE } from "./server-shared";

type AuditOutcome = "allow" | "deny" | "blocked" | "error";

interface AuditLogRow {
  id: string;
  sequence_no: string;
  actor: unknown;
  action: string;
  outcome: AuditOutcome;
  reason: string | null;
  correlation_id: string;
  idempotency_key: string;
  occurred_at: Date;
  payload_schema_ref: string;
  retention_until: Date | null;
  legal_hold: boolean;
  deleted_at: Date | null;
  previous_hash: string | null;
  hash: string;
  created_at: Date;
  cursor_at: string;
}

interface ActorSummary {
  subject_id: string | null;
  roles: readonly string[];
}

interface AuditLogFilters {
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly actorSub?: string;
  readonly correlationId?: string;
  readonly occurredAtFrom?: Date;
  readonly occurredAtTo?: Date;
}

interface VerificationRunFilters {
  readonly status?: AuditVerificationRunStatus;
}

export function registerAuditLogRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/audit-log", { config: { rbacAction: "audit.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const filters = parseAuditLogFilters(query);
    const rows = await selectAuditLogRows(deps, principal.tenantId, filters, limit + 1, cursor);

    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapAuditLogRow));
  });

  app.get("/v1/audit-log/export", { config: { rbacAction: "audit.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    if (query.format !== undefined && query.format !== "csv") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_export_format" });
    }
    const { limit, cursor } = parsePageParams(query);
    const filters = parseAuditLogFilters(query);
    const rows = await selectAuditLogRows(deps, principal.tenantId, filters, limit, cursor);
    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;

    reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename}"`)
      // BOM 없으면 Windows Excel 이 CP949 로 열어 한글이 깨진다.
      .send(csvWithBom(auditRowsToCsv(rows)));
  });

  app.get("/v1/audit-log/verification-runs", { config: { rbacAction: "audit.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const filters = parseVerificationRunFilters(query);
    const rows = await selectVerificationRuns(deps, principal.tenantId, filters, limit + 1, cursor);

    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapAuditVerificationRunRow));
  });

  app.post("/v1/audit-log/verification-runs/verify", { config: { rbacAction: "audit.verify" } }, async (request, reply) => {
    const response = await runIdempotentCommand(
      deps,
      request,
      "runAuditVerification",
      "/v1/audit-log/verification-runs/verify",
      async (client, tenantId) => {
        const body = parseVerificationRequest(request.body);
        const principal = requirePrincipal(request);
        const startedAt = new Date();
        const result = await verifyAuditChainInTenantTx(client, tenantId);
        const completedAt = new Date();
        const row = await insertAuditVerificationRun(client, {
          tenantId,
          result,
          startedAt,
          completedAt,
          correlationId: UUID_RE.test(request.correlationId) ? request.correlationId : randomUUID(),
          triggeredBy: { subjectId: principal.subjectId, roles: principal.roles },
          triggerKind: "manual_api",
          legalHold: body.legalHold,
        });
        return { status: 201, body: mapAuditVerificationRunRow(row) };
      },
    );
    reply.code(response.status).send(response.body);
  });
}

function parseAuditLogFilters(query: Record<string, unknown>): AuditLogFilters {
  return {
    action: nonEmptyStringFilter(query.action, "invalid_action"),
    outcome: auditOutcomeFilter(query.outcome),
    actorSub: principalIdFilter(query.actor, "invalid_actor"),
    correlationId: uuidFilter(query.correlation_id, "invalid_correlation_id"),
    occurredAtFrom: dateTimeFilter(query.occurred_at_from, "invalid_occurred_at_from"),
    occurredAtTo: dateTimeFilter(query.occurred_at_to, "invalid_occurred_at_to"),
  };
}

async function selectAuditLogRows(
  deps: ApiServerDeps,
  tenantId: string,
  filters: AuditLogFilters,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
): Promise<AuditLogRow[]> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    const result = await client.query<AuditLogRow>(
      `SELECT id, sequence_no::text, actor, action, outcome, reason, correlation_id,
              idempotency_key, occurred_at, payload_schema_ref, retention_until,
              legal_hold, deleted_at, previous_hash, hash, created_at,
              occurred_at::text AS cursor_at
         FROM audit_log
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR outcome = $3)
          AND ($4::text IS NULL OR actor->>'subjectId' = $4)
          AND ($5::uuid IS NULL OR correlation_id = $5::uuid)
          AND ($6::timestamptz IS NULL OR occurred_at >= $6::timestamptz)
          AND ($7::timestamptz IS NULL OR occurred_at <= $7::timestamptz)
          AND ($8::timestamptz IS NULL OR (occurred_at, id) < ($8::timestamptz, $9::uuid))
        ORDER BY occurred_at DESC, id DESC
        LIMIT $10`,
      [
        tenantId,
        filters.action ?? null,
        filters.outcome ?? null,
        filters.actorSub ?? null,
        filters.correlationId ?? null,
        filters.occurredAtFrom?.toISOString() ?? null,
        filters.occurredAtTo?.toISOString() ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit,
      ],
    );
    return result.rows;
  });
}

function nonEmptyStringFilter(raw: unknown, reason: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function auditOutcomeFilter(raw: unknown): AuditOutcome | undefined {
  if (raw === undefined) return undefined;
  if (raw === "allow" || raw === "deny" || raw === "blocked" || raw === "error") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_outcome" });
}

function dateTimeFilter(raw: unknown, reason: string): Date | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return date;
}

function parseVerificationRunFilters(query: Record<string, unknown>): VerificationRunFilters {
  return { status: verificationRunStatusFilter(query.status) };
}

function verificationRunStatusFilter(raw: unknown): AuditVerificationRunStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "valid" || raw === "invalid" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_audit_verification_status" });
}

function parseVerificationRequest(raw: unknown): { legalHold: boolean } {
  if (raw === undefined || raw === null) return { legalHold: false };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "audit_verification_body_expected_object" });
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "legal_hold")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "audit_verification_unknown_field" });
  }
  if (raw.legal_hold === undefined || raw.legal_hold === null) return { legalHold: false };
  if (typeof raw.legal_hold !== "boolean") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_legal_hold" });
  }
  return { legalHold: raw.legal_hold };
}

async function selectVerificationRuns(
  deps: ApiServerDeps,
  tenantId: string,
  filters: VerificationRunFilters,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
): Promise<AuditVerifierRunRow[]> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    const result = await client.query<AuditVerifierRunRow>(
      `SELECT id, status, rows_checked::text, violation_count, violations,
              checked_from_sequence::text, checked_to_sequence::text,
              started_at, completed_at, correlation_id, triggered_by, trigger_kind,
              retention_until, legal_hold, completed_at::text AS cursor_at
         FROM audit_verifier_runs
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR (completed_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY completed_at DESC, id DESC
        LIMIT $5`,
      [tenantId, filters.status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );
    return result.rows;
  });
}

function mapActor(raw: unknown): ActorSummary {
  if (typeof raw !== "object" || raw === null) return { subject_id: null, roles: [] };
  const actor = raw as { subjectId?: unknown; roles?: unknown };
  return {
    subject_id: typeof actor.subjectId === "string" ? actor.subjectId : null,
    roles: Array.isArray(actor.roles) ? actor.roles.filter((role): role is string => typeof role === "string") : [],
  };
}

function mapAuditLogRow(row: AuditLogRow): Record<string, unknown> {
  return {
    audit_id: row.id,
    sequence_no: Number(row.sequence_no),
    actor: mapActor(row.actor),
    action: row.action,
    outcome: row.outcome,
    reason: row.reason,
    correlation_id: row.correlation_id,
    idempotency_key: row.idempotency_key,
    occurred_at: row.occurred_at.toISOString(),
    payload_schema_ref: row.payload_schema_ref,
    retention_until: row.retention_until?.toISOString() ?? null,
    legal_hold: row.legal_hold,
    previous_hash: row.previous_hash,
    hash: row.hash,
    created_at: row.created_at.toISOString(),
  };
}

function auditRowsToCsv(rows: readonly AuditLogRow[]): string {
  const header = [
    "audit_id",
    "sequence_no",
    "actor_subject_id",
    "actor_roles",
    "action",
    "outcome",
    "reason",
    "correlation_id",
    "idempotency_key",
    "occurred_at",
    "payload_schema_ref",
    "retention_until",
    "legal_hold",
    "previous_hash",
    "hash",
    "created_at",
  ];
  const lines = rows.map((row) => {
    const actor = mapActor(row.actor);
    return [
      row.id,
      row.sequence_no,
      actor.subject_id ?? "",
      actor.roles.join(";"),
      row.action,
      row.outcome,
      row.reason ?? "",
      row.correlation_id,
      row.idempotency_key,
      row.occurred_at.toISOString(),
      row.payload_schema_ref,
      row.retention_until?.toISOString() ?? "",
      String(row.legal_hold),
      row.previous_hash ?? "",
      row.hash,
      row.created_at.toISOString(),
    ].map((value) => csvCell(String(value))).join(",");
  });
  return [header.join(","), ...lines].join("\n");
}
