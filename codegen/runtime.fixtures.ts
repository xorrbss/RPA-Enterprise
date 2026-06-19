/**
 * Runtime scaffold fixture.
 *
 * Run with:
 *   npx tsx codegen/runtime.fixtures.ts
 */
import {
  InMemoryRuntimeStore,
  InMemoryRuntimeWorker,
} from "../runtime/fake-store";
import { EVENT_PAYLOAD_SCHEMA_REFS } from "./event-payload-registry";
import { IllegalTransition } from "../ts/state-machine-types";
import type { SecretRef } from "../ts/core-types";
import type {
  CorrelationId,
  PolicyId,
  RunId,
  TenantId,
} from "../ts/security-middleware-contract";
import type {
  ArtifactLifecycleOperationalUseCase,
  EventId,
  HumanTaskId,
  IsoDateTime,
  OutboxEventDraft,
  OutboxRow,
  StateMachineCasResult,
  WorkerId,
  WorkitemId,
} from "../ts/runtime-contract";
import {
  ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT as artifactLifecycleContract,
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
} from "../ts/runtime-contract";
import {
  EXECUTOR_AUDIT_EVIDENCE_CONTRACT as executorAuditEvidenceContract,
  EXECUTOR_OUTCOME_MAPPING_CONTRACT as executorOutcomeMappingContract,
} from "../ts/runtime-contract";

const tenantId = "11111111-1111-4111-8111-111111111111" as TenantId;
const runId = "22222222-2222-4222-8222-222222222222" as RunId;
const workitemId = "33333333-3333-4333-8333-333333333333" as WorkitemId;
const humanTaskId = "44444444-4444-4444-8444-444444444444" as HumanTaskId;
const siteProfileId = "55555555-5555-4555-8555-555555555555" as PolicyId;
const workerId = "66666666-6666-4666-8666-666666666666" as WorkerId;
const correlationId = "77777777-7777-4777-8777-777777777777" as CorrelationId;
const credentialRef = "secret://tenant/main-login" as SecretRef;

const artifactLifecycleUseCases: readonly ArtifactLifecycleOperationalUseCase[] =
  artifactLifecycleContract.requiresDedicatedBypassRlsUseCases;
