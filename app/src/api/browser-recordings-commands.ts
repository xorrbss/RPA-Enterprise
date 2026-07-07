import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { validateStudioGraph } from "../../../codegen/validators";
import { originOf } from "../runtime/site-resolution";
import type { CommandResponse } from "./command";
import { compileScenario } from "./compile-pipeline";
import { ApiResponseError } from "../runtime/errors";
import { resolveRunTargetForIr } from "./scenarios-support";
import { assertHttpUrl, type AppendEventsBody, type StartRecordingBody } from "./browser-recordings-ingest";
import { assessRecordingReview, validateDraftIr } from "./browser-recordings-review";
import {
  getRecordingForUpdate,
  incrementElementUsage,
  loadElementLookup,
  loadRecordingEvents,
  mapRecording,
  promotedRecordingBody,
  type RecordingRow,
} from "./browser-recordings-store";
import { buildDraftIr, sha256Hex, studioGraphFromIr, withStudioMode } from "./browser-recordings-studio";

export async function startRecording(
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
               event_count, draft_ir, validation_report, review_status, review_report,
               promoted_scenario_id::text AS promoted_scenario_id, promoted_scenario_version,
               promoted_studio_project_id::text AS promoted_studio_project_id, promoted_studio_graph_version,
               updated_by::text AS updated_by, created_at, updated_at,
               updated_at::text AS cursor_at`,
    [recordingId, tenantId, siteId, identity.rows[0]?.id ?? null, body.name, startUrl, updatedBy],
  );
  return { status: 201, body: mapRecording(inserted.rows[0]) };
}

export async function appendEvents(
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

export async function completeRecording(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  recordingId: string,
  updatedBy: string | null,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const recording = await getRecordingForUpdate(client, tenantId, siteId, recordingId);
  if (
    recording.status === "completed" &&
    recording.draft_ir !== null &&
    recording.validation_report !== null &&
    recording.review_report !== null
  ) {
    return { status: 200, body: mapRecording(recording) };
  }
  if (recording.status === "completed" && recording.draft_ir !== null) {
    const events = await loadRecordingEvents(client, tenantId, recordingId);
    const elementLookup = await loadElementLookup(client, tenantId, siteId, events);
    const validation = validateDraftIr(recording.draft_ir, signedCommandRefs);
    const review = assessRecordingReview(recordingId, events, elementLookup, validation.report);
    const updatedCompleted = await client.query<RecordingRow>(
      `UPDATE browser_recording_sessions
          SET validation_report=$1::jsonb, review_status=$2, review_report=$3::jsonb, updated_by=$4::uuid, updated_at=now()
        WHERE tenant_id=$5::uuid AND id=$6::uuid
        RETURNING id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
                  event_count, draft_ir, validation_report, review_status, review_report,
                  promoted_scenario_id::text AS promoted_scenario_id, promoted_scenario_version,
                  promoted_studio_project_id::text AS promoted_studio_project_id, promoted_studio_graph_version,
                  updated_by::text AS updated_by, created_at, updated_at,
                  updated_at::text AS cursor_at`,
      [JSON.stringify(validation.report), review.review_status, JSON.stringify(review), updatedBy, tenantId, recordingId],
    );
    return { status: 200, body: mapRecording(updatedCompleted.rows[0]) };
  }
  if (recording.status !== "recording") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "recording_not_active", status: recording.status });
  }
  const events = await loadRecordingEvents(client, tenantId, recordingId);
  if (events.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "no_recorded_events" });
  }
  const elementLookup = await loadElementLookup(client, tenantId, siteId, events);
  await incrementElementUsage(client, tenantId, siteId, [...elementLookup.values()].map((row) => row.element_key));
  const draftIr = buildDraftIr(recording.name, events, elementLookup);
  const validation = validateDraftIr(draftIr, signedCommandRefs);
  const review = assessRecordingReview(recordingId, events, elementLookup, validation.report);
  const updated = await client.query<RecordingRow>(
    `UPDATE browser_recording_sessions
        SET status='completed', event_count=$1, draft_ir=$2::jsonb, validation_report=$3::jsonb,
            review_status=$4, review_report=$5::jsonb, updated_by=$6::uuid, updated_at=now()
      WHERE tenant_id=$7::uuid AND id=$8::uuid
      RETURNING id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
                event_count, draft_ir, validation_report, review_status, review_report,
                promoted_scenario_id::text AS promoted_scenario_id, promoted_scenario_version,
                promoted_studio_project_id::text AS promoted_studio_project_id, promoted_studio_graph_version,
                updated_by::text AS updated_by, created_at, updated_at,
                updated_at::text AS cursor_at`,
    [events.length, JSON.stringify(draftIr), JSON.stringify(validation.report), review.review_status, JSON.stringify(review), updatedBy, tenantId, recordingId],
  );
  return { status: 200, body: mapRecording(updated.rows[0]) };
}

export async function promoteRecordingToStudio(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  recordingId: string,
  updatedBy: string | null,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const recording = await getRecordingForUpdate(client, tenantId, siteId, recordingId);
  if (
    recording.promoted_scenario_id !== null &&
    recording.promoted_scenario_version !== null &&
    recording.promoted_studio_project_id !== null &&
    recording.promoted_studio_graph_version !== null
  ) {
    return {
      status: 200,
      body: promotedRecordingBody(recording, recording.promoted_studio_project_id, null),
    };
  }
  if (recording.status !== "completed" || recording.draft_ir === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "recording_not_completed" });
  }

  const events = await loadRecordingEvents(client, tenantId, recordingId);
  const elementLookup = await loadElementLookup(client, tenantId, siteId, events);
  const validation = validateDraftIr(recording.draft_ir, signedCommandRefs);
  const review = assessRecordingReview(recordingId, events, elementLookup, validation.report);
  const blockers = review.blockers.filter((blocker) => blocker.severity === "blocker");
  if (blockers.length > 0 || !validation.valid) {
    await client.query(
      `UPDATE browser_recording_sessions
          SET review_status='review_needed', validation_report=$1::jsonb, review_report=$2::jsonb,
              updated_by=$3::uuid, updated_at=now()
        WHERE tenant_id=$4::uuid AND id=$5::uuid`,
      [JSON.stringify(validation.report), JSON.stringify(review), updatedBy, tenantId, recordingId],
    );
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "recording_review_blocked", blockers });
  }

  const irForStudio = withStudioMode(recording.draft_ir, recording.name, 1, "visual");
  const compile = compileScenario(irForStudio, { signedCommandRefs });
  if (!compile.ok) throw new ApiResponseError(compile.code, compile.details);
  const inferredTarget = await resolveRunTargetForIr(client, tenantId, compile.ir);
  const irToStore = inferredTarget !== undefined ? { ...compile.ir, target: inferredTarget } : compile.ir;
  const scenario = await client.query<{ id: string }>(
    `INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)
     ON CONFLICT (tenant_id, name) WHERE archived_at IS NULL DO NOTHING RETURNING id::text AS id`,
    [randomUUID(), tenantId, compile.ir.meta.name],
  );
  if (scenario.rowCount !== 1 || scenario.rows[0] === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_name_in_use", name: compile.ir.meta.name });
  }
  const scenarioId = scenario.rows[0].id;
  await client.query(
    `INSERT INTO scenario_versions
       (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)`,
    [
      randomUUID(),
      tenantId,
      scenarioId,
      compile.ir.meta.version,
      JSON.stringify(irToStore),
      compile.compiledAst,
      compile.ir.params_schema !== undefined ? JSON.stringify(compile.ir.params_schema) : null,
    ],
  );

  const projectId = randomUUID();
  await client.query(
    `INSERT INTO studio_projects
       (id, tenant_id, name, source_kind, source_recording_session_id, created_by)
     VALUES ($1::uuid, $2::uuid, $3, 'recording', $4::uuid, $5::uuid)`,
    [projectId, tenantId, recording.name, recordingId, updatedBy],
  );

  const graph = studioGraphFromIr(projectId, recording.name, compile.ir, scenarioId, compile.ir.meta.version, validation.report.stages);
  const graphValidation = validateStudioGraph(graph);
  if (!graphValidation.valid) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "studio_graph_invalid", errors: graphValidation.errors });
  }
  const graphVersionId = randomUUID();
  const graphHash = sha256Hex(graph);
  const compiledIrHash = sha256Hex(irToStore);
  await client.query(
    `INSERT INTO studio_graph_versions
       (id, tenant_id, studio_project_id, version, compiler_version, graph, graph_hash, compiled_ir_hash,
        scenario_id, scenario_version, source_recording_session_id, validation_stages, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'studio-graph@1', $4::jsonb, $5, $6,
             $7::uuid, $8, $9::uuid, $10::jsonb, $11::uuid)`,
    [
      graphVersionId,
      tenantId,
      projectId,
      JSON.stringify(graph),
      graphHash,
      compiledIrHash,
      scenarioId,
      compile.ir.meta.version,
      recordingId,
      JSON.stringify(validation.report.stages),
      updatedBy,
    ],
  );
  for (const stage of validation.report.stages) {
    await client.query(
      `INSERT INTO studio_validation_runs
         (id, tenant_id, studio_project_id, studio_graph_version_id, stage, status, reason_code, detail, report)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::jsonb)`,
      [
        randomUUID(),
        tenantId,
        projectId,
        graphVersionId,
        stage.stage,
        stage.status,
        stage.reason_code,
        stage.detail,
        JSON.stringify(validation.report),
      ],
    );
  }

  const updated = await client.query<RecordingRow>(
    `UPDATE browser_recording_sessions
        SET review_status='promoted_to_studio', review_report=$1::jsonb,
            promoted_scenario_id=$2::uuid, promoted_scenario_version=$3,
            promoted_studio_project_id=$4::uuid, promoted_studio_graph_version=1,
            updated_by=$5::uuid, updated_at=now()
      WHERE tenant_id=$6::uuid AND id=$7::uuid
      RETURNING id::text AS id, site_profile_id::text AS site_profile_id, name, start_url, status,
                event_count, draft_ir, validation_report, review_status, review_report,
                promoted_scenario_id::text AS promoted_scenario_id, promoted_scenario_version,
                promoted_studio_project_id::text AS promoted_studio_project_id, promoted_studio_graph_version,
                updated_by::text AS updated_by, created_at, updated_at,
                updated_at::text AS cursor_at`,
    [JSON.stringify(review), scenarioId, compile.ir.meta.version, projectId, updatedBy, tenantId, recordingId],
  );
  return { status: 201, body: promotedRecordingBody(updated.rows[0], projectId, graphVersionId) };
}
