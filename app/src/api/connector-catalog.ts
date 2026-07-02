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
    name: "SAP 웹 / ERP 포털",
    kind: "browser",
    category: "ERP",
    status: "candidate",
    priority: "P0",
    summary: "목록 추출·결재·증빙 캡처를 위한 브라우저 우선 SAP·ERP 포털 자동화 템플릿.",
    best_for: ["주문 조회", "송장 상태", "결재 포털", "기준정보 조회"],
    supported_actions: ["navigate", "act", "extract", "verify", "human_task"],
    template_ids: ["sap-web-list-extract", "sap-web-approval-check"],
    required_rbac_actions: ["connector.read", "site.read", "scenario.create"],
    required_secret_refs: ["secret://<env>/connector/sap-web/*"],
    allowed_domains: ["*.sap.example.com", "*.erp.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<env>/connector/sap-web/*"] },
    implementation_state: "browser template pack for approved web portals",
    security_notes: ["자격증명 값은 보안 자격증명 저장소 안에만 보관됩니다.", "고위험 사이트 실행은 여전히 사이트 승인이 필요합니다."],
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
    summary: "보안 베어러 자격증명을 사용하는 브라우저 RPA 업무용, 승인된 HTTP 연동 템플릿 메타데이터.",
    best_for: ["시스템 간 조회", "상태 업데이트", "웹훅 발송"],
    supported_actions: ["api_call", "verify"],
    template_ids: ["http-api-status-check"],
    required_rbac_actions: ["connector.read", "connector.enable"],
    required_secret_refs: ["secret://<env>/connector/http-api/*"],
    allowed_domains: ["api.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<env>/connector/http-api/*"] },
    implementation_state: "HTTP API P1 supports approved bearer-token profiles; basic auth, mTLS, and OAuth profiles require a future connector profile contract",
    security_notes: ["인증 헤더(Authorization)는 템플릿 본문에 저장하지 않습니다.", "베어러 토큰은 보안 자격증명 경계 안에서만 해소됩니다.", "활성화·설치 시 커넥터 보안 감사 결정을 반드시 남깁니다."],
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000007",
    connector_id: "managed-idp-scim",
    name: "관리형 IdP SCIM",
    kind: "api",
    category: "Identity",
    status: "requires_admin",
    priority: "P0",
    summary: "관리형 IdP SCIM 제공자 등록·그룹-역할 가져오기·폐기 증빙을 위한 메타데이터 전용 설정 템플릿.",
    best_for: ["SCIM 제공자 온보딩", "IdP 그룹-역할 정합", "제공자 폐기 증빙"],
    supported_actions: ["scim_provider_register", "scim_group_role_import", "scim_provider_decommission"],
    template_ids: ["managed-idp-scim-provider-registration", "managed-idp-scim-group-role-import", "managed-idp-scim-provider-decommission"],
    required_rbac_actions: ["connector.read", "scim.sync"],
    required_secret_refs: ["secret://<tenant>/scim/<provider_key>/signing"],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<tenant>/scim/<provider_key>/signing"] },
    implementation_state: "SCIM P1 uses /v1/scim/providers, group-role mapping import, and signed inbound scim-principal@1; no outbound IdP network connector is required.",
    security_notes: [
      "제공자 서명 자료는 보안 저장소 안에만 보관되며 signature_secret_ref 로만 참조합니다.",
      "인바운드 SCIM 동기화는 connectorId=scim:<provider_key> 를 통해 서명 보안 연결을 해소합니다.",
      "외부 그룹 의미는 추론하지 않으며, 저장소가 소유한 그룹-역할 매핑 행만 신뢰합니다.",
    ],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000008",
    connector_id: "existing-rpa-handoff",
    name: "기존 RPA 핸드오프 프로필",
    kind: "api",
    category: "Federation",
    status: "requires_admin",
    priority: "P1",
    summary: "UiPath·Automation Anywhere·Power Automate·Blue Prism 핸드오프 원장을 위한 메타데이터 전용 제공자 프로필입니다. 벤더 API/OAuth 직접 커넥터가 아닙니다.",
    best_for: ["외부 RPA 작업 핸드오프", "제공자 접수 증빙 캡처", "공존 마이그레이션", "데스크톱 자동화 연합"],
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
      "카탈로그는 제공자 별칭과 보안 연결 네임스페이스만 노출하며, 벤더 실제 엔드포인트·OAuth 클라이언트·토큰·해소된 보안 연결 값은 노출하지 않습니다.",
      "생성은 부작용이 없으며, ‘접수됨’은 제공자 접수(2xx)를 의미할 뿐 업무 완료가 아닙니다.",
      "벤더별 API·OAuth 동작은 테넌트가 프로필을 활성화하기 전에 오너/제공자의 승인을 받아야 합니다.",
    ],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000003",
    connector_id: "excel-csv",
    name: "Excel / CSV 브라우저 파일",
    kind: "file",
    category: "Office",
    status: "candidate",
    priority: "P1",
    summary: "CSV·스프레드시트형 내보내기를 위한 브라우저 다운로드/업로드 파일 업무 템플릿.",
    best_for: ["리포트 다운로드", "대량 업로드", "대사 파일"],
    supported_actions: ["navigate", "act", "extract", "artifact"],
    template_ids: ["browser-report-download"],
    required_rbac_actions: ["connector.read", "artifact.read", "scenario.create"],
    required_secret_refs: [],
    allowed_domains: ["reports.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "browser artifact workflow for report download and upload",
    security_notes: ["다운로드한 증빙은 마스킹·권한(RBAC) 게이트 뒤에 보관됩니다."],
    created_at: "2026-06-21T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000006",
    connector_id: "document-idp",
    name: "문서 IDP (브라우저 증빙)",
    kind: "file",
    category: "Document Automation",
    status: "candidate",
    priority: "P1",
    summary: "마스킹 적용된 브라우저 증빙을 위한 내장 결정형 문서 추출·검증 템플릿.",
    best_for: ["송장 검토", "계약 항목 확인", "브라우저 다운로드 증빙", "검증 대기열"],
    supported_actions: ["artifact", "extract", "human_task", "verify"],
    template_ids: ["document-idp-validation"],
    required_rbac_actions: ["connector.read", "artifact.read", "human_task.read", "scenario.create"],
    required_secret_refs: [],
    allowed_domains: ["reports.example.com", "vendor.example.com"],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "P1 engine: built_in_deterministic_text_v1 over redaction-visible text/CSV/JSON artifacts; OCR and image decoding require a future document adapter",
    security_notes: [
      "문서 원문(바이트)은 P1 에서 테넌트 경계 안에 머뭅니다.",
      "증빙 본문 접근은 기존 증빙 마스킹·권한(RBAC)·감사 게이트를 그대로 거칩니다.",
      "이미지 OCR/PDF 디코딩은 향후 문서 어댑터 계약에서 다룹니다.",
    ],
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000004",
    connector_id: "ops-webhook-sender",
    name: "운영 알림 웹훅 발송기",
    kind: "notification",
    category: "Notification",
    status: "available",
    priority: "P1",
    summary: "운영 알림용으로 구현된 보안 연결 기반 범용 HTTPS 웹훅 발송기. 발송 시도와 제공자 접수/회신을 메타데이터만으로 원장에 기록합니다.",
    best_for: ["실패 알림 웹훅", "사람 확인 에스컬레이션 웹훅", "SLA 위험 알림"],
    supported_actions: ["notify", "receipt_record", "provider_callback"],
    template_ids: ["ops-failure-alert"],
    required_rbac_actions: ["connector.read", "ops_alert.deliver"],
    required_secret_refs: ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"] },
    implementation_state: "Implemented: /v1/ops-alerts/{alert_id}/deliveries/send-webhook queues durable SecretRef-backed webhook attempts; /v1/ops-alerts/{alert_id}/deliveries and /v1/webhooks/ops-alerts/{tenant_id}/{attempt_id} record metadata-only receipts/callbacks.",
    security_notes: [
      "웹훅 URL 은 비밀 값이며 보안 연결로만 관리합니다. 엔드포인트 URL·토큰·인증 헤더·제공자 응답 본문·해소된 보안 연결 값은 카탈로그 데이터가 아닙니다.",
      "HTTP 2xx 웹훅 응답은 ‘발송됨’ 증빙이지 ‘전달됨’ 증빙이 아닙니다.",
      "Teams/Slack/이메일/PagerDuty/ServiceNow 별 인증·수신자 해소·전달 접수 의미는 오너/제공자 결정 사항입니다.",
    ],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000009",
    connector_id: "slack-notification-candidate",
    name: "Slack 알림 프로필 후보",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Slack 전용 알림 프로필 후보입니다. 범용 웹훅 발송은 보안 연결 엔드포인트로 보낼 수 있지만, Slack 앱/OAuth/인증·채널 소유·전달 접수는 오너/제공자 증빙이 필요합니다.",
    best_for: ["Slack 운영 채널 검토", "오너 승인 Slack 알림 경로"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before Slack-specific auth mode, route ownership, recipient/channel resolution, or delivery receipt semantics can be approved",
    security_notes: ["Slack 웹훅 URL·봇 토큰·앱 시크릿·채널 명단·해소된 보안 연결 값을 카탈로그에 저장하지 마세요."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000010",
    connector_id: "teams-notification-candidate",
    name: "Teams 알림 프로필 후보",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "Microsoft Teams 전용 알림 프로필 후보입니다. 범용 웹훅 발송은 보안 연결 엔드포인트로 보낼 수 있지만, Teams 앱/인증·채널 소유·전달 접수는 오너/제공자 증빙이 필요합니다.",
    best_for: ["Teams 운영 채널 검토", "오너 승인 Teams 알림 경로"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before Teams-specific auth mode, route ownership, recipient/channel resolution, or delivery receipt semantics can be approved",
    security_notes: ["Teams 웹훅 URL·앱 시크릿·채널 명단·해소된 보안 연결 값을 카탈로그에 저장하지 마세요."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000011",
    connector_id: "email-notification-candidate",
    name: "이메일 알림 프로필 후보",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "이메일 전용 알림 프로필 후보입니다. SMTP/OAuth/인증·수신 그룹 확장·전달/반송 접수는 오너/제공자 증빙이 필요합니다.",
    best_for: ["이메일 에스컬레이션 검토", "오너 승인 메일 경로"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before email provider auth, recipient-group resolution, bounce handling, or delivery receipt semantics can be approved",
    security_notes: ["SMTP 비밀번호·OAuth 클라이언트/시크릿·수신자 명단 원본·메시지 본문·해소된 보안 연결 값을 카탈로그에 저장하지 마세요."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000012",
    connector_id: "pagerduty-notification-candidate",
    name: "PagerDuty 인시던트 프로필 후보",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "PagerDuty 전용 인시던트 프로필 후보입니다. 인시던트 라우팅 키·에스컬레이션 정책 소유·접수/해결 접수 의미는 오너/제공자 증빙이 필요합니다.",
    best_for: ["인시던트 에스컬레이션 검토", "오너 승인 PagerDuty 경로"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before PagerDuty-specific auth, escalation policy mapping, incident ownership, or incident receipt semantics can be approved",
    security_notes: ["PagerDuty 라우팅 키·토큰·에스컬레이션 명단·인시던트 본문·해소된 보안 연결 값을 카탈로그에 저장하지 마세요."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000013",
    connector_id: "servicenow-notification-candidate",
    name: "ServiceNow 인시던트 프로필 후보",
    kind: "notification",
    category: "Notification",
    status: "candidate",
    priority: "P2",
    summary: "ServiceNow 전용 인시던트 프로필 후보입니다. 인스턴스 소유·인증·인시던트 필드 매핑·접수/해결 접수 의미는 오너/제공자 증빙이 필요합니다.",
    best_for: ["ITSM 인시던트 검토", "오너 승인 ServiceNow 경로"],
    supported_actions: ["owner_evidence_review"],
    template_ids: [],
    required_rbac_actions: ["connector.read"],
    required_secret_refs: [],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: [] },
    implementation_state: "candidate: owner/provider evidence required before ServiceNow-specific auth, table/field mapping, assignment routing, or incident receipt semantics can be approved",
    security_notes: ["ServiceNow 아이디/비밀번호·OAuth 시크릿·인시던트 본문 원본·배정 명단·해소된 보안 연결 값을 카탈로그에 저장하지 마세요."],
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "91000000-0000-4000-8000-000000000005",
    connector_id: "database-read",
    name: "데이터베이스 조회",
    kind: "data",
    category: "Data",
    status: "blocked",
    priority: "P2",
    summary: "기획용 데이터베이스 조회 커넥터 후보입니다. 브라우저 범위 예외 승인 후에만 활성화합니다.",
    best_for: ["참조 조회", "대사", "감사 증빙 결합"],
    supported_actions: ["query"],
    template_ids: [],
    required_rbac_actions: ["connector.read", "connector.enable"],
    required_secret_refs: ["secret://<env>/connector/database-read/*"],
    allowed_domains: [],
    manifest_permissions: { api: ["readConfig"], network: false, secret_refs: ["secret://<env>/connector/database-read/*"] },
    implementation_state: "blocked by browser-scope decision; no approved browser execution surface",
    security_notes: ["활성화 전에 명시적 백엔드 승인과 보안 자격증명 저장이 필요합니다."],
    created_at: "2026-06-19T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
];

const TEMPLATES: readonly TemplateCatalogItem[] = [
  {
    catalog_id: "92000000-0000-4000-8000-000000000001",
    template_id: "sap-web-list-extract",
    connector_id: "sap-web",
    name: "SAP 목록 추출",
    kind: "browser_workflow",
    status: "candidate",
    priority: "P0",
    summary: "ERP 목록 화면을 열어 필터를 적용하고 행을 추출한 뒤 마스킹된 증빙을 보관합니다.",
    best_for: ["송장 상태", "발주 목록", "납품 목록"],
    required_params: ["entry_url", "filter_text", "max_pages"],
    required_secret_refs: ["secret://<env>/connector/sap-web/*"],
    produced_ir_pattern: "navigate -> act(filter) -> loop(extract rows) -> verify(row_count)",
    success_criteria: "행이 최소 1건 추출되거나 결정형 빈-상태 플래그가 관찰됩니다.",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000002",
    template_id: "sap-web-approval-check",
    connector_id: "sap-web",
    name: "SAP 결재 확인",
    kind: "browser_workflow",
    status: "candidate",
    priority: "P1",
    summary: "웹 결재 대기열을 확인하고 모호한 판단은 사람 확인 검증으로 넘깁니다.",
    best_for: ["결재 대기열", "예외 검토", "이중 확인"],
    required_params: ["entry_url", "document_id"],
    required_secret_refs: ["secret://<env>/connector/sap-web/*"],
    produced_ir_pattern: "navigate -> extract approval fields -> human_task(validation) when ambiguous",
    success_criteria: "판단 항목이 추출되거나 검증용 사람 확인 작업이 열립니다.",
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000003",
    template_id: "browser-report-download",
    connector_id: "excel-csv",
    name: "브라우저 리포트 다운로드",
    kind: "file_workflow",
    status: "candidate",
    priority: "P1",
    summary: "리포트 화면으로 이동해 CSV 내보내기를 다운로드하고 마스킹 게이트를 거친 증빙으로 보관합니다.",
    best_for: ["일일 리포트", "대사 내보내기", "정산 파일"],
    required_params: ["entry_url", "report_name"],
    required_secret_refs: [],
    produced_ir_pattern: "navigate -> act(download) -> artifact(receipt) -> verify(download_complete)",
    success_criteria: "다운로드 증빙이 마스킹 상태 ‘마스킹됨(redacted)’ 또는 ‘불필요(not_required)’로 기록됩니다.",
    created_at: "2026-06-21T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000006",
    template_id: "document-idp-validation",
    connector_id: "document-idp",
    name: "문서 항목 검증",
    kind: "file_workflow",
    status: "candidate",
    priority: "P1",
    summary: "브라우저로 캡처한 텍스트/CSV/JSON 증빙에서 설정된 항목을 추출하고, 신뢰도가 낮으면 검증 작업을 엽니다.",
    best_for: ["송장 항목", "계약 메타데이터", "결재 증빙", "수기 보정 루프"],
    required_params: ["source_artifact_id", "document_type", "field_schema"],
    required_secret_refs: [],
    produced_ir_pattern: "browser artifact -> deterministic_text_v1 extract -> human_task(validation) for low confidence",
    success_criteria: "필수 항목이 추출되거나 증빙 참조가 포함된 business_form_v1 검증 작업이 열립니다.",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000004",
    template_id: "http-api-status-check",
    connector_id: "http-api",
    name: "HTTP 상태 확인",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P0",
    summary: "결과 확인용으로 승인된 API 상태 조회 템플릿.",
    best_for: ["상태 조회", "케이스 보강", "API 핸드오프"],
    required_params: ["endpoint_url", "method", "request_schema_ref"],
    required_secret_refs: ["secret://<env>/connector/http-api/*"],
    produced_ir_pattern: "api_call -> verify(http_status)",
    success_criteria: "설정된 2xx HTTP 상태가 관찰됩니다. 응답 스키마 검증은 향후 커넥터 프로필 계약이 필요합니다.",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000007",
    template_id: "managed-idp-scim-provider-registration",
    connector_id: "managed-idp-scim",
    name: "SCIM 제공자 등록",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P0",
    summary: "보안 연결 전용 서명 메타데이터와 닫힌 회전 정책으로 관리형 IdP SCIM 제공자를 등록합니다.",
    best_for: ["신규 IdP 테넌트 온보딩", "SCIM 서명 키 등록", "제공자 준비 증빙"],
    required_params: ["provider_key", "display_name", "signature_secret_ref", "secret_rotation_policy", "clock_skew_seconds"],
    required_secret_refs: ["secret://<tenant>/scim/<provider_key>/signing"],
    produced_ir_pattern: "POST /v1/scim/providers -> provider rotation evidence",
    success_criteria: "auth_mode=signed_request_v1 로 제공자 행이 생성되고 signature_secret_ref 만 노출됩니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000008",
    template_id: "managed-idp-scim-group-role-import",
    connector_id: "managed-idp-scim",
    name: "SCIM 그룹-역할 가져오기",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P0",
    summary: "저장소가 소유한 매핑 원장을 통해 불투명한 IdP 그룹을 닫힌 RPA 역할로 일괄 가져오거나 정합합니다.",
    best_for: ["그룹 매핑 초기 구성", "주기적 접근 검토", "IdP-RPA 역할 정합"],
    required_params: ["provider_key", "mode", "mappings"],
    required_secret_refs: [],
    produced_ir_pattern: "POST /v1/scim/providers/{provider_key}/group-role-mappings/import",
    success_criteria: "응답이 외부 그룹 의미를 추론하지 않고 가져옴·갱신·변경없음·비활성 매핑 건수를 보고합니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000009",
    template_id: "managed-idp-scim-provider-decommission",
    connector_id: "managed-idp-scim",
    name: "SCIM 제공자 폐기",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P1",
    summary: "폐기된 IdP 제공자를 비활성화하고 활성 매핑을 끄며, 감사 증빙과 함께 활성 SCIM 관리 배정을 회수합니다.",
    best_for: ["IdP 테넌트 폐기", "제공자 마이그레이션 정리", "접근 회수 증빙"],
    required_params: ["provider_key", "reason"],
    required_secret_refs: [],
    produced_ir_pattern: "POST /v1/scim/providers/{provider_key}/decommission",
    success_criteria: "제공자가 비활성화되고 응답이 disabled_mappings·revoked_assignments 건수를 기록합니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000010",
    template_id: "uipath-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "UiPath 핸드오프 제공자 프로필",
    kind: "api_workflow",
    status: "requires_admin",
    priority: "P1",
    summary: "기존 RPA 원장을 위한 메타데이터 전용 UiPath 핸드오프 별칭/프로필 템플릿입니다. UiPath API/OAuth 나 큐 의미는 구현하지 않습니다.",
    best_for: ["UiPath Orchestrator 공존", "큐 핸드오프 증빙", "서명된 제공자 접수 캡처"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/uipath/callback-url", "secret://<tenant>/integration/uipath/callback-signing", "secret://<tenant>/integration/uipath/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "핸드오프 생성은 보류 상태로 유지되고, 디스패치는 ‘접수됨’만 기록하며, ‘완료’는 오너/제공자 프로필이 제공하는 UiPath 접수/회신 증빙이 필요합니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000011",
    template_id: "automation-anywhere-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "Automation Anywhere 핸드오프 제공자 프로필",
    kind: "api_workflow",
    status: "candidate",
    priority: "P1",
    summary: "메타데이터 전용 Automation Anywhere 핸드오프 별칭/프로필 템플릿입니다. Control Room API/OAuth 직접 연동은 오너/제공자 범위로 남습니다.",
    best_for: ["Automation Anywhere 공존", "Control Room 작업 증빙", "외부 봇 접수 캡처"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/automation-anywhere/callback-url", "secret://<tenant>/integration/automation-anywhere/callback-signing", "secret://<tenant>/integration/automation-anywhere/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "프로필은 메타데이터와 접수 상태만 기록하며, 실제 Automation Anywhere API/OAuth 동작은 오너/제공자 계약이 승인되기 전까지 보장하지 않습니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000012",
    template_id: "power-automate-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "Power Automate 핸드오프 제공자 프로필",
    kind: "api_workflow",
    status: "candidate",
    priority: "P1",
    summary: "메타데이터 전용 Power Automate 핸드오프 별칭/프로필 템플릿입니다. 클라우드 플로우/데스크톱 플로우 API/OAuth 직접 연동은 오너/제공자 범위로 남습니다.",
    best_for: ["Power Automate 공존", "클라우드 플로우 핸드오프 증빙", "외부 플로우 접수 캡처"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/power-automate/callback-url", "secret://<tenant>/integration/power-automate/callback-signing", "secret://<tenant>/integration/power-automate/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "프로필은 메타데이터와 접수 상태만 기록하며, 실제 Power Automate API/OAuth 동작은 오너/제공자 계약이 승인되기 전까지 보장하지 않습니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000013",
    template_id: "blue-prism-handoff-provider-profile",
    connector_id: "existing-rpa-handoff",
    name: "Blue Prism 핸드오프 제공자 프로필",
    kind: "api_workflow",
    status: "candidate",
    priority: "P1",
    summary: "메타데이터 전용 Blue Prism 핸드오프 별칭/프로필 템플릿입니다. Control Room/API/OAuth 직접 연동은 오너/제공자 범위로 남습니다.",
    best_for: ["Blue Prism 공존", "Control Room 작업 큐 증빙", "외부 프로세스 접수 캡처"],
    required_params: ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "endpoint_secret_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/integration/blue-prism/callback-url", "secret://<tenant>/integration/blue-prism/callback-signing", "secret://<tenant>/integration/blue-prism/dispatch-endpoint"],
    produced_ir_pattern: "POST /v1/integration-handoffs -> optional dispatch -> provider receipt/callback",
    success_criteria: "프로필은 메타데이터와 접수 상태만 기록하며, 실제 Blue Prism API/OAuth 동작은 오너/제공자 계약이 승인되기 전까지 보장하지 않습니다.",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
  },
  {
    catalog_id: "92000000-0000-4000-8000-000000000005",
    template_id: "ops-failure-alert",
    connector_id: "ops-webhook-sender",
    name: "운영 실패 알림",
    kind: "notification_workflow",
    status: "available",
    priority: "P1",
    summary: "실패한 실행·SLA 위험·사람 확인 시간초과 에스컬레이션을 위한 보안 연결 기반 범용 웹훅 알림 패턴.",
    best_for: ["실행 실패 웹훅", "SLA 위험 웹훅", "사람 확인 시간초과 웹훅"],
    required_params: ["severity", "message_template", "endpoint_secret_ref", "route_policy_ref", "allowed_hosts"],
    required_secret_refs: ["secret://<tenant>/notification-sender/webhook/<route_alias>/endpoint"],
    produced_ir_pattern: "ops event -> /v1/ops-alerts alert -> webhook send attempt -> receipt ledger",
    success_criteria: "웹훅 시도가 큐에 적재되고 발송/실패 메타데이터를 기록합니다. ‘전달됨’은 제공자 접수/회신 증빙이 필요하며 콘솔 확인만으로는 추론하지 않습니다.",
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
