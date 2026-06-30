import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

type ConnectorKind = "browser" | "api" | "file" | "notification" | "data";
type CatalogStatus = "available" | "candidate" | "requires_admin" | "blocked";
type TemplateKind = "browser_workflow" | "api_workflow" | "file_workflow" | "notification_workflow";
type ConnectorProfileStatus = "draft" | "security_review" | "certified" | "enabled" | "disabled" | "deprecated";
type ConnectorCertificationStatus = "security_review" | "certified" | "blocked" | "revoked";
type ConnectorEnvironment = "dev" | "staging" | "prod";

interface ConnectorCatalogItem {
  catalog_id: string;
  connector_id: string;
  name: string;
  kind: ConnectorKind;
  category: string;
  status: CatalogStatus;
  priority: "P0" | "P1" | "P2" | "P3";
  summary: string;
  best_for: readonly string[];
  supported_actions: readonly string[];
  template_ids: readonly string[];
  required_rbac_actions: readonly string[];
  required_secret_refs: readonly string[];
  allowed_domains: readonly string[];
  manifest_permissions: {
    api: readonly ("migrateSchema" | "registerTargets" | "readConfig")[];
    network: false;
    secret_refs: readonly string[];
  };
  implementation_state: string;
  security_notes: readonly string[];
  created_at: string;
  updated_at: string;
}

interface TemplateCatalogItem {
  catalog_id: string;
  template_id: string;
  connector_id: string;
  name: string;
  kind: TemplateKind;
  status: CatalogStatus;
  priority: "P0" | "P1" | "P2" | "P3";
  summary: string;
  best_for: readonly string[];
  required_params: readonly string[];
  required_secret_refs: readonly string[];
  produced_ir_pattern: string;
  success_criteria: string;
  created_at: string;
  updated_at: string;
}

