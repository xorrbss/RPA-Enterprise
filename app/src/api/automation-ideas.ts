import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { UUID_RE } from "./server-shared";

type IdeaStage = "intake" | "assess" | "approved" | "build" | "operate" | "rejected" | "archived";
type IdeaPriority = "low" | "medium" | "high" | "critical";
type IdeaSource = "manual" | "process_mining" | "task_mining" | "imported";

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
  source_import_id: string | null;
  source_item_ref: string | null;
  source_lineage: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface IdeaCreateBody {
  title: string;
  description: string;
  business_owner: string;
  department: string;
  source: IdeaSource;
  priority: IdeaPriority;
  score: number;
  source_import_id: string | null;
  source_item_ref: string | null;
  source_lineage: Readonly<Record<string, unknown>>;
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

const STAGE_TRANSITIONS: Readonly<Record<IdeaStage, readonly IdeaStage[]>> = {
  intake: ["assess", "archived"],
  assess: ["approved", "rejected", "archived"],
  approved: ["build", "archived"],
  build: ["operate", "archived"],
  operate: ["archived"],
  rejected: ["archived"],
  archived: [],
};

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
                scenario_id, run_trigger_id, source_import_id, source_item_ref, source_lineage,
                created_by, created_at, updated_at, updated_at::text AS cursor_at
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
}

async function createAutomationIdea(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  body: IdeaCreateBody,
): Promise<CommandResponse> {
  await assertSourceImportAvailable(client, body);
  const result = await client.query<AutomationIdeaRow>(
    `INSERT INTO automation_ideas
       (id, tenant_id, title, description, business_owner, department, source, priority, score,
        source_import_id, source_item_ref, source_lineage, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::jsonb, $13)
     RETURNING id, title, description, business_owner, department, source, stage, priority, score,
               scenario_id, run_trigger_id, source_import_id, source_item_ref, source_lineage,
               created_by, created_at, updated_at, updated_at::text AS cursor_at`,
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
      body.source_import_id,
      body.source_item_ref,
      JSON.stringify(body.source_lineage),
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
                scenario_id, run_trigger_id, source_import_id, source_item_ref, source_lineage,
                created_by, created_at, updated_at, updated_at::text AS cursor_at`,
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
                scenario_id, run_trigger_id, source_import_id, source_item_ref, source_lineage,
                created_by, created_at, updated_at, updated_at::text AS cursor_at`,
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

async function selectIdea(client: PoolClient, ideaId: string): Promise<AutomationIdeaRow | null> {
  const result = await client.query<AutomationIdeaRow>(
    `SELECT id, title, description, business_owner, department, source, stage, priority, score,
            scenario_id, run_trigger_id, source_import_id, source_item_ref, source_lineage,
            created_by, created_at, updated_at, updated_at::text AS cursor_at
       FROM automation_ideas
      WHERE id=$1::uuid`,
    [ideaId],
  );
  return result.rows[0] ?? null;
}

export async function assertIdeaExists(client: PoolClient, ideaId: string): Promise<void> {
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

async function assertSourceImportAvailable(client: PoolClient, body: IdeaCreateBody): Promise<void> {
  if (body.source_import_id === null) return;
  const result = await client.query<{ source_type: string; status: string }>(
    `SELECT source_type, status
       FROM process_mining_imports
      WHERE id=$1::uuid`,
    [body.source_import_id],
  );
  const sourceImport = result.rows[0];
  if (sourceImport === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "source_import_not_found" });
  if (sourceImport.status === "blocked") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_import_blocked" });
  if (body.source === "process_mining" && sourceImport.source_type !== "process_mining") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_import_type_mismatch" });
  }
  if (body.source === "task_mining" && sourceImport.source_type !== "task_mining") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_import_type_mismatch" });
  }
  if (body.source === "imported" && sourceImport.source_type !== "monitoring_export" && sourceImport.source_type !== "api_import") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_import_type_mismatch" });
  }
}

function parseCreateBody(raw: unknown): IdeaCreateBody {
  const body = parseKnownBody(raw, [
    "title",
    "description",
    "business_owner",
    "department",
    "source",
    "priority",
    "score",
    "source_import_id",
    "source_item_ref",
    "source_lineage",
  ]);
  const source = optionalSource(body.source) ?? "manual";
  const sourceImportId = optionalUuid(body.source_import_id, "source_import_id") ?? null;
  const sourceItemRef = body.source_item_ref === undefined ? null : requireSafeText(body.source_item_ref, "source_item_ref", 1, 200);
  const sourceLineage = parseSourceLineage(body.source_lineage);
  assertLineageMatchesSource(source, sourceImportId, sourceItemRef, sourceLineage);
  return {
    title: requireText(body.title, "title"),
    description: requireText(body.description, "description"),
    business_owner: requireText(body.business_owner, "business_owner"),
    department: requireText(body.department, "department"),
    source,
    priority: optionalPriority(body.priority) ?? "medium",
    score: optionalScore(body.score) ?? 0,
    source_import_id: sourceImportId,
    source_item_ref: sourceItemRef,
    source_lineage: sourceLineage,
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

export function parseKnownBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
  return raw;
}

export function validateIdeaId(value: unknown): string {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

function requireText(value: unknown, field: string): string {
  return requireSafeText(value, field, 1, field === "description" ? 2000 : 240);
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

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function optionalStringFilter(value: unknown, reason: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const text = value.trim();
    assertSafeEvidenceString(text, reason);
    return text;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function requireSafeText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
  const text = value.trim();
  if (text.length < min || text.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(text, field);
  return text;
}

function parseSourceLineage(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_lineage_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_lineage_too_large" });
  assertSafeMetadata(raw, "source_lineage", 0);
  return raw;
}

function assertLineageMatchesSource(
  source: IdeaSource,
  sourceImportId: string | null,
  sourceItemRef: string | null,
  sourceLineage: Readonly<Record<string, unknown>>,
): void {
  const hasLineage = Object.keys(sourceLineage).length > 0;
  if (source === "manual" && (sourceImportId !== null || sourceItemRef !== null || hasLineage)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "manual_source_must_not_have_import_lineage" });
  }
  if ((source === "process_mining" || source === "task_mining") && (sourceImportId === null || sourceItemRef === null || !hasLineage)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "import_lineage_required_for_mining_source" });
  }
  if (source === "imported") {
    const hasAnyImportLineage = sourceImportId !== null || sourceItemRef !== null || hasLineage;
    const hasCompleteImportLineage = sourceImportId !== null && sourceItemRef !== null && hasLineage;
    if (hasAnyImportLineage && !hasCompleteImportLineage) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "imported_lineage_incomplete" });
    }
  }
}

function assertSafeMetadata(value: unknown, path: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", path });
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeEvidenceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", path });
    value.forEach((item, index) => assertSafeMetadata(item, `${path}.${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  const entries = Object.entries(value);
  if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", path });
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(item, `${path}.${key}`, depth + 1);
  }
}

function assertSafeEvidenceString(value: string, path: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", path });
  }
  if (/\bauthorization\b/i.test(value) || /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|auth_header|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_payload|raw_activity|payload|body|host|hostname|agent_id|device_id)([_.-]|$)/i.test(key);
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
    source_import_id: row.source_import_id,
    source_item_ref: row.source_item_ref,
    source_lineage: isRecord(row.source_lineage) ? row.source_lineage : {},
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
