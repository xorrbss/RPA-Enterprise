/**
 * Runtime Worker Scaffold Contract v1
 *
 * This is a typed scaffold for the future Graphile/worker runtime. It binds
 * state-machine transitions to DB CAS, outbox, leases, resume tokens, and DLQ
 * without introducing runnable application code.
 *
 * Authoritative contracts:
 * - state-machine.md
 * - db/migration_core_entities.sql
 * - db/migration_concurrency_idempotency.sql
 * - impl-contracts-bundle.md §B, §D, §E
 * - reserved-handlers.md
 */

import type {
  ArtifactRef,
  IRActionType,
  ObjectRef,
  PageStateRef,
  SecretRef,
  StepResult,
  StepStatus,
} from "./core-types";
import type { ErrorCode } from "./error-catalog";
import type {
  EventEnvelopeType,
  HumanTaskEvent,
  HumanTaskGuard,
  HumanTaskKind,
  HumanTaskState,
  RunEvent,
  RunGuard,
  RunState,
  SideEffectCmd,
  TransitionResult,
  WorkitemEvent,
  WorkitemGuard,
  WorkitemState,
} from "./state-machine-types";
import type {
  BypassRlsUseCase,
  CorrelationId,
  LLMCallIdempotencyKey,
  PolicyId,
  RunId,
  StepId,
  TenantId,
} from "./security-middleware-contract";

export type WorkitemId = string & { readonly __brand: "WorkitemId" };
export type HumanTaskId = string & { readonly __brand: "HumanTaskId" };
export type WorkerId = string & { readonly __brand: "WorkerId" };
export type LeaseId = string & { readonly __brand: "LeaseId" };
export type EventId = string & { readonly __brand: "EventId" };
export type IsoDateTime = string & { readonly __brand: "IsoDateTime" };
export type ScenarioGenerationId = string & { readonly __brand: "ScenarioGenerationId" };

export type RuntimeEntityKind = "run" | "workitem" | "human_task";

export type RunEntityRef = { kind: "run"; tenantId: TenantId; id: RunId };
export type WorkitemEntityRef = { kind: "workitem"; tenantId: TenantId; id: WorkitemId };
export type HumanTaskEntityRef = { kind: "human_task"; tenantId: TenantId; id: HumanTaskId };
export type RuntimeEntityRef = RunEntityRef | WorkitemEntityRef | HumanTaskEntityRef;

export interface RunTransitionAttempt {
  entity: RunEntityRef;
  current: RunState;
  event: RunEvent;
  guard: RunGuard;
  transition: TransitionResult<RunState>;
}

export interface WorkitemTransitionAttempt {
  entity: WorkitemEntityRef;
  current: WorkitemState;
  event: WorkitemEvent;
  guard: WorkitemGuard;
  transition: TransitionResult<WorkitemState>;
}

export interface HumanTaskTransitionAttempt {
  entity: HumanTaskEntityRef;
  current: HumanTaskState;
  event: HumanTaskEvent;
  guard: HumanTaskGuard;
  transition: TransitionResult<HumanTaskState>;
}

export type StateMachineCasResult<S> =
  | { kind: "applied"; next: S; sideEffects: readonly SideEffectCmd[]; outbox: readonly OutboxEventDraft[] }
  | { kind: "cas_miss"; latestState?: S; action: "reload_and_reclassify" };

export interface StateMachineCasRepository {
  /**
   * Every apply method must use UPDATE ... WHERE tenant_id=? AND id=? AND
   * status=<current>. A 0-row update is a CAS miss, never a silent no-op.
   * Outbox rows are inserted in the same transaction as the successful state
   * update.
   */
  applyRun(attempt: RunTransitionAttempt): Promise<StateMachineCasResult<RunState>>;
  applyWorkitem(attempt: WorkitemTransitionAttempt): Promise<StateMachineCasResult<WorkitemState>>;
  applyHumanTask(attempt: HumanTaskTransitionAttempt): Promise<StateMachineCasResult<HumanTaskState>>;
}

export interface OutboxEventDraft {
  eventId: EventId;
  eventType: EventEnvelopeType;
  eventVersion: number;
  tenantId: TenantId;
  runId?: RunId;
  workitemId?: WorkitemId;
  stepId?: StepId;
  correlationId: CorrelationId;
  causationId?: EventId;
  orderingKey?: string;
  occurredAt: IsoDateTime;
  idempotencyKey: string;
  payloadSchemaRef: string;
  payload: unknown;
}