interface ConnectorProfile {
  readonly profile_id: string;
  readonly connector_id: string;
  readonly profile_name: string;
  readonly status: ConnectorProfileStatus;
  readonly environment: ConnectorEnvironment;
  readonly secret_refs: readonly string[];
  readonly allowed_hosts: readonly string[];
  readonly owner_ref: string;
  readonly support_owner_ref: string | null;
  readonly profile_metadata: Readonly<Record<string, unknown>>;
  readonly latest_certification: ConnectorCertification | null;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ConnectorCertification {
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
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly certified_by: string;
  readonly created_at: string;
}

interface ConnectorReceiptSemantics {
  readonly sent: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly accepted: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly delivered: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly completed: "not_applicable" | "metadata_only" | "business_receipt_required";
}

interface ConnectorProfileRow {
  readonly id: string;
  readonly connector_id: string;
  readonly profile_name: string;
  readonly status: ConnectorProfileStatus;
  readonly environment: ConnectorEnvironment;
  readonly secret_refs: string[];
  readonly allowed_hosts: string[];
  readonly owner_ref: string;
  readonly support_owner_ref: string | null;
  readonly profile_metadata: Readonly<Record<string, unknown>>;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly cursor_at: string;
  readonly certification_id: string | null;
  readonly certification_status: ConnectorCertificationStatus | null;
  readonly certification_reason: string | null;
  readonly manifest_ref: string | null;
  readonly security_review_ref: string | null;
  readonly test_evidence_ref: string | null;
  readonly owner_evidence_ref: string | null;
  readonly receipt_semantics: ConnectorReceiptSemantics | null;
  readonly certification_metadata: Readonly<Record<string, unknown>> | null;
  readonly certified_by: string | null;
  readonly certified_at: Date | null;
}

interface ConnectorCertificationRow {
  readonly id: string;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifest_ref: string | null;
  readonly security_review_ref: string | null;
  readonly test_evidence_ref: string | null;
  readonly owner_evidence_ref: string | null;
  readonly receipt_semantics: ConnectorReceiptSemantics;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly certified_by: string;
  readonly created_at: Date;
}

interface ConnectorProfileCreateInput {
  readonly connectorId: string;
  readonly profileName: string;
  readonly environment: ConnectorEnvironment;
  readonly secretRefs: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly ownerRef: string;
  readonly supportOwnerRef: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface ConnectorCertificationInput {
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifestRef: string | null;
  readonly securityReviewRef: string | null;
  readonly testEvidenceRef: string | null;
  readonly ownerEvidenceRef: string | null;
  readonly receiptSemantics: ConnectorReceiptSemantics;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const CONNECTORS: readonly ConnectorCatalogItem[] = [
  {
    catalog_id: "91000000-0000-4000-8000-000000000001",
    connector_id: "sap-web",
    name: "SAP Web / ERP Portal",
    kind: "browser",
    category: "ERP",
    status: "candidate",
    priority: "P0",
    summary: "Browser-first SAP and ERP portal automation templates for list extraction, approvals, and evidence capture.",
    best_for: ["order inquiry", "invoice status", "approval portal", "master data lookup"],
    supported_actions: ["navigate", "act", "extract", "verify", "human_task"],
    template_ids: ["sap-web-list-extract", "sap-web-approval-check"],
    required_rbac_actions: ["connector.read", "site.read", "scenario.create"],
    required_secret_refs: ["secret://<env>/connector/sap-web/*"],
    allowed_domains: ["*.sap.example.com", "*.erp.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<env>/connector/sap-web/*"] },
    implementation_state: "browser template pack for approved web portals",
    security_notes: ["Credential values stay behind the secure credential store.", "Red-site execution still requires site approval."],
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000002",
    connector_id: "http-api",
    name: "HTTP API",
    kind: "api",
    category: "Integration",
    status: "requires_admin",
    priority: "P0",
    summary: "Approved HTTP integration template metadata for browser RPA workflows using secure bearer credentials.",
    best_for: ["system-to-system lookup", "status update", "webhook dispatch"],
    supported_actions: ["api_call", "verify"],
    template_ids: ["http-api-status-check"],
    required_rbac_actions: ["connector.read", "connector.enable"],
    required_secret_refs: ["secret://<env>/connector/http-api/*"],
    allowed_domains: ["api.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<env>/connector/http-api/*"] },
    implementation_state: "HTTP API P1 supports approved bearer-token profiles; basic auth, mTLS, and OAuth profiles require a future connector profile contract",
    security_notes: ["Do not store Authorization headers in template payloads.", "Bearer tokens resolve behind the secure credential boundary.", "Enable/install must append a connector security audit decision."],
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000007",
    connector_id: "managed-idp-scim",
    name: "Managed IdP SCIM",
    kind: "api",
    category: "Identity",
    status: "requires_admin",
    priority: "P0",
    summary: "Metadata-only setup templates for managed IdP SCIM provider registration, group-role import, and decommission evidence.",
    best_for: ["SCIM provider onboarding", "IdP group-to-role reconciliation", "provider retirement evidence"],
    supported_actions: ["scim_provider_register", "scim_group_role_import", "scim_provider_decommission"],
    template_ids: ["managed-idp-scim-provider-registration", "managed-idp-scim-group-role-import", "managed-idp-scim-provider-decommission"],
    required_rbac_actions: ["connector.read", "scim.sync"],
    required_secret_refs: ["secret://<tenant>/scim/<provider_key>/signing"],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<tenant>/scim/<provider_key>/signing"] },
    implementation_state: "SCIM P1 uses /v1/scim/providers, group-role mapping import, and signed inbound scim-principal@1; no outbound IdP network connector is required.",
    security_notes: [
      "Provider signing material stays behind SecretStore and is referenced only by signature_secret_ref.",
      "Inbound SCIM sync resolves the signing SecretRef through connectorId=scim:<provider_key>.",
      "External group semantics are not inferred; only repo-owned group-role mapping rows are trusted.",
    ],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000008",
    connector_id: "existing-rpa-handoff",
    name: "Existing RPA handoff profiles",
    kind: "api",
    category: "Federation",
    status: "requires_admin",
    priority: "P1",
    summary: "Metadata-only provider profiles for UiPath, Automation Anywhere, Power Automate, and Blue Prism handoff ledgers; not direct vendor API/OAuth connectors.",
    best_for: ["external RPA job handoff", "provider receipt capture", "coexistence migration", "desktop automation federation"],
    supported_actions: ["handoff_request", "dispatch_attempt", "receipt_record", "provider_callback"],
    template_ids: [
      "uipath-handoff-provider-profile",
      "automation-anywhere-handoff-provider-profile",
      "power-automate-handoff-provider-profile",
      "blue-prism-handoff-provider-profile",
    ],
    required_rbac_actions: ["connector.read", "integration.handoff"],
    required_secret_refs: ["secret://<tenant>/integration/<provider_alias>/callback-url", "secret://<tenant>/integration/<provider_alias>/callback-signing", "secret://<tenant>/integration/<provider_alias>/dispatch-endpoint"],
    allowed_domains: [],
    manifest_permissions: {
      api: ["readConfig"],
      network: false,
      secret_refs: ["secret://<tenant>/integration/<provider_alias>/callback-url", "secret://<tenant>/integration/<provider_alias>/callback-signing", "secret://<tenant>/integration/<provider_alias>/dispatch-endpoint"],
    },
    implementation_state: "P1 metadata-only integration handoff ledger, dispatch attempt ledger, SecretRef-backed dispatch, and provider receipt/callback capture are implemented; vendor API/OAuth, queue mapping, and endpoint ownership remain owner/provider decisions.",
    security_notes: [
      "The catalog exposes provider aliases and SecretRef namespaces only, never raw vendor endpoints, OAuth clients, tokens, or resolved SecretRef material.",
      "Create remains side-effect free; accepted means provider receipt/2xx acceptance, not business completion.",
      "Vendor-specific API and OAuth behavior must be approved by the owner/provider before any tenant enables a profile.",
    ],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000003",
    connector_id: "excel-csv",
    name: "Excel / CSV Browser Files",
    kind: "file",
    category: "Office",
    status: "candidate",
    priority: "P1",
    summary: "Browser download/upload file workflow templates for CSV and spreadsheet-like exports.",
    best_for: ["report download", "bulk upload", "reconciliation file"],
    supported_actions: ["navigate", "act", "extract", "artifact"],
    template_ids: ["browser-report-download"],
    required_rbac_actions: ["connector.read", "artifact.read", "scenario.create"],
    required_secret_refs: [],
    allowed_domains: ["reports.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "browser artifact workflow for report download and upload",
    security_notes: ["Downloaded artifacts remain behind artifact redaction/RBAC gates."],
    created_at: "2026-06-21T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000006",
    connector_id: "document-idp",
    name: "Document IDP (Browser Artifacts)",
    kind: "file",
    category: "Document Automation",
    status: "candidate",
    priority: "P1",
    summary: "Built-in deterministic document extraction and validation templates for redaction-visible browser artifacts.",
    best_for: ["invoice review", "contract field check", "browser-downloaded evidence", "validation queue"],
    supported_actions: ["artifact", "extract", "human_task", "verify"],
    template_ids: ["document-idp-validation"],
    required_rbac_actions: ["connector.read", "artifact.read", "human_task.read", "scenario.create"],
    required_secret_refs: [],
    allowed_domains: ["reports.example.com", "vendor.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "P1 engine: built_in_deterministic_text_v1 over redaction-visible text/CSV/JSON artifacts; OCR and image decoding require a future document adapter",
    security_notes: [
      "Document bytes stay inside the tenant boundary in P1.",
      "Artifact body access still uses the existing artifact redaction, RBAC, and audit gates.",
      "Binary OCR/PDF image decoding remains behind a future document adapter contract.",
    ],
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000004",
    connector_id: "ops-webhook-sender",
    name: "Ops webhook sender",
    kind: "notification",
    category: "Notification",
    status: "available",
    priority: "P1",
    summary: "Implemented SecretRef-backed generic HTTPS webhook sender for ops alerts with metadata-only attempt and provider receipt/callback ledgers.",
    best_for: ["failure alert webhook", "HITL escalation webhook", "SLA risk notification"],
    supported_actions: ["notify", "receipt_record", "provider_callback"],
    template_ids: ["ops-failure-alert"],
    required_rbac_actions: ["connector.read", "ops_alert.deliver"],
    required_secret_refs: ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"] },
    implementation_state: "Implemented: /v1/ops-alerts/{alert_id}/deliveries/send-webhook queues durable SecretRef-backed webhook attempts; /v1/ops-alerts/{alert_id}/deliveries and /v1/webhooks/ops-alerts/{tenant_id}/{attempt_id} record metadata-only receipts/callbacks.",
    security_notes: [
      "Webhook URLs are secrets and remain SecretRef-only; endpoint URLs, tokens, Authorization headers, provider response bodies, and resolved SecretRef material are not catalog data.",
      "HTTP 2xx webhook responses are sent evidence, not delivered evidence.",
      "Teams/Slack/email/PagerDuty/ServiceNow-specific auth, recipient resolution, and delivery receipt semantics remain owner/provider decisions.",
    ],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000009",
    connector_id: "slack-notification-candidate",
    name: "Slack notification profile candidate",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Provider-specific Slack notification profile candidate. Generic webhook sending may target a SecretRef endpoint, but Slack app/OAuth/auth, channel ownership, and delivery receipts require owner/provider evidence.",
    best_for: ["Slack ops channel review", "owner-approved Slack alert route"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before Slack-specific auth mode, route ownership, recipient/channel resolution, or delivery receipt semantics can be approved",
    security_notes: ["Do not store Slack webhook URLs, bot tokens, app secrets, channel rosters, or resolved SecretRef material in the catalog."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000010",
    connector_id: "teams-notification-candidate",
    name: "Teams notification profile candidate",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Provider-specific Microsoft Teams notification profile candidate. Generic webhook sending may target a SecretRef endpoint, but Teams app/auth, channel ownership, and delivery receipts require owner/provider evidence.",
    best_for: ["Teams ops channel review", "owner-approved Teams alert route"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before Teams-specific auth mode, route ownership, recipient/channel resolution, or delivery receipt semantics can be approved",
    security_notes: ["Do not store Teams webhook URLs, app secrets, channel rosters, or resolved SecretRef material in the catalog."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000011",
    connector_id: "email-notification-candidate",
    name: "Email notification profile candidate",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Provider-specific email notification profile candidate. SMTP/OAuth/auth, recipient-group expansion, and delivery/bounce receipts require owner/provider evidence.",
    best_for: ["email escalation review", "owner-approved mailing route"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before email provider auth, recipient-group resolution, bounce handling, or delivery receipt semantics can be approved",
    security_notes: ["Do not store SMTP passwords, OAuth clients/secrets, raw recipient rosters, message bodies, or resolved SecretRef material in the catalog."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000012",
    connector_id: "pagerduty-notification-candidate",
    name: "PagerDuty incident profile candidate",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Provider-specific PagerDuty incident profile candidate. Incident routing keys, escalation policy ownership, and accepted/resolved receipt semantics require owner/provider evidence.",
    best_for: ["incident escalation review", "owner-approved PagerDuty route"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before PagerDuty-specific auth, escalation policy mapping, incident ownership, or incident receipt semantics can be approved",
    security_notes: ["Do not store PagerDuty routing keys, tokens, escalation rosters, incident payload bodies, or resolved SecretRef material in the catalog."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000013",
    connector_id: "servicenow-notification-candidate",
    name: "ServiceNow incident profile candidate",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Provider-specific ServiceNow incident profile candidate. Instance ownership, auth, incident field mapping, and accepted/resolved receipt semantics require owner/provider evidence.",
    best_for: ["ITSM incident review", "owner-approved ServiceNow route"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before ServiceNow-specific auth, table/field mapping, assignment routing, or incident receipt semantics can be approved",
    security_notes: ["Do not store ServiceNow usernames/passwords, OAuth secrets, raw incident payloads, assignment rosters, or resolved SecretRef material in the catalog."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000005",
    connector_id: "database-read",
    name: "Database Read",
    kind: "data",
    category: "Data",
    status: "blocked",
    priority: "P2",
    summary: "Database read connector candidate for planning. Enable only after browser-scope exception approval.",
    best_for: ["reference lookup", "reconciliation", "audit evidence join"],
    supported_actions: ["query"],
    template_ids: [],
    required_rbac_actions: ["connector.read", "connector.enable"],
    required_secret_refs: ["secret://<env>/connector/database-read/*"],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<env>/connector/database-read/*"] },
    implementation_state: "blocked by browser-scope decision; no approved browser execution surface",
    security_notes: ["Requires explicit backend approval and secure credential storage before enablement."],
    created_at: "2026-06-19T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
];

const TEMPLATES: readonly TemplateCatalogItem[] = [
  {
    catalog_id: "92000000-0000-4000-8000-000000000001",
    template_id: "sap-web-list-extract",
    connector_id: "sap-web",
    name: "SAP list extract",
    kind: "browser_workflow",
    status: "candidate",
    priority: "P0",
    summary: "Open an ERP list page, apply filters, extract rows, and retain redacted evidence.",
    best_for: ["invoice status", "purchase order list", "delivery list"],
    required_params: ["entry_url", "filter_text", "max_pages"],
    required_secret_refs: ["secret://<env>/connector/sap-web/*"],
    produced_ir_pattern: "navigate -> act(filter) -> loop(extract rows) -> verify(row_count)",
    success_criteria: "At least one row is extracted or a deterministic empty-state flag is observed.",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000002",
    template_id: "sap-web-approval-check",
    connector_id: "sap-web",
    name: "SAP approval check",
    kind: "browser_workflow",
    status: "candidate",
    priority: "P1",
    summary: "Check a web approval queue and route ambiguous decisions to human-task validation.",
    best_for: ["approval queue", "exception review", "four-eyes check"],
    required_params: ["entry_url", "document_id"],
    required_secret_refs: ["secret://<env>/connector/sap-web/*"],
    produced_ir_pattern: "navigate -> extract approval fields -> human_task(validation) when ambiguous",
    success_criteria: "A decision field is extracted or a validation human task is opened.",
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000003",
    template_id: "browser-report-download",
    connector_id: "excel-csv",
    name: "Browser report download",
    kind: "file_workflow",
    status: "candidate",
    priority: "P1",
    summary: "Navigate to a report page, download a CSV export, and keep it as a redaction-gated artifact.",
    best_for: ["daily report", "reconciliation export", "settlement file"],
    required_params: ["entry_url", "report_name"],
    required_secret_refs: [],
    produced_ir_pattern: "navigate -> act(download) -> artifact(receipt) -> verify(download_complete)",
    success_criteria: "A download artifact is recorded with a redaction status of redacted or not_required.",
    created_at: "2026-06-21T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000006",
    template_id: "document-idp-validation",
    connector_id: "document-idp",
    name: "Document field validation",
    kind: "file_workflow",
    status: "candidate",
    priority: "P1",
    summary: "Extract configured fields from browser-captured text/CSV/JSON artifacts and open a validation task when confidence is low.",
    best_for: ["invoice fields", "contract metadata", "approval evidence", "manual correction loop"],
    required_params: ["source_artifact_id", "document_type", "field_schema"],
    required_secret_refs: [],
    produced_ir_pattern: "browser artifact -> deterministic_text_v1 extract -> human_task(validation) for low confidence",
    success_criteria: "Required fields are extracted or a business_form_v1 validation task is opened with artifact references.",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000004",
    template_id: "http-api-status-check",
    connector_id: "http-api",
    name: "HTTP status check",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P0",
    summary: "Approved API status lookup template for result verification.",
    best_for: ["status lookup", "case enrichment", "API handoff"],
    required_params: ["endpoint_url", "method", "request_schema_ref"],
    required_secret_refs: ["secret://<env>/connector/http-api/*"],
    produced_ir_pattern: "api_call -> verify(http_status)",
    success_criteria: "A configured 2xx HTTP status is observed; response-schema validation requires a future connector profile contract.",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000007",
    template_id: "managed-idp-scim-provider-registration",
    connector_id: "managed-idp-scim",
    name: "SCIM provider registration",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P0",
    summary: "Register a managed IdP SCIM provider with SecretRef-only signing metadata and a closed rotation policy.",
    best_for: ["new IdP tenant onboarding", "SCIM signing key registration", "provider readiness evidence"],
    required_params: ["provider_key", "display_name", "signature_secret_ref", "secret_rotation_policy", "clock_skew_seconds"],
    required_secret_refs: ["secret://<tenant>/scim/<provider_key>/signing"],
    produced_ir_pattern: "POST /v1/scim/providers -> provider rotation evidence",
    success_criteria: "A provider row is created with auth_mode=signed_request_v1 and only signature_secret_ref is exposed.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000008",
    template_id: "managed-idp-scim-group-role-import",
    connector_id: "managed-idp-scim",
    name: "SCIM group-role import",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P0",
    summary: "Bulk import or reconcile opaque IdP groups to closed RPA roles through the repo-owned mapping ledger.",
    best_for: ["group mapping bootstrap", "periodic access review", "IdP-to-RPA role reconciliation"],
    required_params: ["provider_key", "mode", "mappings"],
    required_secret_refs: [],
    produced_ir_pattern: "POST /v1/scim/providers/{provider_key}/group-role-mappings/import",
    success_criteria: "The response reports imported, updated, unchanged, and disabled mapping counts without inferring external group semantics.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000009",
    template_id: "managed-idp-scim-provider-decommission",
    connector_id: "managed-idp-scim",
    name: "SCIM provider decommission",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P1",
    summary: "Disable a retired IdP provider, disable active mappings, and revoke active SCIM-managed assignments with audit evidence.",
    best_for: ["IdP tenant retirement", "provider migration cleanup", "access revocation evidence"],
    required_params: ["provider_key", "reason"],
    required_secret_refs: [],
    produced_ir_pattern: "POST /v1/scim/providers/{provider_key}/decommission",
    success_criteria: "The provider is disabled and the response records disabled_mappings and revoked_assignments counts.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000010",
    template_id: "uipath-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "UiPath handoff provider profile",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P1",
    summary: "Metadata-only UiPath handoff alias/profile template for the existing RPA ledger. It does not implement UiPath API/OAuth or queue semantics.",
    best_for: ["UiPath Orchestrator coexistence", "queue handoff evidence", "signed provider receipt capture"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/uipath/callback-url", "secret://<tenant>/integration/uipath/callback-signing", "secret://<tenant>/integration/uipath/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "Handoff creation stays deferred, dispatch can only record accepted, and completed requires UiPath receipt/callback evidence supplied by the owner/provider profile.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000011",
    template_id: "automation-anywhere-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "Automation Anywhere handoff provider profile",
    kind: "api_workflow",
    status: "candidate",
    priority: "P1",
    summary: "Metadata-only Automation Anywhere handoff alias/profile template. Direct Control Room API/OAuth integration remains owner/provider scope.",
    best_for: ["Automation Anywhere coexistence", "Control Room job evidence", "external bot receipt capture"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/automation-anywhere/callback-url", "secret://<tenant>/integration/automation-anywhere/callback-signing", "secret://<tenant>/integration/automation-anywhere/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "The profile records only metadata and receipt state; real Automation Anywhere API/OAuth behavior is not claimed until the owner/provider contract is approved.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000012",
    template_id: "power-automate-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "Power Automate handoff provider profile",
    kind: "api_workflow",
    status: "candidate",
    priority: "P1",
    summary: "Metadata-only Power Automate handoff alias/profile template. Direct cloud flow/desktop flow API/OAuth integration remains owner/provider scope.",
    best_for: ["Power Automate coexistence", "cloud flow handoff evidence", "external flow receipt capture"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/power-automate/callback-url", "secret://<tenant>/integration/power-automate/callback-signing", "secret://<tenant>/integration/power-automate/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "The profile records only metadata and receipt state; real Power Automate API/OAuth behavior is not claimed until the owner/provider contract is approved.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000013",
    template_id: "blue-prism-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "Blue Prism handoff provider profile",
    kind: "api_workflow",
    status: "candidate",
    priority: "P1",
    summary: "Metadata-only Blue Prism handoff alias/profile template. Direct Control Room/API/OAuth integration remains owner/provider scope.",
    best_for: ["Blue Prism coexistence", "Control Room work queue evidence", "external process receipt capture"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/blue-prism/callback-url", "secret://<tenant>/integration/blue-prism/callback-signing", "secret://<tenant>/integration/blue-prism/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "The profile records only metadata and receipt state; real Blue Prism API/OAuth behavior is not claimed until the owner/provider contract is approved.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000005",
    template_id: "ops-failure-alert",
    connector_id: "ops-webhook-sender",
    name: "Ops failure alert",
    kind: "notification_workflow",
    status: "available",
    priority: "P1",
    summary: "SecretRef-backed generic webhook notification pattern for failed runs, SLA risk, and human task timeout escalation.",
    best_for: ["run failure webhook", "SLA risk webhook", "human-task timeout webhook"],
    required_params: ["severity", "message_template", "endpoint_secret_ref", "route_policy_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"],
    produced_ir_pattern: "ops event -> /v1/ops-alerts alert -> webhook send attempt -> receipt ledger",
    success_criteria: "A webhook attempt is queued and records sent/failed metadata; delivered requires provider receipt/callback evidence and is not inferred from console ack.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
];

const CONNECTOR_KIND_SET: Record<ConnectorKind, true> = {
  browser: true,
  api: true,
  file: true,
  notification: true,
  data: true,
};

const STATUS_SET: Record<CatalogStatus, true> = {
  available: true,
  candidate: true,
  requires_admin: true,
  blocked: true,
};

const PROFILE_STATUS_SET: Record<ConnectorProfileStatus, true> = {
  draft: true,
  security_review: true,
  certified: true,
  enabled: true,
  disabled: true,
  deprecated: true,
};

const TEMPLATE_KIND_SET: Record<TemplateKind, true> = {
  browser_workflow: true,
  api_workflow: true,
  file_workflow: true,
  notification_workflow: true,
};

function enumFilter<T extends string>(raw: unknown, set: Record<T, true>, reason: string): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(set, raw)) return raw as T;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function textFilter(raw: unknown, reason: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function orderByCreated<Item extends { created_at: string; catalog_id: string }>(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => {
    const byDate = b.created_at.localeCompare(a.created_at);
    return byDate !== 0 ? byDate : b.catalog_id.localeCompare(a.catalog_id);
  });
}

export function registerConnectorCatalogRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/connectors", { config: { rbacAction: "connector.read" } }, async (request, reply) => {
    requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const kind = enumFilter(query.kind, CONNECTOR_KIND_SET, "invalid_connector_kind");
    const status = enumFilter(query.status, STATUS_SET, "invalid_catalog_status");

    const rows = orderByCreated(CONNECTORS)
      .filter((item) => kind === undefined || item.kind === kind)
      .filter((item) => status === undefined || item.status === status)
      .filter((item) => cursor === null || (item.created_at < cursor.createdAt || (item.created_at === cursor.createdAt && item.catalog_id < cursor.id)))
      .slice(0, limit + 1);

    reply.code(200).send(paginate(rows, limit, (item) => ({ createdAt: item.created_at, id: item.catalog_id }), (item) => item));
  });

  app.get("/v1/templates", { config: { rbacAction: "connector.read" } }, async (request, reply) => {
    requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const kind = enumFilter(query.kind, TEMPLATE_KIND_SET, "invalid_template_kind");
    const status = enumFilter(query.status, STATUS_SET, "invalid_catalog_status");
    const connectorId = textFilter(query.connector_id, "invalid_connector_id");

    const rows = orderByCreated(TEMPLATES)
      .filter((item) => kind === undefined || item.kind === kind)
      .filter((item) => status === undefined || item.status === status)
      .filter((item) => connectorId === undefined || item.connector_id === connectorId)
      .filter((item) => cursor === null || (item.created_at < cursor.createdAt || (item.created_at === cursor.createdAt && item.catalog_id < cursor.id)))
      .slice(0, limit + 1);

    reply.code(200).send(paginate(rows, limit, (item) => ({ createdAt: item.created_at, id: item.catalog_id }), (item) => item));
  });

  app.get("/v1/connector-profiles", { config: { rbacAction: "connector.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const connectorId = textFilter(query.connector_id, "invalid_connector_id");
    const status = enumFilter(query.status, PROFILE_STATUS_SET, "invalid_connector_profile_status");
    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listConnectorProfiles(client, principal.tenantId, limit, cursor, connectorId, status),
    );
    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapConnectorProfile));
  });

  app.post("/v1/connector-profiles", { config: { rbacAction: "connector.enable" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseConnectorProfileCreateRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "createConnectorProfile",
      "/v1/connector-profiles",
      async (client, tenantId) => {
        const item = await insertConnectorProfile(client, tenantId, principal.subjectId, body);
        return { status: 201, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.post<{ Params: { profile_id: string } }>(
    "/v1/connector-profiles/:profile_id/certifications",
    { config: { rbacAction: "connector.enable" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const profileId = parseUuid(request.params.profile_id, "profile_id");
      const body = parseConnectorCertificationRequest(request.body);
      const response = await runIdempotentCommand(
        deps,
        request,
        "certifyConnectorProfile",
        `/v1/connector-profiles/${profileId}/certifications`,
        async (client, tenantId) => {
          const item = await insertConnectorCertification(client, tenantId, profileId, principal.subjectId, body);
          return { status: 201, body: item };
        },
      );
      reply.code(response.status).send(response.body);
    },
  );
}

async function listConnectorProfiles(
  client: PoolClient,
  tenantId: string,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  connectorId: string | undefined,
  status: ConnectorProfileStatus | undefined,
): Promise<ConnectorProfileRow[]> {
  const values: unknown[] = [tenantId];
  const where = ["p.tenant_id = $1::uuid"];
  if (connectorId !== undefined) {
    values.push(connectorId);
    where.push(`p.connector_id = $${values.length}`);
  }
  if (status !== undefined) {
    values.push(status);
    where.push(`p.status = $${values.length}`);
  }
  if (cursor !== null) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(p.updated_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await client.query<ConnectorProfileRow>(
    `SELECT p.id, p.connector_id, p.profile_name, p.status, p.environment,
            p.secret_refs, p.allowed_hosts, p.owner_ref, p.support_owner_ref,
            p.profile_metadata, p.created_by, p.updated_by,
            p.created_at, p.updated_at, p.updated_at::text AS cursor_at,
            c.id AS certification_id,
            c.status AS certification_status,
            c.reason AS certification_reason,
            c.manifest_ref,
            c.security_review_ref,
            c.test_evidence_ref,
            c.owner_evidence_ref,
            c.receipt_semantics,
            c.metadata AS certification_metadata,
            c.certified_by,
            c.created_at AS certified_at
       FROM connector_profiles p
       LEFT JOIN connector_certifications c
         ON c.tenant_id = p.tenant_id
        AND c.id = p.latest_certification_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

async function insertConnectorProfile(
  client: PoolClient,
  tenantId: string,
  actor: string,
  input: ConnectorProfileCreateInput,
): Promise<ConnectorProfile> {
  const catalogItem = findConnector(input.connectorId);
  assertConnectorProfileAllowed(catalogItem);
  if (catalogItem.required_secret_refs.length > 0 && input.secretRefs.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_profile_secret_ref_required", connector_id: input.connectorId });
  }
  const result = await client.query<ConnectorProfileRow>(
    `INSERT INTO connector_profiles
       (id, tenant_id, connector_id, profile_name, environment, secret_refs, allowed_hosts,
        owner_ref, support_owner_ref, profile_metadata, created_by)
     VALUES
       ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10::jsonb, $11)
     ON CONFLICT (tenant_id, connector_id, profile_name) DO UPDATE
        SET updated_at = connector_profiles.updated_at
     RETURNING id, connector_id, profile_name, status, environment, secret_refs, allowed_hosts,
               owner_ref, support_owner_ref, profile_metadata, created_by, updated_by,
               created_at, updated_at, updated_at::text AS cursor_at,
               NULL::uuid AS certification_id, NULL::text AS certification_status,
               NULL::text AS certification_reason, NULL::text AS manifest_ref,
               NULL::text AS security_review_ref, NULL::text AS test_evidence_ref,
               NULL::text AS owner_evidence_ref, NULL::jsonb AS receipt_semantics,
               NULL::jsonb AS certification_metadata, NULL::text AS certified_by,
               NULL::timestamptz AS certified_at`,
    [
      randomUUID(),
      tenantId,
      input.connectorId,
      input.profileName,
      input.environment,
      input.secretRefs,
      input.allowedHosts,
      input.ownerRef,
      input.supportOwnerRef,
      JSON.stringify(input.metadata),
      actor,
    ],
  );
  return mapConnectorProfile(requireOne(result.rows[0], "connector_profile_missing_after_insert"));
}

async function insertConnectorCertification(
  client: PoolClient,
  tenantId: string,
  profileId: string,
  actor: string,
  input: ConnectorCertificationInput,
): Promise<ConnectorCertification> {
  const profile = await selectConnectorProfileForUpdate(client, tenantId, profileId);
  if (profile === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "connector_profile_not_found" });
  }
  findConnector(profile.connector_id);
  assertCertificationEvidence(input);
  const certificationId = randomUUID();
  const result = await client.query<ConnectorCertificationRow>(
    `INSERT INTO connector_certifications
       (id, tenant_id, profile_id, connector_id, status, reason, manifest_ref, security_review_ref,
        test_evidence_ref, owner_evidence_ref, receipt_semantics, metadata, certified_by)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
     RETURNING id, profile_id, connector_id, status, reason, manifest_ref, security_review_ref,
               test_evidence_ref, owner_evidence_ref, receipt_semantics, metadata, certified_by, created_at`,
    [
      certificationId,
      tenantId,
      profileId,
      profile.connector_id,
      input.status,
      input.reason,
      input.manifestRef,
      input.securityReviewRef,
      input.testEvidenceRef,
      input.ownerEvidenceRef,
      JSON.stringify(input.receiptSemantics),
      JSON.stringify(input.metadata),
      actor,
    ],
  );
  const nextProfileStatus = profileStatusFromCertification(input.status);
  await client.query(
    `UPDATE connector_profiles
        SET status = $4,
            latest_certification_id = $5::uuid,
            updated_by = $3,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [tenantId, profileId, actor, nextProfileStatus, certificationId],
  );
  return mapConnectorCertification(requireOne(result.rows[0], "connector_certification_missing_after_insert"));
}

async function selectConnectorProfileForUpdate(
  client: PoolClient,
  tenantId: string,
  profileId: string,
): Promise<{ readonly id: string; readonly connector_id: string; readonly status: ConnectorProfileStatus } | undefined> {
  const result = await client.query<{ id: string; connector_id: string; status: ConnectorProfileStatus }>(
    `SELECT id, connector_id, status
       FROM connector_profiles
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, profileId],
  );
  return result.rows[0];
}

function mapConnectorProfile(row: ConnectorProfileRow): ConnectorProfile {
  return {
    profile_id: row.id,
    connector_id: row.connector_id,
    profile_name: row.profile_name,
    status: row.status,
    environment: row.environment,
    secret_refs: row.secret_refs,
    allowed_hosts: row.allowed_hosts,
    owner_ref: row.owner_ref,
    support_owner_ref: row.support_owner_ref,
    profile_metadata: row.profile_metadata,
    latest_certification: row.certification_id === null
      ? null
      : {
          certification_id: row.certification_id,
          profile_id: row.id,
          connector_id: row.connector_id,
          status: requireOne(row.certification_status, "connector_certification_status_missing"),
          reason: requireOne(row.certification_reason, "connector_certification_reason_missing"),
          manifest_ref: row.manifest_ref,
          security_review_ref: row.security_review_ref,
          test_evidence_ref: row.test_evidence_ref,
          owner_evidence_ref: row.owner_evidence_ref,
          receipt_semantics: row.receipt_semantics ?? defaultReceiptSemantics(),
          metadata: row.certification_metadata ?? {},
          certified_by: requireOne(row.certified_by, "connector_certification_actor_missing"),
          created_at: requireOne(row.certified_at, "connector_certification_created_at_missing").toISOString(),
        },
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapConnectorCertification(row: ConnectorCertificationRow): ConnectorCertification {
  return {
    certification_id: row.id,
    profile_id: row.profile_id,
    connector_id: row.connector_id,
    status: row.status,
    reason: row.reason,
    manifest_ref: row.manifest_ref,
    security_review_ref: row.security_review_ref,
    test_evidence_ref: row.test_evidence_ref,
    owner_evidence_ref: row.owner_evidence_ref,
    receipt_semantics: row.receipt_semantics,
    metadata: row.metadata,
    certified_by: row.certified_by,
    created_at: row.created_at.toISOString(),
  };
}

function parseConnectorProfileCreateRequest(raw: unknown): ConnectorProfileCreateInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_profile_body_expected_object" });
  assertAllowedKeys(raw, ["connector_id", "profile_name", "environment", "secret_refs", "allowed_hosts", "owner_ref", "support_owner_ref", "metadata"]);
  const connectorId = parseConnectorId(raw.connector_id);
  return {
    connectorId,
    profileName: parseSafeText(raw.profile_name, "profile_name", 1, 120),
    environment: parseEnvironment(raw.environment),
    secretRefs: parseSecretRefs(raw.secret_refs),
    allowedHosts: parseAllowedHosts(raw.allowed_hosts),
    ownerRef: requireOne(parseEvidenceRef(raw.owner_ref, "owner_ref", true), "connector_profile_owner_ref_missing"),
    supportOwnerRef: parseEvidenceRef(raw.support_owner_ref, "support_owner_ref", false),
    metadata: parseSafeMetadata(raw.metadata),
  };
}

function parseConnectorCertificationRequest(raw: unknown): ConnectorCertificationInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_certification_body_expected_object" });
  assertAllowedKeys(raw, [
    "status",
    "reason",
    "manifest_ref",
    "security_review_ref",
    "test_evidence_ref",
    "owner_evidence_ref",
    "receipt_semantics",
    "metadata",
  ]);
  return {
    status: parseCertificationStatus(raw.status),
    reason: parseSafeText(raw.reason, "reason", 1, 500),
    manifestRef: parseEvidenceRef(raw.manifest_ref, "manifest_ref", false),
    securityReviewRef: parseEvidenceRef(raw.security_review_ref, "security_review_ref", false),
    testEvidenceRef: parseEvidenceRef(raw.test_evidence_ref, "test_evidence_ref", false),
    ownerEvidenceRef: parseEvidenceRef(raw.owner_evidence_ref, "owner_evidence_ref", false),
    receiptSemantics: parseReceiptSemantics(raw.receipt_semantics),
    metadata: parseSafeMetadata(raw.metadata),
  };
}

function parseConnectorId(raw: unknown): string {
  const value = parseSafeText(raw, "connector_id", 1, 120);
  if (!/^[a-z0-9][a-z0-9_.-]{1,120}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_id" });
  }
  return value;
}

function parseEnvironment(raw: unknown): ConnectorEnvironment {
  if (raw === undefined) return "dev";
  if (raw === "dev" || raw === "staging" || raw === "prod") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_profile_environment" });
}

function parseCertificationStatus(raw: unknown): ConnectorCertificationStatus {
  if (raw === "security_review" || raw === "certified" || raw === "blocked" || raw === "revoked") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_certification_status" });
}

function parseSecretRefs(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_profile_secret_refs" });
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const item of raw) {
    const ref = parseSecretRef(item, "secret_refs");
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertNoRawSecretOrEndpoint(raw, field);
  return raw;
}

function parseAllowedHosts(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_profile_allowed_hosts" });
  }
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host" });
    const host = item.trim().toLowerCase();
    if (
      host.length === 0 ||
      host.length > 253 ||
      host.includes("/") ||
      host.includes(":") ||
      host.includes("*") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      /^[0-9.]+$/.test(host) ||
      !/^[a-z0-9.-]+$/.test(host) ||
      host.startsWith(".") ||
      host.endsWith(".")
    ) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host", host: item });
    }
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

function parseEvidenceRef(raw: unknown, field: string, required: boolean): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
    return null;
  }
  return parseSafeText(raw, field, 1, 500);
}

function parseSafeMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_metadata" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function parseReceiptSemantics(raw: unknown): ConnectorReceiptSemantics {
  if (raw === undefined) return defaultReceiptSemantics();
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_receipt_semantics" });
  assertAllowedKeys(raw, ["sent", "accepted", "delivered", "completed"]);
  return {
    sent: parseReceiptLeg(raw.sent, "sent", ["not_applicable", "metadata_only", "provider_receipt_required"]),
    accepted: parseReceiptLeg(raw.accepted, "accepted", ["not_applicable", "metadata_only", "provider_receipt_required"]),
    delivered: parseReceiptLeg(raw.delivered, "delivered", ["not_applicable", "metadata_only", "provider_receipt_required"]),
    completed: parseReceiptLeg(raw.completed, "completed", ["not_applicable", "metadata_only", "business_receipt_required"]),
  };
}

function parseReceiptLeg<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_receipt_semantics_${field}` });
  }
  return raw as T;
}

function defaultReceiptSemantics(): ConnectorReceiptSemantics {
  return {
    sent: "metadata_only",
    accepted: "provider_receipt_required",
    delivered: "provider_receipt_required",
    completed: "business_receipt_required",
  };
}

function assertCertificationEvidence(input: ConnectorCertificationInput): void {
  if (input.status !== "certified") return;
  if (
    input.manifestRef === null ||
    input.securityReviewRef === null ||
    input.testEvidenceRef === null ||
    input.ownerEvidenceRef === null
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_certification_evidence_required" });
  }
}

function profileStatusFromCertification(status: ConnectorCertificationStatus): ConnectorProfileStatus {
  if (status === "certified") return "certified";
  if (status === "revoked") return "disabled";
  return "security_review";
}

function findConnector(connectorId: string): ConnectorCatalogItem {
  const connector = CONNECTORS.find((item) => item.connector_id === connectorId);
  if (connector === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "connector_catalog_item_not_found" });
  }
  return connector;
}

function assertConnectorProfileAllowed(connector: ConnectorCatalogItem): void {
  if (connector.status === "available" || connector.status === "requires_admin") return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", {
    reason: "connector_profile_not_allowed_for_catalog_status",
    connector_id: connector.connector_id,
    status: connector.status,
  });
}

function parseUuid(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseSafeText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertNoRawSecretOrEndpoint(value, field);
  return value;
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_unknown_field", field: key });
    }
  }
}

function assertSafeMetadata(value: unknown, field: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", field });
  if (typeof value === "string") {
    assertNoRawSecretOrEndpoint(value, field);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", field });
    value.forEach((item, index) => assertSafeMetadata(item, `${field}.${index}`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", field });
    for (const [key, child] of entries) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenConnectorKey(key)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_metadata_secret_or_endpoint_key_forbidden", field: `${field}.${key}` });
      }
      assertSafeMetadata(child, `${field}.${key}`, depth + 1);
    }
  }
}

function assertNoRawSecretOrEndpoint(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bauthorization\b/i.test(value) || /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function forbiddenConnectorKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_payload|request_payload|response_payload|payload|body|raw_body|provider_response|provider_body)([_.-]|$)/i.test(key);
}

function requireOne<T>(row: T | undefined | null, reason: string): T {
  if (row === undefined || row === null) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason });
  }
  return row;
}
