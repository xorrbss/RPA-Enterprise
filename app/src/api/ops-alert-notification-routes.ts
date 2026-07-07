import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { OpsAlertRoute, OpsAlertAutoFireSource, OpsAlertRouteSeverity } from "./ops-alert-routes";
import { isOpsAlertAutoFireSource } from "./ops-alert-routes";
import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

export interface OpsAlertNotificationRoute {
  readonly route_id: string;
  readonly source: OpsAlertAutoFireSource | null;
  readonly min_severity: OpsAlertRouteSeverity;
  readonly provider_alias: string;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly enabled: boolean;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_by: string;
  readonly updated_at: string;
}

interface OpsAlertNotificationRouteRow {
  readonly id: string;
  readonly source: OpsAlertAutoFireSource | null;
  readonly min_severity: OpsAlertRouteSeverity;
  readonly provider_alias: string;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly enabled: boolean;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_by: string;
  readonly updated_at: Date;
}

interface RouteDraft {
  readonly source: OpsAlertAutoFireSource | null;
  readonly minSeverity: OpsAlertRouteSeverity;
  readonly providerAlias: string;
  readonly endpointSecretRef: string;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string;
  readonly recipientGroupRef: string | null;
  readonly allowedHosts: readonly string[];
  readonly enabled: boolean;
}

interface RoutePatch {
  readonly sourceProvided: boolean;
  readonly source: OpsAlertAutoFireSource | null;
  readonly minSeverityProvided: boolean;
  readonly minSeverity: OpsAlertRouteSeverity | null;
  readonly providerAliasProvided: boolean;
  readonly providerAlias: string | null;
  readonly endpointSecretRefProvided: boolean;
  readonly endpointSecretRef: string | null;
  readonly callbackSignatureSecretRefProvided: boolean;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRefProvided: boolean;
  readonly routePolicyRef: string | null;
  readonly recipientGroupRefProvided: boolean;
  readonly recipientGroupRef: string | null;
  readonly allowedHostsProvided: boolean;
  readonly allowedHosts: readonly string[] | null;
  readonly enabledProvided: boolean;
  readonly enabled: boolean | null;
}

export function registerOpsAlertNotificationRouteRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/ops-alert-routes", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    assertNoCursor(query.cursor);
    const limit = parseLimit(query.limit);
    const items = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listOpsAlertNotificationRoutes(client, principal.tenantId, limit),
    );
    reply.code(200).send({ items, next_cursor: null });
  });

  app.post("/v1/ops-alert-routes", { config: { rbacAction: "ops_alert.deliver" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseCreateRouteBody(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "createOpsAlertNotificationRoute",
      "/v1/ops-alert-routes",
      async (client, tenantId) => {
        const route = await insertOpsAlertNotificationRoute(client, tenantId, principal.subjectId, body);
        return { status: 201, body: route };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.patch<{ Params: { route_id: string } }>(
    "/v1/ops-alert-routes/:route_id",
    { config: { rbacAction: "ops_alert.deliver" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const routeId = parseRouteId(request.params.route_id);
      const body = parseUpdateRouteBody(request.body);
      const response = await runIdempotentCommand(
        deps,
        request,
        "updateOpsAlertNotificationRoute",
        `/v1/ops-alert-routes/${routeId}`,
        async (client, tenantId) => {
          const route = await updateOpsAlertNotificationRoute(client, tenantId, routeId, principal.subjectId, body);
          return { status: 200, body: route };
        },
      );
      reply.code(response.status).send(response.body);
    },
  );

  app.delete<{ Params: { route_id: string } }>(
    "/v1/ops-alert-routes/:route_id",
    { config: { rbacAction: "ops_alert.deliver" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const routeId = parseRouteId(request.params.route_id);
      const response = await runIdempotentCommand(
        deps,
        request,
        "deleteOpsAlertNotificationRoute",
        `/v1/ops-alert-routes/${routeId}`,
        async (client, tenantId) => {
          const route = await softDeleteOpsAlertNotificationRoute(client, tenantId, routeId, principal.subjectId);
          return { status: 200, body: { deleted: true, route } };
        },
      );
      reply.code(response.status).send(response.body);
    },
  );
}

export async function readActiveOpsAlertNotificationRoutes(
  client: PoolClient,
  tenantId: string,
): Promise<OpsAlertRoute[]> {
  const result = await client.query<OpsAlertNotificationRouteRow>(
    `SELECT id::text, source, min_severity, provider_alias, endpoint_secret_ref,
            callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
            allowed_hosts, enabled, created_by, created_at, updated_by, updated_at
       FROM ops_alert_notification_routes
      WHERE tenant_id = $1::uuid
        AND enabled = true
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    ...(row.source !== null ? { source: row.source } : {}),
    minSeverity: row.min_severity,
    providerAlias: row.provider_alias,
    endpointSecretRef: row.endpoint_secret_ref,
    allowedHosts: row.allowed_hosts,
    routePolicyRef: row.route_policy_ref,
    ...(row.recipient_group_ref !== null ? { recipientGroupRef: row.recipient_group_ref } : {}),
    ...(row.callback_signature_secret_ref !== null ? { callbackSignatureSecretRef: row.callback_signature_secret_ref } : {}),
  }));
}

async function listOpsAlertNotificationRoutes(
  client: PoolClient,
  tenantId: string,
  limit: number,
): Promise<OpsAlertNotificationRoute[]> {
  const result = await client.query<OpsAlertNotificationRouteRow>(
    `SELECT id::text, source, min_severity, provider_alias, endpoint_secret_ref,
            callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
            allowed_hosts, enabled, created_by, created_at, updated_by, updated_at
       FROM ops_alert_notification_routes
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map(mapRoute);
}

async function insertOpsAlertNotificationRoute(
  client: PoolClient,
  tenantId: string,
  actor: string,
  input: RouteDraft,
): Promise<OpsAlertNotificationRoute> {
  const result = await client.query<OpsAlertNotificationRouteRow>(
    `INSERT INTO ops_alert_notification_routes (
       id, tenant_id, source, min_severity, provider_alias, endpoint_secret_ref,
       callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
       allowed_hosts, enabled, created_by, updated_by
     )
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$12)
     RETURNING id::text, source, min_severity, provider_alias, endpoint_secret_ref,
               callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
               allowed_hosts, enabled, created_by, created_at, updated_by, updated_at`,
    [
      randomUUID(),
      tenantId,
      input.source,
      input.minSeverity,
      input.providerAlias,
      input.endpointSecretRef,
      input.callbackSignatureSecretRef,
      input.routePolicyRef,
      input.recipientGroupRef,
      input.allowedHosts,
      input.enabled,
      actor,
    ],
  );
  return mapRoute(result.rows[0]);
}

async function updateOpsAlertNotificationRoute(
  client: PoolClient,
  tenantId: string,
  routeId: string,
  actor: string,
  input: RoutePatch,
): Promise<OpsAlertNotificationRoute> {
  const result = await client.query<OpsAlertNotificationRouteRow>(
    `UPDATE ops_alert_notification_routes
        SET source = CASE WHEN $3::boolean THEN $4::text ELSE source END,
            min_severity = CASE WHEN $5::boolean THEN $6::text ELSE min_severity END,
            provider_alias = CASE WHEN $7::boolean THEN $8::text ELSE provider_alias END,
            endpoint_secret_ref = CASE WHEN $9::boolean THEN $10::text ELSE endpoint_secret_ref END,
            callback_signature_secret_ref = CASE WHEN $11::boolean THEN $12::text ELSE callback_signature_secret_ref END,
            route_policy_ref = CASE WHEN $13::boolean THEN $14::text ELSE route_policy_ref END,
            recipient_group_ref = CASE WHEN $15::boolean THEN $16::text ELSE recipient_group_ref END,
            allowed_hosts = CASE WHEN $17::boolean THEN $18::text[] ELSE allowed_hosts END,
            enabled = CASE WHEN $19::boolean THEN $20::boolean ELSE enabled END,
            updated_by = $21,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND deleted_at IS NULL
      RETURNING id::text, source, min_severity, provider_alias, endpoint_secret_ref,
                callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
                allowed_hosts, enabled, created_by, created_at, updated_by, updated_at`,
    [
      tenantId,
      routeId,
      input.sourceProvided,
      input.source,
      input.minSeverityProvided,
      input.minSeverity,
      input.providerAliasProvided,
      input.providerAlias,
      input.endpointSecretRefProvided,
      input.endpointSecretRef,
      input.callbackSignatureSecretRefProvided,
      input.callbackSignatureSecretRef,
      input.routePolicyRefProvided,
      input.routePolicyRef,
      input.recipientGroupRefProvided,
      input.recipientGroupRef,
      input.allowedHostsProvided,
      input.allowedHosts,
      input.enabledProvided,
      input.enabled,
      actor,
    ],
  );
  if (result.rows[0] === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_notification_route_not_found" });
  }
  return mapRoute(result.rows[0]);
}

async function softDeleteOpsAlertNotificationRoute(
  client: PoolClient,
  tenantId: string,
  routeId: string,
  actor: string,
): Promise<OpsAlertNotificationRoute> {
  const result = await client.query<OpsAlertNotificationRouteRow>(
    `UPDATE ops_alert_notification_routes
        SET enabled = false,
            updated_by = $3,
            updated_at = now(),
            deleted_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND deleted_at IS NULL
      RETURNING id::text, source, min_severity, provider_alias, endpoint_secret_ref,
                callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
                allowed_hosts, enabled, created_by, created_at, updated_by, updated_at`,
    [tenantId, routeId, actor],
  );
  if (result.rows[0] === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_notification_route_not_found" });
  }
  return mapRoute(result.rows[0]);
}

function mapRoute(row: OpsAlertNotificationRouteRow): OpsAlertNotificationRoute {
  return {
    route_id: row.id,
    source: row.source,
    min_severity: row.min_severity,
    provider_alias: row.provider_alias,
    endpoint_secret_ref: row.endpoint_secret_ref,
    callback_signature_secret_ref: row.callback_signature_secret_ref,
    route_policy_ref: row.route_policy_ref,
    recipient_group_ref: row.recipient_group_ref,
    allowed_hosts: row.allowed_hosts,
    enabled: row.enabled,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_by: row.updated_by,
    updated_at: row.updated_at.toISOString(),
  };
}

function parseCreateRouteBody(raw: unknown): RouteDraft {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_route_body_expected_object" });
  assertAllowedKeys(raw, new Set([
    "source",
    "min_severity",
    "provider_alias",
    "endpoint_secret_ref",
    "callback_signature_secret_ref",
    "route_policy_ref",
    "recipient_group_ref",
    "allowed_hosts",
    "enabled",
  ]));
  return {
    source: parseRouteSource(raw.source, true),
    minSeverity: parseMinSeverity(raw.min_severity),
    providerAlias: parseSafeRouteString(raw.provider_alias, "provider_alias", 1, 120),
    endpointSecretRef: parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref"),
    callbackSignatureSecretRef: raw.callback_signature_secret_ref === undefined || raw.callback_signature_secret_ref === null || raw.callback_signature_secret_ref === ""
      ? null
      : parseSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref"),
    routePolicyRef: parseSafeRouteString(raw.route_policy_ref, "route_policy_ref", 1, 200),
    recipientGroupRef: raw.recipient_group_ref === undefined || raw.recipient_group_ref === null || raw.recipient_group_ref === ""
      ? null
      : parseSafeRouteString(raw.recipient_group_ref, "recipient_group_ref", 1, 200),
    allowedHosts: parseAllowedWebhookHosts(raw.allowed_hosts),
    enabled: raw.enabled === undefined ? true : parseBoolean(raw.enabled, "enabled"),
  };
}

function parseUpdateRouteBody(raw: unknown): RoutePatch {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_route_body_expected_object" });
  assertAllowedKeys(raw, new Set([
    "source",
    "min_severity",
    "provider_alias",
    "endpoint_secret_ref",
    "callback_signature_secret_ref",
    "route_policy_ref",
    "recipient_group_ref",
    "allowed_hosts",
    "enabled",
  ]));
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_route_patch_empty" });
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  return {
    sourceProvided: has("source"),
    source: has("source") ? parseRouteSource(raw.source, true) : null,
    minSeverityProvided: has("min_severity"),
    minSeverity: has("min_severity") ? parseMinSeverity(raw.min_severity) : null,
    providerAliasProvided: has("provider_alias"),
    providerAlias: has("provider_alias") ? parseSafeRouteString(raw.provider_alias, "provider_alias", 1, 120) : null,
    endpointSecretRefProvided: has("endpoint_secret_ref"),
    endpointSecretRef: has("endpoint_secret_ref") ? parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref") : null,
    callbackSignatureSecretRefProvided: has("callback_signature_secret_ref"),
    callbackSignatureSecretRef: has("callback_signature_secret_ref")
      ? raw.callback_signature_secret_ref === null || raw.callback_signature_secret_ref === ""
        ? null
        : parseSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref")
      : null,
    routePolicyRefProvided: has("route_policy_ref"),
    routePolicyRef: has("route_policy_ref") ? parseSafeRouteString(raw.route_policy_ref, "route_policy_ref", 1, 200) : null,
    recipientGroupRefProvided: has("recipient_group_ref"),
    recipientGroupRef: has("recipient_group_ref")
      ? raw.recipient_group_ref === null || raw.recipient_group_ref === ""
        ? null
        : parseSafeRouteString(raw.recipient_group_ref, "recipient_group_ref", 1, 200)
      : null,
    allowedHostsProvided: has("allowed_hosts"),
    allowedHosts: has("allowed_hosts") ? parseAllowedWebhookHosts(raw.allowed_hosts) : null,
    enabledProvided: has("enabled"),
    enabled: has("enabled") ? parseBoolean(raw.enabled, "enabled") : null,
  };
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_route_unknown_field", field: key });
    }
  }
}

function parseRouteSource(raw: unknown, allowNull: boolean): OpsAlertAutoFireSource | null {
  if (raw === undefined || raw === null || raw === "") {
    if (allowNull) return null;
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_alert_route_source" });
  }
  if (isOpsAlertAutoFireSource(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_alert_route_source" });
}

function parseMinSeverity(raw: unknown): OpsAlertRouteSeverity {
  if (raw === "warning" || raw === "critical") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_alert_route_min_severity" });
}

function parseAllowedWebhookHosts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_hosts" });
  }
  const hosts = raw.map((item) => parseAllowedWebhookHost(item));
  return [...new Set(hosts)];
}

function parseAllowedWebhookHost(raw: unknown): string {
  const host = parseSafeRouteString(raw, "allowed_hosts", 1, 253).toLowerCase();
  if (host.includes("://") || host.includes("/") || host.includes("?") || host.includes("#")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "allowed_host_must_not_be_url" });
  }
  if (host === "localhost" || host.endsWith(".localhost") || /^[0-9.]+$/.test(host) || host.includes(":")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "allowed_host_public_dns_required" });
  }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const hostRe = new RegExp(`^(?:${label}\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$`);
  if (!hostRe.test(host)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host" });
  }
  return host;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeRouteString(raw, field);
  return raw;
}

function parseSafeRouteString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeRouteString(value, field);
  return value;
}

function assertSafeRouteString(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseRouteId(raw: string): string {
  if (!UUID_RE.test(raw)) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_notification_route_not_found" });
  return raw;
}

function assertNoCursor(raw: unknown): void {
  if (raw !== undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_route_cursor_not_supported" });
}
