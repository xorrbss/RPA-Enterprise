import type { PoolClient } from "pg";

import { ApiResponseError } from "../runtime/errors";

export type RecordingStatus = "recording" | "completed" | "discarded" | "failed";
export type RecordingReviewStatus = "not_started" | "review_needed" | "ready_for_studio" | "promoted_to_studio" | "discarded";
export type RecordingEventType = "navigate" | "click" | "input" | "select" | "submit" | "wait";
export type SelectorConfidence = "high" | "medium" | "low" | "unknown";

export interface RecordingRow {
  id: string;
  site_profile_id: string;
  name: string;
  start_url: string;
  status: RecordingStatus;
  event_count: number;
  draft_ir: unknown | null;
  validation_report: unknown | null;
  review_status: RecordingReviewStatus;
  review_report: unknown | null;
  promoted_scenario_id: string | null;
  promoted_scenario_version: number | null;
  promoted_studio_project_id: string | null;
  promoted_studio_graph_version: number | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

export interface RecordingEventRow {
  id: string;
  recording_session_id: string;
  seq: number;
  event_type: RecordingEventType;
  selector: string | null;
  element_key: string | null;
  label: string | null;
  url: string | null;
  value_preview: string | null;
  captured_at: Date;
  created_at: Date;
}

export interface SiteElementLookupRow {
  element_key: string;
  label: string;
  selector: string;
  stability: "stable" | "review_needed" | "broken";
  confidence: SelectorConfidence;
  last_probe_result: unknown;
}

export const RECORDING_STATUSES: readonly RecordingStatus[] = ["recording", "completed", "discarded", "failed"];

export async function loadRecordingEvents(client: PoolClient, tenantId: string, recordingId: string): Promise<RecordingEventRow[]> {
  const events = await client.query<RecordingEventRow>(
    `SELECT id::text AS id, recording_session_id::text AS recording_session_id, seq, recording_event_type AS event_type,
            selector, element_key, label, url, value_preview, captured_at, created_at
       FROM browser_recording_events
      WHERE tenant_id=$1::uuid AND recording_session_id=$2::uuid
      ORDER BY seq ASC`,
    [tenantId, recordingId],
  );
  return events.rows;
}

export async function assertSiteExists(client: PoolClient, siteId: string): Promise<void> {
  const result = await client.query<{ id: string }>(`SELECT id FROM site_profiles WHERE id=$1::uuid`, [siteId]);
  if (result.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

export async function assertRecordingExists(client: PoolClient, siteId: string, recordingId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM browser_recording_sessions WHERE site_profile_id=$1::uuid AND id=$2::uuid`,
    [siteId, recordingId],
  );
  if (result.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

export async function getRecordingForUpdate(client: PoolClient, tenantId: string, siteId: string, recordingId: string): Promise<RecordingRow> {
  const result = await client.query<RecordingRow>(
    `SELECT id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
            event_count, draft_ir, validation_report, review_status, review_report,
            promoted_scenario_id::text AS promoted_scenario_id, promoted_scenario_version,
            promoted_studio_project_id::text AS promoted_studio_project_id, promoted_studio_graph_version,
            updated_by::text AS updated_by, created_at, updated_at,
            updated_at::text AS cursor_at
       FROM browser_recording_sessions
      WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid AND id=$3::uuid
      FOR UPDATE`,
    [tenantId, siteId, recordingId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

export async function loadElementLookup(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  events: readonly RecordingEventRow[],
): Promise<ReadonlyMap<string, SiteElementLookupRow>> {
  const keys = [...new Set(events.map((event) => event.element_key).filter((key): key is string => key !== null))];
  const selectors = [...new Set(events.map((event) => event.selector).filter((selector): selector is string => selector !== null))];
  const labels = [...new Set(events.map((event) => event.label).filter((label): label is string => label !== null))];
  if (keys.length === 0 && selectors.length === 0 && labels.length === 0) return new Map();
  const result = await client.query<SiteElementLookupRow>(
    `SELECT element_key, label, selector, stability, confidence, last_probe_result
       FROM site_element_repository
      WHERE tenant_id=$1::uuid
        AND site_profile_id=$2::uuid
        AND (
          element_key = ANY($3::text[])
          OR selector = ANY($4::text[])
          OR lower(label) = ANY($5::text[])
        )
      ORDER BY usage_count DESC, updated_at DESC, element_key ASC`,
    [tenantId, siteId, keys, selectors, labels.map((label) => label.toLowerCase())],
  );
  const byKey = new Map(result.rows.map((row) => [row.element_key, row]));
  const bySelector = new Map(result.rows.map((row) => [row.selector, row]));
  const byLabel = new Map(result.rows.map((row) => [row.label.toLowerCase(), row]));
  const out = new Map<string, SiteElementLookupRow>();
  for (const event of events) {
    const match =
      (event.element_key !== null ? byKey.get(event.element_key) : undefined) ??
      (event.selector !== null ? bySelector.get(event.selector) : undefined) ??
      (event.label !== null ? byLabel.get(event.label.toLowerCase()) : undefined);
    if (match !== undefined) out.set(event.id, match);
  }
  return out;
}

export async function incrementElementUsage(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  elementKeys: Iterable<string>,
): Promise<void> {
  const keys = [...new Set(elementKeys)];
  if (keys.length === 0) return;
  await client.query(
    `UPDATE site_element_repository
        SET usage_count = usage_count + 1, updated_at = now()
      WHERE tenant_id=$1::uuid
        AND site_profile_id=$2::uuid
        AND element_key = ANY($3::text[])`,
    [tenantId, siteId, keys],
  );
}

export function promotedRecordingBody(row: RecordingRow, studioProjectId: string, studioGraphVersionId: string | null): Record<string, unknown> {
  return {
    recording_session_id: row.id,
    site_profile_id: row.site_profile_id,
    studio_project_id: studioProjectId,
    studio_graph_version_id: studioGraphVersionId,
    studio_graph_version: row.promoted_studio_graph_version ?? 1,
    scenario_id: row.promoted_scenario_id,
    version: row.promoted_scenario_version,
    promotion_status: "draft",
    review_status: row.review_status,
  };
}

export function mapRecording(row: RecordingRow): Record<string, unknown> {
  return {
    recording_session_id: row.id,
    site_profile_id: row.site_profile_id,
    name: row.name,
    start_url: row.start_url,
    status: row.status,
    event_count: row.event_count,
    draft_ir: row.draft_ir,
    validation_report: row.validation_report,
    review_status: row.review_status,
    review_report: row.review_report,
    promoted_scenario_id: row.promoted_scenario_id,
    promoted_scenario_version: row.promoted_scenario_version,
    promoted_studio_project_id: row.promoted_studio_project_id,
    promoted_studio_graph_version: row.promoted_studio_graph_version,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function mapRecordingEvent(row: RecordingEventRow): Record<string, unknown> {
  return {
    event_id: row.id,
    recording_session_id: row.recording_session_id,
    seq: row.seq,
    event_type: row.event_type,
    selector: row.selector,
    element_key: row.element_key,
    label: row.label,
    url: row.url,
    value_preview: row.value_preview,
    captured_at: row.captured_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}
