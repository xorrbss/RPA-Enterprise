/**
 * 제어평면 JWT 인증 경계 (D4.1).
 *
 * 계약:
 *  - auth-rbac.md §3 / api-surface.md §0.1: tenant_id·roles는 인증 주체(JWT 클레임)에서만 도출한다
 *    (body/query 불신). 인증 미성립(Bearer 토큰 누락/서명 무효/만료) → UNAUTHENTICATED(401);
 *    인증은 성립했으나 tenant_id 클레임 누락/형식 무효 → AUTHZ_FORBIDDEN(403).
 *  - ts/security-middleware-contract.ts: AuthenticationBoundary / AuthBoundaryResult / AuthFailureCode를 구현.
 *
 * 알고리즘은 검증기(JwtVerifier) 주입으로 분리한다 — 경계는 transport/알고리즘 무관(운영은 RS256/JWKS 검증기
 * 주입). v1 기본은 HS256 공유 시크릿. alg 화이트리스트로 alg-confusion/none을 차단한다.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type {
  AuthBoundaryResult,
  AuthenticatedPrincipal,
  AuthenticationBoundary,
  PrincipalId,
  Role,
  TenantId,
} from "../../../ts/security-middleware-contract";

const ROLES: ReadonlySet<string> = new Set<Role>(["viewer", "operator", "reviewer", "approver", "admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JwtClaimMapping {
  readonly subjectClaim: string;
  readonly tenantClaim: string;
  readonly rolesClaim: string;
  readonly expiryClaim: string;
  readonly displayNameClaim: string;
  readonly emailClaim: string;
}

export const DEFAULT_JWT_CLAIM_MAPPING: JwtClaimMapping = {
  subjectClaim: "sub",
  tenantClaim: "tenant_id",
  rolesClaim: "roles",
  expiryClaim: "exp",
  displayNameClaim: "name",
  emailClaim: "email",
};

export type JwtRoleMap = Readonly<Record<string, Role>>;

export interface JwtAuthenticationBoundaryOptions {
  readonly claimMapping?: Partial<JwtClaimMapping>;
  readonly roleMap?: JwtRoleMap;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.has(value);
}

export function normalizeJwtClaimMapping(mapping: Partial<JwtClaimMapping> | undefined): JwtClaimMapping {
  return {
    subjectClaim: nonEmptyClaimPath(mapping?.subjectClaim, DEFAULT_JWT_CLAIM_MAPPING.subjectClaim),
    tenantClaim: nonEmptyClaimPath(mapping?.tenantClaim, DEFAULT_JWT_CLAIM_MAPPING.tenantClaim),
    rolesClaim: nonEmptyClaimPath(mapping?.rolesClaim, DEFAULT_JWT_CLAIM_MAPPING.rolesClaim),
    expiryClaim: nonEmptyClaimPath(mapping?.expiryClaim, DEFAULT_JWT_CLAIM_MAPPING.expiryClaim),
    displayNameClaim: nonEmptyClaimPath(mapping?.displayNameClaim, DEFAULT_JWT_CLAIM_MAPPING.displayNameClaim),
    emailClaim: nonEmptyClaimPath(mapping?.emailClaim, DEFAULT_JWT_CLAIM_MAPPING.emailClaim),
  };
}

function nonEmptyClaimPath(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function readJwtClaim(payload: Readonly<Record<string, unknown>>, claimPath: string): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, claimPath)) return payload[claimPath];
  const parts = claimPath.split(".");
  if (parts.length <= 1 || parts.some((part) => part.length === 0)) return undefined;
  let current: unknown = payload;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    const record = current as Readonly<Record<string, unknown>>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) return undefined;
    current = record[part];
  }
  return current;
}

function normalizeRoles(rawRoles: unknown, roleMap: JwtRoleMap): Role[] | null {
  const values = Array.isArray(rawRoles)
    ? rawRoles
    : typeof rawRoles === "string" && rawRoles.length > 0
      ? [rawRoles]
      : null;
  if (values === null) return null;

  const roles: Role[] = [];
  const seen = new Set<Role>();
  for (const raw of values) {
    if (typeof raw !== "string" || raw.length === 0) return null;
    const mapped = roleMap[raw] ?? raw;
    if (!isRole(mapped)) return null;
    if (!seen.has(mapped)) {
      seen.add(mapped);
      roles.push(mapped);
    }
  }
  return roles;
}

/** 토큰 → 검증된 JWT 클레임. 실패(서명 무효/만료/형식 오류)는 throw(인증 미성립). */
export type JwtVerifier = (token: string) => Promise<JWTPayload>;

