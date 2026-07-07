/**
 * /v1/bot-pools HTTP 표면 — 브라우저 실행 풀 상태 조회. 집계·health 판정은 runtime/bot-pool-read.
 */
import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { readBrowserBotPool } from "../runtime/bot-pool-read";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

export function registerBotPoolRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/bot-pools", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const item = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readBrowserBotPool(client, principal.tenantId),
    );
    reply.code(200).send({ items: [item], next_cursor: null });
  });
}
