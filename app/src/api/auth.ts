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
import { jwtVerify, type JWTPayload } from "jose";

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

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.has(value);
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

export class JwtAuthenticationBoundary implements AuthenticationBoundary {
  constructor(private readonly verify: JwtVerifier) {}

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

    const tenantClaim = payload.tenant_id;
    if (typeof tenantClaim !== "string" || !UUID_RE.test(tenantClaim)) {
      // 인증은 성립했으나 tenant_id 클레임 부재/형식 무효 → 403(authz, auth-rbac §3). 조용한 통과 금지.
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "missing_or_invalid_tenant_claim" };
    }

    if (!Array.isArray(payload.roles) || payload.roles.some((role) => !isRole(role))) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "invalid_roles_claim" };
    }
    const roles = payload.roles as Role[];
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "missing_or_invalid_subject_claim" };
    }
    const subjectId = payload.sub as PrincipalId;

    const principal: AuthenticatedPrincipal = {
      subjectId,
      tenantId: tenantClaim as TenantId,
      roles,
      source: "jwt",
      claims: payload as Readonly<Record<string, unknown>>,
    };
    return { kind: "authenticated", principal };
  }
}
