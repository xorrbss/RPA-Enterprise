import type { FastifyInstance, FastifyRequest } from "fastify";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parseLimit, parsePageParams } from "./list-query";
import { signedCommandRefsFor } from "./scenarios-support";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { UUID_RE } from "./server-shared";
import { appendEvents, completeRecording, promoteRecordingToStudio, startRecording } from "./browser-recordings-commands";
import { eventSeqCursor, optionalEnum, parseAppendEventsBody, parseStartBody } from "./browser-recordings-ingest";
import {
  assertRecordingExists,
  assertSiteExists,
  mapRecording,
  mapRecordingEvent,
  RECORDING_STATUSES,
  type RecordingEventRow,
  type RecordingRow,
} from "./browser-recordings-store";

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
                  event_count, draft_ir, validation_report, review_status, review_report,
                  promoted_scenario_id::text AS promoted_scenario_id, promoted_scenario_version,
                  promoted_studio_project_id::text AS promoted_studio_project_id, promoted_studio_graph_version,
                  updated_by::text AS updated_by, created_at, updated_at,
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

  app.post<{ Params: { siteId: string; recordingId: string } }>(
    "/v1/sites/:siteId/recordings/:recordingId/promote-to-studio",
    { config: { rbacAction: "scenario.create" } },
    async (request: FastifyRequest<{ Params: { siteId: string; recordingId: string } }>, reply) => {
      const principal = requirePrincipal(request);
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
      const siteId = validateUuid(request.params.siteId);
      const recordingId = validateUuid(request.params.recordingId);
      const result = await runIdempotentCommand(
        deps,
        request,
        "promoteBrowserRecordingToStudio",
        `/v1/sites/${siteId}/recordings/${recordingId}/promote-to-studio`,
        (client, tenantId) =>
          promoteRecordingToStudio(
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

function validateUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return value;
}

function principalUuid(request: FastifyRequest): string | null {
  const principal = requirePrincipal(request);
  return UUID_RE.test(principal.subjectId) ? principal.subjectId : null;
}
