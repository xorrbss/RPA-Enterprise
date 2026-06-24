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
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { buildServer, type ApiServerDeps } from "../src/api/server";
import type { SecurityConfig } from "../src/api/security";
import { createPool } from "../src/db/pool";
import type { ObjectRef, SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ALLOWED_ORIGIN = "http://localhost:5173";
const SECRET = new TextEncoder().encode("d7-security-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};
const noopArtifactReader = {
  async get(_objectRef: ObjectRef) {
    return null;
  },
  async getBytes(_objectRef: ObjectRef) {
    return null;
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

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
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

    // 3) Runtime capability read surface: authenticated + scenario.read, video defaults false unless explicitly configured.
    const viewer = await mint({ sub: "viewer-a", tenant_id: "00000000-0000-4000-8000-0000000000a1", roles: ["viewer"] });
    const capsDefault = buildWith(pool, undefined);
    await capsDefault.ready();
    try {
      const res = await capsDefault.inject({
        method: "GET",
        url: "/v1/scenario-generations/capabilities",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("capabilities default → 200", res.statusCode === 200, res.body);
      check("capabilities default video disabled", res.json().visual_evidence?.video?.enabled === false, res.body);
      check("capabilities default video policies only never", JSON.stringify(res.json().visual_evidence?.video?.policies) === JSON.stringify(["never"]), res.body);
      check("capabilities default video default_policy never", res.json().visual_evidence?.video?.default_policy === "never", res.body);
      check("capabilities default screenshot default_policy each_step", res.json().visual_evidence?.screenshot?.default_policy === "each_step", res.body);

      const readiness = await capsDefault.inject({
        method: "GET",
        url: "/v1/auth/readiness",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("auth readiness default → 200", readiness.statusCode === 200, readiness.body);
      check("auth readiness default marks HS256 as not enterprise SSO", readiness.json().enterprise_sso_ready === false && readiness.json().provider?.mode === "hs256", readiness.body);
      check("auth readiness current principal mapped from JWT", readiness.json().current_principal?.subject_id === "viewer-a", readiness.body);
    } finally {
      await capsDefault.close();
    }

    const ssoReady = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      authReadiness: {
        mode: "jwks",
        configurationSource: "deployment_config",
        jwksUrl: "https://idp.example.com/.well-known/jwks.json",
        issuer: "https://idp.example.com/",
        audience: "rpa-console",
      },
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
      signedCommandRegistry,
    });
    await ssoReady.ready();
    try {
      const readiness = await ssoReady.inject({
        method: "GET",
        url: "/v1/auth/readiness",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("auth readiness JWKS configured → 200", readiness.statusCode === 200, readiness.body);
      check("auth readiness JWKS enterprise ready", readiness.json().enterprise_sso_ready === true && readiness.json().status === "ok", readiness.body);
      check("auth readiness exposes JWKS host only", readiness.json().provider?.jwks_host === "idp.example.com" && !readiness.body.includes("/.well-known/jwks.json"), readiness.body);
      check("auth readiness reports required claim mapping", readiness.json().required_claims?.some((c: { claim?: string; present?: boolean }) => c.claim === "tenant_id" && c.present === true) === true, readiness.body);
    } finally {
      await ssoReady.close();
    }

    const capsVideoWithoutReader = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
      signedCommandRegistry,
      scenarioGenerationCapabilities: { videoRecording: true },
    });
    await capsVideoWithoutReader.ready();
    try {
      const res = await capsVideoWithoutReader.inject({
        method: "GET",
        url: "/v1/scenario-generations/capabilities",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("capabilities video recorder without artifact reader -> 200", res.statusCode === 200, res.body);
      check("capabilities video recorder without artifact reader stays disabled", res.json().visual_evidence?.video?.enabled === false, res.body);
      check("capabilities video recorder without artifact reader policies only never", JSON.stringify(res.json().visual_evidence?.video?.policies) === JSON.stringify(["never"]), res.body);
    } finally {
      await capsVideoWithoutReader.close();
    }

    const capsVideoWithReader = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
      signedCommandRegistry,
      scenarioGenerationCapabilities: { videoRecording: true },
      artifactStore: noopArtifactReader,
      securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
    });
    await capsVideoWithReader.ready();
    try {
      const res = await capsVideoWithReader.inject({
        method: "GET",
        url: "/v1/scenario-generations/capabilities",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("capabilities video enabled with artifact reader -> 200", res.statusCode === 200, res.body);
      check("capabilities video enabled with artifact reader policies", res.json().visual_evidence?.video?.enabled === true && res.body.includes("\"always\""), res.body);
      check("capabilities video enabled with artifact reader default_policy always", res.json().visual_evidence?.video?.default_policy === "always", res.body);
    } finally {
      await capsVideoWithReader.close();
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