assert(
  artifactLifecycleUseCases.includes("artifact_redaction_job") &&
    artifactLifecycleUseCases.includes("artifact_retention_sweeper"),
  "artifact lifecycle contract must name dedicated BYPASSRLS use cases",
);
assert(
  artifactLifecycleContract.applicationRoleMayBypassRls === false,
  "artifact lifecycle contract must not allow application-role BYPASSRLS",
);
assert(
  artifactLifecycleContract.applicationRoleMayMutatePendingArtifacts === false,
  "artifact lifecycle contract must not let application role mutate pending artifacts",
);
assert(
  artifactLifecycleContract.requiresTenantScopedSql === true,
  "artifact lifecycle contract must still require tenant-scoped SQL under operational roles",
);
assert(
  artifactLifecycleContract.requiresAuditBeforeMutation === true &&
    artifactLifecycleContract.auditAction === "bypassrls.use" &&
    artifactLifecycleContract.auditFailClosed === true,
  "artifact lifecycle contract must require fail-closed bypassrls audit before mutation",
);
assert(
  artifactLifecycleContract.operationalRole.requiresNonSuperuser === true &&
    artifactLifecycleContract.operationalRole.mayServeUserTraffic === false,
  "artifact lifecycle operational role must be non-superuser and isolated from user traffic",
);
assert(
  artifactLifecycleContract.objectRefInternalOnly === true &&
    artifactLifecycleContract.publicEvidenceUsesArtifactRefOnly === true &&
    artifactLifecycleContract.objectRefMayReachLogs === false,
  "artifact lifecycle contract must keep ObjectRef internal, expose ArtifactRef only, and keep ObjectRef out of logs",
);
assert(
    artifactLifecycleContract.objectIoEvidence.realSchemaRef === ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF &&
    artifactLifecycleContract.objectIoEvidence.localTestSchemaRef === ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF &&
    artifactLifecycleContract.objectIoEvidence.realPortRequiresSecretRef === true &&
    artifactLifecycleContract.objectIoEvidence.realPortStagingEvidenceMustBeExplicit === true &&
    artifactLifecycleContract.objectIoEvidence.localFilesystemMayBeUsedAsStagingEvidence === false &&
    artifactLifecycleContract.objectIoEvidence.localTestPortMayBeUsedAsStagingEvidence === false &&
    artifactLifecycleContract.objectIoEvidence.successEvidenceRequiredBeforeFinalize === true &&
    artifactLifecycleContract.objectIoEvidence.evidenceMayContainObjectRef === false &&
    artifactLifecycleContract.objectIoEvidence.evidenceMayContainSecretRefIdentifier === true &&
    artifactLifecycleContract.objectIoEvidence.evidenceMayContainPlainSecret === false,
  "artifact lifecycle object I/O evidence must require explicit staging qualification and keep local evidence non-staging",
);
assert(
  artifactLifecycleContract.claimLease.requiredBeforeObjectIo === true &&
    artifactLifecycleContract.claimLease.persistedOnArtifactRow === true &&
    artifactLifecycleContract.claimLease.applicationInsertMaySetClaimLease === false &&
    artifactLifecycleContract.claimLease.uniqueClaimIdPerTenant === true &&
    artifactLifecycleContract.claimLease.workerAndCorrelationBound === true &&
    artifactLifecycleContract.claimLease.shortDbTransactionOnly === true &&
    artifactLifecycleContract.claimLease.expiresAtRequired === true &&
    artifactLifecycleContract.claimLease.staleLeaseMayBeReclaimed === true &&
    artifactLifecycleContract.claimLease.activeUnexpiredClaimDefers === true &&
    artifactLifecycleContract.claimLease.retryAfterRequired === true &&
    artifactLifecycleContract.claimLease.objectIoInsideClaimTransaction === false,
  "artifact lifecycle claim lease must be persisted, app-insert protected, short-lived, defer active claims with retry metadata, and avoid object I/O inside the claim transaction",
);
assert(
  artifactLifecycleContract.finalizeCas.requiredAfterObjectIo === true &&
    artifactLifecycleContract.finalizeCas.requiresClaimId === true &&
    artifactLifecycleContract.finalizeCas.requiresUnexpiredClaim === true &&
    artifactLifecycleContract.finalizeCas.tenantScoped === true &&
    artifactLifecycleContract.finalizeCas.staleObjectIoResultMustNotFinalize === true &&
    artifactLifecycleContract.finalizeCas.objectIoInsideFinalizeTransaction === false &&
    artifactLifecycleContract.finalizeCas.unknownPortResultFailClosed === true &&
    artifactLifecycleContract.finalizeCas.portExceptionMessageMayReachLogs === false,
  "artifact lifecycle finalize CAS must be claim-bound, tenant-scoped, lease-fresh, and fail closed on stale, unknown, or leaking port results",
);
assert(
  artifactLifecycleContract.redactionClaim.redactionStatus === "pending" &&
    artifactLifecycleContract.redactionClaim.deletedAt === null &&
    artifactLifecycleContract.redactionClaim.quarantine === false,
  "artifact redaction claim must select only pending, undeleted, non-quarantined artifacts",
);
assert(
  artifactLifecycleContract.redactionFinalizePredicate.redactionStatus === "pending" &&
    artifactLifecycleContract.redactionFinalizePredicate.deletedAt === null &&
    artifactLifecycleContract.redactionFinalizePredicate.quarantine === false,
  "artifact redaction finalize CAS must still require pending, undeleted, non-quarantined artifacts",
);
assert(
  artifactLifecycleContract.retentionClaim.deletedAt === null &&
    artifactLifecycleContract.retentionClaim.legalHold === false &&
    artifactLifecycleContract.retentionClaim.quarantine === false &&
    artifactLifecycleContract.retentionClaim.retentionUntil === "past_required",
  "artifact retention claim must skip deleted, legal-hold, quarantined, and unexpired artifacts",
);
assert(
  artifactLifecycleContract.retentionFinalizePredicate.deletedAt === null &&
    artifactLifecycleContract.retentionFinalizePredicate.legalHold === false &&
    artifactLifecycleContract.retentionFinalizePredicate.quarantine === false &&
    artifactLifecycleContract.retentionFinalizePredicate.retentionUntil === "past_required",
  "artifact retention finalize CAS must still skip deleted, legal-hold, quarantined, and unexpired artifacts",
);
assert(
  artifactLifecycleContract.retentionSuccessKinds.length === 2 &&
    artifactLifecycleContract.retentionSuccessKinds.includes("deleted") &&
    artifactLifecycleContract.retentionSuccessKinds.includes("not_found") &&
    artifactLifecycleContract.retentionFailureMustNotTombstone === true,
  "artifact retention delete must be idempotent and transient failure must not tombstone",
);
assert(
  executorOutcomeMappingContract.requiresStartedAttemptBeforeProducerWrites === true &&
    executorOutcomeMappingContract.pluginExecutionInsideDbTransaction === false &&
    executorOutcomeMappingContract.finalProducerWritesUseStartedAttemptCas === true,
  "executor outcome mapping must require local started attempts and keep plugin execution outside DB transactions",
);
assert(
  executorOutcomeMappingContract.systemFailure.runTransition === "R8" &&
    executorOutcomeMappingContract.systemFailure.workitemTransition === "W4_or_W5" &&
    executorOutcomeMappingContract.systemFailure.unknownOutcomeMapsTo === "CONTROL_PLANE_INTERNAL_ERROR",
  "executor system/unknown outcomes must map to explicit R8 and W4/W5 error-catalog paths",
);
assert(
  executorOutcomeMappingContract.securityFailure.runTransition === "R10" &&
    executorOutcomeMappingContract.securityFailure.requiresRunAbortJob === true &&
    executorOutcomeMappingContract.securityFailure.requiresNotificationPort === true,
  "executor security outcomes must map to R10 and require explicit abort/notify ports",
);
assert(
  executorOutcomeMappingContract.challengeFailure.runTransition === "R4_then_R11" &&
    executorOutcomeMappingContract.challengeFailure.requiresSuspensionBookmarkPort === true,
  "executor challenge outcomes must map to R4/R11 through an explicit suspension bookmark port",
);
assert(
  executorAuditEvidenceContract.executorOutcomesMustNotUseSecurityAuditLog === true &&
    executorAuditEvidenceContract.durableEvidenceAuthorities.includes("run_steps") &&
    executorAuditEvidenceContract.durableEvidenceAuthorities.includes("events_outbox") &&
    executorAuditEvidenceContract.durableEvidenceAuthorities.includes("stagehand_calls") &&
    executorAuditEvidenceContract.auditLogAllowedForExecutorOnlyWhen.includes("security_boundary_decision"),
  "executor audit evidence must use runtime evidence authorities and reserve audit_log for boundary decisions",
);

