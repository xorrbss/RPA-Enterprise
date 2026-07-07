import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import {
  optionalStage,
  optionalStringFilter,
  parseCreateBody,
  parseTransitionBody,
  parseUpdateBody,
  validateIdeaId,
  type IdeaCreateBody,
  type IdeaPriority,
  type IdeaSource,
  type IdeaStage,
  type IdeaUpdateBody,
} from "./automation-ideas-parse";

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
