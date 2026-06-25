/**
 * scenario 라우트 보조 — promote 핸들러(promoteScenario), signed-command 참조 수집(signedCommandRefsFor),
 * If-Match/version 파싱·IR 클론·에러 본문·레코드 가드. registerScenarioRoutes(scenarios.ts)가 소비한다.
 * (api-surface §2 / 분해 전 scenarios.ts 내부 헬퍼를 sibling 로 추출 — CLAUDE.md #7.)
 */
import { randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

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
import { inferRuntimeTargetForStartUrl } from "./scenario-generation-target";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { promoteActsToDeterministic } from "./scenario-promotion";
import { loadRunActionPlans } from "./scenario-promotion-store";

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
  if (deps.enforceAlmMakerChecker === true) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "legacy_promote_disabled_by_enterprise_alm" });
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
    if (err instanceof ApiResponseError) {
      if (isReleasableVersionConflict(err.code)) {
        await deps.idempotency.release(recordId); // IFM-1: 일시적 version 충돌은 멱등 영속 말고 예약 회수(§0.3 재시도 가능)
      } else if (!ERROR_CATALOG[err.code].retryable) {
        await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
      }
    }
    throw err;
  }
}

/**
 * PbD 승격 ③ — 성공 run 의 결정형 ActionPlan 을 시나리오의 새 draft 버전으로 승격한다(slice1 transform + slice2 read 결합).
 * 흐름: run(completed, 이 시나리오 소속) 검증 → source 버전 IR + loadRunActionPlans(run) → promoteActsToDeterministic
 * (click→act.args.click_selector) → cloneIrWithVersion(meta) → compileScenario → scenario_versions(draft, 다음 버전) INSERT.
 * 승격할 click plan 이 0 이면 no-op 버전을 만들지 않고 loud 거부("조용한 false 금지"). 멱등(Idempotency-Key), RBAC scenario.promote.
 */
