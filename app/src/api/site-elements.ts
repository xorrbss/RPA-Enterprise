import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

type ElementType = "button" | "input" | "link" | "table" | "row" | "field" | "message" | "other";
type ElementStability = "stable" | "review_needed" | "broken";
type ElementSource = "manual" | "pbd" | "capture" | "imported";
type ElementProbeStatus = "matched" | "not_found" | "invalid_selector" | "failed" | "not_run";

interface SiteElementRow {
  id: string;
  site_profile_id: string;
  element_key: string;
  label: string;
  selector: string;
  element_type: ElementType;
  stability: ElementStability;
  source: ElementSource;
  sample_url: string | null;
  notes: string | null;
  usage_count: number;
  last_verified_at: Date | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface CreateBody {
  readonly elementKey: string;
  readonly label: string;
  readonly selector: string;
  readonly elementType: ElementType;
  readonly stability: ElementStability;
  readonly source: ElementSource;
  readonly sampleUrl: string | null;
  readonly notes: string | null;
}

interface UpdateBody {
  label?: string;
  selector?: string;
  elementType?: ElementType;
  stability?: ElementStability;
  sampleUrl?: string | null;
  notes?: string | null;
}

interface ProbeBody {
  readonly sampleUrl: string | null;
}

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
                  element_type, stability, source, sample_url, notes, usage_count, last_verified_at,
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

async function createElement(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  updatedBy: string | null,
  body: CreateBody,
): Promise<CommandResponse> {
  await assertSiteExists(client, siteId);
  try {
    const result = await client.query<SiteElementRow>(
      `INSERT INTO site_element_repository
         (id, tenant_id, site_profile_id, element_key, label, selector, element_type, stability, source, sample_url, notes, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid)
       RETURNING id::text AS id, site_profile_id::text AS site_profile_id, element_key, label, selector,
                 element_type, stability, source, sample_url, notes, usage_count, last_verified_at,
                 updated_by::text AS updated_by, created_at, updated_at, updated_at::text AS cursor_at`,
      [
        randomUUID(),
        tenantId,
        siteId,
        body.elementKey,
        body.label,
        body.selector,
        body.elementType,
        body.stability,
        body.source,
        body.sampleUrl,
        body.notes,
        updatedBy,
      ],
    );
    return { status: 201, body: mapElement(result.rows[0]) };
  } catch (err) {
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "element_key_already_exists", element_key: body.elementKey });
    }
    throw err;
  }
}

