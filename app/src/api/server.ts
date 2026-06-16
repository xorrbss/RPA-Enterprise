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
import type { Pool, PoolClient } from "pg";

import { isApiErrorResponse, toApiError } from "../../../codegen/error-middleware";
import type { ObjectRef } from "../../../ts/core-types";
import type { ControlPlaneIdempotencyStore } from "../../../ts/control-plane-contract";
import { ERROR_CATALOG, type ApiError } from "../../../ts/error-catalog";
import type {
  AuthenticatedPrincipal,
  AuthenticationBoundary,
  CanonicalRequestHash,
  IdempotencyKey,
  RbacAction,
  RbacMiddleware,
  SignedCommandRegistry,
} from "../../../ts/security-middleware-contract";
import type { RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "../runtime/outbox";
import { applyRunTransition } from "../runtime/run-transition";
import { ApiResponseError, registerErrorHandler } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import { registerDlqRoutes } from "./dlq";
import { registerGatewayRoutes } from "./gateway";
import { registerHumanTaskRoutes } from "./human-tasks";
import { registerReadRoutes } from "./reads";
import { registerSiteRoutes } from "./sites";
import type { RunEnqueuer } from "./run-queue";
import { registerScenarioRoutes } from "./scenarios";
import { registerSecurity, type SecurityConfig } from "./security";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    principal: AuthenticatedPrincipal | null;
  }
  // 라우트별 RBAC 액션 선언(auth-rbac §2). RBAC preHandler가 이 값으로 authorize를 호출한다.
  interface FastifyContextConfig {
    rbacAction?: RbacAction;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 엄격 ISO-8601(date-time). Date.parse는 느슨하고 calendar-invalid 값을 보정하므로 직접 검증한다(api-surface §0.6).
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * artifact 본문 read 경계(narrow — api는 byte-store 구현에 의존하지 않는다, 단방향 의존).
 * `FsObjectStore`(로컬/CI) 등 ObjectStore 구현이 구조적으로 충족. 실 분산 object-store(S3) 바인딩은
 * deploy-time(B3, release-decisions D8-A1) — 미지정 시 GET /v1/artifacts 라우트는 미등록(조회 capability 미노출).
 */
export interface ArtifactObjectReader {
  get(objectRef: ObjectRef): Promise<string>;
}

export interface ApiServerDeps {
  pool: Pool;
  auth: AuthenticationBoundary;
  rbac: RbacMiddleware;
  idempotency: ControlPlaneIdempotencyStore;
  enqueuer: RunEnqueuer;
  signedCommandRegistry: SignedCommandRegistry;
  /** B2/B3 보안 인프라(선택). 미지정 시 베이스라인 헤더만 적용하고 CORS는 비활성(same-origin). */
  security?: SecurityConfig;
  /** artifact 본문 read 경계(선택). 미지정 시 GET /v1/artifacts/{id} 미등록(D8-A1 — 실 object-store 바인딩 deploy-time). */
  artifactStore?: ArtifactObjectReader;
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

  // B2/B3 보안(헤더 + opt-in CORS) — 라우트/인증 훅보다 먼저 등록해 CORS preflight가 인증보다 앞서 처리되고
  //   베이스라인 헤더가 모든 응답(에러 포함)에 적용된다(D7 분석 §4.3).
  registerSecurity(app, deps.security ?? {});

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

  // POST /v1/runs/{run_id}/abort — 실행 중단 명령(멱등, api-surface §1). 어휘 체인: abort→aborting→cancelled→
  //   run.cancelled→"취소됨". running/suspended/resume_requested/resuming은 abort_requested→aborting(D2 전이,
  //   run.cancelled는 worker가 R23/R24 drain 후 발행). queued/claimed는 run.started 이전이라 dispatcher CAS로
  //   취소+run.cancelled. completing은 R25 거부, 종결 상태는 RUN_ALREADY_TERMINAL.
  app.post<{ Params: { run_id: string } }>(
    "/v1/runs/:run_id/abort",
    { config: { rbacAction: "run.abort" } },
    async (request, reply) => {
      const result = await abortRun(deps, request.params.run_id, request);
      reply.code(result.status).send(result.body);
    },
  );

  registerScenarioRoutes(app, deps);
  registerHumanTaskRoutes(app, deps);
  registerDlqRoutes(app, deps);
  registerReadRoutes(app, deps);
  registerSiteRoutes(app, deps);
  registerGatewayRoutes(app, deps);

  return app;
}

export function requirePrincipal(request: FastifyRequest): AuthenticatedPrincipal {
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
  } else if (typeof params.as_of === "string" && isStrictIsoDateTime(params.as_of)) {
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
        const existingRun = await c.query(`SELECT 1 FROM runs WHERE workitem_id = $1::uuid LIMIT 1`, [workitemId]);
        if (existingRun.rowCount !== 0) {
          throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "workitem_run_exists" });
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
        retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
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
    const apiErr = classifyRunCreateFailure(err);
    // 결정론적(분류·non-retryable) 실패만 'failed'로 저장 → 동일 키 재요청이 같은 응답을 재생.
    // 미분류/일시(인프라)·retryable 실패는 저장하지 않고 재던진다 → 예약 'processing' 유지(TTL 회수),
    //   클라이언트 at-least-once 재시도는 in-flight(409, retryable)로 안전 진행(api-surface §0.4).
    if (apiErr !== undefined) {
      if (shouldPersistRunCreateFailure(apiErr)) {
        await deps.idempotency.saveFailure(recordId, apiErrorBody(apiErr, request.correlationId));
      }
      throw apiErr;
    }
    throw err;
  }
}