export interface OutboxRow extends OutboxEventDraft {
  publishedAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

export type OutboxPublishResult =
  | { kind: "published"; eventId: EventId }
  | { kind: "duplicate"; eventId: EventId; idempotencyKey: string }
  | { kind: "failed"; eventId: EventId; retryable: boolean; reason: string };

export interface OutboxPayloadValidator {
  /**
   * Product Open v1 fixes event_type -> payload_schema_ref and enforces closed
   * empty payload bodies for every tenant events/{event_type}@1 schema.
   */
  validate(payloadSchemaRef: string, payload: unknown): { valid: true } | { valid: false; details: unknown };
}

export interface OutboxRelay {
  pollUnpublished(limit: number): Promise<readonly OutboxRow[]>;
  publish(row: OutboxRow): Promise<OutboxPublishResult>;
  markPublished(eventId: EventId, publishedAt: IsoDateTime): Promise<void>;
}

export type BrowserLeaseState = "reserved" | "active" | "draining" | "expired";
export type CredentialLeaseStatus = "active" | "released" | "expired";
export type LeaseIsolation = "browser" | "context" | "page";
export type LeaseCleanupPolicy = "clear_all" | "preserve_session" | "preserve_downloads";

export interface BrowserLease {
  id: LeaseId;
  tenantId: TenantId;
  siteProfileId: PolicyId;
  browserIdentityId: string;
  runId?: RunId;
  ownerWorkerId: WorkerId;
  isolation: LeaseIsolation;
  state: BrowserLeaseState;
  cleanupPolicy: LeaseCleanupPolicy;
  downloadDirRef?: string;
  heartbeatAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export interface CredentialLease {
  tenantId: TenantId;
  credentialRef: SecretRef;
  siteProfileId: PolicyId;
  slotNo: number;
  runId: RunId;
  workitemId?: WorkitemId;
  status: CredentialLeaseStatus;
  lockedUntil: IsoDateTime;
  acquiredAt: IsoDateTime;
}

export type LeaseAcquireResult<TLease> =
  | { kind: "acquired"; lease: TLease }
  | { kind: "deferred"; code: Extract<ErrorCode, "SESSION_LOCKED">; retryAfterMs: number };

export type LeaseRenewResult =
  | { kind: "renewed"; expiresAt: IsoDateTime }
  | { kind: "lost"; code: Extract<ErrorCode, "BROWSER_LEASE_EXPIRED">; reason: string };

export type CredentialLeaseRenewResult =
  | { kind: "renewed"; lockedUntil: IsoDateTime }
  | { kind: "lost"; code: Extract<ErrorCode, "SESSION_LOCKED">; reason: string };

export interface LeaseManager {
  acquireBrowser(input: {
    tenantId: TenantId;
    runId: RunId;
    siteProfileId: PolicyId;
    browserIdentityId: string;
    workerId: WorkerId;
    isolation: LeaseIsolation;
    cleanupPolicy: LeaseCleanupPolicy;
    ttlMs: number;
  }): Promise<LeaseAcquireResult<BrowserLease>>;

  renewBrowser(input: { tenantId: TenantId; leaseId: LeaseId; workerId: WorkerId; ttlMs: number }): Promise<LeaseRenewResult>;
  drainBrowser(input: {
    tenantId: TenantId;
    leaseId: LeaseId;
    workerId: WorkerId;
    reason: "run_cancelled" | "run_completed" | "run_suspended" | "sweeper";
  }): Promise<void>;

  acquireCredential(input: {
    tenantId: TenantId;
    runId: RunId;
    workitemId?: WorkitemId;
    credentialRef: SecretRef;
    siteProfileId: PolicyId;
    lockedUntil: IsoDateTime;
  }): Promise<LeaseAcquireResult<CredentialLease>>;

