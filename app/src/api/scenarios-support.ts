/**
 * scenario 라우트 보조 — promote 핸들러(promoteScenario), signed-command 참조 수집(signedCommandRefsFor),
 * If-Match/version 파싱·IR 클론·에러 본문·레코드 가드. registerScenarioRoutes(scenarios.ts)가 소비한다.
 * (api-surface §2 / 분해 전 scenarios.ts 내부 헬퍼를 sibling 로 추출 — CLAUDE.md #7.)
 */
import type { FastifyRequest } from "fastify";

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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

export interface ScenarioVersionListRow {
  version_id: string;
  version: number;
  promotion_status: string;
  created_at: string;
  promoted_at: string | null;
}

export interface ScenarioVersionDetailRow extends ScenarioVersionListRow {
  scenario_id: string;
  name: string;
  ir: unknown;
}

export async function promoteScenario(
  deps: ApiServerDeps,
  scenarioId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(scenarioId)) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  const target = isRecord(request.body) && (request.body.target === "prod" || request.body.target === "draft")
    ? request.body.target
    : null;
  if (target === null || !isRecord(request.body) || Object.keys(request.body).some((key) => key !== "target")) {
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
            AND s.archived_at IS NULL
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

      let compiledAst: string | null = null;
      if (target === "prod") {
        const outcome = compileScenario(row.ir, { promote: true, signedCommandRefs });
        if (!outcome.ok) {
          throw new ApiResponseError(outcome.code, outcome.details);
        }
        compiledAst = outcome.compiledAst;
      }

      if (target === "prod") {
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
          [compiledAst, principal.tenantId, row.version_id],
        );
      } else {
        await c.query(
          `UPDATE scenario_versions
              SET promotion_status='draft', promoted_at=NULL
            WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [principal.tenantId, row.version_id],
        );
      }

      const body = { scenario_id: scenarioId, version: row.version, promotion_status: target };
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

export async function signedCommandRefsFor(
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

export function parseIfMatch(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^W\//, "").replace(/^"|"$/g, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function parseVersionParam(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && String(parsed) === value ? parsed : undefined;
}

export function cloneIrWithVersion(value: unknown, expectedName: string, version: number): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(clone)) return clone;
  const meta = isRecord(clone.meta) ? clone.meta : {};
  clone.meta = { ...meta, name: expectedName, version };
  return clone;
}

function apiErrorBody(err: ApiResponseError, correlationId: string): ApiError {
  const mapped = toApiError(err.code, correlationId, err.details);
  if (isApiErrorResponse(mapped)) {
    return mapped.body;
  }
  return { code: err.code, message: ERROR_CATALOG[err.code].userMessage, correlation_id: correlationId };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