/** state-machine §1: Run 종결 상태 — abort 거부(RUN_ALREADY_TERMINAL). */
const RUN_TERMINAL_SET: ReadonlySet<RunState> = new Set<RunState>([
  "completed",
  "cancelled",
  "failed_business",
  "failed_system",
]);

/**
 * Run abort 명령(멱등). 흐름: 형식/키 선검사 → 멱등 예약 이전 상태 선검사(부재/종결/completing/suspending은
 * 부작용 없는 거부라 키 미소모) → 예약 → 작업 tx에서 상태별 적용(dispatcher 취소 또는 abort_requested 전이,
 * CAS 경합은 재조회). 결정론적 비-retryable 실패만 saveFailure로 영속(동일 키 재요청이 같은 응답 재생).
 */
async function abortRun(deps: ApiServerDeps, runId: string, request: FastifyRequest): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  // 형식 무효 id는 존재할 수 없다 → 404(존재 비노출, FK/cast 500 회피).
  if (!UUID_RE.test(runId)) {
    throw new ApiResponseError("RUN_NOT_FOUND");
  }

  // body: optional reason만 허용(닫힌 shape). reason은 v1 비영속(runs에 컬럼 없음) — 수신만 허용.
  if (request.body !== undefined && request.body !== null) {
    if (!isRecord(request.body) || Object.keys(request.body).some((k) => k !== "reason")) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_abort_request" });
    }
    if (request.body.reason !== undefined && typeof request.body.reason !== "string") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_abort_reason" });
    }
  }

  // Idempotency-Key 필수(api-surface §0.4). 누락 → 422(예약 이전, 키 소모 없음).
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  // 예약 이전 선검사: 부작용 없는 거부 경로(부재/종결/completing/suspending)는 멱등 키를 소모하지 않는다.
  // suspending은 bookmark-cancel port/durable abort intent가 없으므로 retry-after-suspended로 fail-closed한다.
  const requestHash = canonicalRequestHash("POST", `/v1/runs/${runId}/abort`, request.body ?? null);
  const existingIdempotency = await readAbortIdempotencyExisting(
    deps.pool,
    principal.tenantId,
    idempotencyKey,
    requestHash,
  );
  if (existingIdempotency.kind === "replay") {
    return existingIdempotency.response;
  }
  if (existingIdempotency.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  if (existingIdempotency.kind === "none") {
    const preStatus = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const r = await c.query<{ status: RunState }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
      return r.rows[0]?.status ?? null;
    });
    rejectIfNotAbortable(preStatus);
  }

  // (부작용 명령) → 멱등 예약(release-decisions #7).
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "abortRun",
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
    return await withTenantTx(deps.pool, principal.tenantId, (c) =>
      applyAbort(c, deps.enqueuer, principal.tenantId, runId, request.correlationId, recordId),
    );
  } catch (err) {
    // 결정론적(비-retryable) 실패만 'failed'로 저장 → 동일 키 재요청이 같은 응답을 재생.
    // retryable(경합/transient)은 저장하지 않고 재던진다(예약 'processing' 유지, TTL 회수).
    if (err instanceof ApiResponseError && !ERROR_CATALOG[err.code].retryable) {
      await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
    }
    throw err;
  }
}

