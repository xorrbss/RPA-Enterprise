import type { FastifyInstance } from "fastify";

import { type ApiServerDeps } from "./server";

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

export function registerCapabilityReadRoutes(app: FastifyInstance, _deps: ApiServerDeps): void {
  app.get("/v1/capabilities", { config: { rbacAction: "site.read" } }, async (_request, reply) => {
    reply.code(200).send(runtimeCapabilitiesFromEnv());
  });
}