export async function promoteScenarioFromRun(
  deps: ApiServerDeps,
  scenarioId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(scenarioId)) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  // body: { run_id } closed shape.
  const body = isRecord(request.body) ? request.body : undefined;
  const runId = body !== undefined && typeof body.run_id === "string" ? body.run_id : undefined;
  if (body === undefined || runId === undefined || !UUID_RE.test(runId) || Object.keys(body).some((k) => k !== "run_id")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_promote_from_run_request" });
  }
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }
  const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.promote");

  const requestHash = canonicalRequestHash("POST", `/v1/scenarios/${scenarioId}/promote-from-run`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "promoteScenarioFromRun",
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
      // 1) run 로드 — 완료 + 이 시나리오 소속 검증(RLS 스코프). 부재/타시나리오/미완료는 loud 거부.
      const runResult = await c.query<{ scenario_version_id: string; status: string; scenario_id: string; name: string }>(
        `SELECT r.scenario_version_id, r.status, sv.scenario_id, s.name
           FROM runs r
           JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
           JOIN scenarios s ON s.tenant_id = sv.tenant_id AND s.id = sv.scenario_id
          WHERE r.id = $1::uuid AND s.archived_at IS NULL`,
        [runId],
      );
      const runRow = runResult.rows[0];
      if (runRow === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      if (runRow.scenario_id !== scenarioId) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "run_not_for_scenario" });
      }
      if (runRow.status !== "completed") {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "run_not_completed", status: runRow.status });
      }
      // 2) source 버전 IR.
      const sourceResult = await c.query<{ ir: unknown }>(
        `SELECT ir FROM scenario_versions WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [principal.tenantId, runRow.scenario_version_id],
      );
      const sourceRow = sourceResult.rows[0];
      if (sourceRow === undefined || !isRecord(sourceRow.ir)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      // 3) 캡처 plan → 결정형 transform(click → click_selector, fill → fill_selector[값 출처 보유 노드]).
      //    다중-act 노드(ambiguousNodeIds)는 plan→act 귀속 불가 → transform 이 multi_act_node_ambiguous 로 loud skip.
      const { plans, ambiguousNodeIds } = await loadRunActionPlans(c, runId);
      const promotion = promoteActsToDeterministic(sourceRow.ir, plans, ambiguousNodeIds);
      if (promotion.promotedNodeIds.length === 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "no_plans_to_promote" });
      }
      // 4) 다음 버전 번호 + meta(name/version) 세팅.
      const currentVersion = await c.query<{ version: number }>(
        `SELECT version FROM scenario_versions WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid ORDER BY version DESC LIMIT 1`,
        [principal.tenantId, scenarioId],
      );
      const nextVersion = (currentVersion.rows[0]?.version ?? 0) + 1;
      const versionedIr = cloneIrWithVersion(promotion.ir, runRow.name, nextVersion);
      // 5) compile 검증(저장 전).
      const outcome = compileScenario(versionedIr, { signedCommandRefs });
      if (!outcome.ok) {
        throw new ApiResponseError(outcome.code, outcome.details);
      }
      // 6) 새 draft 버전 INSERT(자동 prod 승격 아님 — 운영자가 별도 promote).
      const newVersionId = randomUUID();
      const insertedVersion = await c.query(
        `INSERT INTO scenario_versions
           (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)
         ON CONFLICT (tenant_id, scenario_id, version) DO NOTHING
         RETURNING id`,
        [
          newVersionId,
          principal.tenantId,
          scenarioId,
          nextVersion,
          JSON.stringify(outcome.ir),
          outcome.compiledAst,
          outcome.ir.params_schema !== undefined ? JSON.stringify(outcome.ir.params_schema) : null,
        ],
      );
      if (insertedVersion.rowCount !== 1) {
        // IFM-2: 동시 작성자 version 선점(UNIQUE 경합) → 412 환원(raw 23505→500 회피).
        throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "concurrent_version_insert", version: nextVersion });
      }
      const commandResponse: CommandResponse = {
        status: 201,
        body: {
          scenario_id: scenarioId,
          version: nextVersion,
          scenario_version_id: newVersionId,
          promotion_status: "draft",
          promoted_node_ids: promotion.promotedNodeIds,
          skipped: promotion.skipped,
        },
      };
      await completeIdempotencyInTx(c, recordId, commandResponse);
      return commandResponse;
    });
    return response;
  } catch (err) {
    if (err instanceof ApiResponseError) {
      if (isReleasableVersionConflict(err.code)) {
        await deps.idempotency.release(recordId); // IFM-1: 일시적 version 충돌은 멱등 영속 말고 예약 회수(§0.3 재시도 가능)
      } else if (!ERROR_CATALOG[err.code].retryable) {
        await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
      }
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

// IFM-1: 일시적 낙관적-동시성 충돌(예약 회수 대상). command.ts 와 동일 규약(순환의존 회피로 로컬 정의).
function isReleasableVersionConflict(code: string): boolean {
  return code === "SCENARIO_VERSION_CONFLICT" || code === "POLICY_VERSION_CONFLICT";
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

/**
 * 실행 대상(ir.target) 자동 해소 — 쉬운 만들기/일반 저장 IR은 ir.target(site/browser/network)을 만들지 않아
 * createRun 시 run_target_unresolved 로 거부된다(server-create-run). IR의 navigate url_ref 가 가리키는 params 기본값
 * (시작 URL)으로 사이트를 자동 추론(자연어 생성과 동일 inferRuntimeTargetForStartUrl)해 주입할 target 을 돌려준다.
 *  - 이미 명시 target 이 있으면 undefined(호출측이 원본 IR 보존).
 *  - 시작 URL 부재·추론 실패(미등록/모호 사이트)도 undefined(후방호환: target 없이 저장 = 기존 동작).
 */
export async function resolveRunTargetForIr(
  client: PoolClient,
  tenantId: string,
  ir: unknown,
): Promise<{ site_profile_id: string; browser_identity_id: string; network_policy_id: string } | undefined> {
  if (!isRecord(ir) || isRecord(ir.target)) return undefined;
  const startUrl = startUrlFromIr(ir);
  if (startUrl === undefined) return undefined;
  const inference = await inferRuntimeTargetForStartUrl(client, tenantId, startUrl);
  return inference.target;
}

/** IR 의 navigate 액션 url_ref 가 가리키는 params_schema 기본값 중 첫 http(s) 절대 URL(시작 URL). */
function startUrlFromIr(ir: Record<string, unknown>): string | undefined {
  const nodes = isRecord(ir.nodes) ? ir.nodes : {};
  const urlRefKeys = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!isRecord(node) || !Array.isArray(node.what)) continue;
    for (const step of node.what) {
      if (isRecord(step) && step.action === "navigate" && typeof step.url_ref === "string") {
        urlRefKeys.add(step.url_ref);
      }
    }
  }
  const schema = isRecord(ir.params_schema) ? ir.params_schema : {};
  const props = isRecord(schema.properties) ? schema.properties : {};
  for (const key of urlRefKeys) {
    const prop = props[key];
    if (isRecord(prop) && typeof prop.default === "string" && isHttpUrl(prop.default)) {
      return prop.default;
    }
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