/**
 * HS256 공유 시크릿 검증기. alg를 HS256으로 고정해 alg-confusion/`none`을 차단한다.
 * exp를 필수(requiredClaims)로 강제 — exp 없는 토큰은 throw(만료 없는 자격증명의 무한 유효 방지, fail-closed).
 * exp/nbf는 jose가 자동 검증하므로 만료/미래(nbf) 토큰도 throw → UNAUTHENTICATED.
 */
export function hmacJwtVerifier(secret: Uint8Array): JwtVerifier {
  return async (token) => {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    return payload;
  };
}

export interface JwksRs256VerifierOptions {
  /** Absolute https URL of the IdP JWKS endpoint (RS256 public keys). */
  readonly jwksUrl: string;
  /** Optional expected `iss` — when set, jose rejects tokens from other issuers (token-confusion defense). */
  readonly issuer?: string;
  /** Optional expected `aud` — when set, jose rejects tokens minted for another audience. */
  readonly audience?: string;
}

/**
 * RS256/JWKS 검증기 (운영 기본). 원격 JWKS(IdP 공개키)로 서명 검증한다. alg를 RS256으로 고정해
 * alg-confusion/`none`/HS256-혼동을 차단한다. exp를 필수로 강제(만료 없는 토큰 throw, fail-closed); issuer/audience
 * 지정 시 함께 검증한다. JWKS 는 첫 검증 시 lazy-fetch(이 함수 호출=부팅 시점엔 네트워크 호출 없음).
 */
export function jwksRs256Verifier(opts: JwksRs256VerifierOptions): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
      ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    });
    return payload;
  };
}

export class JwtAuthenticationBoundary implements AuthenticationBoundary {
  private readonly claimMapping: JwtClaimMapping;
  private readonly roleMap: JwtRoleMap;

  constructor(
    private readonly verify: JwtVerifier,
    options: JwtAuthenticationBoundaryOptions = {},
  ) {
    this.claimMapping = normalizeJwtClaimMapping(options.claimMapping);
    this.roleMap = options.roleMap ?? {};
  }

  async authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<AuthBoundaryResult> {
    const authorization = headers.authorization;
    if (authorization === undefined || !/^bearer /i.test(authorization)) {
      // 인증 미성립: Bearer 토큰 자체가 없거나 형식 무효 → 401(authn).
      return { kind: "denied", code: "UNAUTHENTICATED", reason: "missing_bearer_authorization" };
    }

    const token = authorization.slice(authorization.indexOf(" ") + 1).trim();
    let payload: JWTPayload;
    try {
      payload = await this.verify(token);
    } catch {
      // 서명 무효/만료/형식 오류 → 인증 미성립 → 401. 내부 사유는 표면화하지 않는다(보안 경계).
      return { kind: "denied", code: "UNAUTHENTICATED", reason: "jwt_verification_failed" };
    }

    const claims = payload as Readonly<Record<string, unknown>>;
    const tenantClaim = readJwtClaim(claims, this.claimMapping.tenantClaim);
    if (typeof tenantClaim !== "string" || !UUID_RE.test(tenantClaim)) {
      // 인증은 성립했으나 tenant_id 클레임 부재/형식 무효 → 403(authz, auth-rbac §3). 조용한 통과 금지.
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "missing_or_invalid_tenant_claim" };
    }

    const roles = normalizeRoles(readJwtClaim(claims, this.claimMapping.rolesClaim), this.roleMap);
    if (roles === null) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "invalid_roles_claim" };
    }
    const subjectClaim = readJwtClaim(claims, this.claimMapping.subjectClaim);
    if (typeof subjectClaim !== "string" || subjectClaim.length === 0) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "missing_or_invalid_subject_claim" };
    }
    const subjectId = subjectClaim as PrincipalId;

    const principal: AuthenticatedPrincipal = {
      subjectId,
      tenantId: tenantClaim as TenantId,
      roles,
      source: "jwt",
      claims,
    };
    return { kind: "authenticated", principal };
  }
}
