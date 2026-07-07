import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type AuthenticatedPrincipal,
  type CorrelationId,
  type DurableSecurityAuditDecisionWriter,
  type IdempotencyKey,
  type IsoDateTime,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { csvRow, csvWithBom } from "./csv";
import { ApiResponseError } from "../runtime/errors";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

// offboarding export audit 보존일수 — artifact.read audit(ARTIFACT_READ_AUDIT_RETENTION_DAYS=90)과 동일 기준 재사용(비발명).
const OFFBOARDING_EXPORT_AUDIT_RETENTION_DAYS = 90;

interface OffboardingRunRow {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly scenario_name: string;
  readonly scenario_version_id: string;
  readonly scenario_version: number;
  readonly status: string;
  readonly priority: string;
  readonly attempts: number;
  readonly as_of: Date | null;
  readonly workitem_id: string | null;
  readonly worker_id: string | null;
  readonly failure_code: string | null;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface OffboardingHumanTaskRow {
  readonly human_task_id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly state: string;
  readonly assignee: string | null;
  readonly assignee_role: string | null;
  readonly on_timeout: string;
  readonly expires_at: Date | null;
  readonly resolved_by: string | null;
  readonly escalated_by: string | null;
  readonly escalated_at: Date | null;
  readonly artifact_ref_count: string;
  readonly has_payload: boolean;
  readonly has_result: boolean;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
  readonly updated_at: Date;
}

interface OffboardingArtifactRow {
  readonly artifact_id: string;
  readonly run_id: string | null;
  readonly generation_id: string | null;
  readonly step_id: string | null;
  readonly attempt: number | null;
  readonly type: string;
  readonly media_type: string | null;
  readonly filename: string | null;
  readonly byte_size: string | null;
  readonly duration_ms: number | null;
  readonly redaction_status: string;
  readonly retention_until: Date | null;
  readonly legal_hold: boolean;
  readonly created_at: Date;
}

interface OffboardingExportRows {
  readonly runs: readonly OffboardingRunRow[];
  readonly humanTasks: readonly OffboardingHumanTaskRow[];
  readonly artifacts: readonly OffboardingArtifactRow[];
}

export function registerOffboardingExportRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/offboarding/export", { config: { rbacAction: "tenant_data.export" } }, async (request, reply) => {
    const securityAudit = requireOffboardingSecurityAudit(deps);
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const format = query.format ?? "csv";
    if (format !== "csv") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_export_format" });
    }
    const createdAtFrom = dateTimeFilter(query.created_at_from, "invalid_created_at_from");
    const createdAtTo = dateTimeFilter(query.created_at_to, "invalid_created_at_to");
    if (createdAtFrom !== null && createdAtTo !== null && createdAtFrom.getTime() > createdAtTo.getTime()) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_created_at_range" });
    }
    const rows = await selectOffboardingExportRows(deps, principal.tenantId, createdAtFrom, createdAtTo);

    // 반출 결정을 본문 반환 전에 fail-closed 로 기록(설계 §4-4) — append 실패 시 본문 미반환. payload 는 범위/행수만(원문 미포함).
    await recordOffboardingAudit(securityAudit, request, principal, "tenant_data.export", "offboarding_metadata_export_disclosed", {
      decision_kind: "tenant_data.export",
      delivery: "metadata_csv",
      created_at_from: nullableIso(createdAtFrom),
      created_at_to: nullableIso(createdAtTo),
      run_count: rows.runs.length,
      human_task_count: rows.humanTasks.length,
      artifact_count: rows.artifacts.length,
    });

    const filename = `offboarding-export-${new Date().toISOString().slice(0, 10)}.csv`;

    reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(csvWithBom(offboardingRowsToCsv(rows, {
        tenantId: principal.tenantId,
        generatedAt: new Date(),
        createdAtFrom,
        createdAtTo,
      })));
  });
}

