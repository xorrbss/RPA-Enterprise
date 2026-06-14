/**
 * 제어평면 Fastify 부트스트랩 (D4.1).
 *
 * 책임(api-surface.md §0 / d4-prompt §5.1): 얇은 핸들러 + 요청 경계 미들웨어.
 *  1) correlation: x-correlation-id 또는 생성 — ApiError·trace·event 공통 상관키(api-surface §0.2).
 *  2) authenticate: 모든 라우트 인증 필수(api-surface §0.1). 미성립→401, tenant 클레임 부재→403.
 *  3) RLS 바인딩: 모든 DB 작업은 app/src/db/pool.ts의 withTenantTx(pool, principal.tenantId, …) 경유
 *     (SET LOCAL app.tenant_id, FORCE RLS) — cross-tenant row는 보이지 않는다(auth-rbac §3/§4).
 *  4) 에러 매핑: codegen toApiError(error-middleware) 재사용(errors.ts).
 *
 * RBAC(authorize)·경계검증(ajv)·멱등/If-Match·컴파일 파이프라인은 후속 증분(D4.2+)에서 동일 경계에 추가한다.
 * 실행기 의존 e2e는 D3 BLOCKED — 본 계층은 executor 없이 검증 가능한 인증/RLS/에러 경계만 다룬다.
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { AuthenticatedPrincipal, AuthenticationBoundary } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { ApiResponseError, registerErrorHandler } from "./errors";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    principal: AuthenticatedPrincipal | null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiServerDeps {
  pool: Pool;
  auth: AuthenticationBoundary;
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

  registerErrorHandler(app);

  // GET /v1/runs/{run_id} — RLS 스코프 조회. cross-tenant/부재/형식무효 id → RUN_NOT_FOUND(404).
  app.get<{ Params: { run_id: string } }>("/v1/runs/:run_id", async (request) => {
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
