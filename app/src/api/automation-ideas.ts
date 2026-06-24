import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

type IdeaStage = "intake" | "assess" | "approved" | "build" | "operate" | "rejected" | "archived";
type IdeaPriority = "low" | "medium" | "high" | "critical";
type IdeaSource = "manual" | "process_mining" | "task_mining" | "imported";
type RoiConfidence = "low" | "medium" | "high";

interface AutomationIdeaRow {
  id: string;
  title: string;
  description: string;
  business_owner: string;
  department: string;
  source: IdeaSource;
  stage: IdeaStage;
  priority: IdeaPriority;
  score: number;
  scenario_id: string | null;
  run_trigger_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

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

interface IdeaCreateBody {
  title: string;
  description: string;
  business_owner: string;
  department: string;
  source: IdeaSource;
  priority: IdeaPriority;
  score: number;
}

interface IdeaUpdateBody {
  title?: string;
  description?: string;
  business_owner?: string;
  department?: string;
  priority?: IdeaPriority;
  score?: number;
  scenario_id?: string | null;
  run_trigger_id?: string | null;
}

interface RoiCreateBody {
  frequency_per_month: number;
  minutes_per_case: number;
  exception_rate: number;
  hourly_cost: number;
  implementation_effort: number;
  confidence: RoiConfidence;
}

const STAGE_TRANSITIONS: Readonly<Record<IdeaStage, readonly IdeaStage[]>> = {
  intake: ["assess", "archived"],
  assess: ["approved", "rejected", "archived"],
  approved: ["build", "archived"],
  build: ["operate", "archived"],
  operate: ["archived"],
  rejected: ["archived"],
  archived: [],
};
const MAX_INT4 = 2_147_483_647;
const MAX_NUMERIC_5_4 = 9.9999;
const MAX_NUMERIC_10_2 = 99_999_999.99;
const MAX_NUMERIC_12_2 = 9_999_999_999.99;
const MAX_NUMERIC_14_2 = 999_999_999_999.99;

export function registerAutomationIdeaRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/automation-ideas", { config: { rbacAction: "automation_idea.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const stage = optionalStage(query.stage);
    const owner = optionalStringFilter(query.owner, "invalid_owner");
    const department = optionalStringFilter(query.department, "invalid_department");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<AutomationIdeaRow>(
        `SELECT id, title, description, business_owner, department, source, stage, priority, score,
                scenario_id, run_trigger_id, created_by, created_at, updated_at, updated_at::text AS cursor_at
           FROM automation_ideas
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR stage = $2)
            AND ($3::text IS NULL OR business_owner = $3)
            AND ($4::text IS NULL OR department = $4)
            AND ($5::timestamptz IS NULL OR (updated_at, id) < ($5::timestamptz, $6::uuid))
          ORDER BY updated_at DESC, id DESC
          LIMIT $7`,
        [principal.tenantId, stage ?? null, owner ?? null, department ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapIdea));
  });

  app.post("/v1/automation-ideas", { config: { rbacAction: "automation_idea.manage" } }, async (request, reply) => {
    const body = parseCreateBody(request.body);
    const result = await runIdempotentCommand(deps, request, "createAutomationIdea", "/v1/automation-ideas", (client, tenantId) =>
      createAutomationIdea(client, tenantId, request, body),
    );
    reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId",
    { config: { rbacAction: "automation_idea.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const ideaId = validateIdeaId(request.params.ideaId);
      const row = await withTenantTx(deps.pool, principal.tenantId, (client) => selectIdea(client, ideaId));
      if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      reply.code(200).send(mapIdea(row));
    },
  );

  app.patch<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId",
    { config: { rbacAction: "automation_idea.manage" } },
    async (request, reply) => {
      const ideaId = validateIdeaId(request.params.ideaId);
      const body = parseUpdateBody(request.body);
      const result = await runIdempotentCommand(deps, request, "updateAutomationIdea", `/v1/automation-ideas/${ideaId}`, (client) =>
        updateAutomationIdea(client, ideaId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { ideaId: string } }>(
    "/v1/automation-ideas/:ideaId/transition",
    { config: { rbacAction: "automation_idea.manage" } },
    async (request, reply) => {
      const ideaId = validateIdeaId(request.params.ideaId);
      const stage = parseTransitionBody(request.body);
      await assertTransitionAuthorized(deps, request, stage);
      const result = await runIdempotentCommand(deps, request, "transitionAutomationIdea", `/v1/automation-ideas/${ideaId}/transition`, (client) =>
        transitionAutomationIdea(client, ideaId, stage),
      );
      reply.code(result.status).send(result.body);
    },
  );

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

async function createAutomationIdea(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  body: IdeaCreateBody,
): Promise<CommandResponse> {
  const result = await client.query<AutomationIdeaRow>(
    `INSERT INTO automation_ideas
       (id, tenant_id, title, description, business_owner, department, source, priority, score, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, title, description, business_owner, department, source, stage, priority, score,
               scenario_id, run_trigger_id, created_by, created_at, updated_at, updated_at::text AS cursor_at`,
    [
      randomUUID(),
      tenantId,
      body.title,
      body.description,
      body.business_owner,
      body.department,
      body.source,
      body.priority,
      body.score,
      requirePrincipal(request).subjectId,
    ],
  );
  return { status: 201, body: mapIdea(result.rows[0]) };
}

async function updateAutomationIdea(client: PoolClient, ideaId: string, body: IdeaUpdateBody): Promise<CommandResponse> {
  await assertIdeaExists(client, ideaId);
  await assertOptionalLinksExist(client, body);
  const result = await client.query<AutomationIdeaRow>(
    `UPDATE automation_ideas
        SET title = COALESCE($2, title),
            description = COALESCE($3, description),
            business_owner = COALESCE($4, business_owner),
            department = COALESCE($5, department),
            priority = COALESCE($6, priority),
            score = COALESCE($7, score),
            scenario_id = CASE WHEN $8::boolean THEN $9::uuid ELSE scenario_id END,
            run_trigger_id = CASE WHEN $10::boolean THEN $11::uuid ELSE run_trigger_id END,
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id, title, description, business_owner, department, source, stage, priority, score,
                scenario_id, run_trigger_id, created_by, created_at, updated_at, updated_at::text AS cursor_at`,
    [
      ideaId,
      body.title ?? null,
      body.description ?? null,
      body.business_owner ?? null,
      body.department ?? null,
      body.priority ?? null,
      body.score ?? null,
      Object.prototype.hasOwnProperty.call(body, "scenario_id"),
      body.scenario_id ?? null,
      Object.prototype.hasOwnProperty.call(body, "run_trigger_id"),
      body.run_trigger_id ?? null,
    ],
  );
  return { status: 200, body: mapIdea(result.rows[0]) };
}

async function transitionAutomationIdea(client: PoolClient, ideaId: string, targetStage: IdeaStage): Promise<CommandResponse> {
  const current = await selectIdea(client, ideaId);
  if (current === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  if (!STAGE_TRANSITIONS[current.stage].includes(targetStage)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "illegal_automation_idea_transition",
      from: current.stage,
      to: targetStage,
    });
  }
  const result = await client.query<AutomationIdeaRow>(
    `UPDATE automation_ideas
        SET stage=$2, updated_at=now()
      WHERE id=$1::uuid
      RETURNING id, title, description, business_owner, department, source, stage, priority, score,
                scenario_id, run_trigger_id, created_by, created_at, updated_at, updated_at::text AS cursor_at`,
    [ideaId, targetStage],
  );
  return { status: 200, body: mapIdea(result.rows[0]) };
}

async function assertTransitionAuthorized(
  deps: ApiServerDeps,
  request: FastifyRequest,
  targetStage: IdeaStage,
): Promise<void> {
  if (targetStage !== "approved" && targetStage !== "rejected") return;
  const principal = requirePrincipal(request);
  const decision = await deps.rbac.authorize(principal, {
    action: "automation_idea.approve",
    tenantId: principal.tenantId,
  });
  if (decision.kind === "deny") {
    request.log.warn(
      { action: decision.action, code: decision.code, reason: decision.reason, correlation_id: request.correlationId },
      "automation idea approval denied",
    );
    throw new ApiResponseError(decision.code);
  }
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

async function selectIdea(client: PoolClient, ideaId: string): Promise<AutomationIdeaRow | null> {
  const result = await client.query<AutomationIdeaRow>(
    `SELECT id, title, description, business_owner, department, source, stage, priority, score,
            scenario_id, run_trigger_id, created_by, created_at, updated_at, updated_at::text AS cursor_at
       FROM automation_ideas
      WHERE id=$1::uuid`,
    [ideaId],
  );
  return result.rows[0] ?? null;
}

async function assertIdeaExists(client: PoolClient, ideaId: string): Promise<void> {
  if ((await selectIdea(client, ideaId)) === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

async function assertOptionalLinksExist(client: PoolClient, body: IdeaUpdateBody): Promise<void> {
  if (body.scenario_id !== undefined && body.scenario_id !== null) {
    const scenario = await client.query(`SELECT 1 FROM scenarios WHERE id=$1::uuid AND archived_at IS NULL`, [body.scenario_id]);
    if (scenario.rowCount !== 1) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "scenario_not_found" });
  }
  if (body.run_trigger_id !== undefined && body.run_trigger_id !== null) {
    const trigger = await client.query(`SELECT 1 FROM run_triggers WHERE id=$1::uuid`, [body.run_trigger_id]);
    if (trigger.rowCount !== 1) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "run_trigger_not_found" });
  }
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

function parseCreateBody(raw: unknown): IdeaCreateBody {
  const body = parseKnownBody(raw, ["title", "description", "business_owner", "department", "source", "priority", "score"]);
  return {
    title: requireText(body.title, "title"),
    description: requireText(body.description, "description"),
    business_owner: requireText(body.business_owner, "business_owner"),
    department: requireText(body.department, "department"),
    source: optionalSource(body.source) ?? "manual",
    priority: optionalPriority(body.priority) ?? "medium",
    score: optionalScore(body.score) ?? 0,
  };
}

function parseUpdateBody(raw: unknown): IdeaUpdateBody {
  const body = parseKnownBody(raw, ["title", "description", "business_owner", "department", "priority", "score", "scenario_id", "run_trigger_id"]);
  if (Object.keys(body).length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  return {
    title: body.title === undefined ? undefined : requireText(body.title, "title"),
    description: body.description === undefined ? undefined : requireText(body.description, "description"),
    business_owner: body.business_owner === undefined ? undefined : requireText(body.business_owner, "business_owner"),
    department: body.department === undefined ? undefined : requireText(body.department, "department"),
    priority: optionalPriority(body.priority),
    score: optionalScore(body.score),
    scenario_id: optionalUuidOrNull(body.scenario_id, "scenario_id"),
    run_trigger_id: optionalUuidOrNull(body.run_trigger_id, "run_trigger_id"),
  };
}

function parseTransitionBody(raw: unknown): IdeaStage {
  const body = parseKnownBody(raw, ["stage"]);
  return requireStage(body.stage);
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

function parseKnownBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
  return raw;
}

function validateIdeaId(value: unknown): string {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

function requireText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
}

function requireStage(value: unknown): IdeaStage {
  if (value === "intake" || value === "assess" || value === "approved" || value === "build" || value === "operate" || value === "rejected" || value === "archived") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_stage" });
}

function optionalStage(value: unknown): IdeaStage | undefined {
  if (value === undefined) return undefined;
  return requireStage(value);
}

function optionalPriority(value: unknown): IdeaPriority | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_priority" });
}

function optionalSource(value: unknown): IdeaSource | undefined {
  if (value === undefined) return undefined;
  if (value === "manual" || value === "process_mining" || value === "task_mining" || value === "imported") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source" });
}

function optionalScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_score" });
}

function optionalUuidOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function optionalStringFilter(value: unknown, reason: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
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

function mapIdea(row: AutomationIdeaRow): Record<string, unknown> {
  return {
    idea_id: row.id,
    title: row.title,
    description: row.description,
    business_owner: row.business_owner,
    department: row.department,
    source: row.source,
    stage: row.stage,
    priority: row.priority,
    score: row.score,
    scenario_id: row.scenario_id,
    run_trigger_id: row.run_trigger_id,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
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