  releaseCredential(input: { tenantId: TenantId; credentialRef: SecretRef; siteProfileId: PolicyId; slotNo: number }): Promise<void>;
  renewCredential(input: {
    tenantId: TenantId;
    credentialRef: SecretRef;
    siteProfileId: PolicyId;
    slotNo: number;
    runId: RunId;
    lockedUntil: IsoDateTime;
  }): Promise<CredentialLeaseRenewResult>;
  sweepExpired(now: IsoDateTime): Promise<readonly (BrowserLease | CredentialLease)[]>;
}

export interface ResumeTokenEnvelope {
  runId: RunId;
  resumeNodeId: string;
  pageStateRef: PageStateRef;
  loopContext?: { iteration: number; pageCount: number };
  issuedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  kid: string;
  hmac: string;
}

export type ResumeTokenVerification =
  | { kind: "valid"; token: ResumeTokenEnvelope }
  | { kind: "expired"; code: Extract<ErrorCode, "CHALLENGE_UNRESOLVED">; reason: string }
  | { kind: "invalid"; code: Extract<ErrorCode, "IR_EXPRESSION_RUNTIME">; reason: string };

export interface ResumeTokenCodec {
  /**
   * hmac key material is in SecretStore/KMS only. DB stores the signed envelope,
   * never the signing key.
   */
  issue(input: Omit<ResumeTokenEnvelope, "kid" | "hmac">): Promise<ResumeTokenEnvelope>;
  verify(token: ResumeTokenEnvelope): Promise<ResumeTokenVerification>;
}

export type ResumeTokenRecovery =
  | { kind: "recovered"; token: ResumeTokenEnvelope }
  | ResumeTokenVerification;

export interface ResumeTokenRepository {
  /**
   * Save and recover the signed envelope from runs.resume_token. Implementations
   * must verify hmac/expiry before returning a recoverable token.
   */
  save(input: { tenantId: TenantId; runId: RunId; token: ResumeTokenEnvelope }): Promise<void>;
  recover(input: { tenantId: TenantId; runId: RunId }): Promise<ResumeTokenRecovery>;
}

export interface SessionRestoreInput {
  tenantId: TenantId;
  runId: RunId;
  leaseId: LeaseId;
  workerId: WorkerId;
  correlationId: CorrelationId;
  token: ResumeTokenEnvelope;
  expectedPageStateRef: PageStateRef;
  resumeNodeId: string;
}

export type SessionRestoreResult =
  | { kind: "restored"; pageStateRef: PageStateRef }
  | { kind: "login_bypass"; reason: string }
  | { kind: "terminal_failure"; reason: string }
  | {
      kind: "invalid_token";
      code: Extract<ErrorCode, "CHALLENGE_UNRESOLVED" | "IR_EXPRESSION_RUNTIME">;
      reason: string;
    }
  | {
      kind: "page_state_mismatch";
      actualPageStateRef?: PageStateRef;
      loginBypassPossible: boolean;
      reason: string;
    };

export interface SessionRestorer {
  /**
   * Performs resume_token verification and browser/session restoration outside
   * the DB transaction. HMAC/KMS/SecretStore details remain behind this port.
   */
  restoreSession(input: SessionRestoreInput): Promise<SessionRestoreResult>;
}

export interface RunAbortDrainInput {
  tenantId: TenantId;
  runId: RunId;
  leaseId: LeaseId;
  workerId: WorkerId;
  correlationId: CorrelationId;
  timeoutMs: number;
}

export type RunAbortDrainResult =
  | { kind: "drained" }
  | { kind: "timeout" }
  | { kind: "transient_failed"; retryAfterMs?: number; reason: string }
  | { kind: "terminal_failed"; reason: string };

export interface RunAbortDrainer {
  /**
   * Performs SSE close and browser drain outside the DB transaction. A
   * successful or timed-out result is finalized through R23/R24 by the runtime
   * worker; transient failures leave the run in aborting for Graphile retry.
   */
  drainAbort(input: RunAbortDrainInput): Promise<RunAbortDrainResult>;
}

export interface DeadLetterRecord {
  id: string;
  tenantId: TenantId;
  workitemId?: WorkitemId;
  runId?: RunId;
  reasonCode: ErrorCode;
  evidenceRef?: ArtifactRef;
  replayable: boolean;
  createdAt: IsoDateTime;
  replayedAt?: IsoDateTime;
}

export type DeadLetterReplayResult =
  | { kind: "replayed"; workitemId: WorkitemId; nextState: Extract<WorkitemState, "new"> }
  | { kind: "not_replayable"; code: Extract<ErrorCode, "DEAD_LETTER">; reason: string }
  | { kind: "conflict"; code: Extract<ErrorCode, "WORKITEM_CHECKOUT_CONFLICT">; reason: string };

export interface DeadLetterService {
  create(input: {
    tenantId: TenantId;
    workitemId?: WorkitemId;
    runId?: RunId;
    reasonCode: ErrorCode;
    evidenceRef?: ArtifactRef;
  }): Promise<DeadLetterRecord>;
  replay(input: { tenantId: TenantId; deadLetterId: string; requestedBy: string }): Promise<DeadLetterReplayResult>;
}

export interface StagehandCallRecord {
  id: string;
  tenantId: TenantId;
  runId: RunId;
  stepId: StepId;
  attempt: number;
  idempotencyKey: LLMCallIdempotencyKey;
  requestHash: string;
  model: string;
  transport: "sse" | "sync";
  streamStatus?: "open" | "done" | "aborted" | "error" | "fallback";
  promptTemplateVersion: string;
  inputRedactedRef?: string;
  outputRef?: ArtifactRef;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  ttfbMs?: number;
}

export interface StepExecutionKey {
  tenantId: TenantId;
  runId: RunId;
  stepId: StepId;
  attempt: number;
}

export type RunStepPersistedStatus = "started" | StepStatus;

export interface ExecutorStepAttemptStartInput {
  tenantId: TenantId;
  runId: RunId;
  stepId: StepId;
  nodeId: string;
  action: IRActionType;
  correlationId: CorrelationId;
  startedAt?: IsoDateTime;
}

export interface ExecutorStepAttemptStartResult {
  key: StepExecutionKey;
  runStepId: string;
  emittedEvents: readonly EventId[];
}

export interface ExecutorStepAttemptStore {
  begin(input: ExecutorStepAttemptStartInput): Promise<ExecutorStepAttemptStartResult>;
}

export type ExecutorArtifactRedactionStatus = "pending" | "redacted" | "failed" | "not_required";

export interface ExecutorInvocationArtifactMetadata {
  artifactRef: ArtifactRef;
  objectRef: ObjectRef;
  type: string;
  mediaType?: string;
  filename?: string;
  byteSize?: number;
  durationMs?: number;
  redactionStatus: Extract<ExecutorArtifactRedactionStatus, "pending">;
  retentionUntil: IsoDateTime;
  sha256?: string;
  legalHold?: boolean;
  quarantine?: boolean;
  /**
   * The producer already inserted the artifacts row before step finalization.
   * The recorder must verify the row instead of inserting a duplicate.
   */
  metadataStored?: boolean;
}

export type VisualEvidenceRecordingPolicy = "always" | "masked_on_failure" | "never";
export type VisualEvidenceCaptureKind = "screenshot_png" | "video_webm";
export type VisualEvidenceVideoPolicy = "always" | "failure";

export interface VisualEvidenceCaptureRequest {
  tenantId: TenantId;
  runId: RunId;
  stepId: StepId;
  attempt: number;
  nodeId: string;
  policy: VisualEvidenceRecordingPolicy;
  kind: VisualEvidenceCaptureKind;
}

export interface VisualEvidenceCaptureResult {
  artifactRef: ArtifactRef;
  metadata: ExecutorInvocationArtifactMetadata;
}

export interface VisualEvidenceVideoStartInput {
  tenantId: TenantId;
  runId: RunId;
  leaseId: LeaseId;
  correlationId: CorrelationId;
  policy: VisualEvidenceVideoPolicy;
}

export interface VisualEvidenceVideoStopInput {
  terminal: "success" | "success_empty" | "fail_business" | "fail_system" | "suspend";
}

export interface RunVideoRecording {
  stopAndPersist(input: VisualEvidenceVideoStopInput): Promise<ArtifactRef | undefined>;
  discard(input: { reason: string }): Promise<void>;
}

export interface VisualEvidenceVideoRecorder {
  startRunVideo(input: VisualEvidenceVideoStartInput): Promise<RunVideoRecording>;
}

export const VISUAL_EVIDENCE_CAPTURE_CONTRACT = {
  screenshot: {
    capturePoint: "after_executor_execute",
    cdpMethod: "Page.captureScreenshot",
    artifactType: "screenshot_masked",
    artifactScope: "run_level_step_hint_in_filename",
    mediaType: "image/png",
    redactionStatus: "pending",
    captureMask: "dom_sensitive_fields_and_text_patterns",
    rawUnmaskedScreenshotStored: false,
  },
  video: {
    captureScope: "run",
    captureMethod: "masked_screenshot_frame_sampling_ffmpeg",
    artifactType: "video_masked",
    mediaType: "video/webm",
    redactionStatus: "pending",
    visibilityUntilRedacted: "hidden_by_artifact_rls",
    requiresStartStopLifecyclePort: true,
    requiresFrameOrStreamEvents: false,
    currentCdpSessionSendOnlyPortIsInsufficient: false,
    rawUnmaskedVideoStored: false,
  },
} as const;

export interface ExecutorInvocationRecordInput {
  key: StepExecutionKey;
  nodeId: string;
  correlationId: CorrelationId;
  result: StepResult;
  artifacts: readonly ExecutorInvocationArtifactMetadata[];
}

export interface ExecutorInvocationRecordResult {
  runStepId: string;
  emittedEvents: readonly EventId[];
}

export interface ExecutorInvocationRecorder {
  record(input: ExecutorInvocationRecordInput): Promise<ExecutorInvocationRecordResult>;
}

export type ExecutorOutcomeTransitionPath =
  | "record_only"
  | "terminal_success_R7_R21_W2"
  | "terminal_business_R9_W3"
  | "terminal_system_R8_W4_or_W5"
  | "terminal_security_R10_then_run_abort"
  | "terminal_challenge_R4_then_bookmark_R11"
  | "unsupported_fail_closed";

export const EXECUTOR_OUTCOME_MAPPING_CONTRACT = {
  requiresStartedAttemptBeforeProducerWrites: true,
  pluginExecutionInsideDbTransaction: false,
  finalProducerWritesUseStartedAttemptCas: true,
  stepCompletedRequiresRunStepForeignKey: true,
  systemFailure: {
    acceptedStepStatuses: ["failed_system", "uncertain"],
    requiredExceptionClass: "system",
    requiredErrorCatalogClass: "system",
    runTransition: "R8",
    workitemTransition: "W4_or_W5",
    unknownOutcomeMapsTo: "CONTROL_PLANE_INTERNAL_ERROR",
  },
  securityFailure: {
    acceptedStepStatuses: ["failed_security"],
    requiredExceptionClass: "security",
    requiredErrorCatalogClass: "security",
    runTransition: "R10",
    requiresRunAbortJob: true,
    requiresNotificationPort: true,
  },
  challengeFailure: {
    acceptedStepStatuses: ["failed_challenge"],
    requiredExceptionClass: "challenge",
    requiredErrorCatalogClass: "challenge",
    runTransition: "R4_then_R11",
    requiresSuspensionBookmarkPort: true,
  },
  unsupportedStatusesFailClosed: ["skipped", "suspended"],
} as const;

export const EXECUTOR_AUDIT_EVIDENCE_CONTRACT = {
  securityBoundaryAuditLogReserved: true,
  executorOutcomesMustNotUseSecurityAuditLog: true,
  durableEvidenceAuthorities: [
    "run_steps",
    "events_outbox",
    "stagehand_calls",
    "artifacts",
    "dead_letter",
  ],
  runStepsEvidence: {
    canonicalKey: ["tenant_id", "run_id", "step_id", "attempt"],
    requiresStartedBeforeFinal: true,
    stores: [
      "status",
      "action",
      "cache_mode",
      "action_plan_cache_id",
      "page_state_before",
      "page_state_after",
      "artifacts",
      "stagehand_call_ids",
      "side_effect",
      "exception",
      "started_at",
      "ended_at",
      "duration_ms",
    ],
  },
  eventsEvidence: {
    startedAndCompletedAreStepBound: true,
    terminalRunAndWorkitemEventsUseOutbox: true,
  },
  artifactEvidence: {
    pendingRowsRequireLifecycleJobs: true,
    objectRefInternalOnly: true,
    publicEvidenceUsesArtifactRefOnly: true,
  },
  auditLogAllowedForExecutorOnlyWhen: [
    "security_boundary_decision",
    "artifact_lifecycle_bypassrls_use",
  ],
} as const;

export type ArtifactLifecycleJobKind = "artifact_redaction" | "artifact_retention";
export type ArtifactLifecycleOperationalUseCase = Extract<
  BypassRlsUseCase,
  "artifact_redaction_job" | "artifact_retention_sweeper"
>;
export const ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF = "artifact/object-io-evidence@1" as const;
export const ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF = "artifact/object-io-local-test@1" as const;

export type ArtifactObjectIoOperation = "redact" | "delete";

export interface ArtifactRealObjectStorePortBinding {
  kind: "real_object_store";
  backendAlias: string;
  credentialRef: SecretRef;
  evidenceSchemaRef: typeof ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF;
  /** true only for SecretRef-backed external object-store evidence that may be cited for staging/open. */
  mayBeUsedAsStagingEvidence: boolean;
}

export interface ArtifactLocalTestPortBinding {
  kind: "test_fake";
  backendAlias: "local-test-fake";
  evidenceSchemaRef: typeof ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF;
  testOnly: true;
}

export type ArtifactObjectIoPortBinding =
  | ArtifactRealObjectStorePortBinding
  | ArtifactLocalTestPortBinding;

export type ArtifactObjectIoEvidence =
  | {
      schemaRef: typeof ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF;
      portKind: "real_object_store";
      backendAlias: string;
      credentialRef: SecretRef;
      operation: ArtifactObjectIoOperation;
      artifactRef: ArtifactRef;
      correlationId: CorrelationId;
      receiptId: string;
      objectRefInternalOnly: true;
      mayBeUsedAsStagingEvidence: boolean;
      sha256?: string;
    }
  | {
      schemaRef: typeof ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF;
      portKind: "test_fake";
      backendAlias: "local-test-fake";
      operation: ArtifactObjectIoOperation;
      artifactRef: ArtifactRef;
      correlationId: CorrelationId;
      receiptId: string;
      objectRefInternalOnly: true;
      mayBeUsedAsStagingEvidence: false;
      sha256?: string;
    };

export interface ArtifactLifecycleTarget {
  tenantId: TenantId;
  artifactRef: ArtifactRef;
  objectRef: ObjectRef;
  runId?: RunId;
  generationId?: ScenarioGenerationId;
  stepId?: StepId;
  attempt?: number;
  type: string;
  redactionStatus: ExecutorArtifactRedactionStatus;
  redactionAttempts: number;
  sha256?: string;
  retentionUntil?: IsoDateTime;
  legalHold: boolean;
  quarantine: boolean;
  deletedAt?: IsoDateTime;
  deletedReason?: string;
  deletedByJob?: string;
}

export interface ArtifactLifecycleOperationalAudit {
  useCase: ArtifactLifecycleOperationalUseCase;
  action: "bypassrls.use";
  failClosed: true;
  correlationId: CorrelationId;
  reasonCode: string;
}

export type ArtifactLifecycleClaimId = string & { readonly __brand: "ArtifactLifecycleClaimId" };
export type ArtifactLifecyclePhase = "claim" | "object_io" | "finalize";

export interface ArtifactLifecycleClaimLease {
  claimId: ArtifactLifecycleClaimId;
  jobKind: ArtifactLifecycleJobKind;
  tenantId: TenantId;
  artifactRef: ArtifactRef;
  workerId: WorkerId;
  correlationId: CorrelationId;
  claimedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  audit: ArtifactLifecycleOperationalAudit;
  artifactSnapshot: ArtifactLifecycleTarget;
}

export type ArtifactLifecycleFinalizeOutcome =
  | { kind: "redacted"; redactedObjectRef: ObjectRef; sha256?: string }
  | { kind: "not_required"; reason: string }
  | { kind: "redaction_failed"; terminal: boolean; reason: string; evidenceRef?: ArtifactRef }
  | { kind: "retention_deleted"; deleteResult: "deleted" | "not_found"; deletedReason: "retention_expired" }
  | { kind: "retention_transient_failed"; reason: string };

export interface ArtifactLifecycleFinalizeRequest {
  tenantId: TenantId;
  claim: ArtifactLifecycleClaimLease;
  outcome: ArtifactLifecycleFinalizeOutcome;
}

export interface ArtifactRedactionPolicy {
  maxAttempts: number;
}

export interface ArtifactRedactionRequest {
  tenantId: TenantId;
  correlationId: CorrelationId;
  artifact: ArtifactLifecycleTarget;
  policy: ArtifactRedactionPolicy;
  portBinding: ArtifactObjectIoPortBinding;
  audit: ArtifactLifecycleOperationalAudit & { useCase: "artifact_redaction_job" };
}

export type ArtifactRedactionDecision =
  | { kind: "redacted"; redactedObjectRef: ObjectRef; sha256: string; evidence: ArtifactObjectIoEvidence }
  | { kind: "not_required"; reason: string; evidence: ArtifactObjectIoEvidence }
  | { kind: "retryable_failed"; reason: string; evidence?: ArtifactObjectIoEvidence }
  | { kind: "terminal_failed"; reason: string; evidence?: ArtifactObjectIoEvidence; evidenceRef?: ArtifactRef };

export interface ArtifactRedactor {
  readonly binding: ArtifactObjectIoPortBinding;
  /**
   * Reads the internal ObjectRef and writes a redaction-safe object/ref behind
   * this port. Public events/logs/audit payloads must use ArtifactRef only.
   * `test_fake` bindings are local fixture evidence only and cannot satisfy
   * staging/product-open object-store evidence.
   */
  redact(input: ArtifactRedactionRequest): Promise<ArtifactRedactionDecision>;
}

export interface ArtifactRetentionPolicy {
  deleteReason: "retention_expired";
}

export interface ArtifactRetentionDeleteRequest {
  tenantId: TenantId;
  correlationId: CorrelationId;
  artifact: ArtifactLifecycleTarget;
  jobId: string;
  policy: ArtifactRetentionPolicy;
  portBinding: ArtifactObjectIoPortBinding;
  audit: ArtifactLifecycleOperationalAudit & { useCase: "artifact_retention_sweeper" };
}

export type ArtifactRetentionDeleteResult =
  | { kind: "deleted"; evidence: ArtifactObjectIoEvidence }
  | { kind: "not_found"; evidence: ArtifactObjectIoEvidence }
  | { kind: "transient_failed"; reason: string };

export interface ArtifactRetentionStore {
  readonly binding: ArtifactObjectIoPortBinding;
  /**
   * Deletes the internal object. `deleted` and `not_found` are idempotent
   * success; `transient_failed` must not set artifacts.deleted_at. `test_fake`
   * bindings are local fixture evidence only and cannot satisfy staging/product
   * object deletion evidence.
   */
  deleteObject(input: ArtifactRetentionDeleteRequest): Promise<ArtifactRetentionDeleteResult>;
}

export const ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT = {
  requiresTenantScopedSql: true,
  applicationRoleMayBypassRls: false,
  applicationRoleMayMutatePendingArtifacts: false,
  requiresDedicatedBypassRlsUseCases: [
    "artifact_redaction_job",
    "artifact_retention_sweeper",
  ],
  requiresAuditBeforeMutation: true,
  auditAction: "bypassrls.use",
  auditFailClosed: true,
  operationalRole: {
    requiresNonSuperuser: true,
    mayServeUserTraffic: false,
  },
  objectRefInternalOnly: true,
  publicEvidenceUsesArtifactRefOnly: true,
  objectRefMayReachLogs: false,
  objectIoEvidence: {
    realSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
    localTestSchemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
    realPortRequiresSecretRef: true,
    realPortStagingEvidenceMustBeExplicit: true,
    localFilesystemMayBeUsedAsStagingEvidence: false,
    localTestPortMayBeUsedAsStagingEvidence: false,
    successEvidenceRequiredBeforeFinalize: true,
    evidenceMayContainObjectRef: false,
    evidenceMayContainSecretRefIdentifier: true,
    evidenceMayContainPlainSecret: false,
  },
  claimLease: {
    requiredBeforeObjectIo: true,
    persistedOnArtifactRow: true,
    applicationInsertMaySetClaimLease: false,
    uniqueClaimIdPerTenant: true,
    workerAndCorrelationBound: true,
    shortDbTransactionOnly: true,
    expiresAtRequired: true,
    staleLeaseMayBeReclaimed: true,
    activeUnexpiredClaimDefers: true,
    retryAfterRequired: true,
    objectIoInsideClaimTransaction: false,
  },
  finalizeCas: {
    requiredAfterObjectIo: true,
    requiresClaimId: true,
    requiresUnexpiredClaim: true,
    tenantScoped: true,
    staleObjectIoResultMustNotFinalize: true,
    objectIoInsideFinalizeTransaction: false,
    unknownPortResultFailClosed: true,
    portExceptionMessageMayReachLogs: false,
  },
  redactionClaim: {
    redactionStatus: "pending",
    deletedAt: null,
    quarantine: false,
  },
  redactionFinalizePredicate: {
    redactionStatus: "pending",
    deletedAt: null,
    quarantine: false,
  },
  retentionClaim: {
    deletedAt: null,
    legalHold: false,
    quarantine: false,
    retentionUntil: "past_required",
  },
  retentionFinalizePredicate: {
    deletedAt: null,
    legalHold: false,
    quarantine: false,
    retentionUntil: "past_required",
  },
  retentionSuccessKinds: ["deleted", "not_found"],
  retentionFailureMustNotTombstone: true,
} as const;

// ============================================================================
// D6 — Sink delivery port (데이터평면 외부 전달)
//
// sink_deliveries 외부 전달의 주입형 포트. artifact object-I/O 포트와 동형(real|test_fake):
// real_sink는 SecretRef-backed 실 다운스트림 전달(외부 사실 — staging 증거), test_fake는 로컬 픽스처
// 증거 전용(staging 증거 불가). DB측 멱등키/attempt 원장/status CAS/DLQ/이벤트는 결정형(app/ 내 빌드),
// 실 네트워크 전송만 외부 경계로 남는다.
//
// sink_idempotency_key = `tenant_id:sink_config_id:schema_ref:natural_key`(attempt_no 제외 — 같은
// 레코드의 모든 attempt가 동일 키를 보내 외부가 1건으로 흡수). 제어평면 Idempotency-Key와 다른 계층
// (api-surface §0.4).
// ============================================================================
export const SINK_DELIVERY_EVIDENCE_SCHEMA_REF = "sink/delivery-evidence@1" as const;
export const SINK_DELIVERY_LOCAL_TEST_SCHEMA_REF = "sink/delivery-local-test@1" as const;

export interface SinkRealDeliveryPortBinding {
  kind: "real_sink";
  backendAlias: string;
  credentialRef: SecretRef;
  evidenceSchemaRef: typeof SINK_DELIVERY_EVIDENCE_SCHEMA_REF;
}

export interface SinkLocalTestPortBinding {
  kind: "test_fake";
  backendAlias: "local-test-fake";
  evidenceSchemaRef: typeof SINK_DELIVERY_LOCAL_TEST_SCHEMA_REF;
  testOnly: true;
}

export type SinkDeliveryPortBinding = SinkRealDeliveryPortBinding | SinkLocalTestPortBinding;

/**
 * sink attempt 상한 정책. attempt_no < maxAttempts 실패 → 'failed'(재전달 가능),
 * attempt_no >= maxAttempts 실패 → 'dead_letter'. 값 출처 = ops-defaults.md#sink.delivery
 * (release-decisions #14: workitem retry family 정렬). 코드에 상수 하드코딩 금지 — 주입형.
 */
export interface SinkDeliveryPolicy {
  source: "ops-defaults.md#sink.delivery";
  maxAttempts: number;
}

export interface SinkDeliveryRequest {
  tenantId: TenantId;
  correlationId: CorrelationId;
  sinkConfigId: string;
  sinkIdempotencyKey: string;
  normalizedRecordId: string;
  attemptNo: number;
  portBinding: SinkDeliveryPortBinding;
}

export type SinkDeliveryDecision =
  | { kind: "delivered"; receiptRef?: string }
  | { kind: "transient_failed"; reason: string };

export interface SinkDeliveryPort {
  readonly binding: SinkDeliveryPortBinding;
  /**
   * 외부 다운스트림에 1건 전달(sinkIdempotencyKey를 외부 Idempotency-Key로 사용). delivered 또는
   * transient_failed만 반환 — dead_letter(상한 도달)는 호출측 SinkDeliveryPolicy가 판정한다. SINK_DELIVERY_FAILED는
   * retryable이므로 포트는 영구실패를 표현하지 않고, 영구성은 attempt 상한 소진으로 표현된다. test_fake 바인딩은
   * 로컬 픽스처 증거 전용이며 staging/product-open 전달 증거가 될 수 없다.
   */
  deliver(input: SinkDeliveryRequest): Promise<SinkDeliveryDecision>;
}

export interface RuntimeWorkerJob {
  kind:
    | "run_claim"
    | "run_abort"
    | "run_resume"
    | "workitem_checkout"
    | "outbox_relay"
    | "lease_sweeper"
    | "workitem_checkout_sweeper"
    | "artifact_redaction"
    | "artifact_retention"
    | "dlq_replay"
    | "sink_deliver";
  tenantId?: TenantId;
  runId?: RunId;
  artifactId?: ArtifactRef;
  generationId?: ScenarioGenerationId;
  workitemId?: WorkitemId;
  deadLetterId?: string;
  correlationId?: CorrelationId;
  abortTimeoutMs?: number;
  /**
   * sink_deliver 잡 입력(closed, release-decision #9). 데이터평면 외부 전달 대상.
   * schema_ref/natural_key는 잡에 싣지 않는다 — sink_idempotency_key는 normalized_records 행의
   * 권위 컬럼에서 산출하므로(FIX#7) 페이로드 중복은 stale 키 위험만 만든다.
   */
  sinkDelivery?: {
    sinkConfigId: string;
    normalizedRecordId: string;
  };
}

export type RuntimeJobResult =
  | { kind: "completed"; emittedEvents: readonly EventId[] }
  | { kind: "deferred"; retryAfterMs: number; code?: ErrorCode }
  | { kind: "failed"; code: ErrorCode; evidenceRef?: ArtifactRef };

export interface RuntimeWorker {
  handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult>;
}
