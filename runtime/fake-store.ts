/**
 * Contract-backed in-memory runtime scaffold.
 *
 * This is not a production runtime. It is a deterministic fake for proving the
 * worker/storage contracts before the Graphile/Postgres implementation exists.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  transitionHumanTask,
  transitionRun,
  transitionWorkitem,
} from "../codegen/transitions";
import { EVENT_PAYLOAD_SCHEMA_REFS } from "../codegen/event-payload-registry";
import type { EventType } from "../codegen/types";
import type { ArtifactRef, SecretRef } from "../ts/core-types";
import type { ErrorCode } from "../ts/error-catalog";
import type {
  HumanTaskEvent,
  HumanTaskGuard,
  HumanTaskKind,
  HumanTaskState,
  RunEvent,
  RunGuard,
  RunState,
  SideEffectCmd,
  WorkitemEvent,
  WorkitemGuard,
  WorkitemState,
} from "../ts/state-machine-types";
import type {
  BrowserLease,
  CredentialLease,
  CredentialLeaseRenewResult,
  DeadLetterRecord,
  DeadLetterReplayResult,
  DeadLetterService,
  EventId,
  HumanTaskEntityRef,
  HumanTaskId,
  HumanTaskTransitionAttempt,
  IsoDateTime,
  LeaseAcquireResult,
  LeaseCleanupPolicy,
  LeaseId,
  LeaseIsolation,
  LeaseManager,
  LeaseRenewResult,
  OutboxEventDraft,
  OutboxPayloadValidator,
  OutboxPublishResult,
  OutboxRelay,
  OutboxRow,
  ResumeTokenCodec,
  ResumeTokenEnvelope,
  ResumeTokenRecovery,
  ResumeTokenRepository,
  ResumeTokenVerification,
  RuntimeJobResult,
  RuntimeWorker,
  RuntimeWorkerJob,
  StateMachineCasRepository,
  StateMachineCasResult,
  WorkitemEntityRef,
  WorkitemId,
  WorkitemTransitionAttempt,
  WorkerId,
  RunEntityRef,
  RunTransitionAttempt,
} from "../ts/runtime-contract";
import type {
  CorrelationId,
  PolicyId,
  RunId,
  TenantId,
} from "../ts/security-middleware-contract";

export interface RuntimeFakeOptions {
  nowMs?: number;
  resumeKid?: string;
  resumeSigningKey?: string;
  defaultCredentialMaxConcurrency?: number;
}

export interface RunRow {
  tenantId: TenantId;
  id: RunId;
  status: RunState;
  correlationId: CorrelationId;
  workitemId?: WorkitemId;
  workerId?: WorkerId;
  attempts: number;
  resumeToken?: ResumeTokenEnvelope;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  endedAt?: IsoDateTime;
}

export interface WorkitemRow {
  tenantId: TenantId;
  id: WorkitemId;
  status: WorkitemState;
  correlationId: CorrelationId;
  connectorId: string;
  uniqueReference: string;
  attempts: number;
  checkedOutBy?: WorkerId;
  checkedOutAt?: IsoDateTime;
  checkoutExpiresAt?: IsoDateTime;
  checkoutPausedAt?: IsoDateTime;
  evidenceRef?: ArtifactRef;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface HumanTaskRow {
  tenantId: TenantId;
  id: HumanTaskId;
  runId: RunId;
  state: HumanTaskState;
  kind: HumanTaskKind;
  correlationId: CorrelationId;
  onTimeout: "fail" | "escalate";
  assignee?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type RuntimeRelayResult = {
  rows: readonly OutboxRow[];
  results: readonly OutboxPublishResult[];
};

type RuntimeEntityRow = RunRow | WorkitemRow | HumanTaskRow;

type CredentialPolicyKey = `${string}:${string}:${string}`;
type CredentialLeaseKey = `${CredentialPolicyKey}:${number}`;

export class InMemoryRuntimeStore
  implements
    StateMachineCasRepository,
    OutboxRelay,
    OutboxPayloadValidator,
    LeaseManager,
    ResumeTokenCodec,
    ResumeTokenRepository,
    DeadLetterService
{
  private nowMs: number;
  private sequence = 1;
  private readonly resumeKid: string;
  private readonly resumeSigningKey: string;
  private readonly defaultCredentialMaxConcurrency: number;

  private readonly runs = new Map<string, RunRow>();
  private readonly workitems = new Map<string, WorkitemRow>();
  private readonly humanTasks = new Map<string, HumanTaskRow>();
  private readonly outbox = new Map<string, OutboxRow>();
  private readonly outboxOrder: EventId[] = [];
  private readonly outboxIdempotency = new Map<string, EventId>();
  private readonly deliveredIdempotency = new Set<string>();
  private readonly browserLeases = new Map<string, BrowserLease>();
  private readonly credentialPolicies = new Map<CredentialPolicyKey, number>();
  private readonly credentialLeases = new Map<CredentialLeaseKey, CredentialLease>();
  private readonly deadLetters = new Map<string, DeadLetterRecord>();

  public readonly publishedEvents: OutboxRow[] = [];

  constructor(options: RuntimeFakeOptions = {}) {
    this.nowMs = options.nowMs ?? Date.parse("2026-06-13T00:00:00.000Z");
    this.resumeKid = options.resumeKid ?? "fixture-kid";
    this.resumeSigningKey = options.resumeSigningKey ?? "fixture-resume-hmac-key";
    this.defaultCredentialMaxConcurrency =
      options.defaultCredentialMaxConcurrency ?? 1;
  }

  now(): IsoDateTime {
    return new Date(this.nowMs).toISOString() as IsoDateTime;
  }

  advanceMs(ms: number): IsoDateTime {
    this.nowMs += ms;
    return this.now();
  }

  seedRun(input: {
    tenantId: TenantId;
    id: RunId;
    status?: RunState;
    correlationId?: CorrelationId;
    workitemId?: WorkitemId;
    attempts?: number;
  }): RunRow {
    const now = this.now();
    const row: RunRow = {
      tenantId: input.tenantId,
      id: input.id,
      status: input.status ?? "queued",
      correlationId: input.correlationId ?? (input.id as unknown as CorrelationId),
      workitemId: input.workitemId,
      attempts: input.attempts ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(entityKey(input.tenantId, input.id), row);
    return { ...row };
  }

  seedWorkitem(input: {
    tenantId: TenantId;
    id: WorkitemId;
    status?: WorkitemState;
    correlationId?: CorrelationId;
    connectorId?: string;
    uniqueReference?: string;
    attempts?: number;
  }): WorkitemRow {
    const now = this.now();
    const row: WorkitemRow = {
      tenantId: input.tenantId,
      id: input.id,
      status: input.status ?? "new",
      correlationId: input.correlationId ?? (input.id as unknown as CorrelationId),
      connectorId: input.connectorId ?? "fixture-connector",
      uniqueReference: input.uniqueReference ?? String(input.id),
      attempts: input.attempts ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.workitems.set(entityKey(input.tenantId, input.id), row);
    return { ...row };
  }

  seedHumanTask(input: {
    tenantId: TenantId;
    id: HumanTaskId;
    runId: RunId;
    state?: HumanTaskState;
    kind?: HumanTaskKind;
    correlationId?: CorrelationId;
    onTimeout?: "fail" | "escalate";
  }): HumanTaskRow {
    const now = this.now();
    const row: HumanTaskRow = {
      tenantId: input.tenantId,
      id: input.id,
      runId: input.runId,
      state: input.state ?? "open",
      kind: input.kind ?? "exception",
      correlationId: input.correlationId ?? (input.runId as unknown as CorrelationId),
      onTimeout: input.onTimeout ?? "fail",
      createdAt: now,
      updatedAt: now,
    };
    this.humanTasks.set(entityKey(input.tenantId, input.id), row);
    return { ...row };
  }

  getRun(tenantId: TenantId, runId: RunId): RunRow | undefined {
    const row = this.runs.get(entityKey(tenantId, runId));
    return row ? { ...row } : undefined;
  }

  getWorkitem(tenantId: TenantId, workitemId: WorkitemId): WorkitemRow | undefined {
    const row = this.workitems.get(entityKey(tenantId, workitemId));
    return row ? { ...row } : undefined;
  }

  getHumanTask(tenantId: TenantId, humanTaskId: HumanTaskId): HumanTaskRow | undefined {
    const row = this.humanTasks.get(entityKey(tenantId, humanTaskId));
    return row ? { ...row } : undefined;
  }

  getOutboxRows(): readonly OutboxRow[] {
    return this.outboxOrder
      .map((eventId) => this.outbox.get(eventId))
      .filter((row): row is OutboxRow => row !== undefined)
      .map((row) => ({ ...row }));
  }

  getDeadLetters(): readonly DeadLetterRecord[] {
    return [...this.deadLetters.values()].map((row) => ({ ...row }));
  }

  getBrowserLeases(): readonly BrowserLease[] {
    return [...this.browserLeases.values()].map((row) => ({ ...row }));
  }

  getCredentialLeases(): readonly CredentialLease[] {
    return [...this.credentialLeases.values()].map((row) => ({ ...row }));
  }

  async applyRunEvent(input: {
    tenantId: TenantId;
    runId: RunId;
    event: RunEvent;
    guard?: RunGuard;
    expectedState?: RunState;
  }): Promise<StateMachineCasResult<RunState>> {
    const row = this.runs.get(entityKey(input.tenantId, input.runId));
    if (!row) return { kind: "cas_miss", action: "reload_and_reclassify" };
    const current = input.expectedState ?? row.status;
    const guard = input.guard ?? {};
    const transition = transitionRun(current, input.event, guard);
    return this.applyRun({
      entity: { kind: "run", tenantId: input.tenantId, id: input.runId },
      current,
      event: input.event,
      guard,
      transition,
    });
  }

  async applyWorkitemEvent(input: {
    tenantId: TenantId;
    workitemId: WorkitemId;
    event: WorkitemEvent;
    guard?: WorkitemGuard;
    expectedState?: WorkitemState;
  }): Promise<StateMachineCasResult<WorkitemState>> {
    const row = this.workitems.get(entityKey(input.tenantId, input.workitemId));
    if (!row) return { kind: "cas_miss", action: "reload_and_reclassify" };
    const current = input.expectedState ?? row.status;
    const guard = input.guard ?? {};
    const transition = transitionWorkitem(current, input.event, guard);
    return this.applyWorkitem({
      entity: { kind: "workitem", tenantId: input.tenantId, id: input.workitemId },
      current,
      event: input.event,
      guard,
      transition,
    });
  }

  async applyHumanTaskEvent(input: {
    tenantId: TenantId;
    humanTaskId: HumanTaskId;
    event: HumanTaskEvent;
    guard?: HumanTaskGuard;
    expectedState?: HumanTaskState;
  }): Promise<StateMachineCasResult<HumanTaskState>> {
    const row = this.humanTasks.get(entityKey(input.tenantId, input.humanTaskId));
    if (!row) return { kind: "cas_miss", action: "reload_and_reclassify" };
    const current = input.expectedState ?? row.state;
    const guard = input.guard ?? {};
    const transition = transitionHumanTask(current, input.event, guard);
    return this.applyHumanTask({
      entity: { kind: "human_task", tenantId: input.tenantId, id: input.humanTaskId },
      current,
      event: input.event,
      guard,
      transition,
    });
  }

  async applyRun(attempt: RunTransitionAttempt): Promise<StateMachineCasResult<RunState>> {
    const row = this.runs.get(entityKey(attempt.entity.tenantId, attempt.entity.id));
    if (!row || row.status !== attempt.current) {
      return {
        kind: "cas_miss",
        latestState: row?.status,
        action: "reload_and_reclassify",
      };
    }

    const outbox = this.appendOutboxDrafts(
      this.outboxDraftsForTransition(attempt.entity, row, attempt.event.type, attempt.transition.sideEffects),
    );
    row.status = attempt.transition.next;
    row.updatedAt = this.now();
    this.applyRunSideEffects(row, attempt);
    return {
      kind: "applied",
      next: row.status,
      sideEffects: attempt.transition.sideEffects,
      outbox,
    };
  }

  async applyWorkitem(
    attempt: WorkitemTransitionAttempt,
  ): Promise<StateMachineCasResult<WorkitemState>> {
    const row = this.workitems.get(entityKey(attempt.entity.tenantId, attempt.entity.id));
    if (!row || row.status !== attempt.current) {
      return {
        kind: "cas_miss",
        latestState: row?.status,
        action: "reload_and_reclassify",
      };
    }

    const outbox = this.appendOutboxDrafts(
      this.outboxDraftsForTransition(attempt.entity, row, attempt.event.type, attempt.transition.sideEffects),
    );
    row.status = attempt.transition.next;
    row.updatedAt = this.now();
    this.applyWorkitemSideEffects(row, attempt);
    this.createDlqForSideEffect(row, attempt.transition.sideEffects);
    return {
      kind: "applied",
      next: row.status,
      sideEffects: attempt.transition.sideEffects,
      outbox,
    };
  }

  async applyHumanTask(
    attempt: HumanTaskTransitionAttempt,
  ): Promise<StateMachineCasResult<HumanTaskState>> {
    const row = this.humanTasks.get(entityKey(attempt.entity.tenantId, attempt.entity.id));
    if (!row || row.state !== attempt.current) {
      return {
        kind: "cas_miss",
        latestState: row?.state,
        action: "reload_and_reclassify",
      };
    }

    const outbox = this.appendOutboxDrafts(
      this.outboxDraftsForTransition(attempt.entity, row, attempt.event.type, attempt.transition.sideEffects),
    );
    row.state = attempt.transition.next;
    row.updatedAt = this.now();
    this.applyHumanTaskSideEffects(row, attempt);
    return {
      kind: "applied",
      next: row.state,
      sideEffects: attempt.transition.sideEffects,
      outbox,
    };
  }

  appendOutboxDrafts(drafts: readonly OutboxEventDraft[]): readonly OutboxEventDraft[] {
    const inserted: OutboxEventDraft[] = [];
    for (const draft of drafts) {
      const idempotencyKey = tenantScopedKey(draft.tenantId, draft.idempotencyKey);
      if (this.outboxIdempotency.has(idempotencyKey)) continue;
      const row: OutboxRow = { ...draft, createdAt: this.now() };
      this.outbox.set(row.eventId, row);
      this.outboxOrder.push(row.eventId);
      this.outboxIdempotency.set(idempotencyKey, row.eventId);
      inserted.push(draft);
    }
    return inserted;
  }

  async pollUnpublished(limit: number): Promise<readonly OutboxRow[]> {
    return this.outboxOrder
      .map((eventId) => this.outbox.get(eventId))
      .filter((row): row is OutboxRow => row !== undefined && row.publishedAt === undefined)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async publish(row: OutboxRow): Promise<OutboxPublishResult> {
    if (row.payloadSchemaRef !== EVENT_PAYLOAD_SCHEMA_REFS[row.eventType as EventType]) {
      return {
        kind: "failed",
        eventId: row.eventId,
        retryable: false,
        reason: "event_type and payload_schema_ref mismatch",
      };
    }

    const validation = this.validate(row.payloadSchemaRef, row.payload);
    if (!validation.valid) {
      return {
        kind: "failed",
        eventId: row.eventId,
        retryable: false,
        reason: "payload_schema_ref or placeholder payload shape rejected",
      };
    }

    const deliveryKey = tenantScopedKey(row.tenantId, row.idempotencyKey);
    if (this.deliveredIdempotency.has(deliveryKey)) {
      return { kind: "duplicate", eventId: row.eventId, idempotencyKey: row.idempotencyKey };
    }

    this.deliveredIdempotency.add(deliveryKey);
    this.publishedEvents.push({ ...row });
    return { kind: "published", eventId: row.eventId };
  }

  async markPublished(eventId: EventId, publishedAt: IsoDateTime): Promise<void> {
    const row = this.outbox.get(eventId);
    if (!row || row.publishedAt !== undefined) return;
    row.publishedAt = publishedAt;
  }

  async relayOutboxBatch(limit: number): Promise<RuntimeRelayResult> {
    const rows = await this.pollUnpublished(limit);
    const results: OutboxPublishResult[] = [];
    for (const row of rows) {
      const result = await this.publish(row);
      results.push(result);
      if (result.kind === "published" || result.kind === "duplicate") {
        await this.markPublished(row.eventId, this.now());
      }
    }
    return { rows, results };
  }

  validate(payloadSchemaRef: string, payload: unknown): { valid: true } | { valid: false; details: unknown } {
    const refs = new Set<string>(Object.values(EVENT_PAYLOAD_SCHEMA_REFS));
    if (!refs.has(payloadSchemaRef)) {
      return { valid: false, details: { reason: "unknown_payload_schema_ref", payloadSchemaRef } };
    }
    if (!isPlainObject(payload) || Object.keys(payload).length !== 0) {
      return {
        valid: false,
        details: {
          reason: "payload_body_not_allowed_v1",
          decision: "events/{event_type}@1 payload bodies are closed empty objects in v1",
        },
      };
    }
    return { valid: true };
  }

  async acquireBrowser(input: {
    tenantId: TenantId;
    runId: RunId;
    siteProfileId: PolicyId;
    browserIdentityId: string;
    workerId: WorkerId;
    isolation: LeaseIsolation;
    cleanupPolicy: LeaseCleanupPolicy;
    ttlMs: number;
  }): Promise<LeaseAcquireResult<BrowserLease>> {
    const active = [...this.browserLeases.values()].find(
      (lease) =>
        lease.tenantId === input.tenantId &&
        lease.siteProfileId === input.siteProfileId &&
        lease.browserIdentityId === input.browserIdentityId &&
        (lease.state === "reserved" || lease.state === "active"),
    );
    if (active && !this.isExpired(active.expiresAt)) {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: this.msUntil(active.expiresAt) };
    }
    if (active && this.isExpired(active.expiresAt)) active.state = "expired";

    const lease: BrowserLease = {
      id: this.nextId<LeaseId>(),
      tenantId: input.tenantId,
      siteProfileId: input.siteProfileId,
      browserIdentityId: input.browserIdentityId,
      runId: input.runId,
      ownerWorkerId: input.workerId,
      isolation: input.isolation,
      state: "active",
      cleanupPolicy: input.cleanupPolicy,
      heartbeatAt: this.now(),
      expiresAt: this.isoAfter(input.ttlMs),
    };
    this.browserLeases.set(lease.id, lease);
    return { kind: "acquired", lease: { ...lease } };
  }

  async renewBrowser(input: {
    tenantId: TenantId;
    leaseId: LeaseId;
    workerId: WorkerId;
    ttlMs: number;
  }): Promise<LeaseRenewResult> {
    const lease = this.browserLeases.get(input.leaseId);
    if (
      !lease ||
      lease.tenantId !== input.tenantId ||
      lease.ownerWorkerId !== input.workerId ||
      (lease.state !== "reserved" && lease.state !== "active") ||
      this.isExpired(lease.expiresAt)
    ) {
      return {
        kind: "lost",
        code: "BROWSER_LEASE_EXPIRED",
        reason: "lease missing, owned by another worker, drained, or expired",
      };
    }
    lease.state = "active";
    lease.heartbeatAt = this.now();
    lease.expiresAt = this.isoAfter(input.ttlMs);
    return { kind: "renewed", expiresAt: lease.expiresAt };
  }

  async drainBrowser(input: {
    tenantId: TenantId;
    leaseId: LeaseId;
    workerId: WorkerId;
    reason: "run_cancelled" | "run_completed" | "run_suspended" | "sweeper";
  }): Promise<void> {
    const lease = this.browserLeases.get(input.leaseId);
    if (!lease || lease.tenantId !== input.tenantId || lease.ownerWorkerId !== input.workerId) return;
    lease.state = input.reason === "sweeper" ? "expired" : "draining";
    lease.expiresAt = this.now();
  }

  setCredentialMaxConcurrency(input: {
    tenantId: TenantId;
    credentialRef: SecretRef;
    siteProfileId: PolicyId;
    maxConcurrency: number;
  }): void {
    this.credentialPolicies.set(
      credentialPolicyKey(input.tenantId, input.credentialRef, input.siteProfileId),
      input.maxConcurrency,
    );
  }

  async acquireCredential(input: {
    tenantId: TenantId;
    runId: RunId;
    workitemId?: WorkitemId;
    credentialRef: SecretRef;
    siteProfileId: PolicyId;
    lockedUntil: IsoDateTime;
  }): Promise<LeaseAcquireResult<CredentialLease>> {
    const policyKey = credentialPolicyKey(input.tenantId, input.credentialRef, input.siteProfileId);
    const maxConcurrency = this.credentialPolicies.get(policyKey) ?? this.defaultCredentialMaxConcurrency;

    for (let slotNo = 0; slotNo < maxConcurrency; slotNo += 1) {
      const key = credentialLeaseKey(policyKey, slotNo);
      const existing = this.credentialLeases.get(key);
      if (
        existing &&
        existing.status === "active" &&
        !this.isExpired(existing.lockedUntil)
      ) {
        continue;
      }

      const lease: CredentialLease = {
        tenantId: input.tenantId,
        credentialRef: input.credentialRef,
        siteProfileId: input.siteProfileId,
        slotNo,
        runId: input.runId,
        workitemId: input.workitemId,
        status: "active",
        lockedUntil: input.lockedUntil,
        acquiredAt: this.now(),
      };
      this.credentialLeases.set(key, lease);
      return { kind: "acquired", lease: { ...lease } };
    }

    return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: 1 };
  }

  async releaseCredential(input: {
    tenantId: TenantId;
    credentialRef: SecretRef;
    siteProfileId: PolicyId;
    slotNo: number;
  }): Promise<void> {
    const key = credentialLeaseKey(
      credentialPolicyKey(input.tenantId, input.credentialRef, input.siteProfileId),
      input.slotNo,
    );
    const lease = this.credentialLeases.get(key);
    if (lease) lease.status = "released";
  }

  async renewCredential(input: {
    tenantId: TenantId;
    credentialRef: SecretRef;
    siteProfileId: PolicyId;
    slotNo: number;
    runId: RunId;
    lockedUntil: IsoDateTime;
  }): Promise<CredentialLeaseRenewResult> {
    const key = credentialLeaseKey(
      credentialPolicyKey(input.tenantId, input.credentialRef, input.siteProfileId),
      input.slotNo,
    );
    const lease = this.credentialLeases.get(key);
    if (
      !lease ||
      lease.status !== "active" ||
      lease.runId !== input.runId ||
      this.isExpired(lease.lockedUntil)
    ) {
      return {
        kind: "lost",
        code: "SESSION_LOCKED",
        reason: "credential lease missing, released, owned by another run, or expired",
      };
    }
    lease.lockedUntil = input.lockedUntil;
    return { kind: "renewed", lockedUntil: lease.lockedUntil };
  }

  async sweepExpired(now: IsoDateTime): Promise<readonly (BrowserLease | CredentialLease)[]> {
    const swept: (BrowserLease | CredentialLease)[] = [];
    const sweepMs = Date.parse(now);

    for (const lease of this.browserLeases.values()) {
      if (
        (lease.state === "reserved" || lease.state === "active") &&
        Date.parse(lease.expiresAt) < sweepMs
      ) {
        lease.state = "expired";
        swept.push({ ...lease });
      }
    }

    for (const lease of this.credentialLeases.values()) {
      if (lease.status === "active" && Date.parse(lease.lockedUntil) < sweepMs) {
        lease.status = "expired";
        swept.push({ ...lease });
      }
    }

    return swept;
  }

  async issue(input: Omit<ResumeTokenEnvelope, "kid" | "hmac">): Promise<ResumeTokenEnvelope> {
    const unsigned = { ...input, kid: this.resumeKid };
    return { ...unsigned, hmac: this.sign(unsigned) };
  }

  async verify(token: ResumeTokenEnvelope): Promise<ResumeTokenVerification> {
    const expected = this.sign(omitHmac(token));
    if (!safeEqual(token.hmac, expected)) {
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: "resume token hmac mismatch" };
    }
    if (this.isExpired(token.expiresAt)) {
      return { kind: "expired", code: "CHALLENGE_UNRESOLVED", reason: "resume token expired" };
    }
    return { kind: "valid", token };
  }

  async save(input: {
    tenantId: TenantId;
    runId: RunId;
    token: ResumeTokenEnvelope;
  }): Promise<void> {
    const row = this.runs.get(entityKey(input.tenantId, input.runId));
    if (!row) throw new Error(`run not found for resume token: ${input.runId}`);
    row.resumeToken = input.token;
    row.updatedAt = this.now();
  }

  async recover(input: { tenantId: TenantId; runId: RunId }): Promise<ResumeTokenRecovery> {
    const row = this.runs.get(entityKey(input.tenantId, input.runId));
    if (!row?.resumeToken) {
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: "resume token missing" };
    }
    const verification = await this.verify(row.resumeToken);
    if (verification.kind !== "valid") return verification;
    if (verification.token.runId !== input.runId) {
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: "resume token run mismatch" };
    }
    return { kind: "recovered", token: verification.token };
  }

  async create(input: {
    tenantId: TenantId;
    workitemId?: WorkitemId;
    runId?: RunId;
    reasonCode: ErrorCode;
    evidenceRef?: ArtifactRef;
  }): Promise<DeadLetterRecord> {
    const record: DeadLetterRecord = {
      id: this.nextId<string>(),
      tenantId: input.tenantId,
      workitemId: input.workitemId,
      runId: input.runId,
      reasonCode: input.reasonCode,
      evidenceRef: input.evidenceRef,
      replayable: true,
      createdAt: this.now(),
    };
    this.deadLetters.set(record.id, record);
    return { ...record };
  }

  async replay(input: {
    tenantId: TenantId;
    deadLetterId: string;
    requestedBy: string;
  }): Promise<DeadLetterReplayResult> {
    const record = this.deadLetters.get(input.deadLetterId);
    if (!record || record.tenantId !== input.tenantId || !record.replayable || record.replayedAt) {
      return { kind: "not_replayable", code: "DEAD_LETTER", reason: "dead letter is missing or closed" };
    }
    if (!record.workitemId) {
      return { kind: "not_replayable", code: "DEAD_LETTER", reason: "dead letter has no workitem" };
    }
    const workitem = this.workitems.get(entityKey(input.tenantId, record.workitemId));
    if (!workitem || workitem.status !== "abandoned") {
      return {
        kind: "conflict",
        code: "WORKITEM_CHECKOUT_CONFLICT",
        reason: "workitem is not abandoned",
      };
    }

    const applied = await this.applyWorkitemEvent({
      tenantId: input.tenantId,
      workitemId: record.workitemId,
      event: { type: "manual_replay" },
      guard: { operatorAuthorized: true },
      expectedState: "abandoned",
    });
    if (applied.kind !== "applied") {
      return {
        kind: "conflict",
        code: "WORKITEM_CHECKOUT_CONFLICT",
        reason: "manual_replay CAS miss",
      };
    }

    record.replayedAt = this.now();
    return { kind: "replayed", workitemId: record.workitemId, nextState: "new" };
  }

  private applyRunSideEffects(row: RunRow, attempt: RunTransitionAttempt): void {
    if (attempt.event.type === "init_failed" && attempt.transition.next === "queued") {
      row.attempts += 1;
    }
    if (
      attempt.transition.next === "completed" ||
      attempt.transition.next === "cancelled" ||
      attempt.transition.next === "failed_business" ||
      attempt.transition.next === "failed_system"
    ) {
      row.endedAt = this.now();
    }
  }

  private applyWorkitemSideEffects(row: WorkitemRow, attempt: WorkitemTransitionAttempt): void {
    if (
      (attempt.event.type === "system_exception" || attempt.event.type === "checkout_expired") &&
      (attempt.transition.next === "retry" || attempt.transition.next === "abandoned")
    ) {
      row.attempts += 1;
    }
    if (attempt.event.type === "manual_replay" && attempt.transition.next === "new") {
      row.attempts = 0;
      row.checkoutPausedAt = undefined;
      row.checkedOutAt = undefined;
      row.checkoutExpiresAt = undefined;
    }
    if (attempt.event.type === "run_suspended") {
      row.checkoutPausedAt = this.now();
    }
    if (attempt.event.type === "run_resumed") {
      row.checkoutPausedAt = undefined;
    }
  }

  private applyHumanTaskSideEffects(row: HumanTaskRow, attempt: HumanTaskTransitionAttempt): void {
    if (attempt.event.type === "assign") {
      row.assignee = row.assignee ?? "fixture-assignee";
    }
  }

  private createDlqForSideEffect(row: WorkitemRow, sideEffects: readonly SideEffectCmd[]): void {
    if (!sideEffects.some((cmd) => cmd.kind === "createDeadLetter")) return;
    const existing = [...this.deadLetters.values()].some(
      (record) => record.tenantId === row.tenantId && record.workitemId === row.id && !record.replayedAt,
    );
    if (existing) return;
    const record: DeadLetterRecord = {
      id: this.nextId<string>(),
      tenantId: row.tenantId,
      workitemId: row.id,
      reasonCode: "DEAD_LETTER",
      replayable: true,
      createdAt: this.now(),
    };
    this.deadLetters.set(record.id, record);
  }

  private outboxDraftsForTransition(
    entity: RunEntityRef | WorkitemEntityRef | HumanTaskEntityRef,
    row: RuntimeEntityRow,
    transitionEvent: string,
    sideEffects: readonly SideEffectCmd[],
  ): OutboxEventDraft[] {
    const drafts: OutboxEventDraft[] = [];
    let index = 0;
    for (const cmd of sideEffects) {
      if (cmd.kind !== "emitEvent") continue;
      const eventType = cmd.event as EventType;
      drafts.push({
        eventId: this.nextId<EventId>(),
        eventType: cmd.event,
        eventVersion: 1,
        tenantId: entity.tenantId,
        runId: runIdFor(entity, row),
        workitemId: workitemIdFor(entity, row),
        correlationId: row.correlationId,
        orderingKey: orderingKeyFor(entity, row),
        occurredAt: this.now(),
        idempotencyKey: [
          entity.kind,
          entity.id,
          transitionEvent,
          cmd.event,
          String(index),
        ].join(":"),
        payloadSchemaRef: EVENT_PAYLOAD_SCHEMA_REFS[eventType],
        payload: {},
      });
      index += 1;
    }
    return drafts;
  }

  private nextId<T extends string>(): T {
    const hex = this.sequence.toString(16).padStart(12, "0");
    this.sequence += 1;
    return `00000000-0000-4000-8000-${hex}` as T;
  }

  private isoAfter(ms: number): IsoDateTime {
    return new Date(this.nowMs + ms).toISOString() as IsoDateTime;
  }

  private isExpired(value: IsoDateTime): boolean {
    return Date.parse(value) < this.nowMs;
  }

  private msUntil(value: IsoDateTime): number {
    return Math.max(0, Date.parse(value) - this.nowMs);
  }

  private sign(value: unknown): string {
    return createHmac("sha256", this.resumeSigningKey)
      .update(stableJson(value))
      .digest("base64url");
  }
}

export class InMemoryRuntimeWorker implements RuntimeWorker {
  constructor(private readonly store: InMemoryRuntimeStore) {}

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    switch (job.kind) {
      case "outbox_relay": {
        const result = await this.store.relayOutboxBatch(100);
        return {
          kind: "completed",
          emittedEvents: result.results
            .filter((item): item is Extract<OutboxPublishResult, { kind: "published" | "duplicate" }> =>
              item.kind === "published" || item.kind === "duplicate",
            )
            .map((item) => item.eventId),
        };
      }
      case "lease_sweeper": {
        await this.store.sweepExpired(this.store.now());
        return { kind: "completed", emittedEvents: [] };
      }
      case "dlq_replay": {
        if (!job.tenantId || !job.deadLetterId) {
          return { kind: "failed", code: "RESOURCE_NOT_FOUND" };
        }
        const replay = await this.store.replay({
          tenantId: job.tenantId,
          deadLetterId: job.deadLetterId,
          requestedBy: "runtime-worker",
        });
        if (replay.kind === "replayed") {
          return { kind: "completed", emittedEvents: [] };
        }
        return { kind: "failed", code: replay.code };
      }
      case "run_claim":
      case "run_abort":
      case "run_resume":
      case "workitem_checkout":
      case "artifact_redaction":
      case "artifact_retention":
      case "sink_deliver":
        // Decision v1 defines these as closed job-kind inputs; the fake runtime
        // intentionally fails unsupported execution instead of inventing effects.
        return { kind: "failed", code: "IR_EXPRESSION_RUNTIME" };
    }
  }
}

function entityKey(tenantId: TenantId, id: string): string {
  return `${tenantId}:${id}`;
}

function tenantScopedKey(tenantId: TenantId, idempotencyKey: string): string {
  return `${tenantId}:${idempotencyKey}`;
}

function credentialPolicyKey(
  tenantId: TenantId,
  credentialRef: SecretRef,
  siteProfileId: PolicyId,
): CredentialPolicyKey {
  return `${tenantId}:${credentialRef}:${siteProfileId}`;
}

function credentialLeaseKey(policyKey: CredentialPolicyKey, slotNo: number): CredentialLeaseKey {
  return `${policyKey}:${slotNo}`;
}

function runIdFor(
  entity: RunEntityRef | WorkitemEntityRef | HumanTaskEntityRef,
  row: RuntimeEntityRow,
): RunId | undefined {
  if (entity.kind === "run") return entity.id;
  if (entity.kind === "human_task") return (row as HumanTaskRow).runId;
  return undefined;
}

function workitemIdFor(
  entity: RunEntityRef | WorkitemEntityRef | HumanTaskEntityRef,
  row: RuntimeEntityRow,
): WorkitemId | undefined {
  if (entity.kind === "workitem") return entity.id;
  if (entity.kind === "run") return (row as RunRow).workitemId;
  return undefined;
}

function orderingKeyFor(
  entity: RunEntityRef | WorkitemEntityRef | HumanTaskEntityRef,
  row: RuntimeEntityRow,
): string {
  if (entity.kind === "run") return entity.id;
  if (entity.kind === "human_task") return (row as HumanTaskRow).runId;
  return entity.id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitHmac(token: ResumeTokenEnvelope): Omit<ResumeTokenEnvelope, "hmac"> {
  const { hmac: _hmac, ...unsigned } = token;
  return unsigned;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
