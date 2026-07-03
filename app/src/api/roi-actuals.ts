import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { assertIdeaExists, parseKnownBody, validateIdeaId } from "./automation-ideas";

interface RoiActualEvidenceRow {
  readonly id: string;
  readonly automation_idea_id: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly actual_transaction_count: number;
  readonly actual_failure_rate: string;
  readonly human_intervention_minutes: string;
  readonly reprocessing_minutes: string;
  readonly evidence_ref: string;
  readonly summary: string;
  readonly metadata: unknown;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly legal_hold: boolean;
}

interface RoiActualEvidenceInput {
  readonly period_start: string;
  readonly period_end: string;
  readonly actual_transaction_count: number;
  readonly actual_failure_rate: number;
  readonly human_intervention_minutes: number;
  readonly reprocessing_minutes: number;
  readonly evidence_ref: string;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legal_hold: boolean;
}

const ACTUAL_EVIDENCE_RETENTION_DAYS = 365;
const MAX_INT4 = 2_147_483_647;
const MAX_NUMERIC_5_4 = 9.9999;
const MAX_NUMERIC_12_2 = 9_999_999_999.99;

export function registerRoiActualRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/roi-actuals",
    { config: { rbacAction: "automation_idea.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const ideaId = validateIdeaId(request.params.ideaId);
      const query = request.query as Record<string, unknown>;
      const limit = parseLimit(query.limit);
      const items = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertIdeaExists(client, ideaId);
        return readRoiActualEvidence(client, ideaId, limit);
      });
      reply.code(200).send({ items, next_cursor: null });
    },
  );

  // ROI 실적 제안값(read-only) — 아이디어에 연결된 자동화(scenario_id)의 기간 내 prod 실행 통계를 실적 폼
  // 프리필 "제안값"으로 산출한다. **제안일 뿐 증거가 아니다**: 어떤 행도 쓰지 않으며(roi_actual_evidence 미기록),
  // 확정(POST /roi-actuals)은 사람이 저장할 때만 일어난다 — 성과 리포트/Expand 판단은 확정 증거만 읽는다.
  // 기간 해석은 성과 리포트와 동일한 KST(Asia/Seoul) 일 경계. run 통계로 도출 불가한 값(개입/재처리 시간)은
  // 제안하지 않는다(날조 금지 — completed/failed 카운트에서 직접 계산되는 두 값만).
  app.get<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/roi-actuals/suggestion",
    { config: { rbacAction: "automation_idea.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const ideaId = validateIdeaId(request.params.ideaId);
      const query = request.query as Record<string, unknown>;
      const periodStart = parseDateOnly(query.period_start, "period_start");
      const periodEnd = parseDateOnly(query.period_end, "period_end");
      if (Date.parse(`${periodEnd}T00:00:00.000Z`) < Date.parse(`${periodStart}T00:00:00.000Z`)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "period_end_before_start" });
      }
      if (Date.parse(`${periodEnd}T00:00:00.000Z`) > Date.now() + 24 * 60 * 60 * 1000) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "roi_actual_period_in_future" });
      }
      const body = await withTenantTx(deps.pool, principal.tenantId, (client) =>
        readRoiActualSuggestion(client, ideaId, periodStart, periodEnd),
      );
      reply.code(200).send(body);
    },
  );

  app.post<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/roi-actuals",
    { config: { rbacAction: "automation_idea.manage" } },
    async (request, reply) => {
      const ideaId = validateIdeaId(request.params.ideaId);
      const body = parseRoiActualBody(request.body);
      const result = await runIdempotentCommand(deps, request, "recordRoiActualEvidence", `/v1/automation-ideas/${ideaId}/roi-actuals`, (client, tenantId) =>
        recordRoiActualEvidence(client, tenantId, request, ideaId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function readRoiActualEvidence(
  client: PoolClient,
  ideaId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query<RoiActualEvidenceRow>(
    `SELECT id::text, automation_idea_id::text, period_start::text, period_end::text,
            actual_transaction_count, actual_failure_rate, human_intervention_minutes,
            reprocessing_minutes, evidence_ref, summary, metadata, recorded_by, recorded_at, legal_hold
       FROM roi_actual_evidence
      WHERE automation_idea_id=$1::uuid
        AND deleted_at IS NULL
      ORDER BY period_end DESC, recorded_at DESC, id DESC
      LIMIT $2`,
    [ideaId, limit],
  );
  return result.rows.map(mapRoiActualEvidence);
}

/** KST(Asia/Seoul) 일 경계의 UTC 인스턴트 — 성과 리포트의 월 경계(Date.UTC(..., -9h))와 동일 규칙. */
function kstDayStartUtc(dateOnly: string, addDays: number): Date {
  const [y, m, d] = dateOnly.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(y, m - 1, d + addDays, -9, 0, 0, 0));
}

async function readRoiActualSuggestion(
  client: PoolClient,
  ideaId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Record<string, unknown>> {
  const idea = await client.query<{ scenario_id: string | null }>(
    `SELECT scenario_id::text AS scenario_id FROM automation_ideas WHERE id=$1::uuid`,
    [ideaId],
  );
  const ideaRow = idea.rows[0];
  if (ideaRow === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  const base = {
    automation_idea_id: ideaId,
    scenario_id: ideaRow.scenario_id,
    period_start: periodStart,
    period_end: periodEnd,
    run_mode: "prod",
  };
  // 자동화 미연결 아이디어 — 집계 자체가 불가. 0 으로 날조하지 않고 null 로 정직 표기(콘솔은 연결 안내).
  if (ideaRow.scenario_id === null) {
    return {
      ...base,
      total_runs: null,
      completed_runs: null,
      failed_runs: null,
      suggested_actual_transaction_count: null,
      suggested_actual_failure_rate: null,
    };
  }
  const counts = await client.query<{ total: number; completed: number; failed: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
            count(*) FILTER (WHERE r.status IN ('failed_business','failed_system'))::int AS failed
       FROM runs r
       JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
      WHERE sv.scenario_id = $1::uuid
        AND r.run_mode = 'prod'
        AND r.created_at >= $2::timestamptz
        AND r.created_at < $3::timestamptz`,
    [ideaRow.scenario_id, kstDayStartUtc(periodStart, 0).toISOString(), kstDayStartUtc(periodEnd, 1).toISOString()],
  );
  const row = counts.rows[0] ?? { total: 0, completed: 0, failed: 0 };
  const settled = row.completed + row.failed;
  return {
    ...base,
    total_runs: row.total,
    completed_runs: row.completed,
    failed_runs: row.failed,
    // 제안값 = 종결(완료+실패) 실행에서만 도출. 종결 0건이면 제안 없음(null) — "0건 처리" 로 오해 방지.
    suggested_actual_transaction_count: settled === 0 ? null : row.completed,
    suggested_actual_failure_rate: settled === 0 ? null : Math.round((row.failed / settled) * 10000) / 10000,
  };
}

async function recordRoiActualEvidence(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  ideaId: string,
  body: RoiActualEvidenceInput,
): Promise<CommandResponse> {
  await assertIdeaExists(client, ideaId);
  const retentionUntil = new Date(Date.now() + ACTUAL_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<RoiActualEvidenceRow>(
    `INSERT INTO roi_actual_evidence
       (id, tenant_id, automation_idea_id, period_start, period_end, actual_transaction_count,
        actual_failure_rate, human_intervention_minutes, reprocessing_minutes, evidence_ref,
        summary, metadata, recorded_by, retention_until, legal_hold)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::timestamptz, $15)
     RETURNING id::text, automation_idea_id::text, period_start::text, period_end::text,
               actual_transaction_count, actual_failure_rate, human_intervention_minutes,
               reprocessing_minutes, evidence_ref, summary, metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      ideaId,
      body.period_start,
      body.period_end,
      body.actual_transaction_count,
      body.actual_failure_rate,
      body.human_intervention_minutes,
      body.reprocessing_minutes,
      body.evidence_ref,
      body.summary,
      JSON.stringify(body.metadata),
      requirePrincipal(request).subjectId,
      retentionUntil.toISOString(),
      body.legal_hold,
    ],
  );
  return { status: 201, body: mapRoiActualEvidence(result.rows[0]) };
}

function parseRoiActualBody(raw: unknown): RoiActualEvidenceInput {
  const body = parseKnownBody(raw, [
    "period_start",
    "period_end",
    "actual_transaction_count",
    "actual_failure_rate",
    "human_intervention_minutes",
    "reprocessing_minutes",
    "evidence_ref",
    "summary",
    "metadata",
    "legal_hold",
  ]);
  const periodStart = parseDateOnly(body.period_start, "period_start");
  const periodEnd = parseDateOnly(body.period_end, "period_end");
  if (Date.parse(`${periodEnd}T00:00:00.000Z`) < Date.parse(`${periodStart}T00:00:00.000Z`)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "period_end_before_start" });
  }
  if (Date.parse(`${periodEnd}T00:00:00.000Z`) > Date.now() + 24 * 60 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "roi_actual_period_in_future" });
  }
  return {
    period_start: periodStart,
    period_end: periodEnd,
    actual_transaction_count: parseNonNegativeInteger(body.actual_transaction_count, "actual_transaction_count", MAX_INT4),
    actual_failure_rate: parseRate(body.actual_failure_rate, "actual_failure_rate"),
    human_intervention_minutes: parseNonNegativeNumber(body.human_intervention_minutes, "human_intervention_minutes", MAX_NUMERIC_12_2),
    reprocessing_minutes: parseNonNegativeNumber(body.reprocessing_minutes, "reprocessing_minutes", MAX_NUMERIC_12_2),
    evidence_ref: parseEvidenceRef(body.evidence_ref),
    summary: parseSafeSummary(body.summary),
    metadata: parseMetadata(body.metadata),
    legal_hold: body.legal_hold === undefined ? false : parseBoolean(body.legal_hold, "legal_hold"),
  };
}

