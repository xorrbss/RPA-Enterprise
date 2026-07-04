import type { FastifyInstance, FastifyRequest } from "fastify";

import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { createRelease, deployRelease, productionReadinessConfig, rollbackRelease, transitionRelease, type CreateReleaseBody } from "./scenario-releases-commands";
import { mapBinding, mapRelease, releaseDetail, releaseSelectSql, withRelease, withScenario, type BindingRow, type ReleaseRow, type ReleaseStatus, type ReleaseTargetEnvironment } from "./scenario-releases-store";
import { parseIfMatch, signedCommandRefsFor } from "./scenarios-support";
import { UUID_RE } from "./server-shared";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

interface ReasonBody {
  readonly reason: string | null;
}

interface RejectBody {
  readonly reason: string;
}

export function registerScenarioReleaseRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  const readinessConfig = productionReadinessConfig(deps);

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
        (client, tenantId) => transitionRelease(client, request, tenantId, releaseId, "submitted", body.reason, readinessConfig),
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
        (client, tenantId) => transitionRelease(client, request, tenantId, releaseId, "approved", body.reason, readinessConfig),
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
        (client, tenantId) => transitionRelease(client, request, tenantId, releaseId, "rejected", body.reason, readinessConfig),
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
        (client, tenantId) => deployRelease(client, request, tenantId, releaseId, expectedVersion, signedCommandRefs, readinessConfig),
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
