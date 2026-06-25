/**
 * Security Middleware Scaffold Contract v1
 *
 * This file is a typed implementation scaffold, not runtime code. It fixes the
 * middleware boundaries that future Fastify/control-plane, runtime worker, and
 * LLM Gateway implementations must satisfy.
 *
 * Authoritative contracts:
 * - auth-rbac.md §1..§4
 * - security-contracts.md §1..§9
 * - llm-gateway-adapter.md §1..§7
 * - api-surface.md §0.1, §5, §6
 */

import type {
  ArtifactRef,
  ObjectRef,
  PlainSecret,
  RedactedString,
  SecretRef,
  SecretStore,
} from "./core-types";
import type { ErrorCode } from "./error-catalog";
import type { HumanTaskKind } from "./state-machine-types";

export type TenantId = string & { readonly __brand: "TenantId" };
export type PrincipalId = string & { readonly __brand: "PrincipalId" };
export type PolicyId = string & { readonly __brand: "PolicyId" };
export type RunId = string & { readonly __brand: "RunId" };
export type StepId = string & { readonly __brand: "StepId" };
export type CorrelationId = string & { readonly __brand: "CorrelationId" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };
export type CanonicalRequestHash = string & { readonly __brand: "CanonicalRequestHash" };
export type IsoDateTime = string & { readonly __brand: "IsoDateTime" };

// auth-rbac.md §1 is authoritative for this closed role set.
export type Role = "viewer" | "operator" | "reviewer" | "approver" | "admin";

export interface AuthenticatedPrincipal {
  subjectId: PrincipalId;
  tenantId: TenantId;
  roles: readonly Role[];
  source: "jwt" | "session";
  claims: Readonly<Record<string, unknown>>;
}

// authn 미성립(Bearer 토큰 누락/서명 무효)은 UNAUTHENTICATED(401); 인증은 됐으나 tenant_id 클레임
// 누락/모호는 AUTHZ_FORBIDDEN(403, auth-rbac §3). 둘 다 authenticate() 경계의 거부 코드(api-surface §0.1).
export type AuthFailureCode = Extract<ErrorCode, "UNAUTHENTICATED" | "AUTHZ_FORBIDDEN">;

export type AuthBoundaryResult =
  | { kind: "authenticated"; principal: AuthenticatedPrincipal }
  | { kind: "denied"; code: AuthFailureCode; reason: string };

export interface AuthenticationBoundary {
  /**
   * tenant_id and roles MUST come from authenticated claims only. Body/query
   * tenant_id is never trusted.
   */
  authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<AuthBoundaryResult>;
}

export type RbacAction =
  | "run.read"
  | "run.create"
  | "run.abort"
  | "trigger.read"
  | "trigger.manage"
  | "ops_alert.read"
  | "automation_idea.read"
  | "automation_idea.manage"
  | "automation_idea.approve"
  | "document_job.read"
  | "document_job.manage"
  | "audit.read"
  | "workitem.read"
  | "human_task.read"
  | "principal.read"
  | "principal.manage"
  | "human_task.assign"
  | "human_task.escalate"
  | "human_task.start"
  | "human_task.resolve.validation"
  | "human_task.resolve.exception"
  | "human_task.resolve.captcha"
  | "human_task.resolve.mfa"
  | "human_task.resolve.approval"
  | "node_policy.approve"
  | "dlq.replay"
  | "sink_dlq.replay"
  | "scenario.create"
  | "scenario.read"
  | "scenario.update"
  | "scenario.promote"
  | "scenario.promote.approve"
  | "artifact.read"
  | "site.read"
  | "site.approve"
  | "site.create"
  | "site.update"
  | "approval.decide"
  | "session.capture"
  | "secret.resolve"
  | "credential.manage"
  | "worker_pool.manage"
  | "connector.read"
  | "connector.enable"
  | "gateway_policy.read"
  | "gateway_policy.edit"
  | "network_policy.edit"
  | "rbac.grant";