/** 반출 결정은 fail-closed audit 없이 응답하지 않는다(설계 §4-4). 미주입=서버 구성 오류 — 조용한 무감사 반출 금지. */
export function requireOffboardingSecurityAudit(deps: ApiServerDeps): DurableSecurityAuditDecisionWriter {
  if (deps.securityAudit === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "offboarding_audit_not_configured" });
  }
  return deps.securityAudit;
}

export async function recordOffboardingAudit(
  securityAudit: DurableSecurityAuditDecisionWriter,
  request: FastifyRequest,
  principal: AuthenticatedPrincipal,
  action: "tenant_data.export" | "tenant_data.purge.request" | "tenant_data.purge.approve",
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const occurredAt = new Date();
  await securityAudit.recordDecision(
    {
      tenantId: principal.tenantId,
      actor: { subjectId: principal.subjectId, roles: principal.roles },
      action,
      outcome: "allow",
      reason,
      correlationId: request.correlationId as CorrelationId,
      // 각 반출 = 별개 audit 이벤트(idempotency_key UNIQUE) — correlation 재사용에도 충돌 없게 per-request UUID.
      idempotencyKey: randomUUID() as IdempotencyKey,
      occurredAt: occurredAt.toISOString() as IsoDateTime,
      retentionUntil: new Date(
        occurredAt.getTime() + OFFBOARDING_EXPORT_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString() as IsoDateTime,
      payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
      failClosed: true,
      payload,
    },
    { exported: true },
  );
}

export function nullableIso(value: Date | null): string | null {
  return value === null ? null : iso(value);
}

async function selectOffboardingExportRows(
  deps: ApiServerDeps,
  tenantId: string,
  createdAtFrom: Date | null,
  createdAtTo: Date | null,
): Promise<OffboardingExportRows> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    const runs = await client.query<OffboardingRunRow>(
      `SELECT r.id AS run_id, sv.scenario_id, s.name AS scenario_name, r.scenario_version_id,
              sv.version AS scenario_version, r.status, r.priority, r.attempts, r.as_of,
              r.workitem_id, r.worker_id, r.failure_reason->>'code' AS failure_code,
              r.started_at, r.ended_at, r.created_at, r.updated_at
         FROM runs r
         JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
         JOIN scenarios s ON s.tenant_id = sv.tenant_id AND s.id = sv.scenario_id
        WHERE r.tenant_id = $1::uuid
          AND ($2::timestamptz IS NULL OR r.created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR r.created_at <= $3::timestamptz)
        ORDER BY r.created_at DESC, r.id DESC`,
      [tenantId, createdAtFrom, createdAtTo],
    );
    const humanTasks = await client.query<OffboardingHumanTaskRow>(
      `SELECT id AS human_task_id, run_id, kind, state, assignee, assignee_role,
              on_timeout, expires_at, resolved_by, escalated_by, escalated_at,
              jsonb_array_length(CASE WHEN jsonb_typeof(artifact_refs) = 'array' THEN artifact_refs ELSE '[]'::jsonb END)::text AS artifact_ref_count,
              payload <> '{}'::jsonb AS has_payload,
              result IS NOT NULL AS has_result,
              created_at, resolved_at, updated_at
         FROM human_tasks
        WHERE tenant_id = $1::uuid
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
        ORDER BY created_at DESC, id DESC`,
      [tenantId, createdAtFrom, createdAtTo],
    );
    const artifacts = await client.query<OffboardingArtifactRow>(
      `SELECT id AS artifact_id, run_id, generation_id, step_id, attempt, type, media_type,
              filename, byte_size::text AS byte_size, duration_ms, redaction_status,
              retention_until, legal_hold, created_at
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND redaction_status IN ('redacted', 'not_required')
          AND deleted_at IS NULL
          AND quarantine = false
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
        ORDER BY created_at DESC, id DESC`,
      [tenantId, createdAtFrom, createdAtTo],
    );
    return { runs: runs.rows, humanTasks: humanTasks.rows, artifacts: artifacts.rows };
  });
}

