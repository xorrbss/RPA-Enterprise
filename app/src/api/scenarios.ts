/**
 * Scenario create/read/validate/promote routes (D4.4 / api-surface section 2).
 *
 * All writes run the section 10 compile pipeline before persistence. Promote
 * also requires If-Match and Idempotency-Key and blocks static warnings.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { isApiErrorResponse, toApiError } from "../../../codegen/error-middleware";
import { ERROR_CATALOG, type ApiError } from "../../../ts/error-catalog";
import type {
  AuthenticatedPrincipal,
  CanonicalRequestHash,
  IdempotencyKey,
  SignedCommandRegistryPurpose,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { compileScenario } from "./compile-pipeline";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import { requirePrincipal, type ApiServerDeps } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface CommandResponse {
  status: number;
  body: unknown;
}

interface ScenarioVersionRow {
  scenario_id: string;
  version_id: string;
  version: number;
  ir: unknown;
}

export function registerScenarioRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post("/v1/scenarios", { config: { rbacAction: "scenario.create" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
    const outcome = compileScenario(request.body, { signedCommandRefs });
    if (!outcome.ok) {
      throw new ApiResponseError(outcome.code, outcome.details);
    }
    const ir = outcome.ir;
    const created = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const sc = await c.query<{ id: string }>(
        `INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`,
        [randomUUID(), principal.tenantId, ir.meta.name],
      );
      if (sc.rowCount === 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_name_in_use", name: ir.meta.name });
      }
      const scenarioId = sc.rows[0].id;
      await c.query(
        `INSERT INTO scenario_versions
           (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)`,
        [
          randomUUID(),
          principal.tenantId,
          scenarioId,
          ir.meta.version,
          JSON.stringify(ir),
          outcome.compiledAst,
          ir.params_schema !== undefined ? JSON.stringify(ir.params_schema) : null,
        ],
      );
      return { scenarioId, version: ir.meta.version };
    });
    reply
      .code(201)
      .header("ETag", String(created.version))
      .send({ scenario_id: created.scenarioId, version: created.version, promotion_status: "draft" });
  });

  app.get<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.scenarioId;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const r = await c.query<{ id: string; name: string; version: number; promotion_status: string }>(
          `SELECT s.id, s.name, sv.version, sv.promotion_status
             FROM scenarios s
             JOIN scenario_versions sv ON sv.tenant_id = s.tenant_id AND sv.scenario_id = s.id
            WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid
            ORDER BY sv.version DESC
            LIMIT 1`,
          [principal.tenantId, id],
        );
        return r.rows[0] ?? null;
      });
      if (row === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply
        .code(200)
        .header("ETag", String(row.version))
        .send({ scenario_id: row.id, name: row.name, version: row.version, promotion_status: row.promotion_status });
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/validate",
    { config: { rbacAction: "scenario.read" } },
    async (request) => {
      const principal = requirePrincipal(request);
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.validate");
      const outcome = compileScenario(request.body, { signedCommandRefs });
      if (!outcome.ok) {
        if (outcome.report === undefined) {
          throw new ApiResponseError(outcome.code, outcome.details);
        }
        return { valid: false, report: outcome.report };
      }
      return { valid: true, report: outcome.report };
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/promote",
    { config: { rbacAction: "scenario.promote" } },
    async (request, reply) => {
      const result = await promoteScenario(deps, request.params.scenarioId, request);
      reply.code(result.status);
      if (isRecord(result.body) && typeof result.body.version === "number") {
        reply.header("ETag", String(result.body.version));
      }
      reply.send(result.body);
    },
  );
}

async function promoteScenario(
  deps: ApiServerDeps,
  scenarioId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(scenarioId)) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  if (!isRecord(request.body) || request.body.target !== "prod" || Object.keys(request.body).some((key) => key !== "target")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_promote_request", target: request.body });
  }

  const expectedVersion = parseIfMatch(request.headers["if-match"]);
  if (expectedVersion === undefined) {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "missing_if_match" });
  }

  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }
  const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.promote");

  const requestHash = canonicalRequestHash("POST", `/v1/scenarios/${scenarioId}/promote`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "promoteScenario",
    key: idempotencyKey as IdempotencyKey,
    requestHash: requestHash as CanonicalRequestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  if (reservation.kind === "replay") {
    return { status: reservation.response.status, body: reservation.response.body };
  }
  if (reservation.kind === "in_flight") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "idempotency_in_flight" });
  }
  if (reservation.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  const recordId = reservation.recordId;
  try {
    const response = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const current = await c.query<ScenarioVersionRow>(
        `SELECT s.id AS scenario_id, sv.id AS version_id, sv.version, sv.ir
           FROM scenarios s
           JOIN scenario_versions sv ON sv.tenant_id = s.tenant_id AND sv.scenario_id = s.id
          WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid
          ORDER BY sv.version DESC
          LIMIT 1`,
        [principal.tenantId, scenarioId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      if (row.version !== expectedVersion) {
        throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", {
          reason: "if_match_mismatch",
          currentVersion: row.version,
        });
      }

      const outcome = compileScenario(row.ir, { promote: true, signedCommandRefs });
      if (!outcome.ok) {
        throw new ApiResponseError(outcome.code, outcome.details);
      }

      await c.query(
        `UPDATE scenario_versions
            SET promotion_status='draft', promoted_at=NULL
          WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND id <> $3::uuid AND promotion_status='prod'`,
        [principal.tenantId, scenarioId, row.version_id],
      );
      await c.query(
        `UPDATE scenario_versions
            SET promotion_status='prod', compiled_ast=$1, promoted_at=now()
          WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        [outcome.compiledAst, principal.tenantId, row.version_id],
      );

      const body = { scenario_id: scenarioId, version: row.version, promotion_status: "prod" };
      const commandResponse: CommandResponse = { status: 200, body };
      await completeIdempotencyInTx(c, recordId, commandResponse);
      return commandResponse;
    });
    return response;
  } catch (err) {
    if (err instanceof ApiResponseError && !ERROR_CATALOG[err.code].retryable) {
      await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
    }
    throw err;
  }
}

async function signedCommandRefsFor(
  deps: ApiServerDeps,
  principal: AuthenticatedPrincipal,
  purpose: SignedCommandRegistryPurpose,
): Promise<readonly string[] | undefined> {
  const result = await deps.signedCommandRegistry.listAllowedCommandRefs({ principal, purpose });
  if (result.kind === "unavailable") {
    return undefined;
  }
  const snapshot = result.snapshot;
  if (typeof snapshot.sourceRef !== "string" || snapshot.sourceRef.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "signed_command_registry_source_missing" });
  }
  if (!Array.isArray(snapshot.commands)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "signed_command_registry_commands_invalid" });
  }
  const cmdRefs: string[] = [];
  for (const command of snapshot.commands) {
    if (
      command === undefined ||
      typeof command.cmdRef !== "string" ||
      command.cmdRef.length === 0 ||
      typeof command.kid !== "string" ||
      command.kid.length === 0 ||
      typeof command.signature !== "string" ||
      command.signature.length === 0 ||
      typeof command.verificationKeyRef !== "string" ||
      command.verificationKeyRef.length === 0
    ) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "signed_command_registry_ref_invalid" });
    }
    cmdRefs.push(command.cmdRef);
  }
  return cmdRefs;
}

function parseIfMatch(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^W\//, "").replace(/^"|"$/g, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function apiErrorBody(err: ApiResponseError, correlationId: string): ApiError {
  const mapped = toApiError(err.code, correlationId, err.details);
  if (isApiErrorResponse(mapped)) {
    return mapped.body;
  }
  return { code: err.code, message: ERROR_CATALOG[err.code].userMessage, correlation_id: correlationId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
