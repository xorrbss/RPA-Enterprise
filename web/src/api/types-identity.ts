/**
 * 테넌트 담당자 디렉터리 항목(principals 테이블). 배정값은 `sub`(PrincipalId=JWT sub, 자유형)이고 `display_name`은
 * picker 표시이름. `principal_id`는 surrogate uuid(커서/식별), `source`는 쓰기 경로(jwt|manual). 자유 입력 폴백은 유지
 * (디렉터리 미등록 sub도 직접 배정 가능).
 */
export interface PrincipalItem {
  readonly principal_id: string;
  readonly sub: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly source: "jwt" | "manual" | "scim";
  readonly external_id: string | null;
  readonly idp_provider: string | null;
  readonly lifecycle_source: "local" | "jwt" | "scim";
}

export type RoleAssignmentRole = "viewer" | "operator" | "reviewer" | "approver" | "admin";

export type ScimProviderSecretRotationPolicy = "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";

export type ScimProviderRotationStatus = "manual" | "current" | "due_soon" | "overdue" | "decommissioned";

export interface ScimProviderItem {
  readonly provider_id: string;
  readonly provider_key: string;
  readonly display_name: string;
  readonly status: "active" | "disabled";
  readonly inbound_schema_ref: "scim-principal@1";
  readonly auth_mode: "signed_request_v1";
  readonly signature_secret_ref: string;
  readonly secret_rotation_policy: ScimProviderSecretRotationPolicy;
  readonly rotation_due_at: string | null;
  readonly rotation_status: ScimProviderRotationStatus;
  readonly clock_skew_seconds: number;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_secret_rotated_at: string | null;
  readonly last_secret_rotated_by: string | null;
  readonly decommissioned_at: string | null;
  readonly decommissioned_by: string | null;
  readonly decommission_reason: string | null;
}

export interface ScimProviderCreateBody {
  readonly provider_key: string;
  readonly display_name: string;
  readonly signature_secret_ref: string;
  readonly secret_rotation_policy?: ScimProviderSecretRotationPolicy;
  readonly clock_skew_seconds?: number;
}

export interface ScimProviderUpdateBody {
  readonly display_name?: string;
  readonly status?: "active" | "disabled";
  readonly signature_secret_ref?: string;
  readonly secret_rotation_policy?: ScimProviderSecretRotationPolicy;
  readonly clock_skew_seconds?: number;
}

export interface ScimProviderDecommissionBody {
  readonly reason: string;
}

export interface ScimProviderDecommissionResult {
  readonly provider: ScimProviderItem;
  readonly disabled_mappings: number;
  readonly revoked_assignments: number;
}

export interface ScimGroupRoleMappingItem {
  readonly mapping_id: string;
  readonly provider_key: string;
  readonly external_group: string;
  readonly role: RoleAssignmentRole;
  readonly status: "active" | "disabled";
  readonly description: string | null;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type ScimGroupRoleMappingImportMode = "upsert_only" | "replace_active";

export interface ScimGroupRoleMappingImportEntry {
  readonly external_group: string;
  readonly role: RoleAssignmentRole;
  readonly description?: string | null;
}

export interface ScimGroupRoleMappingImportBody {
  readonly mode: ScimGroupRoleMappingImportMode;
  readonly mappings: readonly ScimGroupRoleMappingImportEntry[];
}

export interface ScimGroupRoleMappingImportResult {
  readonly provider_key: string;
  readonly mode: ScimGroupRoleMappingImportMode;
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly disabled: number;
  readonly items: readonly ScimGroupRoleMappingItem[];
}

export interface RoleAssignmentItem {
  readonly assignment_id: string;
  readonly principal_sub: string;
  readonly role: RoleAssignmentRole;
  readonly source: "manual" | "scim";
  readonly external_id: string | null;
  readonly idp_provider: string | null;
  readonly lifecycle_source: "local" | "scim";
  readonly status: "active" | "revoked";
  readonly reason: string | null;
  readonly expires_at: string | null;
  readonly granted_by: string;
  readonly granted_at: string;
  readonly revoked_by: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type AuthReadinessStatus = "ok" | "warning" | "blocked";

export interface AuthReadiness {
  readonly status: AuthReadinessStatus;
  readonly enterprise_sso_ready: boolean;
  readonly provider: {
    readonly mode: "hs256" | "jwks";
    readonly configuration_source: "deployment_config" | "test_default";
    readonly algorithm: "HS256" | "RS256";
    readonly jwks_url_configured: boolean;
    readonly jwks_host: string | null;
    readonly issuer_configured: boolean;
    readonly issuer: string | null;
    readonly audience_configured: boolean;
    readonly audience: string | null;
  };
  readonly claim_mapping: {
    readonly subject_claim: string;
    readonly tenant_claim: string;
    readonly roles_claim: string;
    readonly expiry_claim: string;
    readonly display_name_claim: string;
    readonly email_claim: string;
  };
  readonly role_mapping: {
    readonly configured: boolean;
    readonly mapped_values: number;
  };
  readonly required_claims: readonly {
    readonly claim: string;
    readonly label: string;
    readonly required: boolean;
    readonly present: boolean;
    readonly mapped_to: string;
  }[];
  readonly current_principal: {
    readonly subject_id: string;
    readonly tenant_id: string;
    readonly roles: readonly string[];
    readonly source: "jwt" | "session";
    readonly display_name: string | null;
    readonly email: string | null;
  };
  readonly operational_gaps: readonly string[];
}