function offboardingRowsToCsv(
  rows: OffboardingExportRows,
  manifest: {
    readonly tenantId: string;
    readonly generatedAt: Date;
    readonly createdAtFrom: Date | null;
    readonly createdAtTo: Date | null;
  },
): string {
  return [
    csvSection("manifest", ["key", "value"], [
      ["schema_ref", "offboarding-metadata-export@1"],
      ["tenant_id", manifest.tenantId],
      ["generated_at", iso(manifest.generatedAt)],
      ["created_at_from", maybeIso(manifest.createdAtFrom)],
      ["created_at_to", maybeIso(manifest.createdAtTo)],
      ["run_count", String(rows.runs.length)],
      ["human_task_count", String(rows.humanTasks.length)],
      ["artifact_count", String(rows.artifacts.length)],
      ["artifact_scope", "redacted_or_not_required_non_deleted_non_quarantined_metadata_only"],
      ["omitted_fields", "runs.params,resume_token,bookmark,failure_reason.message;human_tasks.payload,result,result_schema,payload_ref,artifact_refs;artifacts.object_ref,sha256,content"],
    ]),
    csvSection("runs", [
      "run_id",
      "scenario_id",
      "scenario_name",
      "scenario_version_id",
      "scenario_version",
      "status",
      "priority",
      "attempts",
      "as_of",
      "workitem_id",
      "worker_id",
      "failure_code",
      "started_at",
      "ended_at",
      "created_at",
      "updated_at",
    ], rows.runs.map((row) => [
      row.run_id,
      row.scenario_id,
      row.scenario_name,
      row.scenario_version_id,
      row.scenario_version,
      row.status,
      row.priority,
      row.attempts,
      maybeIso(row.as_of),
      row.workitem_id,
      row.worker_id,
      row.failure_code,
      maybeIso(row.started_at),
      maybeIso(row.ended_at),
      iso(row.created_at),
      iso(row.updated_at),
    ])),
    csvSection("human_tasks", [
      "human_task_id",
      "run_id",
      "kind",
      "state",
      "assignee",
      "assignee_role",
      "on_timeout",
      "expires_at",
      "resolved_by",
      "escalated_by",
      "escalated_at",
      "artifact_ref_count",
      "has_payload",
      "has_result",
      "created_at",
      "resolved_at",
      "updated_at",
    ], rows.humanTasks.map((row) => [
      row.human_task_id,
      row.run_id,
      row.kind,
      row.state,
      row.assignee,
      row.assignee_role,
      row.on_timeout,
      maybeIso(row.expires_at),
      row.resolved_by,
      row.escalated_by,
      maybeIso(row.escalated_at),
      row.artifact_ref_count,
      row.has_payload,
      row.has_result,
      iso(row.created_at),
      maybeIso(row.resolved_at),
      iso(row.updated_at),
    ])),
    csvSection("artifacts", [
      "artifact_id",
      "run_id",
      "generation_id",
      "step_id",
      "attempt",
      "type",
      "media_type",
      "filename",
      "byte_size",
      "duration_ms",
      "redaction_status",
      "retention_until",
      "legal_hold",
      "created_at",
    ], rows.artifacts.map((row) => [
      row.artifact_id,
      row.run_id,
      row.generation_id,
      row.step_id,
      row.attempt,
      row.type,
      row.media_type,
      row.filename,
      row.byte_size,
      row.duration_ms,
      row.redaction_status,
      maybeIso(row.retention_until),
      row.legal_hold,
      iso(row.created_at),
    ])),
  ].join("\n\n");
}

function csvSection(
  name: string,
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  return [csvRow(["section", name]), csvRow(header), ...rows.map(csvRow)].join("\n");
}

export function dateTimeFilter(raw: unknown, reason: string): Date | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return date;
}

function maybeIso(value: Date | null): string {
  return value === null ? "" : iso(value);
}

export function iso(value: Date): string {
  return value.toISOString();
}
