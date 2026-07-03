import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { readActiveOffboardingRequest } from "./offboarding-lock";
import { requirePrincipal, type ApiServerDeps } from "./server";

export type SessionCaptureServerMode = "dev" | "off";

export interface RuntimeCapabilities {
  readonly session_capture: {
    readonly server: {
      readonly mode: SessionCaptureServerMode;
      readonly enabled: boolean;
    };
  };
}

export function sessionCaptureServerModeFromEnv(value: string | undefined = process.env.SESSION_CAPTURE_SERVER_MODE): SessionCaptureServerMode {
  return value === "dev" ? "dev" : "off";
}

export function runtimeCapabilitiesFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeCapabilities {
  const mode = sessionCaptureServerModeFromEnv(env.SESSION_CAPTURE_SERVER_MODE);
  return {
    session_capture: {
      server: {
        mode,
        enabled: mode === "dev",
      },
    },
  };
}

export function registerCapabilityReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/capabilities", { config: { rbacAction: "site.read" } }, async (request, reply) => {
    // 오프보딩 상태는 전 역할 가시(전역 배너) — 쓰기 409 의 이유를 운영자도 화면에서 알 수 있어야 한다(설계 O3).
    const principal = requirePrincipal(request);
    const offboarding = await withTenantTx(deps.pool, principal.tenantId, readActiveOffboardingRequest);
    reply.code(200).send({
      ...runtimeCapabilitiesFromEnv(),
      offboarding: {
        active: offboarding !== null,
        status: offboarding?.status ?? null,
        purge_after: offboarding?.purge_after?.toISOString() ?? null,
        request_id: offboarding?.request_id ?? null,
      },
    });
  });
}