/** abort 불가 상태를 명시적으로 거부한다(조용한 false 금지). 적용 가능 상태면 반환 없이 통과. */
type ExistingAbortIdempotency =
  | { kind: "none" }
  | { kind: "processing" }
  | { kind: "blocked" }
  | { kind: "replay"; response: CommandResponse };

async function readAbortIdempotencyExisting(
  pool: Pool,
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ExistingAbortIdempotency> {
  return withTenantTx(pool, tenantId, async (client) => {
    const existing = await client.query<{
      request_hash: string;
      status: "processing" | "succeeded" | "failed";
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, status, response_status, response_body
         FROM control_plane_idempotency_keys
        WHERE tenant_id=$1::uuid
          AND endpoint='abortRun'
          AND idempotency_key=$2`,
      [tenantId, idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) return { kind: "none" };
    if (row.request_hash !== requestHash) return { kind: "blocked" };
    if (row.status === "processing") return { kind: "processing" };
    if (row.response_status === null || row.response_body === null) {
      throw new Error(`abortRun idempotency record is ${row.status} without stored response`);
    }
    return { kind: "replay", response: { status: row.response_status, body: row.response_body } };
  });
}

function rejectIfNotAbortable(status: RunState | null): void {
  if (status === null) {
    // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
    throw new ApiResponseError("RUN_NOT_FOUND");
  }
  if (RUN_TERMINAL_SET.has(status) || status === "completing") {
    // 종결 + completing(R25: finalize 우선, abort 거부) → RUN_ALREADY_TERMINAL.
    throw new ApiResponseError("RUN_ALREADY_TERMINAL", { status });
  }
  if (status === "suspending") {
    // R26: bookmark 취소 가능 여부(runtime guard)는 제어평면이 알 수 없다(가정 금지). suspending은 bookmark
    //   저장 중 전이 상태로 곧 suspended 도달 → 거기서 R16이 무조건 abort 가능. retryable 충돌로 재시도 유도
    //   (release-decisions #7의 in-flight와 동일한 retryable 409 코드 재사용).
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "run_bookmark_in_progress", status });
  }
}

/**
 * 작업 tx 내 abort 적용. 예약 이전 선검사 이후 상태가 바뀌었을 수 있어 재조회 후 CAS로 경합을 해소한다.
 *  - aborting: 이미 진행 중 → 202(idempotent).
 *  - queued/claimed: run.started 이전 → dispatcher CAS 취소 + 동일 tx run.cancelled.
 *  - running/suspended/resume_requested/resuming: abort_requested → aborting(D2 전이; run.cancelled는 worker).
 */
function isAbortSourceStatus(status: RunState | null): status is "running" | "suspended" | "resume_requested" | "resuming" {
  return status === "running" || status === "suspended" || status === "resume_requested" || status === "resuming";
}

async function applyAbort(
  client: PoolClient,
  enqueuer: RunEnqueuer,
  tenantId: string,
  runId: string,
  requestCorrelationId: string,
  recordId: string,
): Promise<CommandResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cur = await client.query<{
      status: RunState;
      correlation_id: string | null;
      worker_id: string | null;
      abort_source_status: RunState | null;
    }>(
      `SELECT status, correlation_id::text AS correlation_id, worker_id::text AS worker_id, abort_source_status
         FROM runs
        WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [runId, tenantId],
    );
    const row = cur.rows[0] ?? null;
    rejectIfNotAbortable(row?.status ?? null);
    if (row === null) {
      throw new ApiResponseError("RUN_NOT_FOUND");
    }
    const status = row.status;
    // run.cancelled는 run 생명주기 이벤트 → runs.correlation_id 사용(R23/R24 worker 경로와 일치).
    const correlationId = row?.correlation_id ?? requestCorrelationId;

    if (status === "aborting") {
      if (!isAbortSourceStatus(row.abort_source_status)) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "run_abort_missing_source_status" });
      }
      await enqueuer.enqueueRunAbort(client, { tenantId, runId, correlationId });
      const response: CommandResponse = { status: 202, body: { run_id: runId, status: "aborting" } };
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    }

    if (status === "queued" || status === "claimed") {
      // (id,status) CAS로 큐/claim 회수(state-machine §1 "abort 보편성"). 0 rows면 경합 → 재조회.
      const cancelled = await client.query(
        `UPDATE runs SET status='cancelled', updated_at=now(), ended_at=now()
          WHERE id=$1::uuid AND tenant_id=$2::uuid AND status=$3
        RETURNING id`,
        [runId, tenantId, status],
      );
      if (cancelled.rowCount === 0) continue;
      if (status === "claimed") {
        await expireClaimedAbortBrowserLease(client, tenantId, runId, row.worker_id);
      }
      await emitOutboxEvent(client, {
        tenantId,
        eventType: "run.cancelled",
        correlationId,
        runId,
        idempotencyKey: `${runId}:run.cancelled`,
        retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
      });
      const response: CommandResponse = { status: 202, body: { run_id: runId, status: "cancelled" } };
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    }

    // running/suspended/resume_requested/resuming → abort_requested → aborting.
    const outcome = await applyRunTransition(client, {
      tenantId,
      runId,
      fromStatus: status,
      event: { type: "abort_requested" },
      guard: {},
      correlationId,
    });
    if (!outcome.applied) continue; // cas_conflict → 재조회
    if (!isAbortDrainPending(status, outcome.pending)) {
      throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
        reason: "run_abort_pending_side_effects_unsupported",
        pending: pendingSideEffectKinds(outcome.pending),
      });
    }
    const sourceRecorded = await client.query(
      `UPDATE runs
          SET abort_source_status = $3
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'aborting'`,
      [tenantId, runId, status],
    );
    if (sourceRecorded.rowCount !== 1) {
      throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "run_abort_source_record_failed" });
    }
    await enqueuer.enqueueRunAbort(client, { tenantId, runId, correlationId });
    const response: CommandResponse = { status: 202, body: { run_id: runId, status: outcome.next } };
    await completeIdempotencyInTx(client, recordId, response);
    return response;
  }
  // CAS 경합 3회 — 조용한 false 금지: 재시도 가능 충돌로 표면화.
  throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "run_abort_cas_contention" });
}

