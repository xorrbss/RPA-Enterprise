/**
 * Visual evidence unit tests.
 *
 * This keeps screenshot capture honest without launching Chrome or PostgreSQL:
 * - action recording policy controls capture
 * - screenshot metadata is inserted as pending image/png with raw bytes in object storage
 * - object bytes are deleted when metadata insertion fails closed
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type pg from "pg";

import type { ArtifactRef, ObjectRef, RunContext, StepResult, VerifyResult } from "../../ts/core-types";
import type { CdpSession, CdpSessionProvider } from "../src/executor/cdp-session";
import {
  PgScreenshotFrameVideoRecorder,
  PgVisualEvidenceRecorder,
  VisualEvidenceError,
  VisualEvidenceExecutor,
  type ScreenshotFrameVideoEncoder,
  type VisualEvidenceObjectStore,
  type VisualEvidenceRecorder,
} from "../src/runtime/visual-evidence";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { bootstrapTracing } from "../src/observability/bootstrap";

const spanExporter = new InMemorySpanExporter();
bootstrapTracing(spanExporter);

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function baseResult(status: StepResult["status"] = "success", artifacts: ArtifactRef[] = []): StepResult {
  return {
    stepId: "open.0",
    action: "navigate",
    status,
    pageStateBefore: "before",
    pageStateAfter: "after",
    artifacts,
    cache: { mode: "bypass" },
    timings: { startedAt: "2026-06-19T00:00:00.000Z", endedAt: "2026-06-19T00:00:00.010Z", durationMs: 10 },
  };
}

function runContext(): RunContext {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    nodeId: "open",
    attempt: 2,
    pageState: {
      url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
      dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
      auth: "anonymous",
      flags: {},
      matchedWhere: [],
    },
    siteProfileId: "33333333-3333-4333-8333-333333333333",
    browserIdentityId: "44444444-4444-4444-8444-444444444444",
    networkPolicyId: "55555555-5555-4555-8555-555555555555",
    leaseId: "lease-1",
    assetRefs: {},
    abortSignal: new AbortController().signal,
  };
}

class FakeSession implements CdpSession {
  readonly calls: { method: string; params?: object }[] = [];

  private readonly evaluateValues: unknown[];

  constructor(evaluateValues: unknown[] = []) {
    this.evaluateValues = [...evaluateValues];
  }

  url(): string {
    return "about:blank";
  }

  goto(): Promise<void> {
    throw new Error("unused");
  }

  reload(): Promise<void> {
    throw new Error("unused");
  }

  evaluate<R = unknown>(): Promise<R> {
    throw new Error("unused");
  }

  sendCDP<T = unknown>(method: string, params?: object): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Runtime.evaluate") {
      return Promise.resolve({ result: { value: this.evaluateValues.shift() ?? { ok: true } } } as T);
    }
    return Promise.resolve({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") } as T);
  }

  click(): Promise<void> {
    throw new Error("unused");
  }

  fill(): Promise<void> {
    throw new Error("unused");
  }

  selectOption(): Promise<void> {
    throw new Error("unused");
  }

  setInputFiles(): Promise<void> {
    throw new Error("unused");
  }

  downloadDir(): string {
    return "C:\\downloads";
  }

  waitForDownload(): Promise<boolean> {
    throw new Error("unused");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSessionProvider implements CdpSessionProvider {
  constructor(readonly session: CdpSession) {}

  forLease(_leaseId: string): CdpSession {
    return this.session;
  }
}

class FakeRecorder implements VisualEvidenceRecorder {
  readonly captures: Parameters<VisualEvidenceRecorder["captureStepScreenshot"]>[0][] = [];

  async captureStepScreenshot(input: Parameters<VisualEvidenceRecorder["captureStepScreenshot"]>[0]): Promise<ArtifactRef> {
    this.captures.push(input);
    return "screenshot-ref" as ArtifactRef;
  }
}

class FakeExecutor {
  constructor(private readonly result: StepResult) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: false, vision: false, utility: true };
  }

  async execute(_stepId: string, _action: unknown, _ctx: RunContext): Promise<StepResult> {
    return this.result;
  }

  async verify(): Promise<VerifyResult> {
    return { status: "pass", confidence: 1, failedCriteria: [], evidenceRefs: [], recommendation: "continue" };
  }
}

class FakeStore implements VisualEvidenceObjectStore {
  readonly puts: Uint8Array[] = [];
  readonly deletes: ObjectRef[] = [];

  async putBytes(content: Uint8Array): Promise<ObjectRef> {
    this.puts.push(content);
    return "file:///tmp/evidence.png" as ObjectRef;
  }

  async delete(objectRef: ObjectRef): Promise<void> {
    this.deletes.push(objectRef);
  }
}

class FakeVideoEncoder implements ScreenshotFrameVideoEncoder {
  readonly webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
  input: Parameters<ScreenshotFrameVideoEncoder["encode"]>[0] | undefined;
  firstFrame: Uint8Array | undefined;

  async encode(input: Parameters<ScreenshotFrameVideoEncoder["encode"]>[0]): Promise<{ bytes: Uint8Array; durationMs: number }> {
    this.input = input;
    this.firstFrame = new Uint8Array(await readFile(join(input.framesDir, "frame-000001.png")));
    return { bytes: this.webmBytes, durationMs: 1200 };
  }
}

class FakePgClient {
  readonly queries: { text: string; params?: readonly unknown[] }[] = [];
  released = false;

  constructor(private readonly failInsert = false) {}

  async query(text: string, params?: readonly unknown[]): Promise<{ rows: [] }> {
    this.queries.push({ text, params });
    if (this.failInsert && text.includes("INSERT INTO artifacts")) {
      throw new Error("insert failed");
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

class FakePgPool {
  readonly client: FakePgClient;

  constructor(failInsert = false) {
    this.client = new FakePgClient(failInsert);
  }

  async connect(): Promise<FakePgClient> {
    return this.client;
  }
}

async function testExecutorPolicies(): Promise<void> {
  const session = new FakeSession();
  const sessions = new FakeSessionProvider(session);
  const ctx = runContext();

  const alwaysRecorder = new FakeRecorder();
  const existing = "existing-artifact" as ArtifactRef;
  const always = new VisualEvidenceExecutor(new FakeExecutor(baseResult("success", [existing])), sessions, alwaysRecorder);
  const alwaysResult = await always.execute("open.0", { type: "navigate", recording: "always" }, ctx);
  check("always policy captures successful step", alwaysRecorder.captures.length === 1);
  check("always policy appends screenshot artifact after existing refs", alwaysResult.artifacts.join(",") === "existing-artifact,screenshot-ref");
  check("capture input carries run/step/attempt", alwaysRecorder.captures[0]?.attempt === 2 && alwaysRecorder.captures[0]?.stepId === "open.0");
  const captureSpan = spanExporter.getFinishedSpans().find((sp) => sp.name === "artifact.capture");
  check(
    "§E artifact.capture span attr type=screenshot_masked + redaction_status=pending (#9)",
    captureSpan?.attributes.type === "screenshot_masked" && captureSpan?.attributes.redaction_status === "pending",
    JSON.stringify(captureSpan?.attributes),
  );

  const maskedSuccessRecorder = new FakeRecorder();
  const maskedSuccess = new VisualEvidenceExecutor(new FakeExecutor(baseResult("success")), sessions, maskedSuccessRecorder);
  await maskedSuccess.execute("open.0", { type: "navigate", recording: "masked_on_failure" }, ctx);
  check("masked_on_failure skips successful step", maskedSuccessRecorder.captures.length === 0);

  const maskedFailRecorder = new FakeRecorder();
  const maskedFail = new VisualEvidenceExecutor(new FakeExecutor(baseResult("failed_system")), sessions, maskedFailRecorder);
  await maskedFail.execute("open.0", { type: "navigate", recording: "masked_on_failure" }, ctx);
  check("masked_on_failure captures failed step", maskedFailRecorder.captures.length === 1);

  const neverRecorder = new FakeRecorder();
  const never = new VisualEvidenceExecutor(new FakeExecutor(baseResult("failed_system")), sessions, neverRecorder);
  await never.execute("open.0", { type: "navigate", recording: "never" }, ctx);
  check("never policy skips capture even on failure", neverRecorder.captures.length === 0);
}

async function testPgRecorder(): Promise<void> {
  const pool = new FakePgPool();
  const store = new FakeStore();
  const session = new FakeSession();
  const recorder = new PgVisualEvidenceRecorder(pool as unknown as pg.Pool, store, { retentionDays: 7 });
  const ref = await recorder.captureStepScreenshot({
    session,
    tenantId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    nodeId: "open/node",
    stepId: "open.0",
    attempt: 0,
    result: baseResult(),
  });

  const insert = pool.client.queries.find((q) => q.text.includes("INSERT INTO artifacts"));
  const params = insert?.params;
  const bytes = store.puts[0];
  check(
    "recorder masks DOM before capture and restores after",
    session.calls[0]?.method === "Runtime.evaluate" &&
      session.calls[1]?.method === "Page.captureScreenshot" &&
      session.calls[2]?.method === "Runtime.evaluate",
    session.calls.map((c) => c.method).join(","),
  );
  check(
    "recorder applies visual evidence mask script before screenshot",
    String(session.calls[0]?.params && "expression" in session.calls[0].params ? session.calls[0].params.expression : "").includes("__rpaVisualEvidenceMask"),
  );
  const maskScript = String(session.calls[0]?.params && "expression" in session.calls[0].params ? session.calls[0].params.expression : "");
  check(
    "recorder mask script traverses open shadow roots and same-origin frames",
    maskScript.includes("shadowRoot") &&
      maskScript.includes("contentDocument") &&
      maskScript.includes("maskedCrossOriginFrames") &&
      maskScript.includes("skippedFrames"),
  );
  check("recorder writes PNG bytes to object store", bytes !== undefined && Buffer.from(bytes).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  check("recorder returns generated artifact ref", typeof ref === "string" && ref.length > 0);
  check("recorder inserts pending masked screenshot metadata", insert?.text.includes("'screenshot_masked'") === true && insert.text.includes("'image/png'"));
  check(
    "recorder binds tenant/run and stores screenshot step provenance",
    params?.[1] === "22222222-2222-4222-8222-222222222222" &&
      params?.[2] === "11111111-1111-4111-8111-111111111111" &&
      params?.[3] === "open.0" &&
      params?.[4] === 0 &&
      insert?.text.includes("NULL, NULL, 'screenshot_masked'") === false,
  );
  check("recorder stores filename/byte size/sha/retention", params?.[5] === "open-node-open.0-attempt-0.png" && params?.[6] === 4 && params?.[7] === createHash("sha256").update(Buffer.from([0x89, 0x50, 0x4e, 0x47])).digest("hex") && params?.[9] === 7);
  check("recorder commits and releases client", pool.client.queries.some((q) => q.text === "COMMIT") && pool.client.released);

  const failingPool = new FakePgPool(true);
  const failingStore = new FakeStore();
  const failingRecorder = new PgVisualEvidenceRecorder(failingPool as unknown as pg.Pool, failingStore, { retentionDays: 7 });
  try {
    await failingRecorder.captureStepScreenshot({
      session: new FakeSession(),
      tenantId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      nodeId: "open",
      stepId: "open.0",
      attempt: 0,
      result: baseResult(),
    });
    check("metadata insert failure throws", false, "expected VisualEvidenceError");
  } catch (error) {
    check("metadata insert failure throws VisualEvidenceError", error instanceof VisualEvidenceError);
  }
  check("metadata insert failure deletes object bytes", failingStore.deletes[0] === "file:///tmp/evidence.png");
  check("metadata insert failure rolls back", failingPool.client.queries.some((q) => q.text === "ROLLBACK"));
}

async function testSkippedFrameMaskFailsClosed(): Promise<void> {
  const pool = new FakePgPool();
  const store = new FakeStore();
  const session = new FakeSession([{ skippedFrames: 1 }]);
  const recorder = new PgVisualEvidenceRecorder(pool as unknown as pg.Pool, store, { retentionDays: 7 });
  try {
    await recorder.captureStepScreenshot({
      session,
      tenantId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      nodeId: "open",
      stepId: "open.0",
      attempt: 0,
      result: baseResult(),
    });
    check("skipped inaccessible frame throws", false, "expected VisualEvidenceError");
  } catch (error) {
    check("skipped inaccessible frame throws VisualEvidenceError", error instanceof VisualEvidenceError);
  }
  check("skipped inaccessible frame prevents screenshot capture", !session.calls.some((c) => c.method === "Page.captureScreenshot"));
  check("skipped inaccessible frame prevents object write", store.puts.length === 0);
}

async function testPgVideoRecorder(): Promise<void> {
  const pool = new FakePgPool();
  const store = new FakeStore();
  const session = new FakeSession();
  const sessions = new FakeSessionProvider(session);
  const encoder = new FakeVideoEncoder();
  const recorder = new PgScreenshotFrameVideoRecorder(pool as unknown as pg.Pool, store, sessions, {
    retentionDays: 7,
    ffmpegPath: "ffmpeg",
    frameIntervalMs: 60_000,
    frameRate: 1,
    encoder,
  });
  const recording = await recorder.startRunVideo({
    tenantId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    leaseId: "lease-1",
    correlationId: "33333333-3333-4333-8333-333333333333",
    policy: "always",
  });
  const ref = await recording.stopAndPersist({ terminal: "success" });

  const insert = pool.client.queries.find((q) => q.text.includes("INSERT INTO artifacts"));
  const params = insert?.params;
  check("video recorder captures at least one masked PNG frame", encoder.input?.frameCount === 1);
  check(
    "video recorder frame capture uses visual mask before/after screenshot",
    session.calls[0]?.method === "Runtime.evaluate" &&
      session.calls[1]?.method === "Page.captureScreenshot" &&
      session.calls[2]?.method === "Runtime.evaluate",
    session.calls.map((c) => c.method).join(","),
  );
  check(
    "video recorder writes captured frame to encoder input directory",
    encoder.firstFrame !== undefined && Buffer.from(encoder.firstFrame).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  );
  check("video recorder writes encoded WebM bytes to object store", Buffer.from(store.puts[0] ?? []).equals(Buffer.from(encoder.webmBytes)));
  check("video recorder returns generated artifact ref", typeof ref === "string" && ref.length > 0);
  check("video recorder inserts pending masked WebM metadata", insert?.text.includes("'video_masked'") === true && insert.text.includes("'video/webm'"));
  check("video recorder stores video as run-level artifact", insert?.text.includes("NULL, NULL, 'video_masked'") === true && params?.[2] === "11111111-1111-4111-8111-111111111111");
  check(
    "video recorder stores filename/byte size/duration/sha/retention",
    typeof params?.[3] === "string" &&
      params[3].includes("always-success.webm") &&
      params?.[4] === encoder.webmBytes.byteLength &&
      params?.[5] === 1200 &&
      params?.[6] === createHash("sha256").update(encoder.webmBytes).digest("hex") &&
      params?.[8] === 7,
  );

  const failingPool = new FakePgPool(true);
  const failingStore = new FakeStore();
  const failingRecorder = new PgScreenshotFrameVideoRecorder(failingPool as unknown as pg.Pool, failingStore, sessions, {
    retentionDays: 7,
    ffmpegPath: "ffmpeg",
    frameIntervalMs: 60_000,
    frameRate: 1,
    encoder: new FakeVideoEncoder(),
  });
  try {
    const failingRecording = await failingRecorder.startRunVideo({
      tenantId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      leaseId: "lease-1",
      correlationId: "33333333-3333-4333-8333-333333333333",
      policy: "always",
    });
    await failingRecording.stopAndPersist({ terminal: "fail_system" });
    check("video metadata insert failure throws", false, "expected VisualEvidenceError");
  } catch (error) {
    check("video metadata insert failure throws VisualEvidenceError", error instanceof VisualEvidenceError);
  }
  check("video metadata insert failure deletes object bytes", failingStore.deletes[0] === "file:///tmp/evidence.png");
  check("video metadata insert failure rolls back", failingPool.client.queries.some((q) => q.text === "ROLLBACK"));
}

await testExecutorPolicies();
await testPgRecorder();
await testSkippedFrameMaskFailsClosed();
await testPgVideoRecorder();

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: visual evidence unit green");
process.exit(0);
