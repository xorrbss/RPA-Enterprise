/**
 * D7 선행 B2/B3 테스트 — 보안 헤더(B3) + opt-in CORS(B2). (security.ts)
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-security.int.ts
 * DB는 건드리지 않는다(401 인증거부·OPTIONS preflight 경로). 풀은 buildServer 의존성으로만 필요.
 *
 * 검증:
 *  - B3: 베이스라인 헤더가 모든 응답(401 포함)에 부착. HSTS는 config.hsts일 때만.
 *  - B2: corsOrigins 미지정 → CORS 비활성(ACAO 없음). 지정 → allowlist origin preflight만 ACAO 반환.
 */
import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer, type ApiServerDeps } from "../src/api/server";
import type { SecurityConfig } from "../src/api/security";
import { createPool } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ALLOWED_ORIGIN = "http://localhost:5173";
const SECRET = new TextEncoder().encode("d7-security-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function buildWith(pool: ReturnType<typeof createPool>, security?: SecurityConfig) {
  const deps: ApiServerDeps = {
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
    security,
  };
  return buildServer(deps);
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    // 1) 보안 config 적용 서버(CORS allowlist + HSTS).
    const secured = buildWith(pool, { corsOrigins: [ALLOWED_ORIGIN], hsts: true });
    await secured.ready();
    try {
      // B3: 미인증 401 응답에도 베이스라인 헤더 부착.
      const unauth = await secured.inject({ method: "GET", url: "/v1/runs" });
      check("401 (no token)", unauth.statusCode === 401, String(unauth.statusCode));
      check("B3 X-Content-Type-Options=nosniff", unauth.headers["x-content-type-options"] === "nosniff", JSON.stringify(unauth.headers));
      check("B3 X-Frame-Options=DENY", unauth.headers["x-frame-options"] === "DENY", "");
      check("B3 Referrer-Policy=no-referrer", unauth.headers["referrer-policy"] === "no-referrer", "");
      check("B3 Cross-Origin-Resource-Policy=same-origin", unauth.headers["cross-origin-resource-policy"] === "same-origin", "");
      check("B3 HSTS present when configured", typeof unauth.headers["strict-transport-security"] === "string", JSON.stringify(unauth.headers["strict-transport-security"]));

      // B2: allowlist origin preflight → ACAO 반환.
      const preflightOk = await secured.inject({
        method: "OPTIONS",
        url: "/v1/runs",
        headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" },
      });
      check("B2 preflight allowed origin → ACAO echoes origin", preflightOk.headers["access-control-allow-origin"] === ALLOWED_ORIGIN, JSON.stringify(preflightOk.headers["access-control-allow-origin"]));

      // B2: disallowed origin preflight → ACAO 없음(또는 origin 불일치).
      const preflightBad = await secured.inject({
        method: "OPTIONS",
        url: "/v1/runs",
        headers: { origin: "http://evil.example", "access-control-request-method": "GET" },
      });
      check("B2 preflight disallowed origin → no ACAO for evil", preflightBad.headers["access-control-allow-origin"] !== "http://evil.example", JSON.stringify(preflightBad.headers["access-control-allow-origin"]));
    } finally {
      await secured.close();
    }

    // 2) 기본 서버(보안 config 미지정) → CORS 비활성, HSTS 없음.
    const plain = buildWith(pool, undefined);
    await plain.ready();
    try {
      const unauth = await plain.inject({ method: "GET", url: "/v1/runs" });
      check("default: baseline headers still present", unauth.headers["x-content-type-options"] === "nosniff", "");
      check("default: no HSTS (not configured)", unauth.headers["strict-transport-security"] === undefined, JSON.stringify(unauth.headers["strict-transport-security"]));
      const preflight = await plain.inject({
        method: "OPTIONS",
        url: "/v1/runs",
        headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" },
      });
      check("default: CORS disabled → no ACAO", preflight.headers["access-control-allow-origin"] === undefined, JSON.stringify(preflight.headers["access-control-allow-origin"]));
    } finally {
      await plain.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D7 B2/B3 security headers + opt-in CORS green");
}

main().catch((err) => {
  console.error("FAIL: security test threw:", err);
  process.exit(1);
});
