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
  EventId,
  HumanTaskId,
  IsoDateTime,
  OutboxEventDraft,
  OutboxRow,
  StateMachineCasResult,
  WorkerId,
  WorkitemId,
} from "../ts/runtime-contract";

const tenantId = "11111111-1111-4111-8111-111111111111" as TenantId;
const runId = "22222222-2222-4222-8222-222222222222" as RunId;
const workitemId = "33333333-3333-4333-8333-333333333333" as WorkitemId;
const humanTaskId = "44444444-4444-4444-8444-444444444444" as HumanTaskId;
const siteProfileId = "55555555-5555-4555-8555-555555555555" as PolicyId;
const workerId = "66666666-6666-4666-8666-666666666666" as WorkerId;
const correlationId = "77777777-7777-4777-8777-777777777777" as CorrelationId;
const credentialRef = "secret://tenant/main-login" as SecretRef;

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
  leaseId: browser.lease.id,
  workerId,
  ttlMs: 500,
});
assert(renewed.kind === "renewed", "browser lease must renew before expiry");

store.advanceMs(501);
const lost = await store.renewBrowser({
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
    if (error instanceof IllegalTransition) return;
    throw new Error(`${label}: expected IllegalTransition, got ${error instanceof Error ? error.name : String(error)}`);
  }
  throw new Error(`${label}: expected IllegalTransition, got no throw`);
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