export type SecurityDenyCode = Extract<
  ErrorCode,
  | "AUTHZ_FORBIDDEN"
  | "SECRET_ACCESS_DENIED"
  | "CONNECTOR_PERMISSION_DENIED"
  | "SITE_PROFILE_BLOCKED"
  | "ARTIFACT_NOT_REDACTED"
  | "DOMAIN_POLICY_VIOLATION"
  | "PROMPT_INJECTION_DETECTED"
  | "SHELL_COMMAND_NOT_ALLOWED"
  | "LLM_CAPABILITY_MISMATCH"
>;

export type AuthorizationDecision =
  | { kind: "allow"; principal: AuthenticatedPrincipal; action: RbacAction }
  | { kind: "deny"; action: RbacAction; code: SecurityDenyCode; reason: string };

export interface AuthorizationCheck {
  action: RbacAction;
  tenantId: TenantId;
  resource?: {
    kind:
      | "run"
      | "workitem"
      | "human_task"
      | "artifact"
      | "secret"
      | "connector"
      | "site"
      | "scenario"
      | "trigger"
      | "automation_idea"
      | "audit_log"
      | "gateway_policy"
      | "network_policy";
    id: string;
  };
  humanTask?: {
    kind: HumanTaskKind;
    assigneeId?: PrincipalId;
    assigneeRole?: Role;
  };
}

export interface RbacMiddleware {
  authorize(principal: AuthenticatedPrincipal, check: AuthorizationCheck): Promise<AuthorizationDecision>;
}

export interface TenantBindingStatement {
  sql: "SET LOCAL app.tenant_id = $1";
  values: readonly [TenantId];
}

export interface TenantSessionBinder {
  /**
   * Must run once inside every request/job DB transaction before tenant-scoped
   * reads or writes. Missing tenant claim is AUTHZ_FORBIDDEN, not a default.
   */
  bindTenant(principal: AuthenticatedPrincipal): TenantBindingStatement;
}

export interface SecretAccessRequest {
  principal: AuthenticatedPrincipal;
  ref: SecretRef;
  /**
   * Least-privilege scope of the credential. `object_store` is dedicated to artifact
   * redaction/retention real object-store credentials, resolved only by the isolated
   * artifact-lifecycle operational identity (ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT),
   * kept distinct from `executor` user-traffic so executor identities are never authorized
   * for object-store credentials — see release-decisions.md D8-A10.
   * `browser_session` is the at-rest envelope-encryption KEK for reused login sessions
   * (browser_sessions.ciphertext), kept distinct from `executor` credential-fill so a
   * session-key compromise is isolated from live credential traffic — see browser-session-store.ts.
   */
  purpose: "executor" | "connector" | "resume_token_hmac" | "gateway_policy" | "object_store" | "browser_session";
  runId?: RunId;
  connectorId?: string;
}

export type SecretAccessDecision =
  | { kind: "allow"; ref: SecretRef }
  | { kind: "deny"; code: Extract<ErrorCode, "SECRET_ACCESS_DENIED">; reason: string };

export interface SecretStoreBoundary {
  store: SecretStore;
  authorize(request: SecretAccessRequest): Promise<SecretAccessDecision>;
  /**
   * Only this method may call SecretStore.resolve(). The returned PlainSecret
   * remains tainted and cannot be serialized/logged/artifacted.
   */
  resolveAuthorized(request: SecretAccessRequest): Promise<PlainSecret>;
}

export type SignedCommandRegistryPurpose =
  | "scenario.save"
  | "scenario.validate"
  | "scenario.promote";

export interface SignedCommandRegistryReadRequest {
  principal: AuthenticatedPrincipal;
  purpose: SignedCommandRegistryPurpose;
}

export interface SignedCommandRegistryEntry {
  cmdRef: string;
  kid: string;
  signature: string;
  sideEffectKind: "read_only" | "create" | "update" | "delete" | "upload";
  /** SecretStore/KMS reference for signature verification key material. */
  verificationKeyRef: SecretRef;
}

