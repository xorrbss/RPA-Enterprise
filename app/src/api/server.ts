/**
 * 제어평면 Fastify 부트스트랩 (D4.1).
 *
 * 책임(api-surface.md §0 / d4-prompt §5.1): 얇은 핸들러 + 요청 경계 미들웨어.
 *  1) correlation: x-correlation-id 또는 생성 — ApiError·trace·event 공통 상관키(api-surface §0.2).
 *  2) authenticate: 모든 라우트 인증 필수(api-surface §0.1). 미성립→401, tenant 클레임 부재→403.
 *  3) RLS 바인딩: 모든 DB 작업은 app/src/db/pool.ts의 withTenantTx(pool, principal.tenantId, …) 경유
 *     (SET LOCAL app.tenant_id, FORCE RLS) — cross-tenant row는 보이지 않는다(auth-rbac §3/§4).
 *  4) 에러 매핑: codegen toApiError(error-middleware) 재사용(errors.ts).
 *  5) authorize(RBAC): 라우트가 선언한 rbacAction을 auth-rbac §2 매트릭스로 평가(rbac.ts). 미허용 → AUTHZ_FORBIDDEN.
 *
 *  6) 멱등(Idempotency-Key): 명령형 POST(run create)는 control_plane_idempotency_keys로 재요청 보호
 *     (idempotency.ts, release-decisions #7). run create는 params.as_of 1회 고정(§0.6) + runs(queued) +
 *     run.created outbox + run_claim enqueue(동일 tx). If-Match(scenario.version)·ajv 경계검증·컴파일
 *     파이프라인은 후속 증분(D4.4+)에서 추가한다.
 * 실행기 의존 e2e는 D3 BLOCKED — 본 계층은 executor 없이 검증 가능한 인증/RLS/RBAC/멱등 경계만 다룬다.
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { isApiErrorResponse, toApiError } from "../../../codegen/error-middleware";
import type { ControlPlaneIdempotencyStore } from "../../../ts/control-plane-contract";
import { ERROR_CATALOG, type ApiError } from "../../../ts/error-catalog";
import type {
  AuthenticatedPrincipal,
  AuthenticationBoundary,
  CanonicalRequestHash,
  IdempotencyKey,
  RbacAction,
  RbacMiddleware,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { emitOutboxEvent } from "../runtime/outbox";
import { ApiResponseError, registerErrorHandler } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import type { RunEnqueuer } from "./run-queue";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    principal: AuthenticatedPrincipal | null;
  }
  // 라우트별 RBAC 액션 선언(auth-rbac §2). RBAC preHandler가 이 값으로 authorize를 호출한다.
  interface FastifyContextConfig {
    rbacAction?: RbacAction;
    idempotencyBeforeRbac?: boolean;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 엄격 ISO-8601(date-time). Date.parse는 느슨하므로 형식 regex + 파싱 유효성 병행(api-surface §0.6).
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ApiServerDeps {
  pool: Pool;
  auth: AuthenticationBoundary;
  rbac: RbacMiddleware;
  idempotency: ControlPlaneIdempotencyStore;
  enqueuer: RunEnqueuer;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface CommandResponse {
  status: number;
  body: unknown;
}

/** RLS 스코프로 조회한 run 상세(api-surface §1 GET /v1/runs/{run_id}). */
interface RunRow {
  id: string;
  status: string;
  worker_id: string | null;
  attempts: number;
  as_of: Date | null;
}

