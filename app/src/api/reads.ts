/**
 * 운영 콘솔(D7) 조회(read) 라우트 오케스트레이터 — 도메인별 모듈에 위임(D6.5, api-surface §1·§3).
 *
 * 라우트 구현은 도메인 모듈에 있다: reads-runs(run list/summary/steps/artifacts) · reads-people
 * (human-task/principal) · reads-work(workitem/DLQ) · reads-catalog(scenario/gateway/site) ·
 * reads-artifacts(artifact 본문/목록). 도메인 간 공유 leaf 심볼은 reads-support.ts.
 */

import type { FastifyInstance } from "fastify";

import type { ApiServerDeps } from "./server";
import { registerArtifactReadRoutes } from "./reads-artifacts";
import { registerCatalogReadRoutes } from "./reads-catalog";
import { registerPeopleReadRoutes } from "./reads-people";
import { registerRunReadRoutes } from "./reads-runs";
import { registerWorkReadRoutes } from "./reads-work";

export function registerReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  registerRunReadRoutes(app, deps);
  registerPeopleReadRoutes(app, deps);
  registerWorkReadRoutes(app, deps);
  registerCatalogReadRoutes(app, deps);
  registerArtifactReadRoutes(app, deps);
}
