import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams, principalIdFilter, uuidFilter } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";

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
      .send(auditRowsToCsv(rows));
  });
}

function parseAuditLogFilters(query: Record<string, unknown>): AuditLogFilters {
  return {
    action: nonEmptyStringFilter(query.action, "invalid_action"),
    outcome: auditOutcomeFilter(query.outcome),
    actorSub: principalIdFilter(query.actor, "invalid_actor"),
    correlationId: uuidFilter(query.correlation_id, "invalid_correlation_id"),
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
          AND ($6::timestamptz IS NULL OR (occurred_at, id) < ($6::timestamptz, $7::uuid))
        ORDER BY occurred_at DESC, id DESC
        LIMIT $8`,
      [
        tenantId,
        filters.action ?? null,
        filters.outcome ?? null,
        filters.actorSub ?? null,
        filters.correlationId ?? null,
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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