const store = new InMemoryRuntimeStore({
  nowMs: Date.parse("2026-06-13T00:00:00.000Z"),
});
const worker = new InMemoryRuntimeWorker(store);

store.seedRun({ tenantId, id: runId, workitemId, correlationId });
store.seedWorkitem({
  tenantId,
  id: workitemId,
  status: "processing",
  attempts: 1,
  correlationId,
});
store.seedHumanTask({
  tenantId,
  id: humanTaskId,
  runId,
  state: "in_progress",
  kind: "captcha",
  correlationId,
});

const claimed = mustApply(
  await store.applyRunEvent({
    tenantId,
    runId,
    event: { type: "worker.claimed" },
    guard: { leaseAcquired: true },
  }),
  "claimed",
  "R1 claim must apply",
);

assert(claimed.outbox.length === 0, "R1 claim must not invent an outbox event");

const staleClaim = await store.applyRunEvent({
  tenantId,
  runId,
  event: { type: "worker.claimed" },
  guard: { leaseAcquired: true },
  expectedState: "queued",
});
assert(staleClaim.kind === "cas_miss", "stale R1 claim must return cas_miss");
assert(staleClaim.latestState === "claimed", "CAS miss must expose latest run state");

await assertRejectsIllegal(
  () =>
    store.applyRunEvent({
      tenantId,
      runId,
      event: { type: "finalize_ok" },
    }),
  "undefined run transition must surface IllegalTransition",
);

mustApply(
  await store.applyRunEvent({
    tenantId,
    runId,
    event: { type: "run.started" },
    guard: { initOk: true },
  }),
  "running",
  "R2 start must apply",
);

mustApply(
  await store.applyRunEvent({
    tenantId,
    runId,
    event: { type: "step.challenge_detected", challengeKind: "captcha" },
  }),
  "suspending",
  "R4 challenge must suspend",
);

const token = await store.issue({
  runId,
  resumeNodeId: "after_challenge",
  pageStateRef: "page-state://suspend/1",
  loopContext: { iteration: 1, pageCount: 1 },
  issuedAt: store.now(),
  expiresAt: plusIso(store.now(), 2_000),
});

mustApply(
  await store.applyRunEvent({
    tenantId,
    runId,
    event: { type: "bookmark_saved" },
    guard: { resumeTokenIssued: true },
  }),
  "suspended",
  "R11 bookmark save must suspend",
);

await store.save({ tenantId, runId, token });
const recovered = await store.recover({ tenantId, runId });
assert(recovered.kind === "recovered", "valid resume token must recover");
assert(recovered.token.resumeNodeId === "after_challenge", "resume node must round-trip");

const invalidToken = await store.verify({ ...token, hmac: "tampered" });
assert(invalidToken.kind === "invalid", "tampered resume token must fail closed");

