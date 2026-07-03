/**
 * JWT 클레임 매핑 계약(순수 상수/정규화, R2-3 거처 이동).
 *
 * config/env 가 api/auth 를 역-import 하던 config→api 역전을 끊기 위해 api/auth 에서 분리했다
 * (동작 무변경). auth 경계(JwtAuthenticationBoundary)와 env 파서가 함께 소비하는 단방향 leaf.
 */
import type { Role } from "../../../ts/security-middleware-contract";

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
