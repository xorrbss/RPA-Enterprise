import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { compileScenario } from "./compile-pipeline";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { appendGovernanceAudit } from "./role-assignments";
import { parseIfMatch, signedCommandRefsFor, UUID_RE } from "./scenarios-support";
import { requirePrincipal, type ApiServerDeps } from "./server";

type ScenarioEnvironment = "dev" | "staging" | "prod";
type ReleaseTargetEnvironment = Extract<ScenarioEnvironment, "staging" | "prod">;
type ReleaseStatus = "draft" | "submitted" | "approved" | "rejected" | "deployed" | "rolled_back" | "cancelled";

interface ReleaseRow {
  id: string;
  scenario_id: string;
  source_version_id: string;
  source_version: number;
  target_environment: ReleaseTargetEnvironment;
  status: ReleaseStatus;
  package_hash: string;
  validation_report: unknown;
  requested_by: string;
  requested_at: Date;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  deployed_by: string | null;
  deployed_at: Date | null;
  rollback_of_release_id: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface BindingRow {
  id: string;
  scenario_id: string;
  environment: ScenarioEnvironment;
  scenario_version_id: string;
  version: number;
  release_id: string | null;
  activated_by: string;
  activated_at: Date;
}

interface ReleaseEventRow {
  id: string;
  event_type: string;
  actor_sub: string;
  reason: string | null;
  created_at: Date;
}

interface ScenarioVersionRow {
  scenario_id: string;
  scenario_name: string;
  version_id: string;
  version: number;
  ir: unknown;
}

interface CreateReleaseBody {
  readonly sourceVersion: number;
  readonly targetEnvironment: ReleaseTargetEnvironment;
  readonly reason: string | null;
}

interface ReasonBody {
  readonly reason: string | null;
}

interface RejectBody {
  readonly reason: string;
}

export function registerScenarioReleaseRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/environment-bindings",
    { config: { rbacAction: "scenario_release.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const rows = await withScenario(deps, principal.tenantId, scenarioId, async (client) => {
        const result = await client.query<BindingRow>(
          `SELECT b.id::text AS id, b.scenario_id::text AS scenario_id, b.environment, b.scenario_version_id::text AS scenario_version_id,
                  sv.version, b.release_id::text AS release_id, b.activated_by, b.activated_at
             FROM scenario_environment_bindings b
             JOIN scenario_versions sv ON sv.tenant_id=b.tenant_id AND sv.id=b.scenario_version_id
            WHERE b.tenant_id=$1::uuid AND b.scenario_id=$2::uuid AND b.deactivated_at IS NULL
            ORDER BY CASE b.environment WHEN 'prod' THEN 1 WHEN 'staging' THEN 2 ELSE 3 END`,
          [principal.tenantId, scenarioId],
        );
        return result.rows;
      });
      reply.code(200).send({ items: rows.map(mapBinding), next_cursor: null });
    },
  );

  app.get<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/releases",
    { config: { rbacAction: "scenario_release.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const query = request.query as Record<string, unknown>;
      const { limit, cursor } = parsePageParams(query);
      const status = parseOptionalStatus(query.status);
      const target = parseOptionalTargetEnvironment(query.target_environment);
      const rows = await withScenario(deps, principal.tenantId, scenarioId, async (client) => {
        const result = await client.query<ReleaseRow>(
          `${releaseSelectSql()}
            WHERE r.tenant_id=$1::uuid
              AND r.scenario_id=$2::uuid
              AND ($3::text IS NULL OR r.status=$3)
              AND ($4::text IS NULL OR r.target_environment=$4)
              AND ($5::timestamptz IS NULL OR (r.created_at, r.id) < ($5::timestamptz, $6::uuid))
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT $7`,
          [principal.tenantId, scenarioId, status ?? null, target ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });
      reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapRelease));
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/releases",
    { config: { rbacAction: "scenario_release.submit" } },
    async (request: FastifyRequest<{ Params: { scenarioId: string } }>, reply) => {
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = parseCreateReleaseBody(request.body);
      const signedCommandRefs = await signedCommandRefsFor(deps, requirePrincipal(request), "scenario.promote");
      const result = await runIdempotentCommand(
        deps,
        request,
        "createScenarioRelease",
        `/v1/scenarios/${scenarioId}/releases`,
        (client, tenantId) => createRelease(client, request, tenantId, scenarioId, body, signedCommandRefs),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/scenario-releases/:id",
    { config: { rbacAction: "scenario_release.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const releaseId = request.params.id;
      if (!UUID_RE.test(releaseId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const detail = await withRelease(deps, principal.tenantId, releaseId, async (client) => releaseDetail(client, principal.tenantId, releaseId));
      reply.code(200).send(detail);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/scenario-releases/:id/submit",
    { config: { rbacAction: "scenario_release.submit" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const releaseId = request.params.id;
      if (!UUID_RE.test(releaseId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = parseReasonBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "submitScenarioRelease",
        `/v1/scenario-releases/${releaseId}/submit`,
        (client, tenantId) => transitionRelease(client, request, tenantId, releaseId, "submitted", body.reason),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/scenario-releases/:id/approve",
    { config: { rbacAction: "scenario_release.approve" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const releaseId = request.params.id;
      if (!UUID_RE.test(releaseId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = parseReasonBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "approveScenarioRelease",
        `/v1/scenario-releases/${releaseId}/approve`,
        (client, tenantId) => transitionRelease(client, request, tenantId, releaseId, "approved", body.reason),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/scenario-releases/:id/reject",
    { config: { rbacAction: "scenario_release.approve" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const releaseId = request.params.id;
      if (!UUID_RE.test(releaseId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = parseRejectBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "rejectScenarioRelease",
        `/v1/scenario-releases/${releaseId}/reject`,
        (client, tenantId) => transitionRelease(client, request, tenantId, releaseId, "rejected", body.reason),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/scenario-releases/:id/deploy",
    { config: { rbacAction: "scenario_release.deploy" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const releaseId = request.params.id;
      if (!UUID_RE.test(releaseId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      if (expectedVersion === undefined) throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "missing_if_match" });
      const signedCommandRefs = await signedCommandRefsFor(deps, requirePrincipal(request), "scenario.promote");
      const result = await runIdempotentCommand(
        deps,
        request,
        "deployScenarioRelease",
        `/v1/scenario-releases/${releaseId}/deploy`,
        (client, tenantId) => deployRelease(client, request, tenantId, releaseId, expectedVersion, signedCommandRefs),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/scenario-releases/:id/rollback",
    { config: { rbacAction: "scenario_release.rollback" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const releaseId = request.params.id;
      if (!UUID_RE.test(releaseId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      if (expectedVersion === undefined) throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "missing_if_match" });
      const signedCommandRefs = await signedCommandRefsFor(deps, requirePrincipal(request), "scenario.promote");
      const result = await runIdempotentCommand(
        deps,
        request,
        "rollbackScenarioRelease",
        `/v1/scenario-releases/${releaseId}/rollback`,
        (client, tenantId) => rollbackRelease(client, request, tenantId, releaseId, expectedVersion, signedCommandRefs),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function createRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  body: CreateReleaseBody,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const source = await loadScenarioVersion(client, tenantId, scenarioId, body.sourceVersion);
  const outcome = compileScenario(source.ir, { promote: true, signedCommandRefs });
  if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
  const packageHash = packageHashFor({
    scenario_id: scenarioId,
    source_version_id: source.version_id,
    target_environment: body.targetEnvironment,
    ir: outcome.ir,
    params_schema: outcome.ir.params_schema ?? null,
    validation_report: outcome.report,
  });
  const releaseId = randomUUID();
  await client.query(
    `INSERT INTO scenario_releases
       (id, tenant_id, scenario_id, source_version_id, target_environment, status,
        package_hash, validation_report, requested_by, reason)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'draft', $6, $7::jsonb, $8, $9)`,
    [releaseId, tenantId, scenarioId, source.version_id, body.targetEnvironment, packageHash, JSON.stringify(outcome.report), actor.subjectId, body.reason],
  );
  await appendReleaseEvent(client, tenantId, releaseId, "created", actor.subjectId, body.reason);
  await appendGovernanceAudit(client, request, "scenario_release.create", "allow", "release_created", {
    release_id: releaseId,
    scenario_id: scenarioId,
    source_version: source.version,
    target_environment: body.targetEnvironment,
    package_hash: packageHash,
  });
  return { status: 201, body: await releaseDetail(client, tenantId, releaseId) };
}

async function transitionRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  releaseId: string,
  next: Extract<ReleaseStatus, "submitted" | "approved" | "rejected">,
  reason: string | null,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const release = await loadRelease(client, tenantId, releaseId);
  if (next === "submitted" && release.status !== "draft") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_draft", status: release.status });
  }
  if ((next === "approved" || next === "rejected") && release.status !== "submitted") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_submitted", status: release.status });
  }
  if (next === "approved" && release.requested_by === actor.subjectId) {
    throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "maker_checker_violation" });
  }
  const eventType = next === "approved" ? "approved" : next === "rejected" ? "rejected" : "submitted";
  const auditAction = next === "approved"
    ? "scenario_release.approve"
    : next === "rejected"
      ? "scenario_release.reject"
      : "scenario_release.submit";
  if (next === "submitted") {
    await client.query(
      `UPDATE scenario_releases SET status='submitted', submitted_at=now(), updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, releaseId],
    );
  } else if (next === "approved") {
    await client.query(
      `UPDATE scenario_releases SET status='approved', approved_by=$1, approved_at=now(), updated_at=now()
        WHERE tenant_id=$2::uuid AND id=$3::uuid`,
      [actor.subjectId, tenantId, releaseId],
    );
  } else {
    if (reason === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "rejection_reason_required" });
    await client.query(
      `UPDATE scenario_releases SET status='rejected', rejected_by=$1, rejected_at=now(), rejection_reason=$2, updated_at=now()
        WHERE tenant_id=$3::uuid AND id=$4::uuid`,
      [actor.subjectId, reason, tenantId, releaseId],
    );
  }
  await appendReleaseEvent(client, tenantId, releaseId, eventType, actor.subjectId, reason);
  await appendGovernanceAudit(client, request, auditAction, "allow", `release_${eventType}`, {
    release_id: releaseId,
    scenario_id: release.scenario_id,
    target_environment: release.target_environment,
    package_hash: release.package_hash,
  });
  return { status: 200, body: await releaseDetail(client, tenantId, releaseId) };
}

async function deployRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  releaseId: string,
  expectedVersion: number,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const release = await loadRelease(client, tenantId, releaseId);
  if (release.status !== "approved") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_approved", status: release.status });
  }
  const source = await loadScenarioVersionById(client, tenantId, release.scenario_id, release.source_version_id);
  await assertLatestVersion(client, tenantId, release.scenario_id, expectedVersion);
  const outcome = compileScenario(source.ir, { promote: true, signedCommandRefs });
  if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
  await applyEnvironmentBinding(client, tenantId, release.scenario_id, release.target_environment, release.source_version_id, releaseId, actor.subjectId, outcome.compiledAst);
  await client.query(
    `UPDATE scenario_releases SET status='deployed', deployed_by=$1, deployed_at=now(), updated_at=now()
      WHERE tenant_id=$2::uuid AND id=$3::uuid`,
    [actor.subjectId, tenantId, releaseId],
  );
  await appendReleaseEvent(client, tenantId, releaseId, "deployed", actor.subjectId, null);
  await appendGovernanceAudit(client, request, "scenario_release.deploy", "allow", "release_deployed", {
    release_id: releaseId,
    scenario_id: release.scenario_id,
    source_version: source.version,
    target_environment: release.target_environment,
    package_hash: release.package_hash,
  });
  return { status: 200, body: await releaseDetail(client, tenantId, releaseId, true) };
}

async function rollbackRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  releaseId: string,
  expectedVersion: number,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const release = await loadRelease(client, tenantId, releaseId);
  if (release.status !== "deployed") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_deployed", status: release.status });
  }
  await assertLatestVersion(client, tenantId, release.scenario_id, expectedVersion);
  const previous = await client.query<{ scenario_version_id: string }>(
    `SELECT scenario_version_id::text
       FROM scenario_environment_bindings
      WHERE tenant_id=$1::uuid
        AND scenario_id=$2::uuid
        AND environment=$3
        AND deactivated_at IS NOT NULL
        AND release_id IS DISTINCT FROM $4::uuid
      ORDER BY activated_at DESC
      LIMIT 1`,
    [tenantId, release.scenario_id, release.target_environment, releaseId],
  );
  const previousVersionId = previous.rows[0]?.scenario_version_id;
  if (previousVersionId === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "rollback_target_missing" });
  }
  const source = await loadScenarioVersionById(client, tenantId, release.scenario_id, previousVersionId);
  const outcome = compileScenario(source.ir, { promote: true, signedCommandRefs });
  if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
  const packageHash = packageHashFor({
    scenario_id: release.scenario_id,
    source_version_id: previousVersionId,
    target_environment: release.target_environment,
    ir: outcome.ir,
    params_schema: outcome.ir.params_schema ?? null,
    validation_report: outcome.report,
  });
  const rollbackId = randomUUID();
  await client.query(
    `INSERT INTO scenario_releases
       (id, tenant_id, scenario_id, source_version_id, target_environment, status, package_hash,
        validation_report, requested_by, requested_at, submitted_at, approved_by, approved_at,
        deployed_by, deployed_at, rollback_of_release_id, reason)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'deployed', $6, $7::jsonb,
        $8, now(), now(), $8, now(), $8, now(), $9::uuid, $10)`,
    [rollbackId, tenantId, release.scenario_id, previousVersionId, release.target_environment, packageHash, JSON.stringify(outcome.report), actor.subjectId, releaseId, "rollback"],
  );
  await client.query(
    `UPDATE scenario_releases SET status='rolled_back', updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, releaseId],
  );
  await applyEnvironmentBinding(client, tenantId, release.scenario_id, release.target_environment, previousVersionId, rollbackId, actor.subjectId, outcome.compiledAst);
  await appendReleaseEvent(client, tenantId, rollbackId, "created", actor.subjectId, "rollback");
  await appendReleaseEvent(client, tenantId, rollbackId, "approved", actor.subjectId, "rollback");
  await appendReleaseEvent(client, tenantId, rollbackId, "deployed", actor.subjectId, "rollback");
  await appendReleaseEvent(client, tenantId, releaseId, "rolled_back", actor.subjectId, "rollback");
  await appendGovernanceAudit(client, request, "scenario_release.rollback", "allow", "release_rolled_back", {
    release_id: releaseId,
    rollback_release_id: rollbackId,
    scenario_id: release.scenario_id,
    source_version: source.version,
    target_environment: release.target_environment,
    package_hash: packageHash,
  });
  return { status: 201, body: await releaseDetail(client, tenantId, rollbackId, true) };
}

async function applyEnvironmentBinding(
  client: PoolClient,
  tenantId: string,
  scenarioId: string,
  environment: ReleaseTargetEnvironment,
  scenarioVersionId: string,
  releaseId: string,
  actorSub: string,
  compiledAst: string,
): Promise<void> {
  const newBindingId = randomUUID();
  const previous = await client.query<{ id: string }>(
    `UPDATE scenario_environment_bindings
        SET deactivated_by=$1::text, deactivated_at=now()
      WHERE tenant_id=$2::uuid AND scenario_id=$3::uuid AND environment=$4 AND deactivated_at IS NULL`,
    [actorSub, tenantId, scenarioId, environment],
  );
  await client.query(
    `INSERT INTO scenario_environment_bindings
       (id, tenant_id, scenario_id, environment, scenario_version_id, release_id, activated_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::text)`,
    [newBindingId, tenantId, scenarioId, environment, scenarioVersionId, releaseId, actorSub],
  );
  if ((previous.rowCount ?? 0) > 0) {
    await client.query(
      `UPDATE scenario_environment_bindings
          SET replaced_by_binding_id=$1::uuid
        WHERE tenant_id=$2::uuid AND scenario_id=$3::uuid AND environment=$4
          AND deactivated_at IS NOT NULL AND replaced_by_binding_id IS NULL`,
      [newBindingId, tenantId, scenarioId, environment],
    );
  }
  if (environment === "prod") {
    await client.query(
      `UPDATE scenario_versions
          SET promotion_status='draft', promoted_at=NULL
        WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND id <> $3::uuid AND promotion_status='prod'`,
      [tenantId, scenarioId, scenarioVersionId],
    );
    await client.query(
      `UPDATE scenario_versions
          SET promotion_status='prod', compiled_ast=$1, promoted_at=now()
        WHERE tenant_id=$2::uuid AND id=$3::uuid`,
      [compiledAst, tenantId, scenarioVersionId],
    );
  }
}

async function withScenario<T>(
  deps: ApiServerDeps,
  tenantId: string,
  scenarioId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    const exists = await client.query(
      `SELECT 1 FROM scenarios WHERE tenant_id=$1::uuid AND id=$2::uuid AND archived_at IS NULL`,
      [tenantId, scenarioId],
    );
    if (exists.rowCount === 0) throw new ApiResponseError("RESOURCE_NOT_FOUND");
    return work(client);
  });
}

async function withRelease<T>(
  deps: ApiServerDeps,
  tenantId: string,
  releaseId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    await loadRelease(client, tenantId, releaseId);
    return work(client);
  });
}

async function loadScenarioVersion(client: PoolClient, tenantId: string, scenarioId: string, version: number): Promise<ScenarioVersionRow> {
  const result = await client.query<ScenarioVersionRow>(
    `SELECT s.id::text AS scenario_id, s.name AS scenario_name, sv.id::text AS version_id, sv.version, sv.ir
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL AND sv.version=$3`,
    [tenantId, scenarioId, version],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function loadScenarioVersionById(client: PoolClient, tenantId: string, scenarioId: string, versionId: string): Promise<ScenarioVersionRow> {
  const result = await client.query<ScenarioVersionRow>(
    `SELECT s.id::text AS scenario_id, s.name AS scenario_name, sv.id::text AS version_id, sv.version, sv.ir
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL AND sv.id=$3::uuid`,
    [tenantId, scenarioId, versionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function assertLatestVersion(client: PoolClient, tenantId: string, scenarioId: string, expectedVersion: number): Promise<void> {
  const result = await client.query<{ version: number }>(
    `SELECT sv.version
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL
      ORDER BY sv.version DESC
      LIMIT 1`,
    [tenantId, scenarioId],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  if (version !== expectedVersion) {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "if_match_mismatch", currentVersion: version });
  }
}

async function loadRelease(client: PoolClient, tenantId: string, releaseId: string): Promise<ReleaseRow> {
  const result = await client.query<ReleaseRow>(
    `${releaseSelectSql()} WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid`,
    [tenantId, releaseId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function releaseDetail(client: PoolClient, tenantId: string, releaseId: string, includeBinding = false): Promise<Record<string, unknown>> {
  const release = await loadRelease(client, tenantId, releaseId);
  const events = await client.query<ReleaseEventRow>(
    `SELECT id::text AS id, event_type, actor_sub, reason, created_at
       FROM scenario_release_events
      WHERE tenant_id=$1::uuid AND release_id=$2::uuid
      ORDER BY created_at ASC, id ASC`,
    [tenantId, releaseId],
  );
  const body: Record<string, unknown> = {
    ...mapRelease(release),
    events: events.rows.map((event) => ({
      event_id: event.id,
      event_type: event.event_type,
      actor_sub: event.actor_sub,
      reason: event.reason,
      created_at: event.created_at.toISOString(),
    })),
  };
  if (includeBinding) {
    const binding = await client.query<BindingRow>(
      `SELECT b.id::text AS id, b.scenario_id::text AS scenario_id, b.environment, b.scenario_version_id::text AS scenario_version_id,
              sv.version, b.release_id::text AS release_id, b.activated_by, b.activated_at
         FROM scenario_environment_bindings b
         JOIN scenario_versions sv ON sv.tenant_id=b.tenant_id AND sv.id=b.scenario_version_id
        WHERE b.tenant_id=$1::uuid AND b.scenario_id=$2::uuid AND b.environment=$3 AND b.deactivated_at IS NULL`,
      [tenantId, release.scenario_id, release.target_environment],
    );
    body.current_binding = binding.rows[0] !== undefined ? mapBinding(binding.rows[0]) : null;
  }
  return body;
}

function releaseSelectSql(): string {
  return `SELECT r.id::text AS id, r.scenario_id::text AS scenario_id, r.source_version_id::text AS source_version_id,
                 sv.version AS source_version, r.target_environment, r.status, r.package_hash, r.validation_report,
                 r.requested_by, r.requested_at, r.submitted_at, r.approved_by, r.approved_at,
                 r.rejected_by, r.rejected_at, r.rejection_reason, r.deployed_by, r.deployed_at,
                 r.rollback_of_release_id::text AS rollback_of_release_id, r.reason,
                 r.created_at, r.updated_at, r.created_at::text AS cursor_at
            FROM scenario_releases r
            JOIN scenario_versions sv ON sv.tenant_id=r.tenant_id AND sv.id=r.source_version_id`;
}

async function appendReleaseEvent(
  client: PoolClient,
  tenantId: string,
  releaseId: string,
  eventType: string,
  actorSub: string,
  reason: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO scenario_release_events (id, tenant_id, release_id, event_type, actor_sub, reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
    [randomUUID(), tenantId, releaseId, eventType, actorSub, reason],
  );
}

function mapRelease(row: ReleaseRow): Record<string, unknown> {
  return {
    release_id: row.id,
    scenario_id: row.scenario_id,
    source_version_id: row.source_version_id,
    source_version: row.source_version,
    target_environment: row.target_environment,
    status: row.status,
    package_hash: row.package_hash,
    validation_report: row.validation_report,
    requested_by: row.requested_by,
    requested_at: row.requested_at.toISOString(),
    submitted_at: row.submitted_at?.toISOString() ?? null,
    approved_by: row.approved_by,
    approved_at: row.approved_at?.toISOString() ?? null,
    rejected_by: row.rejected_by,
    rejected_at: row.rejected_at?.toISOString() ?? null,
    rejection_reason: row.rejection_reason,
    deployed_by: row.deployed_by,
    deployed_at: row.deployed_at?.toISOString() ?? null,
    rollback_of_release_id: row.rollback_of_release_id,
    reason: row.reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapBinding(row: BindingRow): Record<string, unknown> {
  return {
    binding_id: row.id,
    scenario_id: row.scenario_id,
    environment: row.environment,
    scenario_version_id: row.scenario_version_id,
    version: row.version,
    release_id: row.release_id,
    activated_by: row.activated_by,
    activated_at: row.activated_at.toISOString(),
  };
}

function parseCreateReleaseBody(raw: unknown): CreateReleaseBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "source_version" && key !== "target_environment" && key !== "reason") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const sourceVersion = typeof raw.source_version === "number" && Number.isInteger(raw.source_version) && raw.source_version >= 1
    ? raw.source_version
    : undefined;
  if (sourceVersion === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source_version" });
  return {
    sourceVersion,
    targetEnvironment: parseTargetEnvironment(raw.target_environment),
    reason: parseOptionalReason(raw.reason),
  };
}

function parseReasonBody(raw: unknown): ReasonBody {
  if (raw === undefined) return { reason: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  return { reason: parseOptionalReason(raw.reason) };
}

function parseRejectBody(raw: unknown): RejectBody {
  const reason = parseReasonBody(raw).reason;
  if (reason === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required" });
  return { reason };
}

function parseOptionalStatus(raw: unknown): ReleaseStatus | undefined {
  if (raw === undefined) return undefined;
  const values: readonly string[] = ["draft", "submitted", "approved", "rejected", "deployed", "rolled_back", "cancelled"];
  if (typeof raw === "string" && values.includes(raw)) return raw as ReleaseStatus;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_release_status" });
}

function parseOptionalTargetEnvironment(raw: unknown): ReleaseTargetEnvironment | undefined {
  if (raw === undefined) return undefined;
  return parseTargetEnvironment(raw);
}

function parseTargetEnvironment(raw: unknown): ReleaseTargetEnvironment {
  if (raw === "staging" || raw === "prod") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_target_environment" });
}

function parseOptionalReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 500);
}

function packageHashFor(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}