store.advanceMs(2_001);
const expired = await store.recover({ tenantId, runId });
assert(expired.kind === "expired", "expired resume token must not recover");

const humanResolved = mustApply(
  await store.applyHumanTaskEvent({
    tenantId,
    humanTaskId,
    event: { type: "resolve" },
  }),
  "resolved",
  "H3 resolve must apply",
);
assert(
  humanResolved.outbox.some((event) => event.eventType === "human_task.resolved"),
  "human task resolution must append event outbox",
);

const abandoned = mustApply(
  await store.applyWorkitemEvent({
    tenantId,
    workitemId,
    event: { type: "system_exception" },
    guard: { attemptsBelowMax: false },
  }),
  "abandoned",
  "W5 system exception over max must abandon",
);
assert(
  abandoned.outbox.some((event) => event.eventType === "workitem.dead_lettered"),
  "W5 must append workitem.dead_lettered",
);

const deadLetter = store.getDeadLetters()[0];
assert(deadLetter !== undefined, "W5 must create a DLQ record");

const replayed = await worker.handle({
  kind: "dlq_replay",
  tenantId,
  deadLetterId: deadLetter.id,
});
assert(replayed.kind === "completed", "worker dlq_replay must complete");
assert(
  store.getWorkitem(tenantId, workitemId)?.status === "new",
  "W10 replay must restore workitem to new",
);
assert(
  store.getWorkitem(tenantId, workitemId)?.attempts === 0,
  "W10 replay must reset attempts",
);

const secondReplay = await store.replay({
  tenantId,
  deadLetterId: deadLetter.id,
  requestedBy: "fixture",
});
assert(secondReplay.kind === "not_replayable", "replayed DLQ must close idempotently");

const outboxRows = store.getOutboxRows();
assert(outboxRows.length >= 3, "state transitions must have appended outbox rows");
const firstRow = outboxRows[0];
assert(firstRow !== undefined, "fixture must have at least one outbox row");

const duplicateDraft = {
  ...toDraft(firstRow),
  eventId: "88888888-8888-4888-8888-888888888888" as EventId,
};
assert(
  store.appendOutboxDrafts([duplicateDraft]).length === 0,
  "outbox append must dedupe tenant-scoped idempotency_key",
);

assert(
  store.validate("events/run.completed@2", {}).valid === false,
  "outbox payload validator must reject unknown payload_schema_ref",
);
assert(
  store.validate(EVENT_PAYLOAD_SCHEMA_REFS["run.completed"], { undocumented: true }).valid === false,
  "outbox payload validator must reject undocumented payload fields",
);

const publishBeforeMark = await store.publish(firstRow);
assert(publishBeforeMark.kind === "published", "first relay publish must deliver");
const mismatchedRefPublish = await store.publish({
  ...firstRow,
  eventId: "99999999-9999-4999-8999-999999999999" as EventId,
  payloadSchemaRef: "events/run.completed@2",
});
assert(mismatchedRefPublish.kind === "failed", "relay publish must reject payload_schema_ref drift");
const invalidPayloadPublish = await store.publish({
  ...firstRow,
  eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as EventId,
  payload: { undocumented: true },
});
assert(invalidPayloadPublish.kind === "failed", "relay publish must reject non-empty placeholder payloads");
const relay = await store.relayOutboxBatch(100);
assert(
  relay.results.some((result) => result.kind === "duplicate" && result.eventId === firstRow.eventId),
  "relay retry after publish-before-mark must dedupe downstream",
);
assert(
  store.getOutboxRows().every((row) => row.publishedAt !== undefined),
  "relay must mark published or duplicate rows with CAS",
);

const emptyRelay = await worker.handle({ kind: "outbox_relay" });
assert(
  emptyRelay.kind === "completed" && emptyRelay.emittedEvents.length === 0,
  "worker outbox_relay must tolerate empty polls",
);

const unsupportedRedaction = await worker.handle({
  kind: "artifact_redaction",
  tenantId,
  runId,
  correlationId,
});
assert(
  unsupportedRedaction.kind === "failed" && unsupportedRedaction.code === "IR_EXPRESSION_RUNTIME",
  "artifact_redaction must fail closed until object I/O is implemented",
);

const unsupportedRetention = await worker.handle({
  kind: "artifact_retention",
  tenantId,
  correlationId,
});
assert(
  unsupportedRetention.kind === "failed" && unsupportedRetention.code === "IR_EXPRESSION_RUNTIME",
  "artifact_retention must fail closed until object deletion receipt is implemented",
);

