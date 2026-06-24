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

import Fastify, { type FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError, registerErrorHandler } from "./errors";
import { registerDlqRoutes } from "./dlq";
import { registerGatewayRoutes } from "./gateway";
import { registerHumanTaskRoutes } from "./human-tasks";
import { registerReadRoutes } from "./reads";
import { registerPrincipalRoutes } from "./principals";
import { registerSiteElementRoutes } from "./site-elements";
import { registerSiteRoutes } from "./sites";
import { registerSessionRoutes } from "./sessions";
import { registerApprovalRoutes } from "./approvals";
import { registerScenarioGenerationRoutes } from "./scenario-generations";
import { registerScenarioRoutes } from "./scenarios";
import { registerAuditLogRoutes } from "./audit-log";
import { registerAutomationIdeaRoutes } from "./automation-ideas";
import { registerBrowserRecordingRoutes } from "./browser-recordings";
import { registerConnectorCatalogRoutes } from "./connector-catalog";
import { registerDocumentJobRoutes } from "./document-jobs";
import { registerAuthReadinessRoutes } from "./auth-readiness";
import { registerOpsAlertRoutes } from "./ops-alerts";
import { registerOpsHealthRoutes } from "./ops-health";
import { registerBotPoolRoutes } from "./bot-pools";
import { registerRunTriggerRoutes } from "./run-triggers";
import { registerWebhookTriggerRoutes } from "./webhook-triggers";
import { registerSecurity } from "./security";
import {
  normalizeFailureReason,
  requirePrincipal,
  UUID_RE,
  type AuthReadinessConfig,
  type ApiServerDeps,
} from "./server-shared";
import { abortRun } from "./server-abort-run";
import { createRun } from "./server-create-run";

/** RLS 스코프로 조회한 run 상세(api-surface §1 GET /v1/runs/{run_id}). */
interface RunRow {
  id: string;
  status: string;
  scenario_id: string;
  scenario_version_id: string;
  worker_id: string | null;
  attempts: number;
  as_of: Date | null;
  failure_reason: unknown;
  updated_at: Date;
}

export function buildServer(deps: ApiServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, genReqId: () => randomUUID() });

  // B2/B3 보안(헤더 + opt-in CORS) — 라우트/인증 훅보다 먼저 등록해 CORS preflight가 인증보다 앞서 처리되고
  //   베이스라인 헤더가 모든 응답(에러 포함)에 적용된다(D7 분석 §4.3).
  registerSecurity(app, deps.security ?? {});

  app.decorateRequest("correlationId", "");
  app.decorateRequest("principal", null);

  // 1) correlation — 인증보다 먼저 설정되어 거부 응답에도 상관키가 실린다(에러 echo 는 클라이언트 헤더를 그대로 — 추적용).
    //   단 runs.correlation_id 저장(::uuid)은 UUID 만 가능하므로, 비-UUID 헤더의 INSERT-시 22P02→미분류 500 은 저장
    //   시점(createRunInTx)에서 서버 UUID 로 coerce 해 막는다(echo 와 저장의 관심사 분리, review 후속 "조용한 false 금지").
  app.addHook("onRequest", async (request) => {
    const header = request.headers["x-correlation-id"];
    request.correlationId = typeof header === "string" && header.length > 0 ? header : randomUUID();
  });

  // 2) authenticate — 인증 경계 위임(auth.ts). 거부 코드(401/403)를 ApiResponseError로 표면화.
  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.config.skipJwtAuth === true) return;
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

    // 디렉터리 동기화(name-picker): JWT `name` 클레임이 있으면 best-effort upsert. 인증/인가와 무관한 부수효과라
    // 실패해도 요청은 진행하되 조용히 삼키지 않고 log.warn 한다(가정/은폐 금지). directory 미주입 시 no-op.
    if (deps.principalDirectory !== undefined) {
      try {
        await deps.principalDirectory.upsertFromClaims(
          result.principal.tenantId,
          result.principal.subjectId,
          result.principal.claims,
        );
      } catch (err) {
        request.log.warn(
          { err, correlation_id: request.correlationId },
          "principal directory upsert failed (request continues)",
        );
      }
    }
  });

  // 5) authorize(RBAC) — auth 다음(미들웨어 순서 …→rbac→handler). 라우트 선언 rbacAction을 §2 매트릭스로 평가.
  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.config.skipJwtAuth === true) return;
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
        `SELECT r.id, r.status, sv.scenario_id, r.scenario_version_id, r.worker_id, r.attempts, r.as_of, r.failure_reason, r.updated_at
           FROM runs r
           JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
          WHERE r.id = $1::uuid`,
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
      scenario_id: run.scenario_id,
      scenario_version_id: run.scenario_version_id,
      worker_id: run.worker_id,
      attempts: run.attempts,
      as_of: run.as_of !== null ? run.as_of.toISOString() : null,
      failure_reason: normalizeFailureReason(run.failure_reason),
      current_node: null,
      updated_at: run.updated_at.toISOString(),
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

  registerScenarioGenerationRoutes(app, deps);
  registerScenarioRoutes(app, deps);
  registerAutomationIdeaRoutes(app, deps);
  registerAuthReadinessRoutes(app, deps);
  registerRunTriggerRoutes(app, deps);
  registerWebhookTriggerRoutes(app, deps);
  registerHumanTaskRoutes(app, deps);
  registerDlqRoutes(app, deps);
  registerReadRoutes(app, deps);
  registerPrincipalRoutes(app, deps);
  registerSiteRoutes(app, deps);
  registerSiteElementRoutes(app, deps);
  registerBrowserRecordingRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerGatewayRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerAuditLogRoutes(app, deps);
  registerConnectorCatalogRoutes(app, deps);
  registerDocumentJobRoutes(app, deps);
  registerOpsAlertRoutes(app, deps);
  registerOpsHealthRoutes(app, deps);
  registerBotPoolRoutes(app, deps);

  return app;
}

// 분해 전 공개 표면 보존(consumers import from "./server") — server-shared/server-create-run 구현 재노출.
export { requirePrincipal };
export type { ApiServerDeps, AuthReadinessConfig };
export { createRunInTx } from "./server-create-run";
export type { CreateRunInTxInput } from "./server-create-run";
export type { ArtifactObjectReader } from "./server-shared";
