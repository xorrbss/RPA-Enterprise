import type { ListParams } from "./types-common";

export type ConnectorCatalogKind = "browser" | "api" | "file" | "notification" | "data";
export type CatalogStatus = "available" | "candidate" | "requires_admin" | "blocked";
export type TemplateCatalogKind = "browser_workflow" | "api_workflow" | "file_workflow" | "notification_workflow";
export type ConnectorProfileStatus = "draft" | "security_review" | "certified" | "enabled" | "disabled" | "deprecated";
export type ConnectorCertificationStatus = "security_review" | "certified" | "blocked" | "revoked";
export type ConnectorProfileEnvironment = "dev" | "staging" | "prod";

export interface ConnectorManifestPermissions {
  readonly api: readonly ("migrateSchema" | "registerTargets" | "readConfig")[];
  readonly network: false;
  readonly secret_refs: readonly string[];
}

export interface ConnectorCatalogItem {
  readonly catalog_id: string;
  readonly connector_id: string;
  readonly name: string;
  readonly kind: ConnectorCatalogKind;
  readonly category: string;
  readonly status: CatalogStatus;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly summary: string;
  readonly best_for: readonly string[];
  readonly supported_actions: readonly string[];
  readonly template_ids: readonly string[];
  readonly required_rbac_actions: readonly string[];
  readonly required_secret_refs: readonly string[];
  readonly allowed_domains: readonly string[];
  readonly manifest_permissions: ConnectorManifestPermissions;
  readonly implementation_state: string;
  readonly security_notes: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TemplateCatalogItem {
  readonly catalog_id: string;
  readonly template_id: string;
  readonly connector_id: string;
  readonly name: string;
  readonly kind: TemplateCatalogKind;
  readonly status: CatalogStatus;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly summary: string;
  readonly best_for: readonly string[];
  readonly required_params: readonly string[];
  readonly required_secret_refs: readonly string[];
  readonly produced_ir_pattern: string;
  readonly success_criteria: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectorCatalogListParams extends ListParams {
  readonly kind?: ConnectorCatalogKind;
  readonly status?: CatalogStatus;
}

export interface TemplateCatalogListParams extends ListParams {
  readonly connector_id?: string;
  readonly kind?: TemplateCatalogKind;
  readonly status?: CatalogStatus;
}

export interface ConnectorReceiptSemantics {
  readonly sent: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly accepted: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly delivered: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly completed: "not_applicable" | "metadata_only" | "business_receipt_required";
}

export interface ConnectorCertification {
  readonly certification_id: string;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifest_ref: string | null;
  readonly security_review_ref: string | null;
  readonly test_evidence_ref: string | null;
  readonly owner_evidence_ref: string | null;
  readonly receipt_semantics: ConnectorReceiptSemantics;
  readonly metadata: Record<string, unknown>;
  readonly certified_by: string;
  readonly created_at: string;
}

export interface ConnectorProfile {
  readonly profile_id: string;
  readonly connector_id: string;
  readonly profile_name: string;
  readonly status: ConnectorProfileStatus;
  readonly environment: ConnectorProfileEnvironment;
  readonly secret_refs: readonly string[];
  readonly allowed_hosts: readonly string[];
  readonly owner_ref: string;
  readonly support_owner_ref: string | null;
  readonly profile_metadata: Record<string, unknown>;
  readonly latest_certification: ConnectorCertification | null;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectorProfileListParams extends ListParams {
  readonly connector_id?: string;
  readonly status?: ConnectorProfileStatus;
}

export interface ConnectorProfileCreateRequest {
  readonly connector_id: string;
  readonly profile_name: string;
  readonly environment?: ConnectorProfileEnvironment;
  readonly secret_refs?: readonly string[];
  readonly allowed_hosts?: readonly string[];
  readonly owner_ref: string;
  readonly support_owner_ref?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface ConnectorCertificationRequest {
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifest_ref?: string | null;
  readonly security_review_ref?: string | null;
  readonly test_evidence_ref?: string | null;
  readonly owner_evidence_ref?: string | null;
  readonly receipt_semantics?: ConnectorReceiptSemantics;
  readonly metadata?: Record<string, unknown>;
}