const browser = await store.acquireBrowser({
  tenantId,
  runId,
  siteProfileId,
  browserIdentityId: "browser-identity-fixture",
  workerId,
  isolation: "context",
  cleanupPolicy: "clear_all",
  ttlMs: 500,
});
assert(browser.kind === "acquired", "browser lease must acquire");

const browserConflict = await store.acquireBrowser({
  tenantId,
  runId,
  siteProfileId,
  browserIdentityId: "browser-identity-fixture",
  workerId,
  isolation: "context",
  cleanupPolicy: "clear_all",
  ttlMs: 500,
});
assert(browserConflict.kind === "deferred", "active browser lease must defer");

const renewed = await store.renewBrowser({
  tenantId,
  leaseId: browser.lease.id,
  workerId,
  ttlMs: 500,
});
assert(renewed.kind === "renewed", "browser lease must renew before expiry");

store.advanceMs(501);
const lost = await store.renewBrowser({
  tenantId,
  leaseId: browser.lease.id,
  workerId,
  ttlMs: 500,
});
assert(lost.kind === "lost", "expired browser lease must not be revived");

const sweptBrowser = await store.sweepExpired(store.now());
assert(
  sweptBrowser.some((lease) => "id" in lease && lease.id === browser.lease.id),
  "lease sweeper must expire the stale browser lease once",
);
assert((await store.sweepExpired(store.now())).length === 0, "lease sweeper must be idempotent");

const credential = await store.acquireCredential({
  tenantId,
  runId,
  workitemId,
  credentialRef,
  siteProfileId,
  lockedUntil: plusIso(store.now(), 500),
});
assert(credential.kind === "acquired", "credential lease must acquire slot 0");

const credentialRenewed = await store.renewCredential({
  tenantId,
  credentialRef,
  siteProfileId,
  slotNo: credential.lease.slotNo,
  runId,
  lockedUntil: plusIso(store.now(), 500),
});
assert(credentialRenewed.kind === "renewed", "credential lease must renew before expiry");

const credentialConflict = await store.acquireCredential({
  tenantId,
  runId,
  workitemId,
  credentialRef,
  siteProfileId,
  lockedUntil: plusIso(store.now(), 500),
});
assert(credentialConflict.kind === "deferred", "active credential slot must defer");

store.advanceMs(501);
const credentialLost = await store.renewCredential({
  tenantId,
  credentialRef,
  siteProfileId,
  slotNo: credential.lease.slotNo,
  runId,
  lockedUntil: plusIso(store.now(), 500),
});
assert(credentialLost.kind === "lost", "expired credential lease must not be revived by renew");

const sweptCredential = await store.sweepExpired(store.now());
assert(
  sweptCredential.some((lease) => "slotNo" in lease && lease.slotNo === 0),
  "lease sweeper must expire stale credential slot",
);

const credentialAgain = await store.acquireCredential({
  tenantId,
  runId,
  workitemId,
  credentialRef,
  siteProfileId,
  lockedUntil: plusIso(store.now(), 500),
});
assert(credentialAgain.kind === "acquired", "expired credential slot must be reusable by CAS upsert");

console.log("runtime recovery smoke: DLQ replay restores workitem, replay closes idempotently, outbox publish CAS dedupes, lease sweepers are idempotent");
console.log("runtime fixtures: ALL PASS");

function mustApply<S>(
  result: StateMachineCasResult<S>,
  expectedNext: S,
  label: string,
): Extract<StateMachineCasResult<S>, { kind: "applied" }> {
  assert(result.kind === "applied", `${label}: expected applied, got ${result.kind}`);
  assert(result.next === expectedNext, `${label}: expected ${String(expectedNext)}, got ${String(result.next)}`);
  return result;
}

async function assertRejectsIllegal(
  fn: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (isIllegalTransitionLike(error)) return;
    throw new Error(`${label}: expected IllegalTransition, got ${error instanceof Error ? error.name : String(error)}`);
  }
  throw new Error(`${label}: expected IllegalTransition, got no throw`);
}

function isIllegalTransitionLike(error: unknown): error is IllegalTransition {
  if (error instanceof IllegalTransition) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === "IllegalTransition" &&
    typeof candidate.message === "string" &&
    candidate.message.startsWith("IllegalTransition:")
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function plusIso(value: IsoDateTime, ms: number): IsoDateTime {
  return new Date(Date.parse(value) + ms).toISOString() as IsoDateTime;
}

function toDraft(row: OutboxRow): OutboxEventDraft {
  const { createdAt: _createdAt, publishedAt: _publishedAt, ...draft } = row;
  return draft;
}
