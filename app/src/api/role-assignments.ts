import { randomUUID, createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { safeSerialize } from "../../../security/compliance-scaffold";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type AuditOutcome,
  type Role,
  type SecurityAuditDecisionAction,
} from "../../../ts/security-middleware-contract";
import { RBAC_ROLE_ACTIONS } from "../../../ts/rbac-policy";
import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

const ROLES = ["viewer", "operator", "reviewer", "approver", "admin"] as const satisfies readonly Role[];
const STATUSES = ["active", "revoked"] as const;
const MAX_REASON = 500;

interface AssignmentRow {
  id: string;
  principal_sub: string;
  role: Role;
  source: "manual";
  status: "active" | "revoked";
  reason: string | null;
  expires_at: Date | null;
  granted_by: string;
  granted_at: Date;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface PrincipalSubRow {
  sub: string;
}

export class PgPrincipalRoleAssignmentResolver {
  constructor(private readonly pool: Pool) {}

  async resolveActiveRoles(tenantId: string, principalSub: string): Promise<readonly Role[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const result = await client.query<{ role: Role }>(
        `SELECT role
           FROM principal_role_assignments
          WHERE tenant_id=$1::uuid
            AND principal_sub=$2::text
            AND status='active'
            AND (expires_at IS NULL OR expires_at > now())`,
        [tenantId, principalSub],
      );
      return result.rows.map((row) => row.role);
    });
  }
}

interface GrantBody {
  readonly role: Role;
  readonly reason: string | null;
  readonly expiresAt: string | null;
}

interface RevokeBody {
  readonly reason: string;
}

interface ListFilters {
  readonly role?: Role;
  readonly status?: "active" | "revoked";
  readonly principalSub?: string;
}

