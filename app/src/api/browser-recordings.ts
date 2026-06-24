import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { ValidationReport } from "../../../codegen/types";
import { withTenantTx } from "../db/pool";
import { originOf } from "../runtime/site-resolution";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { compileScenario } from "./compile-pipeline";
import { ApiResponseError } from "./errors";
import { paginate, parseLimit, parsePageParams } from "./list-query";
import { signedCommandRefsFor } from "./scenarios-support";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

type RecordingStatus = "recording" | "completed" | "discarded" | "failed";
type RecordingEventType = "navigate" | "click" | "input" | "select" | "submit" | "wait";

interface RecordingRow {
  id: string;
  site_profile_id: string;
  name: string;
  start_url: string;
  status: RecordingStatus;
  event_count: number;
  draft_ir: unknown | null;
  validation_report: unknown | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface RecordingEventRow {
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

interface SiteElementLookupRow {
  element_key: string;
  label: string;
  selector: string;
}

interface StartRecordingBody {
  readonly name: string;
  readonly startUrl?: string;
}

interface AppendEventsBody {
  readonly events: readonly ParsedRecordingEvent[];
}

interface ParsedRecordingEvent {
  readonly eventType: RecordingEventType;
  readonly selector: string | null;
  readonly elementKey: string | null;
  readonly label: string | null;
  readonly url: string | null;
  readonly valuePreview: string | null;
}

const RECORDING_STATUSES: readonly RecordingStatus[] = ["recording", "completed", "discarded", "failed"];
const EVENT_TYPES: readonly RecordingEventType[] = ["navigate", "click", "input", "select", "submit", "wait"];
const ELEMENT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const SENSITIVE_KEY_RE = /(^value$|password|passwd|token|cookie|secret|otp|mfa|authorization)/i;
const BEARER_VALUE_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/i;
const TOKENISH_VALUE_RE = /^[A-Za-z0-9._~+/=-]{32,}$/;
const OTP_VALUE_RE = /^\d{6,8}$/;
const REDACTED_VALUE_PREVIEW = "[redacted]";

export function registerBrowserRecordingRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Params: { siteId: string } }>(
    "/v1/sites/:siteId/recordings",
    { config: { rbacAction: "site.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const siteId = validateUuid(request.params.siteId);
      const query = request.query as Record<string, unknown>;
      const { limit, cursor } = parsePageParams(query);
      const status = optionalEnum(query.status, RECORDING_STATUSES, "invalid_recording_status");

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertSiteExists(client, siteId);
        const result = await client.query<RecordingRow>(
          `SELECT id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
                  event_count, draft_ir, validation_report, updated_by::text AS updated_by, created_at, updated_at,
                  updated_at::text AS cursor_at
             FROM browser_recording_sessions
            WHERE tenant_id = $1::uuid
              AND site_profile_id = $2::uuid
              AND ($3::text IS NULL OR status = $3)
              AND ($4::timestamptz IS NULL OR (updated_at, id) < ($4::timestamptz, $5::uuid))
            ORDER BY updated_at DESC, id DESC
            LIMIT $6`,
          [principal.tenantId, siteId, status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapRecording));
    },
  );

  app.post<{ Params: { siteId: string } }>(
    "/v1/sites/:siteId/recordings",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string } }>, reply) => {
      const siteId = validateUuid(request.params.siteId);
      const body = parseStartBody(request.body);
      const result = await runIdempotentCommand(deps, request, "startBrowserRecording", `/v1/sites/${siteId}/recordings`, (client, tenantId) =>
        startRecording(client, tenantId, siteId, principalUuid(request), body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { siteId: string; recordingId: string } }>(
    "/v1/sites/:siteId/recordings/:recordingId/events",
    { config: { rbacAction: "site.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const siteId = validateUuid(request.params.siteId);
      const recordingId = validateUuid(request.params.recordingId);
      const query = request.query as Record<string, unknown>;
      const limit = parseLimit(query.limit);
      const cursor = eventSeqCursor(query.cursor);
      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertRecordingExists(client, siteId, recordingId);
        const result = await client.query<RecordingEventRow>(
          `SELECT id::text AS id, recording_session_id::text AS recording_session_id, seq, recording_event_type AS event_type,
                  selector, element_key, label, url, value_preview, captured_at, created_at
             FROM browser_recording_events
            WHERE tenant_id = $1::uuid AND recording_session_id = $2::uuid
              AND ($3::int IS NULL OR seq > $3::int)
            ORDER BY seq ASC
            LIMIT $4`,
          [principal.tenantId, recordingId, cursor, limit + 1],
        );
        return result.rows;
      });
      const items = rows.slice(0, limit).map(mapRecordingEvent);
      reply.code(200).send({ items, next_cursor: rows.length > limit ? String(items.at(-1)?.seq ?? "") : null });
    },
  );

  app.post<{ Params: { siteId: string; recordingId: string } }>(
    "/v1/sites/:siteId/recordings/:recordingId/events",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string; recordingId: string } }>, reply) => {
      const siteId = validateUuid(request.params.siteId);
      const recordingId = validateUuid(request.params.recordingId);
      const body = parseAppendEventsBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "appendBrowserRecordingEvents",
        `/v1/sites/${siteId}/recordings/${recordingId}/events`,
        (client, tenantId) => appendEvents(client, tenantId, siteId, recordingId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { siteId: string; recordingId: string } }>(
    "/v1/sites/:siteId/recordings/:recordingId/complete",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { siteId: string; recordingId: string } }>, reply) => {
      const principal = requirePrincipal(request);
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.validate");
      const siteId = validateUuid(request.params.siteId);
      const recordingId = validateUuid(request.params.recordingId);
      const result = await runIdempotentCommand(
        deps,
        request,
        "completeBrowserRecording",
        `/v1/sites/${siteId}/recordings/${recordingId}/complete`,
        (client, tenantId) =>
          completeRecording(
            client,
            tenantId,
            siteId,
            recordingId,
            UUID_RE.test(principal.subjectId) ? principal.subjectId : null,
            signedCommandRefs,
          ),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function startRecording(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  updatedBy: string | null,
  body: StartRecordingBody,
): Promise<CommandResponse> {
  const site = await client.query<{ risk: string; approved: boolean; url_pattern: string }>(
    `SELECT risk, approved, url_pattern FROM site_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, siteId],
  );
  const row = site.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  if (row.risk === "red" && row.approved !== true) throw new ApiResponseError("SITE_PROFILE_BLOCKED");

  const startUrl = body.startUrl ?? row.url_pattern;
  assertHttpUrl(startUrl, "invalid_start_url");
  const siteOrigin = originOf(row.url_pattern);
  const startOrigin = originOf(startUrl);
  if (siteOrigin === null || startOrigin === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
  }
  if (siteOrigin !== startOrigin) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "start_url_site_mismatch" });
  }

  const identity = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM browser_identities WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid ORDER BY version DESC LIMIT 1`,
    [tenantId, siteId],
  );

  const recordingId = randomUUID();
  const inserted = await client.query<RecordingRow>(
    `INSERT INTO browser_recording_sessions
       (id, tenant_id, site_profile_id, browser_identity_id, name, start_url, updated_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid)
     RETURNING id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
               event_count, draft_ir, validation_report, updated_by::text AS updated_by, created_at, updated_at,
               updated_at::text AS cursor_at`,
    [recordingId, tenantId, siteId, identity.rows[0]?.id ?? null, body.name, startUrl, updatedBy],
  );
  return { status: 201, body: mapRecording(inserted.rows[0]) };
}

async function appendEvents(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  recordingId: string,
  body: AppendEventsBody,
): Promise<CommandResponse> {
  const recording = await getRecordingForUpdate(client, tenantId, siteId, recordingId);
  if (recording.status !== "recording") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "recording_not_active", status: recording.status });
  }
  const maxSeq = await client.query<{ max_seq: number | null }>(
    `SELECT max(seq)::int AS max_seq FROM browser_recording_events WHERE tenant_id=$1::uuid AND recording_session_id=$2::uuid`,
    [tenantId, recordingId],
  );
  const startSeq = (maxSeq.rows[0]?.max_seq ?? 0) + 1;
  for (let i = 0; i < body.events.length; i += 1) {
    const event = body.events[i]!;
    await client.query(
      `INSERT INTO browser_recording_events
         (id, tenant_id, recording_session_id, seq, recording_event_type, selector, element_key, label, url, value_preview)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        tenantId,
        recordingId,
        startSeq + i,
        event.eventType,
        event.selector,
        event.elementKey,
        event.label,
        event.url,
        event.valuePreview,
      ],
    );
  }
  const updated = await client.query<{ event_count: number }>(
    `UPDATE browser_recording_sessions
        SET event_count = event_count + $1, updated_at = now()
      WHERE tenant_id=$2::uuid AND id=$3::uuid
      RETURNING event_count`,
    [body.events.length, tenantId, recordingId],
  );
  return {
    status: 200,
    body: { recording_session_id: recordingId, appended: body.events.length, event_count: updated.rows[0]?.event_count ?? recording.event_count + body.events.length },
  };
}

async function completeRecording(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  recordingId: string,
  updatedBy: string | null,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const recording = await getRecordingForUpdate(client, tenantId, siteId, recordingId);
  if (recording.status === "completed" && recording.draft_ir !== null && recording.validation_report !== null) {
    return { status: 200, body: mapRecording(recording) };
  }
  if (recording.status === "completed" && recording.draft_ir !== null) {
    const validation = validateDraftIr(recording.draft_ir, signedCommandRefs);
    const updatedCompleted = await client.query<RecordingRow>(
      `UPDATE browser_recording_sessions
          SET validation_report=$1::jsonb, updated_by=$2::uuid, updated_at=now()
        WHERE tenant_id=$3::uuid AND id=$4::uuid
        RETURNING id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
                  event_count, draft_ir, validation_report, updated_by::text AS updated_by, created_at, updated_at,
                  updated_at::text AS cursor_at`,
      [JSON.stringify(validation.report), updatedBy, tenantId, recordingId],
    );
    return { status: 200, body: mapRecording(updatedCompleted.rows[0]) };
  }
  if (recording.status !== "recording") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "recording_not_active", status: recording.status });
  }
  const events = await client.query<RecordingEventRow>(
    `SELECT id::text AS id, recording_session_id::text AS recording_session_id, seq, recording_event_type AS event_type,
            selector, element_key, label, url, value_preview, captured_at, created_at
       FROM browser_recording_events
      WHERE tenant_id=$1::uuid AND recording_session_id=$2::uuid
      ORDER BY seq ASC`,
    [tenantId, recordingId],
  );
  if (events.rows.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "no_recorded_events" });
  }
  const elementLookup = await loadElementLookup(client, tenantId, siteId, events.rows);
  await incrementElementUsage(client, tenantId, siteId, [...elementLookup.values()].map((row) => row.element_key));
  const draftIr = buildDraftIr(recording.name, events.rows, elementLookup);
  const validation = validateDraftIr(draftIr, signedCommandRefs);
  const updated = await client.query<RecordingRow>(
    `UPDATE browser_recording_sessions
        SET status='completed', event_count=$1, draft_ir=$2::jsonb, validation_report=$3::jsonb, updated_by=$4::uuid, updated_at=now()
      WHERE tenant_id=$5::uuid AND id=$6::uuid
      RETURNING id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
                event_count, draft_ir, validation_report, updated_by::text AS updated_by, created_at, updated_at,
                updated_at::text AS cursor_at`,
    [events.rows.length, JSON.stringify(draftIr), JSON.stringify(validation.report), updatedBy, tenantId, recordingId],
  );
  return { status: 200, body: mapRecording(updated.rows[0]) };
}

async function assertSiteExists(client: PoolClient, siteId: string): Promise<void> {
  const result = await client.query<{ id: string }>(`SELECT id FROM site_profiles WHERE id=$1::uuid`, [siteId]);
  if (result.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

async function assertRecordingExists(client: PoolClient, siteId: string, recordingId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM browser_recording_sessions WHERE site_profile_id=$1::uuid AND id=$2::uuid`,
    [siteId, recordingId],
  );
  if (result.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

async function getRecordingForUpdate(client: PoolClient, tenantId: string, siteId: string, recordingId: string): Promise<RecordingRow> {
  const result = await client.query<RecordingRow>(
    `SELECT id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
            event_count, draft_ir, validation_report, updated_by::text AS updated_by, created_at, updated_at,
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

async function loadElementLookup(
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
    `SELECT element_key, label, selector
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

async function incrementElementUsage(
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

function validateDraftIr(
  draftIr: unknown,
  signedCommandRefs: readonly string[] | undefined,
): { readonly valid: boolean; readonly report: ValidationReport } {
  const outcome = compileScenario(draftIr, { signedCommandRefs });
  if (outcome.ok) return { valid: true, report: outcome.report };
  if (outcome.report !== undefined) return { valid: false, report: outcome.report };
  return {
    valid: false,
    report: {
      errors: [{
        rule: "V1",
        reason: "schema_invalid",
        code: outcome.code,
        detail: safeDetail(outcome.details),
      }],
      warnings: [],
    },
  };
}

function safeDetail(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return "schema validation failed";
  }
}

function buildDraftIr(
  name: string,
  events: readonly RecordingEventRow[],
  elementLookup: ReadonlyMap<string, SiteElementLookupRow> = new Map(),
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const nodeId = `step_${String(index + 1).padStart(2, "0")}`;
    const next = index === events.length - 1 ? "done" : `step_${String(index + 2).padStart(2, "0")}`;
    const action = actionFromEvent(event, elementLookup.get(event.id), properties, required);
    nodes[nodeId] = {
      what: [action],
      ...(event.event_type === "submit" ? { side_effect: { kind: "submit", idempotency_key: `recorded_submit_${event.seq}` } } : {}),
      next,
    };
  }
  nodes.done = { terminal: "success" };
  return {
    meta: { name, version: 1, studio_mode: "easy" },
    ...(Object.keys(properties).length > 0 ? { params_schema: { type: "object", properties, required } } : {}),
    start: "step_01",
    nodes,
  };
}

function actionFromEvent(
  event: RecordingEventRow,
  element: SiteElementLookupRow | undefined,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  const selector = element?.selector ?? event.selector;
  const label = element?.label ?? event.label ?? event.element_key ?? selector ?? event.url ?? event.event_type;
  if (event.event_type === "navigate") {
    const key = event.seq === 1 ? "entry_url" : `url_${event.seq}`;
    properties[key] = { type: "string", format: "uri", default: event.url };
    required.push(key);
    return { action: "navigate", url_ref: key };
  }
  if (event.event_type === "input") {
    const key = `input_${event.seq}`;
    properties[key] = { type: "string", description: `${label} 입력값` };
    required.push(key);
    return { action: "act", instruction: `${label} 입력`, args: { fill_selector: selector, value_ref: key } };
  }
  if (event.event_type === "select") {
    return { action: "act", instruction: `${label} 선택`, args: { select_selector: selector, select_value: event.value_preview ?? "" } };
  }
  if (event.event_type === "wait") {
    return { action: "observe", instruction: `${label} 대기`, args: { selector: selector ?? undefined } };
  }
  return { action: "act", instruction: `${label} 클릭`, args: { click_selector: selector } };
}

function parseStartBody(raw: unknown): StartRecordingBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  rejectSensitiveKeys(raw);
  for (const key of Object.keys(raw)) {
    if (!["name", "start_url"].includes(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  const name = requireTrimmed(raw.name, "invalid_name");
  const startUrl = optionalHttpUrl(raw.start_url, "invalid_start_url");
  return { name, ...(startUrl !== undefined ? { startUrl } : {}) };
}

function parseAppendEventsBody(raw: unknown): AppendEventsBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  rejectSensitiveKeys(raw);
  for (const key of Object.keys(raw)) {
    if (key !== "events") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_events" });
  }
  return { events: raw.events.map(parseEvent) };
}

function eventSeqCursor(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  }
  const seq = Number.parseInt(raw, 10);
  if (seq < 1) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  return seq;
}

function parseEvent(raw: unknown): ParsedRecordingEvent {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "event_object_required" });
  rejectSensitiveKeys(raw);
  for (const key of Object.keys(raw)) {
    if (!["event_type", "selector", "element_key", "label", "url", "value_preview"].includes(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_event_field", field: key });
    }
  }
  const eventType = requireEnum(raw.event_type, EVENT_TYPES, "invalid_event_type");
  const selector = optionalTrimmed(raw.selector, "invalid_selector");
  const elementKey = optionalElementKey(raw.element_key);
  const label = optionalTrimmed(raw.label, "invalid_label");
  const url = optionalHttpUrl(raw.url, "invalid_event_url");
  const valuePreview = redactSensitiveValuePreview(
    eventType,
    optionalTrimmed(raw.value_preview, "invalid_value_preview"),
    selector,
    elementKey,
    label,
  );

  if (eventType === "navigate" && url === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "navigate_url_required" });
  if ((eventType === "click" || eventType === "input" || eventType === "select" || eventType === "submit") && selector === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "selector_required", event_type: eventType });
  }
  if (eventType === "select" && valuePreview === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "select_value_required" });
  return { eventType, selector: selector ?? null, elementKey: elementKey ?? null, label: label ?? null, url: url ?? null, valuePreview: valuePreview ?? null };
}

