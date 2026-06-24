import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";
// ROI 추정은 automation_ideas 와 별개 테이블(roi_estimates)·별개 bounded context 다. idea 도메인의 식별자/존재
//   검증·바디 파서만 재사용한다(단방향: roi-estimate → automation-ideas, server.ts 가 둘 다 등록).
import { assertIdeaExists, parseKnownBody, validateIdeaId } from "./automation-ideas";

type RoiConfidence = "low" | "medium" | "high";

interface RoiEstimateRow {
  id: string;
  automation_idea_id: string;
  frequency_per_month: number;
  minutes_per_case: string;
  exception_rate: string;
  hourly_cost: string;
  implementation_effort: string;
  monthly_hours_saved: string;
  estimated_monthly_value: string;
  payback_months: string | null;
  confidence: RoiConfidence;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface RoiCreateBody {
  frequency_per_month: number;
  minutes_per_case: number;
  exception_rate: number;
  hourly_cost: number;
  implementation_effort: number;
  confidence: RoiConfidence;
}

const MAX_INT4 = 2_147_483_647;
const MAX_NUMERIC_5_4 = 9.9999;
const MAX_NUMERIC_10_2 = 99_999_999.99;
const MAX_NUMERIC_12_2 = 9_999_999_999.99;
const MAX_NUMERIC_14_2 = 999_999_999_999.99;

export function registerRoiEstimateRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/roi-estimate",
    { config: { rbacAction: "automation_idea.manage" } },
    async (request, reply) => {
      const ideaId = validateIdeaId(request.params.ideaId);
      const body = parseRoiBody(request.body);
      const result = await runIdempotentCommand(deps, request, "upsertRoiEstimate", `/v1/automation-ideas/${ideaId}/roi-estimate`, (client, tenantId) =>
        upsertRoiEstimate(client, tenantId, request, ideaId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/roi-estimate",
    { config: { rbacAction: "automation_idea.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const ideaId = validateIdeaId(request.params.ideaId);
      const row = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertIdeaExists(client, ideaId);
        return selectRoiEstimate(client, ideaId);
      });
      if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      reply.code(200).send(mapRoi(row));
    },
  );
}

async function upsertRoiEstimate(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  ideaId: string,
  body: RoiCreateBody,
): Promise<CommandResponse> {
  await assertIdeaExists(client, ideaId);
  const monthlyHoursSaved = (body.frequency_per_month * body.minutes_per_case * (1 - body.exception_rate)) / 60;
  const estimatedMonthlyValue = monthlyHoursSaved * body.hourly_cost;
  const paybackMonths = estimatedMonthlyValue > 0 ? body.implementation_effort / estimatedMonthlyValue : null;
  assertRoiMetricInRange(monthlyHoursSaved, "monthly_hours_saved", MAX_NUMERIC_12_2);
  assertRoiMetricInRange(estimatedMonthlyValue, "estimated_monthly_value", MAX_NUMERIC_14_2);
  if (paybackMonths !== null) assertRoiMetricInRange(paybackMonths, "payback_months", MAX_NUMERIC_10_2);
  const result = await client.query<RoiEstimateRow>(
    `INSERT INTO roi_estimates
       (id, tenant_id, automation_idea_id, frequency_per_month, minutes_per_case, exception_rate, hourly_cost,
        implementation_effort, monthly_hours_saved, estimated_monthly_value, payback_months, confidence, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, automation_idea_id)
     DO UPDATE SET frequency_per_month=EXCLUDED.frequency_per_month,
                   minutes_per_case=EXCLUDED.minutes_per_case,
                   exception_rate=EXCLUDED.exception_rate,
                   hourly_cost=EXCLUDED.hourly_cost,
                   implementation_effort=EXCLUDED.implementation_effort,
                   monthly_hours_saved=EXCLUDED.monthly_hours_saved,
                   estimated_monthly_value=EXCLUDED.estimated_monthly_value,
                   payback_months=EXCLUDED.payback_months,
                   confidence=EXCLUDED.confidence,
                   updated_at=now()
     RETURNING id, automation_idea_id, frequency_per_month, minutes_per_case, exception_rate, hourly_cost,
               implementation_effort, monthly_hours_saved, estimated_monthly_value, payback_months, confidence,
               created_by, created_at, updated_at`,
    [
      randomUUID(),
      tenantId,
      ideaId,
      body.frequency_per_month,
      body.minutes_per_case,
      body.exception_rate,
      body.hourly_cost,
      body.implementation_effort,
      monthlyHoursSaved,
      estimatedMonthlyValue,
      paybackMonths,
      body.confidence,
      requirePrincipal(request).subjectId,
    ],
  );
  return { status: 200, body: mapRoi(result.rows[0]) };
}

async function selectRoiEstimate(client: PoolClient, ideaId: string): Promise<RoiEstimateRow | null> {
  const result = await client.query<RoiEstimateRow>(
    `SELECT id, automation_idea_id, frequency_per_month, minutes_per_case, exception_rate, hourly_cost,
            implementation_effort, monthly_hours_saved, estimated_monthly_value, payback_months, confidence,
            created_by, created_at, updated_at
       FROM roi_estimates
      WHERE automation_idea_id=$1::uuid`,
    [ideaId],
  );
  return result.rows[0] ?? null;
}

function parseRoiBody(raw: unknown): RoiCreateBody {
  const body = parseKnownBody(raw, ["frequency_per_month", "minutes_per_case", "exception_rate", "hourly_cost", "implementation_effort", "confidence"]);
  const parsed: RoiCreateBody = {
    frequency_per_month: requireNonNegativeInteger(body.frequency_per_month, "frequency_per_month", MAX_INT4),
    minutes_per_case: requireNonNegativeNumber(body.minutes_per_case, "minutes_per_case", MAX_NUMERIC_10_2),
    exception_rate: requireRate(body.exception_rate),
    hourly_cost: requireNonNegativeNumber(body.hourly_cost, "hourly_cost", MAX_NUMERIC_12_2),
    implementation_effort: requireNonNegativeNumber(body.implementation_effort, "implementation_effort", MAX_NUMERIC_12_2),
    confidence: optionalConfidence(body.confidence) ?? "medium",
  };
  assertRoiCalculatedMetricsInRange(parsed);
  return parsed;
}

function requireNonNegativeInteger(value: unknown, field: string, max: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function requireNonNegativeNumber(value: unknown, field: string, max: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function requireRate(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Math.min(1, MAX_NUMERIC_5_4)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_exception_rate" });
}

function assertRoiMetricInRange(value: number, metric: string, max: number): void {
  if (Number.isFinite(value) && value >= 0 && value <= max) return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "roi_metric_out_of_range", metric });
}

function assertRoiCalculatedMetricsInRange(body: RoiCreateBody): void {
  const monthlyHoursSaved = (body.frequency_per_month * body.minutes_per_case * (1 - body.exception_rate)) / 60;
  const estimatedMonthlyValue = monthlyHoursSaved * body.hourly_cost;
  const paybackMonths = estimatedMonthlyValue > 0 ? body.implementation_effort / estimatedMonthlyValue : null;
  assertRoiMetricInRange(monthlyHoursSaved, "monthly_hours_saved", MAX_NUMERIC_12_2);
  assertRoiMetricInRange(estimatedMonthlyValue, "estimated_monthly_value", MAX_NUMERIC_14_2);
  if (paybackMonths !== null) assertRoiMetricInRange(paybackMonths, "payback_months", MAX_NUMERIC_10_2);
}

function optionalConfidence(value: unknown): RoiConfidence | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_confidence" });
}

function mapRoi(row: RoiEstimateRow): Record<string, unknown> {
  return {
    roi_estimate_id: row.id,
    automation_idea_id: row.automation_idea_id,
    frequency_per_month: row.frequency_per_month,
    minutes_per_case: Number(row.minutes_per_case),
    exception_rate: Number(row.exception_rate),
    hourly_cost: Number(row.hourly_cost),
    implementation_effort: Number(row.implementation_effort),
    monthly_hours_saved: Number(row.monthly_hours_saved),
    estimated_monthly_value: Number(row.estimated_monthly_value),
    payback_months: row.payback_months === null ? null : Number(row.payback_months),
    confidence: row.confidence,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