async function updateElement(
  client: PoolClient,
  siteId: string,
  elementId: string,
  updatedBy: string | null,
  body: UpdateBody,
): Promise<CommandResponse> {
  await assertSiteExists(client, siteId);
  const result = await client.query<SiteElementRow>(
    `UPDATE site_element_repository
        SET label = COALESCE($1, label),
            selector = COALESCE($2, selector),
            element_type = COALESCE($3, element_type),
            stability = COALESCE($4, stability),
            sample_url = CASE WHEN $5::boolean THEN $6 ELSE sample_url END,
            notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
            updated_by = $9::uuid,
            updated_at = now()
      WHERE id = $10::uuid AND site_profile_id = $11::uuid
      RETURNING id::text AS id, site_profile_id::text AS site_profile_id, element_key, label, selector,
                element_type, stability, source, sample_url, notes, usage_count, last_verified_at,
                updated_by::text AS updated_by, created_at, updated_at, updated_at::text AS cursor_at`,
    [
      body.label ?? null,
      body.selector ?? null,
      body.elementType ?? null,
      body.stability ?? null,
      Object.prototype.hasOwnProperty.call(body, "sampleUrl"),
      body.sampleUrl ?? null,
      Object.prototype.hasOwnProperty.call(body, "notes"),
      body.notes ?? null,
      updatedBy,
      elementId,
      siteId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return { status: 200, body: mapElement(row) };
}

async function probeElement(
  deps: ApiServerDeps,
  client: PoolClient,
  tenantId: string,
  siteId: string,
  elementId: string,
  updatedBy: string | null,
  correlationId: string,
  body: ProbeBody,
): Promise<CommandResponse> {
  await assertSiteExists(client, siteId);
  const existing = await client.query<SiteElementRow>(
    `SELECT id::text AS id, site_profile_id::text AS site_profile_id, element_key, label, selector,
            element_type, stability, source, sample_url, notes, usage_count, last_verified_at,
            updated_by::text AS updated_by, created_at, updated_at, updated_at::text AS cursor_at
       FROM site_element_repository
      WHERE id = $1::uuid AND site_profile_id = $2::uuid
      FOR UPDATE`,
    [elementId, siteId],
  );
  const element = existing.rows[0];
  if (element === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");

  const checkedAt = new Date();
  const sampleUrl = body.sampleUrl ?? element.sample_url;
  if (sampleUrl === null) {
    return {
      status: 200,
      body: mapProbeResult(element, "not_run", null, "SAMPLE_URL_REQUIRED", checkedAt),
    };
  }
  if (deps.selectorProbe === undefined) {
    return {
      status: 200,
      body: mapProbeResult(element, "not_run", null, "SELECTOR_PROBE_PROVIDER_UNAVAILABLE", checkedAt),
    };
  }

  let status: ElementProbeStatus;
  let matchCount: number | null;
  let reasonCode: string | null;
  try {
    const probe = await deps.selectorProbe.probe({
      tenantId,
      siteProfileId: siteId,
      elementId,
      selector: element.selector,
      sampleUrl,
      correlationId,
    });
    status = probe.status;
    matchCount = normalizeMatchCount(probe.matchCount);
    reasonCode = probe.reasonCode ?? defaultProbeReason(status);
    if (status === "matched" && (matchCount ?? 0) <= 0) {
      status = "not_found";
      reasonCode = "SELECTOR_NOT_FOUND";
    }
  } catch {
    status = "failed";
    matchCount = null;
    reasonCode = "SELECTOR_PROBE_FAILED";
  }

  const nextStability = stabilityFromProbe(status, element.stability);
  const update = await client.query<SiteElementRow>(
    `UPDATE site_element_repository
        SET stability = $1,
            sample_url = $2,
            last_verified_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE last_verified_at END,
            updated_by = $5::uuid,
            updated_at = now()
      WHERE id = $6::uuid AND site_profile_id = $7::uuid
      RETURNING id::text AS id, site_profile_id::text AS site_profile_id, element_key, label, selector,
                element_type, stability, source, sample_url, notes, usage_count, last_verified_at,
                updated_by::text AS updated_by, created_at, updated_at, updated_at::text AS cursor_at`,
    [
      nextStability,
      sampleUrl,
      status !== "failed",
      checkedAt.toISOString(),
      updatedBy,
      elementId,
      siteId,
    ],
  );
  return { status: 200, body: mapProbeResult(update.rows[0] ?? element, status, matchCount, reasonCode, checkedAt) };
}

async function deleteElement(client: PoolClient, siteId: string, elementId: string): Promise<CommandResponse> {
  await assertSiteExists(client, siteId);
  const result = await client.query<{ id: string }>(
    `DELETE FROM site_element_repository
      WHERE id = $1::uuid AND site_profile_id = $2::uuid
      RETURNING id::text AS id`,
    [elementId, siteId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return { status: 200, body: { element_id: row.id, deleted: true } };
}

async function assertSiteExists(client: PoolClient, siteId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM site_profiles WHERE id = $1::uuid`,
    [siteId],
  );
  if (result.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
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

function mapElement(row: SiteElementRow): Record<string, unknown> {
  return {
    element_id: row.id,
    site_profile_id: row.site_profile_id,
    element_key: row.element_key,
    label: row.label,
    selector: row.selector,
    element_type: row.element_type,
    stability: row.stability,
    source: row.source,
    sample_url: row.sample_url,
    notes: row.notes,
    usage_count: row.usage_count,
    last_verified_at: row.last_verified_at !== null ? row.last_verified_at.toISOString() : null,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapProbeResult(
  row: SiteElementRow,
  status: ElementProbeStatus,
  matchCount: number | null,
  reasonCode: string | null,
  checkedAt: Date,
): Record<string, unknown> {
  return {
    element_id: row.id,
    site_profile_id: row.site_profile_id,
    selector: row.selector,
    sample_url: row.sample_url,
    probe_status: status,
    match_count: matchCount,
    reason_code: reasonCode,
    checked_at: checkedAt.toISOString(),
    element: mapElement(row),
  };
}

function normalizeMatchCount(value: number | null): number | null {
  if (value === null) return null;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function defaultProbeReason(status: ElementProbeStatus): string | null {
  if (status === "matched") return null;
  if (status === "not_found") return "SELECTOR_NOT_FOUND";
  if (status === "invalid_selector") return "SELECTOR_INVALID";
  if (status === "failed") return "SELECTOR_PROBE_FAILED";
  return "SELECTOR_PROBE_NOT_RUN";
}

function stabilityFromProbe(status: ElementProbeStatus, current: ElementStability): ElementStability {
  if (status === "matched") return "stable";
  if (status === "not_found") return "review_needed";
  if (status === "invalid_selector") return "broken";
  return current;
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