export interface SignedCommandRegistrySnapshot {
  /**
   * Metadata-only SecretRef for the signed command registry source. Command
   * material and signing keys stay behind SecretStore/KMS.
   */
  sourceRef: SecretRef;
  commands: readonly SignedCommandRegistryEntry[];
}

export type SignedCommandRegistryReadResult =
  | { kind: "available"; snapshot: SignedCommandRegistrySnapshot }
  | { kind: "unavailable"; reason: string; sourceRef?: SecretRef };

export interface SignedCommandRegistry {
  /**
   * Returns only registered cmd_ref keys visible to the principal. Returning an
   * empty list is a fail-closed deny-all registry; plaintext command material is
   * never exposed through the API compile boundary.
   */
  listAllowedCommandRefs(request: SignedCommandRegistryReadRequest): Promise<SignedCommandRegistryReadResult>;
}

export interface PlainSecretSerializationBoundary {
  /**
   * Logger/EventPublisher/ArtifactSink must serialize through this boundary.
   * Passing a tracked PlainSecret is SECRET_ACCESS_DENIED, never best-effort
   * redaction after JSON.stringify().
   */
  safeSerialize(value: unknown): string;
  redactPlainSecret(secret: PlainSecret): RedactedString;
}

export type ArtifactRedactionStatus = "pending" | "redacted" | "failed" | "not_required";

export interface ArtifactAccessSubject {
  artifactId: string;
  /** Redacted object-store reference returned only after redaction and RBAC gates pass. */
  objectRef: ObjectRef;
  tenantId: TenantId;
  runId?: RunId;
  redactionStatus: ArtifactRedactionStatus;
  deletedAt?: IsoDateTime;
  quarantine?: boolean;
}

export type ArtifactAccessDecision =
  | { kind: "allow"; objectRef: ObjectRef }
  | { kind: "deny"; stage: "redaction"; code: Extract<ErrorCode, "ARTIFACT_NOT_REDACTED">; reason: string }
  | { kind: "deny"; stage: "rbac"; code: Extract<ErrorCode, "SECRET_ACCESS_DENIED">; reason: string };

export interface ArtifactAccessGate {
  /**
   * Gate order is contractually fixed: redaction/deleted-row gate first, RBAC
   * second. Reversing them can leak existence or unredacted readiness.
   */
  check(principal: AuthenticatedPrincipal, artifact: ArtifactAccessSubject): Promise<ArtifactAccessDecision>;
}

export interface NetworkPolicy {
  id: PolicyId;
  tenantId: TenantId;
  allowedDomains: readonly string[];
  /** Product Open is fail-closed: false is not monitor-only and still denies off-allowlist traffic. */
  blockOnViolation: boolean;
}

export type NetworkRequestKind = "browser_navigation" | "browser_subrequest" | "api_call" | "download" | "upload";

export interface NetworkPolicyCheck {
  tenantId: TenantId;
  policy: NetworkPolicy;
  requestKind: NetworkRequestKind;
  url: string;
  runId?: RunId;
}

export type NetworkPolicyDecision =
  | { kind: "allow"; matchedDomain: string }
  | { kind: "deny"; code: Extract<ErrorCode, "DOMAIN_POLICY_VIOLATION">; reason: string };

export interface DomainAllowlistMiddleware {
  evaluate(check: NetworkPolicyCheck): NetworkPolicyDecision;
}

export type ConnectorManifestApiPermission = "migrateSchema" | "registerTargets" | "readConfig";

export interface ConnectorManifestPermissions {
  api: readonly ConnectorManifestApiPermission[];
  network: false;
  secret_refs: readonly string[];
}

export interface ConnectorManifestPermissionCheck {
  connectorId: string;
  manifest: ConnectorManifestPermissions;
  signatureVerified: boolean;
}

export type ConnectorManifestPermissionDecision =
  | { kind: "allow"; permissions: ConnectorManifestPermissions }
  | {
      kind: "deny";
      code: Extract<ErrorCode, "CONNECTOR_PERMISSION_DENIED">;
      reasons: readonly string[];
    };

