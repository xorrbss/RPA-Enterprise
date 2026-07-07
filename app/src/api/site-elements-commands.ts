import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import type { ApiServerDeps } from "./server-shared";
import {
  mapElement,
  type CreateBody,
  type ElementConfidence,
  type ElementProbeStatus,
  type ElementStability,
  type ProbeBody,
  type SiteElementRow,
  type UpdateBody,
} from "./site-elements-shared";

export async function createElement(
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
                 element_type, stability, confidence, source, sample_url, last_probe_result, notes, usage_count, last_verified_at,
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

export async function updateElement(
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
                element_type, stability, confidence, source, sample_url, last_probe_result, notes, usage_count, last_verified_at,
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

export async function probeElement(
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
            element_type, stability, confidence, source, sample_url, last_probe_result, notes, usage_count, last_verified_at,
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
  const lastProbeResult = {
    status,
    match_count: matchCount,
    reason_code: reasonCode,
    checked_at: checkedAt.toISOString(),
  };
  const update = await client.query<SiteElementRow>(
    `UPDATE site_element_repository
        SET stability = $1,
            confidence = $2,
            sample_url = $3,
            last_probe_result = $4::jsonb,
            last_verified_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE last_verified_at END,
            updated_by = $7::uuid,
            updated_at = now()
      WHERE id = $8::uuid AND site_profile_id = $9::uuid
      RETURNING id::text AS id, site_profile_id::text AS site_profile_id, element_key, label, selector,
                element_type, stability, confidence, source, sample_url, last_probe_result, notes, usage_count, last_verified_at,
                updated_by::text AS updated_by, created_at, updated_at, updated_at::text AS cursor_at`,
    [
      nextStability,
      confidenceFromProbe(status),
      sampleUrl,
      JSON.stringify(lastProbeResult),
      status !== "failed",
      checkedAt.toISOString(),
      updatedBy,
      elementId,
      siteId,
    ],
  );
  return { status: 200, body: mapProbeResult(update.rows[0] ?? element, status, matchCount, reasonCode, checkedAt) };
}

export async function deleteElement(client: PoolClient, siteId: string, elementId: string): Promise<CommandResponse> {
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

export async function assertSiteExists(client: PoolClient, siteId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM site_profiles WHERE id = $1::uuid`,
    [siteId],
  );
  if (result.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
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

function confidenceFromProbe(status: ElementProbeStatus): ElementConfidence {
  if (status === "matched") return "high";
  if (status === "not_found" || status === "invalid_selector") return "low";
  return "unknown";
}
