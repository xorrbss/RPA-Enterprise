import type { FastifyInstance, FastifyRequest } from "fastify";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { UUID_RE } from "./server-shared";
import { assertSiteExists, createElement, deleteElement, probeElement, updateElement } from "./site-elements-commands";
import {
  mapElement,
  type CreateBody,
  type ElementStability,
  type ElementSource,
  type ElementType,
  type ProbeBody,
  type SiteElementRow,
  type UpdateBody,
} from "./site-elements-shared";

const ELEMENT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const ELEMENT_TYPES: readonly ElementType[] = ["button", "input", "link", "table", "row", "field", "message", "other"];
const STABILITIES: readonly ElementStability[] = ["stable", "review_needed", "broken"];
const SOURCES: readonly ElementSource[] = ["manual", "pbd", "capture", "imported"];

export function registerSiteElementRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Params: { siteId: string } }>(
    "/v1/sites/:siteId/elements",
    { config: { rbacAction: "site.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const siteId = validateUuid(request.params.siteId);
      const query = request.query as Record<string, unknown>;
      const { limit, cursor } = parsePageParams(query);
      const stability = optionalEnum(query.stability, STABILITIES, "invalid_stability");
      const search = optionalSearch(query.search);

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertSiteExists(client, siteId);
        const result = await client.query<SiteElementRow>(
          `SELECT id::text AS id, site_profile_id::text AS site_profile_id, element_key, label, selector,
                  element_type, stability, confidence, source, sample_url, last_probe_result, notes, usage_count, last_verified_at,
                  updated_by::text AS updated_by, created_at, updated_at, updated_at::text AS cursor_at
             FROM site_element_repository
            WHERE tenant_id = $1::uuid
              AND site_profile_id = $2::uuid
              AND ($3::text IS NULL OR stability = $3)
              AND (
                $4::text IS NULL
                OR element_key ILIKE '%' || $4 || '%'
                OR label ILIKE '%' || $4 || '%'
                OR selector ILIKE '%' || $4 || '%'
              )
              AND ($5::timestamptz IS NULL OR (updated_at, id) < ($5::timestamptz, $6::uuid))
            ORDER BY updated_at DESC, id DESC
            LIMIT $7`,
          [principal.tenantId, siteId, stability ?? null, search ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapElement));
    },
  );

  app.post<{ Params: { siteId: string } }>(
    "/v1/sites/:siteId/elements",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string } }>, reply) => {
      const siteId = validateUuid(request.params.siteId);
      const body = parseCreateBody(request.body);
      const result = await runIdempotentCommand(deps, request, "createSiteElement", `/v1/sites/${siteId}/elements`, (client, tenantId) =>
        createElement(client, tenantId, siteId, principalUuid(request), body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.patch<{ Params: { siteId: string; elementId: string } }>(
    "/v1/sites/:siteId/elements/:elementId",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string; elementId: string } }>, reply) => {
      const siteId = validateUuid(request.params.siteId);
      const elementId = validateUuid(request.params.elementId);
      const body = parseUpdateBody(request.body);
      const result = await runIdempotentCommand(deps, request, "updateSiteElement", `/v1/sites/${siteId}/elements/${elementId}`, (client) =>
        updateElement(client, siteId, elementId, principalUuid(request), body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { siteId: string; elementId: string } }>(
    "/v1/sites/:siteId/elements/:elementId/probe",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string; elementId: string } }>, reply) => {
      const siteId = validateUuid(request.params.siteId);
      const elementId = validateUuid(request.params.elementId);
      const body = parseProbeBody(request.body);
      const result = await runIdempotentCommand(deps, request, "probeSiteElement", `/v1/sites/${siteId}/elements/${elementId}/probe`, (client, tenantId) =>
        probeElement(deps, client, tenantId, siteId, elementId, principalUuid(request), request.correlationId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.delete<{ Params: { siteId: string; elementId: string } }>(
    "/v1/sites/:siteId/elements/:elementId",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string; elementId: string } }>, reply) => {
      const siteId = validateUuid(request.params.siteId);
      const elementId = validateUuid(request.params.elementId);
      const result = await runIdempotentCommand(deps, request, "deleteSiteElement", `/v1/sites/${siteId}/elements/${elementId}`, (client) =>
        deleteElement(client, siteId, elementId),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

function parseCreateBody(raw: unknown): CreateBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (!["element_key", "label", "selector", "element_type", "stability", "source", "sample_url", "notes"].includes(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  return {
    elementKey: requireElementKey(raw.element_key),
    label: requireTrimmed(raw.label, "invalid_label"),
    selector: requireTrimmed(raw.selector, "invalid_selector"),
    elementType: optionalEnum(raw.element_type, ELEMENT_TYPES, "invalid_element_type") ?? "other",
    stability: optionalEnum(raw.stability, STABILITIES, "invalid_stability") ?? "stable",
    source: optionalEnum(raw.source, SOURCES, "invalid_source") ?? "manual",
    sampleUrl: optionalUrl(raw.sample_url, "invalid_sample_url"),
    notes: optionalText(raw.notes, "invalid_notes"),
  };
}

function parseUpdateBody(raw: unknown): UpdateBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  const out: UpdateBody = {};
  let seen = false;
  for (const key of Object.keys(raw)) {
    seen = true;
    if (key === "element_key" || key === "source") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "immutable_field", field: key });
    }
    if (key === "last_verified_at") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "probe_managed_field", field: key });
    }
    if (!["label", "selector", "element_type", "stability", "sample_url", "notes"].includes(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  if (!seen) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  if (Object.prototype.hasOwnProperty.call(raw, "label")) out.label = requireTrimmed(raw.label, "invalid_label");
  if (Object.prototype.hasOwnProperty.call(raw, "selector")) out.selector = requireTrimmed(raw.selector, "invalid_selector");
  if (Object.prototype.hasOwnProperty.call(raw, "element_type")) out.elementType = requireEnum(raw.element_type, ELEMENT_TYPES, "invalid_element_type");
  if (Object.prototype.hasOwnProperty.call(raw, "stability")) out.stability = requireEnum(raw.stability, STABILITIES, "invalid_stability");
  if (Object.prototype.hasOwnProperty.call(raw, "sample_url")) out.sampleUrl = optionalUrl(raw.sample_url, "invalid_sample_url");
  if (Object.prototype.hasOwnProperty.call(raw, "notes")) out.notes = optionalText(raw.notes, "invalid_notes");
  return out;
}

function parseProbeBody(raw: unknown): ProbeBody {
  if (raw === undefined || raw === null) return { sampleUrl: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "sample_url") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  return { sampleUrl: optionalUrl(raw.sample_url, "invalid_sample_url") };
}

function validateUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return value;
}

function principalUuid(request: FastifyRequest): string | null {
  const subjectId = requirePrincipal(request).subjectId;
  return UUID_RE.test(subjectId) ? subjectId : null;
}

function requireElementKey(value: unknown): string {
  if (typeof value !== "string" || !ELEMENT_KEY_RE.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_element_key" });
  }
  return value;
}

function requireTrimmed(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return value.trim();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T | undefined {
  if (value === undefined) return undefined;
  return requireEnum(value, allowed, reason);
}

function optionalText(value: unknown, reason: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalUrl(value: unknown, reason: string): string | null {
  const text = optionalText(value, reason);
  if (text === null) return null;
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return text;
  } catch {
    // fall through
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function optionalSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_search" });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
