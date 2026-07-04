import { DEFAULT_JWT_CLAIM_MAPPING, type JwtClaimMapping, type JwtRoleMap } from "./jwt-claims";
import { assertHttpsUrl, opt, req } from "./env-primitives";

/**
 * JWT verification config. `JWKS_URL` selects the production RS256/JWKS verifier (keys fetched from the IdP);
 * absent ??the v1 HS256 shared-secret default (dev/tests). Each mode is fail-closed on its own required value.
 * RPA_ENV=prod additionally requires issuer and audience so JWKS cannot pass production readiness without
 * token-confusion defenses.
 */
export type ApiJwtConfig =
  | ({ readonly mode: "hs256"; readonly secret: string } & ApiJwtCommonConfig)
  | ({ readonly mode: "jwks"; readonly jwksUrl: string; readonly issuer?: string; readonly audience?: string } & ApiJwtCommonConfig);

interface ApiJwtCommonConfig {
  readonly claimMapping: JwtClaimMapping;
  readonly roleMap: JwtRoleMap;
}

export function loadApiJwtConfig(rpaEnv: string): ApiJwtConfig {
  const claimMapping = loadJwtClaimMapping();
  const roleMap = loadJwtRoleMap();
  const jwksUrl = opt("JWKS_URL");
  if (jwksUrl !== undefined) {
    // RS256/JWKS mode: https-forced (IdP keys must not be fetched over cleartext).
    const issuer = opt("JWT_ISSUER");
    const audience = opt("JWT_AUDIENCE");
    if (rpaEnv.toLowerCase() === "prod") {
      if (issuer === undefined) {
        throw new Error("RPA_ENV=prod with JWKS_URL requires JWT_ISSUER (fail-closed auth readiness)");
      }
      if (audience === undefined) {
        throw new Error("RPA_ENV=prod with JWKS_URL requires JWT_AUDIENCE (fail-closed auth readiness)");
      }
    }
    return {
      mode: "jwks",
      jwksUrl: assertHttpsUrl("JWKS_URL", jwksUrl),
      claimMapping,
      roleMap,
      ...(issuer !== undefined ? { issuer } : {}),
      ...(audience !== undefined ? { audience } : {}),
    };
  }
  // HS256 shared-secret mode (v1 default). Env-sourced ??no `jwt` SecretRef purpose exists in the
  // least-privilege matrix yet (mirrors the gateway key gap, release-decisions D8-A16). Fail-closed required.
  const secret = req("JWT_HS256_SECRET");
  if (secret.length < 32) {
    throw new Error("JWT_HS256_SECRET must be at least 32 characters (HS256 key strength)");
  }
  return { mode: "hs256", secret, claimMapping, roleMap };
}

function loadJwtClaimMapping(): JwtClaimMapping {
  return {
    subjectClaim: opt("JWT_SUBJECT_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.subjectClaim,
    tenantClaim: opt("JWT_TENANT_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.tenantClaim,
    rolesClaim: opt("JWT_ROLES_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.rolesClaim,
    expiryClaim: DEFAULT_JWT_CLAIM_MAPPING.expiryClaim,
    displayNameClaim: opt("JWT_DISPLAY_NAME_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.displayNameClaim,
    emailClaim: opt("JWT_EMAIL_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.emailClaim,
  };
}

const API_JWT_ROLES: ReadonlySet<string> = new Set(["viewer", "operator", "reviewer", "approver", "admin"]);

function loadJwtRoleMap(): JwtRoleMap {
  const raw = opt("JWT_ROLE_MAP");
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JWT_ROLE_MAP must be a JSON object mapping IdP role/group values to RPA roles");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JWT_ROLE_MAP must be a JSON object mapping IdP role/group values to RPA roles");
  }
  const out: Record<string, JwtRoleMap[string]> = {};
  for (const [source, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (source.trim().length === 0) {
      throw new Error("JWT_ROLE_MAP must not contain empty IdP role keys");
    }
    if (typeof target !== "string" || !API_JWT_ROLES.has(target)) {
      throw new Error(`JWT_ROLE_MAP target for ${JSON.stringify(source)} must be one of viewer|operator|reviewer|approver|admin`);
    }
    out[source] = target as JwtRoleMap[string];
  }
  return out;
}
