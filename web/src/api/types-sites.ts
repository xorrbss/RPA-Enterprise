import type { ListParams } from "./types-common";

// 자격증명 동시성 정책 가시화(D5) — 사이트·자격증명별 max_concurrency 와 현재 사용량(활성 lease 수).
export interface ConcurrencyPolicy {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: number;
  // DG-4 메타(가시성): 표시명·마지막 등록자·등록 시각. 값(시크릿) 아님.
  readonly label?: string | null;
  readonly registered_by?: string | null;
  readonly registered_at?: string;
  readonly status?: "active" | "deprecated" | "revoked";
  readonly owner_sub?: string | null;
  readonly scope?: "site";
  readonly rotation_policy?: "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
  readonly rotated_at?: string | null;
  readonly last_used_at?: string | null;
  readonly deprecated_at?: string | null;
  readonly revoked_at?: string | null;
  readonly replaced_by_credential_ref?: string | null;
}

// DG-4 자격증명 *참조* 등록 요청/응답 — ⛔ 시크릿 값 필드 없음(SecretRef 경로 식별자 + 한도만). 값은 out-of-band(Vault/KMS).
export interface CredentialBindingRequest {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly max_concurrency: number;
  readonly label?: string;
  readonly owner_sub?: string;
  readonly rotation_policy?: "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
}

export interface CredentialBindingResult {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly max_concurrency: number;
  readonly status?: "active" | "deprecated" | "revoked";
  readonly owner_sub?: string | null;
  readonly scope?: "site";
  readonly rotation_policy?: "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
}

export interface CredentialRotateRequest {
  readonly credential_ref: string;
  readonly new_credential_ref: string;
  readonly site_profile_id: string;
  readonly max_concurrency?: number;
  readonly label?: string;
  readonly rotation_policy?: "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
  readonly reason?: string;
}

export interface CredentialRotateResult {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly status: "deprecated";
  readonly replaced_by_credential_ref: string;
  readonly replacement: CredentialBindingResult;
}

export interface CredentialDecommissionRequest {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly reason?: string;
}

export interface CredentialDecommissionResult {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly status: "revoked";
}

export interface SiteItem {
  readonly site_profile_id: string;
  readonly risk: string;
  // pending | approved | expired(기간 한정 승인 만료 — 런타임 게이트 복귀, 재승인 필요)
  readonly approval_status: string;
  readonly approved_by?: string | null;
  readonly approved_at?: string | null;
  readonly approval_expires_at?: string | null;
  readonly circuit_status: string;
  readonly name?: string;
  readonly url_pattern?: string;
  // 운영자-보조 세션 캡처 가능 여부(reads.ts 투영). loginUrl 설정 사이트만 '세션 등록' 노출.
  readonly login_capable?: boolean;
  readonly session_ready?: boolean;
  readonly session_expires_at?: string | null;
  readonly enc_kid?: string | null;
  readonly default_browser_identity_id?: string | null;
  readonly default_network_policy_id?: string | null;
  readonly page_state_summary?: SitePageStateSummary;
  readonly page_state_selectors?: unknown | null;
}

// GET /v1/sites/{id}/approvals — 승인 이력(불변 감사 원장) 행.
export interface SiteApprovalItem {
  readonly approved_by: string;
  readonly reason: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
}

export interface SitePageStateSummary {
  readonly configured: boolean;
  readonly login_url_configured: boolean;
  readonly authenticated_selector_configured: boolean;
  readonly flag_count: number;
  readonly flags: readonly string[];
}

export interface SitePageStateUpdateResult {
  readonly site_profile_id: string;
  readonly page_state_selectors: unknown | null;
  readonly page_state_summary: SitePageStateSummary;
}

export interface RuntimeCapabilities {
  readonly session_capture?: {
    readonly server?: {
      readonly mode?: "dev" | "off";
      readonly enabled?: boolean;
    };
  };
  /** 오프보딩 원장 활성 상태(O3 전역 배너) — 전 역할 가시. 잠금(쓰기 409)의 이유를 화면에서 설명한다. */
  readonly offboarding?: {
    readonly active?: boolean;
    readonly status?: "pending" | "approved" | "purging" | null;
    readonly purge_after?: string | null;
    readonly request_id?: string | null;
  };
}

export type SiteElementType = "button" | "input" | "link" | "table" | "row" | "field" | "message" | "other";
export type SiteElementStability = "stable" | "review_needed" | "broken";
export type SiteElementConfidence = "high" | "medium" | "low" | "unknown";
export type SiteElementSource = "manual" | "pbd" | "capture" | "imported";

export interface SiteElementItem {
  readonly element_id: string;
  readonly site_profile_id: string;
  readonly element_key: string;
  readonly label: string;
  readonly selector: string;
  readonly element_type: SiteElementType;
  readonly stability: SiteElementStability;
  readonly confidence?: SiteElementConfidence;
  readonly source: SiteElementSource;
  readonly sample_url: string | null;
  readonly last_probe_result?: unknown;
  readonly notes: string | null;
  readonly usage_count: number;
  readonly last_verified_at: string | null;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SiteElementListParams extends ListParams {
  readonly site_profile_id?: string;
  readonly stability?: SiteElementStability;
  readonly search?: string;
}

export interface SiteElementCreateBody {
  readonly element_key: string;
  readonly label: string;
  readonly selector: string;
  readonly element_type?: SiteElementType;
  readonly stability?: SiteElementStability;
  readonly source?: SiteElementSource;
  readonly sample_url?: string;
  readonly notes?: string;
}

export interface SiteElementUpdateBody {
  readonly label?: string;
  readonly selector?: string;
  readonly element_type?: SiteElementType;
  readonly stability?: SiteElementStability;
  readonly sample_url?: string | null;
  readonly notes?: string | null;
}

export type SiteElementProbeStatus = "matched" | "not_found" | "invalid_selector" | "failed" | "not_run";

export interface SiteElementProbeRequest {
  readonly sample_url?: string;
}

export interface SiteElementProbeResponse {
  readonly element_id: string;
  readonly site_profile_id: string;
  readonly selector: string;
  readonly sample_url: string | null;
  readonly probe_status: SiteElementProbeStatus;
  readonly match_count: number | null;
  readonly reason_code: string | null;
  readonly checked_at: string;
  readonly element: SiteElementItem;
}

export interface SiteElementDeleteResult {
  readonly element_id: string;
  readonly deleted: boolean;
}

export type CaptureSessionStatus = "launching" | "awaiting_login" | "capturing" | "captured" | "failed" | "expired";

export interface CaptureSessionItem {
  readonly capture_session_id: string;
  readonly status: CaptureSessionStatus;
  readonly detail: string | null;
  readonly updated_at: string;
}

// POST /v1/sites response. New sites include default run target IDs for generation prefill.
export interface SiteCreateResult {
  readonly site_profile_id: string;
  readonly name: string;
  readonly url_pattern: string;
  readonly risk: string;
  readonly approved: boolean;
  readonly default_browser_identity_id: string;
  readonly default_network_policy_id: string;
}
