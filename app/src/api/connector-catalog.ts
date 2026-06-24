import type { FastifyInstance } from "fastify";

import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";

type ConnectorKind = "browser" | "api" | "file" | "notification" | "data";
type CatalogStatus = "available" | "candidate" | "requires_admin" | "blocked";
type TemplateKind = "browser_workflow" | "api_workflow" | "file_workflow" | "notification_workflow";

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
    connector_id: "teams-webhook",
    name: "Teams / Slack Webhook (future)",
    kind: "notification",
    category: "Notification",
    status: "blocked",
    priority: "P2",
    summary: "Future outbound notification adapter. Product Open v1 uses the console alert center instead of Teams/Slack/email fanout.",
    best_for: ["future failure alert", "future HITL escalation", "future SLA risk notification"],
    supported_actions: ["console_alert"],
    template_ids: ["ops-failure-alert"],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "P2/future: outbound Teams/Slack/email dispatch, ack, retry, and notification DLQ are not implemented in Product Open v1",
    security_notes: ["Webhook URLs must remain SecretRef-only when the future outbound adapter contract is opened.", "Use /v1/ops-alerts for Product Open v1 console alerting."],
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
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
    catalog_id: "92000000-0000-4000-8000-000000000005",
    template_id: "ops-failure-alert",
    connector_id: "teams-webhook",
    name: "Ops failure alert",
    kind: "notification_workflow",
    status: "blocked",
    priority: "P2",
    summary: "Console alert-center pattern for failed runs, SLA risk, and human task timeout escalation; outbound fanout is future scope.",
    best_for: ["console run failure alert", "console SLA risk", "console human-task timeout"],
    required_params: ["severity", "message_template"],
    required_secret_refs: [],
    produced_ir_pattern: "ops event -> /v1/ops-alerts console alert center",
    success_criteria: "The alert appears in the console alert center; external ack/snooze/delivery DLQ requires a future notification contract.",
    created_at: "2026-06-19T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
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

export function registerConnectorCatalogRoutes(app: FastifyInstance, _deps: ApiServerDeps): void {
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
}