function mapRoiActualEvidence(row: RoiActualEvidenceRow): Record<string, unknown> {
  return {
    roi_actual_id: row.id,
    automation_idea_id: row.automation_idea_id,
    period_start: row.period_start,
    period_end: row.period_end,
    actual_transaction_count: row.actual_transaction_count,
    actual_failure_rate: Number(row.actual_failure_rate),
    human_intervention_minutes: Number(row.human_intervention_minutes),
    reprocessing_minutes: Number(row.reprocessing_minutes),
    evidence_ref: row.evidence_ref,
    summary: row.summary,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function parseDateOnly(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_date", field });
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_date", field });
  }
  return raw;
}

function parseNonNegativeInteger(raw: unknown, field: string, max: number): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= max) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseNonNegativeNumber(raw: unknown, field: string, max: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= max) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseRate(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= Math.min(1, MAX_NUMERIC_5_4)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseEvidenceRef(raw: unknown): string {
  const value = parseBoundedString(raw, "evidence_ref", 1, 500);
  assertSafeEvidenceString(value, "evidence_ref");
  return value;
}

function parseSafeSummary(raw: unknown): string {
  const value = parseBoundedString(raw, "summary", 1, 1000);
  assertSafeEvidenceString(value, "summary");
  return value;
}

function parseMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(raw, "metadata");
  return raw;
}

function parseBoundedString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  return value;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertSafeMetadata(value: unknown, path: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeEvidenceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafeMetadata(item, `${path}.${index}`);
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(item, `${path}.${key}`);
  }
}

function assertSafeEvidenceString(value: string, path: string): void {
  if (/https?:\/\//i.test(value) || /bearer\s+[a-z0-9._-]+/i.test(value) || /token=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_or_endpoint_value_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp)([_.-]|$)/i.test(key);
}
