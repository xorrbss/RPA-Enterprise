import type { FastifyInstance } from "fastify";

import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { CONNECTORS, type CatalogStatus, type ConnectorKind } from "./connector-catalog-data";
import { TEMPLATES, type TemplateKind } from "./connector-catalog-templates";
import {
  insertConnectorCertification,
  insertConnectorProfile,
  listConnectorProfiles,
  mapConnectorProfile,
  type ConnectorProfileStatus,
} from "./connector-catalog-profiles";
import {
  parseConnectorCertificationRequest,
  parseConnectorProfileCreateRequest,
  parseUuid,
} from "./connector-catalog-validation";

const CONNECTOR_KIND_SET: Record<ConnectorKind, true> = {
  browser: true,
  api: true,
  file: true,
  notification: true,
  data: true,
};

const STATUS_SET: Record<CatalogStatus, true> = {
  available: true,
  candidate: true,
  requires_admin: true,
  blocked: true,
};

const PROFILE_STATUS_SET: Record<ConnectorProfileStatus, true> = {
  draft: true,
  security_review: true,
  certified: true,
  enabled: true,
  disabled: true,
  deprecated: true,
};

const TEMPLATE_KIND_SET: Record<TemplateKind, true> = {
  browser_workflow: true,
  api_workflow: true,
  file_workflow: true,
  notification_workflow: true,
};

function enumFilter<T extends string>(raw: unknown, set: Record<T, true>, reason: string): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(set, raw)) return raw as T;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function textFilter(raw: unknown, reason: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function orderByCreated<Item extends { created_at: string; catalog_id: string }>(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => {
    const byDate = b.created_at.localeCompare(a.created_at);
    return byDate !== 0 ? byDate : b.catalog_id.localeCompare(a.catalog_id);
  });
}

export function registerConnectorCatalogRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/connectors", { config: { rbacAction: "connector.read" } }, async (request, reply) => {
    requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const kind = enumFilter(query.kind, CONNECTOR_KIND_SET, "invalid_connector_kind");
    const status = enumFilter(query.status, STATUS_SET, "invalid_catalog_status");

    const rows = orderByCreated(CONNECTORS)
      .filter((item) => kind === undefined || item.kind === kind)
      .filter((item) => status === undefined || item.status === status)
      .filter((item) => cursor === null || (item.created_at < cursor.createdAt || (item.created_at === cursor.createdAt && item.catalog_id < cursor.id)))
      .slice(0, limit + 1);

    reply.code(200).send(paginate(rows, limit, (item) => ({ createdAt: item.created_at, id: item.catalog_id }), (item) => item));
  });

  app.get("/v1/templates", { config: { rbacAction: "connector.read" } }, async (request, reply) => {
    requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const kind = enumFilter(query.kind, TEMPLATE_KIND_SET, "invalid_template_kind");
    const status = enumFilter(query.status, STATUS_SET, "invalid_catalog_status");
    const connectorId = textFilter(query.connector_id, "invalid_connector_id");

    const rows = orderByCreated(TEMPLATES)
      .filter((item) => kind === undefined || item.kind === kind)
      .filter((item) => status === undefined || item.status === status)
      .filter((item) => connectorId === undefined || item.connector_id === connectorId)
      .filter((item) => cursor === null || (item.created_at < cursor.createdAt || (item.created_at === cursor.createdAt && item.catalog_id < cursor.id)))
      .slice(0, limit + 1);

    reply.code(200).send(paginate(rows, limit, (item) => ({ createdAt: item.created_at, id: item.catalog_id }), (item) => item));
  });

  app.get("/v1/connector-profiles", { config: { rbacAction: "connector.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const connectorId = textFilter(query.connector_id, "invalid_connector_id");
    const status = enumFilter(query.status, PROFILE_STATUS_SET, "invalid_connector_profile_status");
    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listConnectorProfiles(client, principal.tenantId, limit, cursor, connectorId, status),
    );
    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapConnectorProfile));
  });

  app.post("/v1/connector-profiles", { config: { rbacAction: "connector.enable" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseConnectorProfileCreateRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "createConnectorProfile",
      "/v1/connector-profiles",
      async (client, tenantId) => {
        const item = await insertConnectorProfile(client, tenantId, principal.subjectId, body);
        return { status: 201, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.post<{ Params: { profile_id: string } }>(
    "/v1/connector-profiles/:profile_id/certifications",
    { config: { rbacAction: "connector.enable" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const profileId = parseUuid(request.params.profile_id, "profile_id");
      const body = parseConnectorCertificationRequest(request.body);
      const response = await runIdempotentCommand(
        deps,
        request,
        "certifyConnectorProfile",
        `/v1/connector-profiles/${profileId}/certifications`,
        async (client, tenantId) => {
          const item = await insertConnectorCertification(client, tenantId, profileId, principal.subjectId, body);
          return { status: 201, body: item };
        },
      );
      reply.code(response.status).send(response.body);
    },
  );
}
