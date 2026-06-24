import type { FastifyInstance } from "fastify";

import type { AuthenticatedPrincipal } from "../../../ts/security-middleware-contract";
import { DEFAULT_JWT_CLAIM_MAPPING, normalizeJwtClaimMapping, readJwtClaim, type JwtClaimMapping } from "./auth";
import { requirePrincipal, type ApiServerDeps, type AuthReadinessConfig } from "./server";

type ReadinessStatus = "ok" | "warning" | "blocked";

interface ClaimReadiness {
  readonly claim: string;
  readonly label: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly mapped_to: string;
}

const DEFAULT_READINESS: AuthReadinessConfig = {
  mode: "hs256",
  configurationSource: "test_default",
  claimMapping: DEFAULT_JWT_CLAIM_MAPPING,
};

export function registerAuthReadinessRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get(
    "/v1/auth/readiness",
    { config: { rbacAction: "principal.read" } },
    async (request) => authReadinessResponse(requirePrincipal(request), deps.authReadiness ?? DEFAULT_READINESS),
  );
}

function authReadinessResponse(principal: AuthenticatedPrincipal, config: AuthReadinessConfig) {
  const claimMapping = normalizeJwtClaimMapping(config.claimMapping);
  const roleMapEntries = Object.keys(config.roleMap ?? {}).length;
  const issuerConfigured = nonEmpty(config.issuer);
  const audienceConfigured = nonEmpty(config.audience);
  const jwksConfigured = config.mode === "jwks" && nonEmpty(config.jwksUrl);
  const enterpriseSsoReady = config.mode === "jwks" && jwksConfigured && issuerConfigured && audienceConfigured;
  const gaps = readinessGaps(config, { jwksConfigured, issuerConfigured, audienceConfigured });

  return {
    status: readinessStatus(enterpriseSsoReady, gaps),
    enterprise_sso_ready: enterpriseSsoReady,
    provider: {
      mode: config.mode,
      configuration_source: config.configurationSource,
      algorithm: config.mode === "jwks" ? "RS256" : "HS256",
      jwks_url_configured: jwksConfigured,
      jwks_host: jwksHost(config.jwksUrl),
      issuer_configured: issuerConfigured,
      issuer: config.issuer ?? null,
      audience_configured: audienceConfigured,
      audience: config.audience ?? null,
    },
    claim_mapping: {
      subject_claim: claimMapping.subjectClaim,
      tenant_claim: claimMapping.tenantClaim,
      roles_claim: claimMapping.rolesClaim,
      expiry_claim: claimMapping.expiryClaim,
      display_name_claim: claimMapping.displayNameClaim,
      email_claim: claimMapping.emailClaim,
    },
    role_mapping: {
      configured: roleMapEntries > 0,
      mapped_values: roleMapEntries,
    },
    required_claims: claimReadiness(principal, claimMapping),
    current_principal: {
      subject_id: principal.subjectId,
      tenant_id: principal.tenantId,
      roles: principal.roles,
      source: principal.source,
      display_name: stringClaim(principal, claimMapping.displayNameClaim),
      email: stringClaim(principal, claimMapping.emailClaim),
    },
    operational_gaps: gaps,
  };
}

function readinessStatus(ready: boolean, gaps: readonly string[]): ReadinessStatus {
  if (ready) return "ok";
  return gaps.length > 0 ? "warning" : "blocked";
}

function readinessGaps(
  config: AuthReadinessConfig,
  readiness: { readonly jwksConfigured: boolean; readonly issuerConfigured: boolean; readonly audienceConfigured: boolean },
): string[] {
  const gaps: string[] = [];
  if (config.mode === "hs256") {
    gaps.push("운영 SSO 검증을 위해 RS256/JWKS 모드가 필요합니다.");
  }
  if (config.mode === "jwks" && !readiness.jwksConfigured) {
    gaps.push("IdP 공개키 JWKS 엔드포인트가 설정되지 않았습니다.");
  }
  if (!readiness.issuerConfigured) {
    gaps.push("토큰 발급자(issuer) 검증이 설정되지 않았습니다.");
  }
  if (!readiness.audienceConfigured) {
    gaps.push("토큰 대상(audience) 검증이 설정되지 않았습니다.");
  }
  return gaps;
}

function claimReadiness(principal: AuthenticatedPrincipal, mapping: JwtClaimMapping): ClaimReadiness[] {
  const claims = principal.claims;
  const rolesValue = readJwtClaim(claims, mapping.rolesClaim);
  return [
    { claim: mapping.subjectClaim, label: "처리자 식별", required: true, present: typeof readJwtClaim(claims, mapping.subjectClaim) === "string", mapped_to: "current_principal.subject_id" },
    { claim: mapping.tenantClaim, label: "테넌트 경계", required: true, present: typeof readJwtClaim(claims, mapping.tenantClaim) === "string", mapped_to: "current_principal.tenant_id" },
    { claim: mapping.rolesClaim, label: "역할 매핑", required: true, present: Array.isArray(rolesValue) || typeof rolesValue === "string", mapped_to: "current_principal.roles" },
    { claim: mapping.expiryClaim, label: "만료 시간", required: true, present: typeof readJwtClaim(claims, mapping.expiryClaim) === "number", mapped_to: "인증 만료 검증" },
    { claim: mapping.displayNameClaim, label: "표시 이름", required: false, present: typeof readJwtClaim(claims, mapping.displayNameClaim) === "string", mapped_to: "담당자 디렉터리 표시명" },
    { claim: mapping.emailClaim, label: "이메일", required: false, present: typeof readJwtClaim(claims, mapping.emailClaim) === "string", mapped_to: "담당자 디렉터리 이메일" },
  ];
}

function stringClaim(principal: AuthenticatedPrincipal, key: string): string | null {
  const value = readJwtClaim(principal.claims, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function jwksHost(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