export interface ConnectorManifestPermissionChecker {
  check(input: ConnectorManifestPermissionCheck): ConnectorManifestPermissionDecision;
}

export type PromptInjectionSignal =
  | "hidden_instruction"
  | "instruction_override"
  // Credential exfiltration is blocked independently of URL allowlisting.
  | "credential_exfiltration"
  | "off_allowlist_url";

export interface PromptInjectionEvidence {
  signal: PromptInjectionSignal;
  excerpt: RedactedString;
  source: "dom" | "network" | "screenshot" | "artifact";
}

export type PromptTextVisibility = "visible" | "hidden" | "offscreen" | "zero_opacity";

export interface PromptInspectionTextRun {
  text: RedactedString;
  visibility: PromptTextVisibility;
  source: PromptInjectionEvidence["source"];
}

export type PromptInjectionDecision =
  | { kind: "clean" }
  | {
      kind: "blocked";
      code: Extract<ErrorCode, "PROMPT_INJECTION_DETECTED">;
      evidence: readonly PromptInjectionEvidence[];
    };

export interface PromptInjectionDetector {
  inspect(input: {
    tenantId: TenantId;
    runId?: RunId;
    redactedText: RedactedString;
    textRuns?: readonly PromptInspectionTextRun[];
    networkPolicy?: NetworkPolicy;
  }): PromptInjectionDecision;
}

export interface RedactedContentBlock {
  type: "text" | "structured_json";
  content: RedactedString | Readonly<Record<string, unknown>>;
}