export function registerRoleAssignmentRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Params: { id: string } }>(
    "/v1/principals/:id/role-assignments",
    { config: { rbacAction: "principal.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const principalId = request.params.id;
      if (!UUID_RE.test(principalId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const query = request.query as Record<string, unknown>;
      const { limit, cursor } = parsePageParams(query);
      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        const target = await loadPrincipalSub(client, principal.tenantId, principalId);
        const result = await client.query<AssignmentRow>(
          `${assignmentSelectSql()}
            WHERE tenant_id=$1::uuid
              AND principal_sub=$2::text
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $5`,
          [principal.tenantId, target, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });
      reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), mapAssignment));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/principals/:id/role-assignments",
    { config: { rbacAction: "rbac.grant" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const principalId = request.params.id;
      if (!UUID_RE.test(principalId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = parseGrantBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "grantPrincipalRole",
        `/v1/principals/${principalId}/role-assignments`,
        (client, tenantId) => applyGrant(client, deps, request, tenantId, principalId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get("/v1/role-assignments", { config: { rbacAction: "principal.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const filters = parseListFilters(query);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<AssignmentRow>(
        `${assignmentSelectSql()}
          WHERE tenant_id=$1::uuid
            AND ($2::text IS NULL OR role=$2)
            AND ($3::text IS NULL OR status=$3)
            AND ($4::text IS NULL OR principal_sub=$4)
            AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $7`,
        [
          principal.tenantId,
          filters.role ?? null,
          filters.status ?? null,
          filters.principalSub ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      return result.rows;
    });
    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), mapAssignment));
  });

  app.post<{ Params: { id: string } }>(
    "/v1/role-assignments/:id/revoke",
    { config: { rbacAction: "rbac.grant" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const assignmentId = request.params.id;
      if (!UUID_RE.test(assignmentId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = parseRevokeBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "revokeRoleAssignment",
        `/v1/role-assignments/${assignmentId}/revoke`,
        (client, tenantId) => applyRevoke(client, deps, request, tenantId, assignmentId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

function assignmentSelectSql(): string {
  return `SELECT id::text AS id, principal_sub, role, source, status, reason, expires_at,
                 granted_by, granted_at, revoked_by, revoked_at, revoke_reason,
                 created_at, updated_at, created_at::text AS cursor_at
            FROM principal_role_assignments`;
}

async function loadPrincipalSub(client: PoolClient, tenantId: string, principalId: string): Promise<string> {
  const result = await client.query<PrincipalSubRow>(
    `SELECT sub FROM principals WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, principalId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row.sub;
}

async function applyGrant(
  client: PoolClient,
  deps: ApiServerDeps,
  request: FastifyRequest,
  tenantId: string,
  principalId: string,
  body: GrantBody,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const targetSub = await loadPrincipalSub(client, tenantId, principalId);
  if (actor.subjectId === targetSub && body.role === "admin") {
    throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "self_admin_grant_denied" });
  }
  const now = new Date();
  if (body.expiresAt !== null && new Date(body.expiresAt).getTime() <= now.getTime()) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  }
  const id = randomUUID();
  try {
    await client.query(
      `INSERT INTO principal_role_assignments
         (id, tenant_id, principal_sub, role, source, status, reason, expires_at, granted_by)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'manual', 'active', $5::text, $6::timestamptz, $7::text)`,
      [id, tenantId, targetSub, body.role, body.reason, body.expiresAt, actor.subjectId],
    );
  } catch (err) {
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "role_assignment_already_active", role: body.role, principal_sub: targetSub });
    }
    throw err;
  }
  await client.query(
    `INSERT INTO principal_role_assignment_events
       (id, tenant_id, assignment_id, event_type, actor_sub, target_sub, role, reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'granted', $4::text, $5::text, $6::text, $7::text)`,
    [randomUUID(), tenantId, id, actor.subjectId, targetSub, body.role, body.reason],
  );
  await appendGovernanceAudit(client, request, "rbac.grant", "allow", "role_assignment_granted", {
    assignment_id: id,
    principal_sub: targetSub,
    role: body.role,
    source: "manual",
  });
  const row = await loadAssignment(client, tenantId, id);
  return { status: 201, body: mapAssignment(row) };
}

async function applyRevoke(
  client: PoolClient,
  deps: ApiServerDeps,
  request: FastifyRequest,
  tenantId: string,
  assignmentId: string,
  body: RevokeBody,
): Promise<CommandResponse> {
  void deps;
  const actor = requirePrincipal(request);
  const current = await loadAssignment(client, tenantId, assignmentId);
  if (current.status !== "active") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "role_assignment_not_active" });
  }
  if (actor.subjectId === current.principal_sub && roleAllowsRbacGrant(current.role)) {
    const other = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM principal_role_assignments
        WHERE tenant_id=$1::uuid
          AND principal_sub=$2::text
          AND id <> $3::uuid
          AND status='active'
          AND role='admin'
          AND (expires_at IS NULL OR expires_at > now())`,
      [tenantId, current.principal_sub, assignmentId],
    );
    if ((other.rows[0]?.n ?? 0) === 0) {
      throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "self_last_rbac_grant_revoke_denied" });
    }
  }
  await client.query(
    `UPDATE principal_role_assignments
        SET status='revoked', revoked_by=$1::text, revoked_at=now(), revoke_reason=$2::text, updated_at=now()
      WHERE tenant_id=$3::uuid AND id=$4::uuid`,
    [actor.subjectId, body.reason, tenantId, assignmentId],
  );
  await client.query(
    `INSERT INTO principal_role_assignment_events
       (id, tenant_id, assignment_id, event_type, actor_sub, target_sub, role, reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::text, $5::text, $6::text, $7::text)`,
    [randomUUID(), tenantId, assignmentId, actor.subjectId, current.principal_sub, current.role, body.reason],
  );
  await appendGovernanceAudit(client, request, "rbac.revoke", "allow", "role_assignment_revoked", {
    assignment_id: assignmentId,
    principal_sub: current.principal_sub,
    role: current.role,
    source: "manual",
  });
  const row = await loadAssignment(client, tenantId, assignmentId);
  return { status: 200, body: mapAssignment(row) };
}

async function loadAssignment(client: PoolClient, tenantId: string, assignmentId: string): Promise<AssignmentRow> {
  const result = await client.query<AssignmentRow>(
    `${assignmentSelectSql()} WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, assignmentId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

function parseGrantBody(raw: unknown): GrantBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "role" && key !== "reason" && key !== "expires_at") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const role = parseRole(raw.role);
  const reason = parseOptionalText(raw.reason, "invalid_reason");
  const expiresAt = parseOptionalIso(raw.expires_at);
  return { role, reason, expiresAt };
}

function parseRevokeBody(raw: unknown): RevokeBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  const reason = parseOptionalText(raw.reason, "invalid_reason");
  if (reason === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required" });
  return { reason };
}

function parseListFilters(query: Record<string, unknown>): ListFilters {
  return {
    role: query.role === undefined ? undefined : parseRole(query.role),
    status: query.status === undefined ? undefined : parseStatus(query.status),
    principalSub: query.principal_sub === undefined ? undefined : parsePrincipalSub(query.principal_sub),
  };
}

function parseRole(raw: unknown): Role {
  if (typeof raw === "string" && (ROLES as readonly string[]).includes(raw)) return raw as Role;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_role" });
}

function parseStatus(raw: unknown): "active" | "revoked" {
  if (typeof raw === "string" && (STATUSES as readonly string[]).includes(raw)) return raw as "active" | "revoked";
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_role_assignment_status" });
}

function parsePrincipalSub(raw: unknown): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_principal_sub" });
}

function parseOptionalText(raw: unknown, reason: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_REASON);
}

function parseOptionalIso(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
  }
  return raw;
}

function roleAllowsRbacGrant(role: Role): boolean {
  return RBAC_ROLE_ACTIONS[role].includes("rbac.grant");
}

function mapAssignment(row: AssignmentRow): Record<string, unknown> {
  return {
    assignment_id: row.id,
    principal_sub: row.principal_sub,
    role: row.role,
    source: row.source,
    status: row.status,
    reason: row.reason,
    expires_at: row.expires_at?.toISOString() ?? null,
    granted_by: row.granted_by,
    granted_at: row.granted_at.toISOString(),
    revoked_by: row.revoked_by,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function appendGovernanceAudit(
  client: PoolClient,
  request: FastifyRequest,
  action: SecurityAuditDecisionAction,
  outcome: AuditOutcome,
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const principal = requirePrincipal(request);
  const occurredAt = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const idempotencyKey = typeof request.headers["idempotency-key"] === "string" && request.headers["idempotency-key"].length > 0
    ? request.headers["idempotency-key"]
    : `${action}:${randomUUID()}`;
  const correlationId = UUID_RE.test(request.correlationId) ? request.correlationId : randomUUID();
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [principal.tenantId]);
  const previous = await client.query<{ sequence_no: string; hash: string }>(
    `SELECT sequence_no, hash
       FROM audit_log
      WHERE tenant_id=$1::uuid
      ORDER BY sequence_no DESC
      LIMIT 1
      FOR UPDATE`,
    [principal.tenantId],
  );
  const previousRow = previous.rows[0];
  const sequence = previousRow === undefined ? 1 : Number(previousRow.sequence_no) + 1;
  const payloadJson = safeSerialize(payload);
  const actor = { subjectId: principal.subjectId, roles: principal.roles };
  const previousHash = previousRow?.hash ?? "GENESIS";
  const hash = hashAuditRecord({
    tenantId: principal.tenantId,
    sequence,
    actor,
    action,
    outcome,
    reason,
    correlationId,
    idempotencyKey,
    occurredAt,
    retentionUntil,
    payload: JSON.parse(payloadJson) as unknown,
    previousHash,
  });
  await client.query(
    `INSERT INTO audit_log
       (id, tenant_id, sequence_no, actor, action, outcome, reason,
        correlation_id, idempotency_key, occurred_at, payload_schema_ref,
        payload, retention_until, previous_hash, hash)
     VALUES
       ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, $6, $7,
        $8::uuid, $9, $10::timestamptz, $11, $12::jsonb, $13::timestamptz, $14, $15)`,
    [
      randomUUID(),
      principal.tenantId,
      sequence,
      JSON.stringify(actor),
      action,
      outcome,
      reason,
      correlationId,
      idempotencyKey,
      occurredAt,
      SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
      payloadJson,
      retentionUntil,
      previousRow?.hash ?? null,
      hash,
    ],
  );
}

function hashAuditRecord(input: {
  tenantId: string;
  sequence: number;
  actor: unknown;
  action: string;
  outcome: string;
  reason: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  retentionUntil: string;
  payload: unknown;
  previousHash: string;
}): string {
  return `sha256:${createHash("sha256").update(canonicalize(input)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}