export function buildServer(deps: ApiServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });

  app.decorateRequest("correlationId", "");
  app.decorateRequest("principal", null);

  // 1) correlation — 인증보다 먼저 설정되어 거부 응답에도 상관키가 실린다.
  app.addHook("onRequest", async (request) => {
    const header = request.headers["x-correlation-id"];
    request.correlationId = typeof header === "string" && header.length > 0 ? header : randomUUID();
  });

  // 2) authenticate — 인증 경계 위임(auth.ts). 거부 코드(401/403)를 ApiResponseError로 표면화.
  app.addHook("preHandler", async (request) => {
    if (request.is404) return; // 미매칭 라우트는 인증 이전에 notFoundHandler로 404 수렴(api-surface §2 각주1).
    const result = await deps.auth.authenticate({ authorization: request.headers.authorization });
    if (result.kind === "denied") {
      // 내부 분류 사유는 로그에만 남긴다(보안 경계: 자원/존재/분류 비노출, auth-rbac §5). 응답엔 code+일반 메시지만.
      request.log.warn(
        { reason: result.reason, code: result.code, correlation_id: request.correlationId },
        "auth denied",
      );
      throw new ApiResponseError(result.code);
    }
    request.principal = result.principal;
  });

  // 5) authorize(RBAC) — auth 다음(미들웨어 순서 …→rbac→handler). 라우트 선언 rbacAction을 §2 매트릭스로 평가.
  app.addHook("preHandler", async (request) => {
    if (request.is404) return; // 미매칭/미지원 메서드는 RBAC 평가 없이 notFoundHandler로 404(403·오탐 로그 방지).
    const action = request.routeOptions.config.rbacAction;
    if (action === undefined) {
      // rbacAction 미선언 = 보안 게이트 누락(설정 오류). 조용히 통과시키지 않고 차단(fail-closed,
      // auth-rbac "미설정 시 통과 금지"). 모든 제어평면 라우트는 §2 액션을 선언해야 한다.
      request.log.error(
        { url: request.url, correlation_id: request.correlationId },
        "route missing rbacAction — denying (misconfiguration)",
      );
      throw new ApiResponseError("AUTHZ_FORBIDDEN");
    }
    const principal = requirePrincipal(request);
    const decision = await deps.rbac.authorize(principal, { action, tenantId: principal.tenantId });
    if (decision.kind === "deny") {
      // 내부 사유는 로그에만(보안 경계: 비노출, auth-rbac §5). 응답엔 code(AUTHZ_FORBIDDEN 등)만.
      request.log.warn(
        { action: decision.action, code: decision.code, reason: decision.reason, correlation_id: request.correlationId },
        "rbac denied",
      );
      throw new ApiResponseError(decision.code);
    }
  });

  registerErrorHandler(app);

  // GET /v1/runs/{run_id} — RLS 스코프 조회. cross-tenant/부재/형식무효 id → RUN_NOT_FOUND(404).
  app.get<{ Params: { run_id: string } }>(
    "/v1/runs/:run_id",
    { config: { rbacAction: "run.read" } },
    async (request) => {
    const principal = requirePrincipal(request);
    const runId = request.params.run_id;
    // 형식 무효 id는 존재할 수 없다 → 404(존재 노출 회피, "조용한 false 금지": 500 크래시 대신 not-found).
    if (!UUID_RE.test(runId)) {
      throw new ApiResponseError("RUN_NOT_FOUND");
    }
    const run = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT id, status, worker_id, attempts, as_of FROM runs WHERE id = $1::uuid`,
        [runId],
      );
      return result.rows[0] ?? null;
    });
    if (run === null) {
      // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(auth-rbac §3 존재 비노출).
      throw new ApiResponseError("RUN_NOT_FOUND");
    }
    return {
      run_id: run.id,
      status: run.status,
      worker_id: run.worker_id,
      attempts: run.attempts,
      as_of: run.as_of,
    };
  });

  // POST /v1/runs — run 생성(멱등 명령, api-surface §1). Idempotency-Key 필수, params.as_of 1회 고정,
  //   runs(queued) + run.created outbox + run_claim enqueue(동일 tx). 실 step 실행은 D3 의존(d4-prompt §3).
  app.post("/v1/runs", { config: { rbacAction: "run.create" } }, async (request, reply) => {
    const result = await createRun(deps, request);
    reply.code(result.status).send(result.body);
  });

  return app;
}

function requirePrincipal(request: FastifyRequest): AuthenticatedPrincipal {
  if (request.principal === null) {
    // preHandler 인증이 선행 보장. 방어적(가정 금지) — 도달 시 인증 경계 결함. 사유는 응답에 노출하지 않는다.
    request.log.error({ correlation_id: request.correlationId }, "principal missing after auth preHandler");
    throw new ApiResponseError("UNAUTHENTICATED");
  }
  return request.principal;
}

/**
 * run 생성(멱등 명령). 흐름: 키/본문 선검사(422) → 멱등 예약(replay/in-flight 409/hash mismatch 412) →
 * reserved면 작업(scenario_version 존재 확인 → runs(queued) + run.created outbox + run_claim enqueue, 동일 tx)
 * → saveResult. 작업 실패는 saveFailure로 표시(동일 키 재요청은 저장 실패 응답 재생, in-flight 무한 방지).
 */
async function createRun(deps: ApiServerDeps, request: FastifyRequest): Promise<CommandResponse> {
  const principal = requirePrincipal(request);

  // (1) 멱등 키 필수(api-surface §0.4 / #7). 누락 → IR_SCHEMA_INVALID(422). 예약 이전 — 키 소모 없음.
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  // (2) 본문 형상 검증(scenario_version_id). 예약 이전 — 형상 오류는 키 소모 없음.
  if (!isRecord(request.body)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const body = request.body as {
    scenario_version_id?: unknown;
    params?: unknown;
    workitem_id?: unknown;
  };
  for (const key of Object.keys(body)) {
    if (key !== "scenario_version_id" && key !== "params" && key !== "workitem_id") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  if (typeof body.scenario_version_id !== "string" || !UUID_RE.test(body.scenario_version_id)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_id_required" });
  }
  const scenarioVersionId = body.scenario_version_id;
  // optional workitem_id(1 Workitem = 1 Run, api-surface §1). 형식 검증은 예약 이전, 존재 검증은 작업 tx.
  let workitemId: string | null = null;
  if (body.workitem_id !== undefined && body.workitem_id !== null) {
    if (typeof body.workitem_id !== "string" || !UUID_RE.test(body.workitem_id)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_workitem_id" });
    }
    workitemId = body.workitem_id;
  }
  if (!isRecord(body.params)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  }
  const params = body.params;
  // params.as_of 1회 고정(api-surface §0.6): 명시 시 그 값(엄격 ISO-8601), 미지정 시 서버 생성 시각.
  //   무효 형식은 예약 이전 IR_SCHEMA_INVALID(422)로 거부 — ::timestamptz cast 500 회피("조용한 false 금지").
  let asOf: string;
  if (params.as_of === undefined) {
    asOf = new Date().toISOString();
  } else if (typeof params.as_of === "string" && ISO_8601_RE.test(params.as_of) && !Number.isNaN(Date.parse(params.as_of))) {
    asOf = params.as_of;
  } else {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }

  // (3) 멱등 예약(release-decisions #7).
  const requestHash = canonicalRequestHash("POST", "/v1/runs", request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "createRun",
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

  // (4) reserved → 작업 수행(동일 tx).
  const recordId = reservation.recordId;
  const runId = randomUUID();
  const response: CommandResponse = { status: 201, body: { run_id: runId, status: "queued", as_of: asOf } };
  try {
    await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      // scenario_version 존재 확인(RLS 스코프). 부재 → IR_SCHEMA_INVALID(FK 위반 500 회피).
      const sv = await c.query(`SELECT 1 FROM scenario_versions WHERE id = $1::uuid`, [scenarioVersionId]);
      if (sv.rowCount === 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_not_found" });
      }
      if (workitemId !== null) {
        // workitem 존재 확인(RLS 스코프). 부재/타테넌트 → IR_SCHEMA_INVALID(FK 위반 500 회피).
        const wi = await c.query(`SELECT 1 FROM workitems WHERE id = $1::uuid`, [workitemId]);
        if (wi.rowCount === 0) {
          throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "workitem_not_found" });
        }
      }
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, params, as_of, correlation_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', $5::jsonb, $6::timestamptz, $7::uuid)`,
        [runId, principal.tenantId, scenarioVersionId, workitemId, JSON.stringify(params), asOf, request.correlationId],
      );
      await emitOutboxEvent(c, {
        tenantId: principal.tenantId,
        eventType: "run.created",
        correlationId: request.correlationId,
        runId,
        idempotencyKey: `${runId}:run.created`,
      });
      await deps.enqueuer.enqueueRunClaim(c, {
        tenantId: principal.tenantId,
        runId,
        correlationId: request.correlationId,
      });
      // 멱등 성공 기록을 동일 tx에 원자화(작업 커밋 == 'succeeded' 커밋). 별도 tx 불일치 창 제거.
      await completeIdempotencyInTx(c, recordId, response);
    });
    return response;
  } catch (err) {
    // 결정론적(분류·non-retryable) 실패만 'failed'로 저장 → 동일 키 재요청이 같은 응답을 재생.
    // 미분류/일시(인프라)·retryable 실패는 저장하지 않고 재던진다 → 예약 'processing' 유지(TTL 회수),
    //   클라이언트 at-least-once 재시도는 in-flight(409, retryable)로 안전 진행(api-surface §0.4).
    if (err instanceof ApiResponseError && !ERROR_CATALOG[err.code].retryable) {
      await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
    }
    throw err;
  }
}

/** 분류된 실패(ApiResponseError)를 멱등 레코드에 저장할 ApiError 본문으로 변환. */
function apiErrorBody(err: ApiResponseError, correlationId: string): ApiError {
  const mapped = toApiError(err.code, correlationId, err.details);
  if (isApiErrorResponse(mapped)) {
    return mapped.body;
  }
  // 도달 불가: err.code는 DEAD_LETTER(상태통지)를 타입에서 배제.
  return { code: err.code, message: ERROR_CATALOG[err.code].userMessage, correlation_id: correlationId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