export interface RedactedImageRef {
  artifactRef: ArtifactRef;
  redactionStatus: Extract<ArtifactRedactionStatus, "redacted" | "not_required">;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface GatewayRedactionBoundary {
  /**
   * Performs security-contracts.md §4 step2: redact sensitive content and run
   * prompt-injection detection before adapter calls.
   */
  redactForGateway(input: {
    tenantId: TenantId;
    runId?: RunId;
    rawTextOrObject: unknown;
    textRuns?: readonly PromptInspectionTextRun[];
    images?: readonly RedactedImageRef[];
    networkPolicy?: NetworkPolicy;
  }): Promise<
    | { kind: "redacted"; content: RedactedString | readonly RedactedContentBlock[]; images?: readonly RedactedImageRef[] }
    | { kind: "blocked"; code: Extract<ErrorCode, "PROMPT_INJECTION_DETECTED">; evidence: readonly PromptInjectionEvidence[] }
  >;
}

export type AuditOutcome = "allow" | "deny" | "blocked" | "error";

export const SECURITY_AUDIT_PAYLOAD_SCHEMA_REF = "audit/security-boundary-decision@1" as const;
export type SecurityAuditPayloadSchemaRef = typeof SECURITY_AUDIT_PAYLOAD_SCHEMA_REF;

export const SECURITY_AUDIT_REQUIRED_ACTIONS = [
  "artifact.read",
  "secret.resolve",
  "connector.enable",
  "connector.install",
  "network.request",
  "prompt.inspect",
  "bypassrls.use",
] as const;

export type SecurityAuditDecisionAction = (typeof SECURITY_AUDIT_REQUIRED_ACTIONS)[number];

export interface ImmutableAuditLogAppendInput {
  tenantId: TenantId;
  actor: {
    subjectId: PrincipalId;
    roles: readonly Role[];
  };
  action: SecurityAuditDecisionAction;
  outcome: AuditOutcome;
  resource?: {
    kind: NonNullable<AuthorizationCheck["resource"]>["kind"];
    id: string;
  };
  reason: string;
  correlationId: CorrelationId;
  idempotencyKey: IdempotencyKey;
  occurredAt: IsoDateTime;
  retentionUntil: IsoDateTime;
  payloadSchemaRef: SecurityAuditPayloadSchemaRef;
  payload?: unknown;
}

export interface ImmutableAuditLogRecord extends ImmutableAuditLogAppendInput {
  sequence: number;
  previousHash: string;
  hash: string;
}

export interface ImmutableAuditLogAppendOnly {
  /**
   * Append-only by contract: no update/delete/read-modify-write mutators are
   * part of this interface. Payload serialization must pass the PlainSecret
   * boundary before hashing.
   */
  append(input: ImmutableAuditLogAppendInput): Promise<ImmutableAuditLogRecord>;
}

export interface SecurityAuditDecisionAppendInput extends ImmutableAuditLogAppendInput {
  /**
   * Security boundary decisions are never best-effort audit events. If append
   * fails, the caller must fail closed and must not return the protected result.
   */
  failClosed: true;
}

export interface AuditedSecurityDecision<TDecision> {
  decision: TDecision;
  auditRecord: ImmutableAuditLogRecord;
}

export interface DurableSecurityAuditDecisionWriter {
  /**
   * Repo-owned D4.4 audit writer boundary for security-relevant API/runtime
   * decisions. Implementations append to PostgreSQL audit_log before returning
   * the decision to the caller.
   */
  recordDecision<TDecision>(
    input: SecurityAuditDecisionAppendInput,
    decision: TDecision,
  ): Promise<AuditedSecurityDecision<TDecision>>;
}

export type BypassRlsUseCase =
  | "schema_migration"
  | "artifact_redaction_job"
  | "artifact_retention_sweeper"
  | "artifact_integrity_checker"
  | "artifact_orphan_sweeper"
  | "lease_sweeper"
  | "scheduler_infra_worker_registry";

export interface BypassRlsPolicyContract {
  applicationRoleMayBypassRls: false;
  bypassRoleMayServeUserTraffic: false;
  requiresDedicatedDatabaseRole: true;
  requiresReasonCode: true;
  requiresImmutableAuditAppend: true;
  allowedUseCases: readonly BypassRlsUseCase[];
}

export const MINIMUM_BYPASS_RLS_POLICY = {
  applicationRoleMayBypassRls: false,
  bypassRoleMayServeUserTraffic: false,
  requiresDedicatedDatabaseRole: true,
  requiresReasonCode: true,
  requiresImmutableAuditAppend: true,
  allowedUseCases: [
    "schema_migration",
    "artifact_redaction_job",
    "artifact_retention_sweeper",
    "artifact_integrity_checker",
    "artifact_orphan_sweeper",
    "lease_sweeper",
    "scheduler_infra_worker_registry",
  ],
} as const satisfies BypassRlsPolicyContract;

export type LLMPrimitive = "act" | "observe" | "extract" | "agent" | "vlm_verify" | "self_heal";

export interface ModelCapabilities {
  domReasoning: boolean;
  vision: boolean;
  jsonMode: boolean;
  toolCall: boolean;
  sse: boolean;
  maxContextTokens: number;
}

export type LLMMessage =
  | { role: "system"; content: string | RedactedString | readonly RedactedContentBlock[] }
  | { role: "user"; content: RedactedString | readonly RedactedContentBlock[] };

export interface LLMToolSpec {
  name: string;
  description: string;
  inputSchemaRef: string;
}

export interface LLMRequestMetadata {
  tenantId: TenantId;
  runId: RunId;
  stepId: StepId;
  /** Canonical step attempt; must be a non-negative integer. */
  attempt: number;
  primitive: LLMPrimitive;
  correlationId: CorrelationId;
  /**
   * Actor to record for `prompt.inspect` security-boundary audit rows. API
   * planner calls should provide the requesting principal; runtime executor
   * calls may omit it and use the gateway's explicit runtime fallback actor.
   */
  auditActor?: {
    subjectId: PrincipalId;
    roles: readonly Role[];
  };
}

export interface LLMBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCost: number;
}

export type LLMCallIdempotencyKey = string & { readonly __brand: "LLMCallIdempotencyKey" };

