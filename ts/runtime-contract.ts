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

import type { ArtifactRef, PageStateRef, SecretRef } from "./core-types";
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

  renewBrowser(input: { leaseId: LeaseId; workerId: WorkerId; ttlMs: number }): Promise<LeaseRenewResult>;
  drainBrowser(input: { leaseId: LeaseId; workerId: WorkerId; reason: "run_cancelled" | "run_completed" | "sweeper" }): Promise<void>;

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
  model: string;
  transport: "sse" | "sync";
  streamStatus?: "open" | "done" | "aborted" | "error" | "fallback";
  promptTemplateVersion: string;
  inputRedactedRef?: string;
  outputRef?: ArtifactRef;
  idempotencyKey?: LLMCallIdempotencyKey;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  ttfbMs?: number;
}

export interface RuntimeWorkerJob {
  kind:
    | "run_claim"
    | "run_resume"
    | "workitem_checkout"
    | "outbox_relay"
    | "lease_sweeper"
    | "artifact_redaction"
    | "artifact_retention"
    | "dlq_replay";
  tenantId?: TenantId;
  runId?: RunId;
  workitemId?: WorkitemId;
  deadLetterId?: string;
  correlationId?: CorrelationId;
}

export type RuntimeJobResult =
  | { kind: "completed"; emittedEvents: readonly EventId[] }
  | { kind: "deferred"; retryAfterMs: number; code?: ErrorCode }
  | { kind: "failed"; code: ErrorCode; evidenceRef?: ArtifactRef };

export interface RuntimeWorker {
  handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult>;
}