function redactSensitiveValuePreview(
  eventType: RecordingEventType,
  valuePreview: string | undefined,
  selector: string | undefined,
  elementKey: string | undefined,
  label: string | undefined,
): string | undefined {
  if (valuePreview === undefined || eventType !== "input") return valuePreview;
  const context = [selector, elementKey, label].filter((value): value is string => value !== undefined).join(" ");
  const trimmed = valuePreview.trim();
  if (
    SENSITIVE_KEY_RE.test(context) ||
    BEARER_VALUE_RE.test(trimmed) ||
    TOKENISH_VALUE_RE.test(trimmed) ||
    OTP_VALUE_RE.test(trimmed)
  ) {
    return REDACTED_VALUE_PREVIEW;
  }
  return valuePreview;
}

function rejectSensitiveKeys(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "sensitive_recording_field_rejected", field: key });
    if (isRecord(nested)) rejectSensitiveKeys(nested);
    if (Array.isArray(nested)) for (const item of nested) rejectSensitiveKeys(item);
  }
}

function mapRecording(row: RecordingRow): Record<string, unknown> {
  return {
    recording_session_id: row.id,
    site_profile_id: row.site_profile_id,
    name: row.name,
    start_url: row.start_url,
    status: row.status,
    event_count: row.event_count,
    draft_ir: row.draft_ir,
    validation_report: row.validation_report,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapRecordingEvent(row: RecordingEventRow): Record<string, unknown> {
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

function validateUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return value;
}

function principalUuid(request: FastifyRequest): string | null {
  const principal = requirePrincipal(request);
  return UUID_RE.test(principal.subjectId) ? principal.subjectId : null;
}

function requireTrimmed(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return value.trim();
}

function optionalTrimmed(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireTrimmed(value, reason);
}

function optionalElementKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ELEMENT_KEY_RE.test(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_element_key" });
  return value;
}

function assertHttpUrl(value: string, reason: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function optionalHttpUrl(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2048) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  const url = value.trim();
  assertHttpUrl(url, reason);
  return url;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  return value as T;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireEnum(value, allowed, reason);
}