export interface LLMRequest {
  model: string;
  promptTemplateVersion: string;
  messages: readonly LLMMessage[];
  promptInspection?: {
    textRuns?: readonly PromptInspectionTextRun[];
  };
  responseFormat?: {
    type: "json_schema";
    schemaRef: string;
    schemaVersion: string;
    strict: boolean;
    /** Inline JSON Schema body for structured-output validation (sourced from the IR extract node's
     *  args.schema). schemaRef/schemaVersion remain identity/versioning; this is the body the validator
     *  checks against. Optional for back-compat; absent ⇒ the validator fails closed. */
    schema?: Record<string, unknown>;
  };
  images?: readonly RedactedImageRef[];
  tools?: readonly LLMToolSpec[];
  metadata: LLMRequestMetadata;
  budget: LLMBudget;
  sampling?: { temperature: number; seed?: number };
  /**
   * Derived from tenant/run/step/primitive/attempt/template/input hash. It must
   * be stable across worker retry and distinct from control-plane Idempotency-Key.
   */
  idempotencyKey: LLMCallIdempotencyKey;
  requestHash: CanonicalRequestHash;
}

export type AdapterErrorCode =
  | "RATE_LIMIT"
  | "BACKEND_ERROR"
  | "STREAM_IDLE_TIMEOUT"
  | "STREAM_TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "MALFORMED_OUTPUT"
  | "CONTENT_FILTERED"
  | "CONNECTION_FAILED";

export type LLMStreamEvent =
  | { type: "open" }
  | { type: "text_delta"; text: string }
  | { type: "json_delta"; partial: string }
  | { type: "tool_call_delta"; id: string; name?: string; argsPartial?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cost: number; estimated?: boolean }
  | { type: "done"; finishReason: "stop" | "length" | "tool_call" | "content_filter" }
  | { type: "error"; code: AdapterErrorCode; retryable: boolean; message: string }
  | { type: "aborted" };

export interface LLMResponse {
  outputRef: ArtifactRef;
  usage: { inputTokens: number; outputTokens: number; cost: number; estimated?: boolean };
  finishReason: "stop" | "length" | "tool_call" | "content_filter";
  parsedJson?: unknown;
  /** Durable stagehand_calls.id when the gateway is backed by LLMCallIdempotencyStore. */
  stagehandCallId?: string;
}

export interface LLMBackendAdapter {
  id: string;
  capabilities(): ModelCapabilities;
  streamCall(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMStreamEvent>;
  syncCall?(req: LLMRequest): Promise<LLMResponse>;
}

export type CapabilityDecision =
  | { kind: "allow"; transport: "sse" | "sync" }
  | { kind: "deny"; code: Extract<ErrorCode, "LLM_CAPABILITY_MISMATCH">; reason: string };

export interface CapabilityGate {
  evaluate(input: {
    primitive: LLMPrimitive;
    responseFormat?: LLMRequest["responseFormat"];
    images?: readonly RedactedImageRef[];
    capabilities: ModelCapabilities;
  }): CapabilityDecision;
}

export type LLMIdempotencyReservation =
  | { kind: "reserved"; callId: string; idempotencyKey: LLMCallIdempotencyKey }
  | { kind: "replay"; response: LLMResponse }
  | { kind: "in_flight"; callId: string }
  | {
      kind: "blocked";
      reason: "request_hash_mismatch";
      // Product Open v1 stores request_hash on stagehand_calls. Mismatch maps to
      // SCENARIO_VERSION_CONFLICT; in-flight duplicates map to WORKITEM_CHECKOUT_CONFLICT
      // until a dedicated LLM idempotency catalog code exists.
    };

export interface LLMCallIdempotencyStore {
  /**
   * Backed by stagehand_calls idempotency_key/request_hash with unique
   * (tenant_id, idempotency_key). Replay must never re-run LLM side effects.
   */
  reserve(req: LLMRequest): Promise<LLMIdempotencyReservation>;
  complete(callId: string, response: LLMResponse): Promise<void>;
  fail(callId: string, error: AdapterErrorCode): Promise<void>;
}