async function expireClaimedAbortBrowserLease(
  client: PoolClient,
  tenantId: string,
  runId: string,
  workerId: string | null,
): Promise<void> {
  if (workerId === null) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "claimed_abort_missing_worker_id" });
  }

  const expired = await client.query<{ id: string }>(
    `UPDATE browser_leases
        SET state = 'expired',
            expires_at = LEAST(expires_at, now())
      WHERE tenant_id = $1::uuid
        AND run_id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')
      RETURNING id::text`,
    [tenantId, runId, workerId],
  );
  if (expired.rowCount !== 1) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
      reason: expired.rowCount === 0 ? "claimed_abort_missing_active_browser_lease" : "claimed_abort_multiple_active_browser_leases",
    });
  }
}

function pendingSideEffectKinds(pending: readonly { readonly kind: string }[]): string[] {
  return pending.map((cmd) => cmd.kind);
}

function isAbortDrainPending(sourceStatus: RunState, pending: readonly { readonly kind: string }[]): boolean {
  if (sourceStatus === "running" || sourceStatus === "resuming") {
    return (
      pending.length === 2 &&
      pending.some((cmd) => cmd.kind === "sseClose") &&
      pending.some((cmd) => cmd.kind === "browserDrain")
    );
  }
  if (sourceStatus === "suspended" || sourceStatus === "resume_requested") {
    return pending.length === 0;
  }
  return false;
}

function classifyRunCreateFailure(error: unknown): ApiResponseError | undefined {
  if (error instanceof ApiResponseError) return error;
  if (
    isPgUniqueViolation(error) &&
    typeof error.constraint === "string" &&
    error.constraint === "idx_runs_one_per_workitem"
  ) {
    return new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "workitem_run_exists" });
  }
  return undefined;
}

function shouldPersistRunCreateFailure(error: ApiResponseError): boolean {
  return (
    !ERROR_CATALOG[error.code].retryable ||
    (error.code === "WORKITEM_CHECKOUT_CONFLICT" && hasReason(error.details, "workitem_run_exists"))
  );
}

function hasReason(details: unknown, reason: string): boolean {
  return typeof details === "object" && details !== null && "reason" in details && details.reason === reason;
}

function isPgUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isStrictIsoDateTime(value: string): boolean {
  const match = ISO_8601_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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
