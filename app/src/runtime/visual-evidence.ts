import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";

import type { ArtifactRef, ExecutorPlugin, ObjectRef, RunContext, StepResult, VerifyResult } from "../../../ts/core-types";
import type {
  RunVideoRecording,
  VisualEvidenceRecordingPolicy,
  VisualEvidenceVideoPolicy,
  VisualEvidenceVideoRecorder,
  VisualEvidenceVideoStopInput,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { SPAN, withSpan, spanCommonFromContext } from "../observability/telemetry";
import type { CdpSession, CdpSessionProvider } from "../executor/cdp-session";

const execFileAsync = promisify(execFile);

export type VisualRecordingPolicy = VisualEvidenceRecordingPolicy;

export interface VisualEvidenceObjectStore {
  putBytes(content: Uint8Array): Promise<ObjectRef>;
  delete(objectRef: ObjectRef): Promise<void>;
}

export interface VisualEvidenceRecorder {
  captureStepScreenshot(input: {
    session: CdpSession;
    tenantId: string;
    runId: string;
    nodeId: string;
    stepId: string;
    attempt: number;
    result: StepResult;
  }): Promise<ArtifactRef>;
}

export interface VisualEvidenceCaptureDeps {
  readonly sessions: CdpSessionProvider;
  readonly recorder: VisualEvidenceRecorder;
}

export interface PgVisualEvidenceRecorderConfig {
  retentionDays: number;
}

export interface ScreenshotFrameVideoEncodeInput {
  framesDir: string;
  outputPath: string;
  frameRate: number;
  frameCount: number;
}

export interface ScreenshotFrameVideoEncodeResult {
  bytes: Uint8Array;
  durationMs: number;
}

export interface ScreenshotFrameVideoEncoder {
  encode(input: ScreenshotFrameVideoEncodeInput): Promise<ScreenshotFrameVideoEncodeResult>;
}

export interface PgScreenshotFrameVideoRecorderConfig extends PgVisualEvidenceRecorderConfig {
  ffmpegPath: string;
  frameIntervalMs?: number;
  frameRate?: number;
  tempRootDir?: string;
  encoder?: ScreenshotFrameVideoEncoder;
}

export class PgVisualEvidenceRecorder implements VisualEvidenceRecorder {
  constructor(
    private readonly pool: pg.Pool,
    private readonly store: VisualEvidenceObjectStore,
    private readonly cfg: PgVisualEvidenceRecorderConfig,
  ) {}

  async captureStepScreenshot(input: {
    session: CdpSession;
    tenantId: string;
    runId: string;
    nodeId: string;
    stepId: string;
    attempt: number;
    result: StepResult;
  }): Promise<ArtifactRef> {
    const normalized = normalizeCaptureInput(input, this.cfg);
    const bytes = await captureScreenshotPng(input.session);
    const objectRef = await this.store.putBytes(bytes);
    const artifactRef = randomUUID() as ArtifactRef;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      await withTenantTx(this.pool, normalized.tenantId, async (client) => {
        await client.query(
          `INSERT INTO artifacts
           (id, tenant_id, run_id, step_id, attempt, type, media_type, filename, byte_size,
              redaction_status, sha256, object_ref, retention_until)
           VALUES
             ($1::uuid, $2::uuid, $3::uuid, $4, $5::int, 'screenshot_masked', 'image/png', $6,
              $7::bigint, 'pending', $8, $9, now() + ($10::int * interval '1 day'))`,
          [
            artifactRef,
            normalized.tenantId,
            normalized.runId,
            normalized.stepId,
            normalized.attempt,
            normalized.filename,
            bytes.byteLength,
            sha256,
            objectRef,
            normalized.retentionDays,
          ],
        );
      });
      return artifactRef;
    } catch (cause) {
      await this.store.delete(objectRef);
      throw new VisualEvidenceError("visual evidence metadata insert failed closed", cause);
    }
  }
}

export class PgScreenshotFrameVideoRecorder implements VisualEvidenceVideoRecorder {
  constructor(
    private readonly pool: pg.Pool,
    private readonly store: VisualEvidenceObjectStore,
    private readonly sessions: CdpSessionProvider,
    private readonly cfg: PgScreenshotFrameVideoRecorderConfig,
  ) {}

  async startRunVideo(input: {
    tenantId: string;
    runId: string;
    leaseId: string;
    correlationId: string;
    policy: VisualEvidenceVideoPolicy;
  }): Promise<RunVideoRecording> {
    const normalized = normalizeVideoStartInput(input, this.cfg);
    const session = this.sessions.forLease(normalized.leaseId);
    const tempRoot = this.cfg.tempRootDir ?? tmpdir();
    const tempDir = await mkdtemp(join(tempRoot, "rpa-video-"));
    const encoder = this.cfg.encoder ?? new FfmpegScreenshotFrameVideoEncoder(normalized.ffmpegPath);
    const recording = new ScreenshotFrameRunVideoRecording(
      this.pool,
      this.store,
      session,
      encoder,
      tempDir,
      normalized,
    );
    recording.start();
    return recording;
  }
}

class ScreenshotFrameRunVideoRecording implements RunVideoRecording {
  private frameCount = 0;
  private captureChain: Promise<void> = Promise.resolve();
  private captureTimer: NodeJS.Timeout | undefined;
  private captureErrors: unknown[] = [];
  private finalized = false;
  private stopping = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly store: VisualEvidenceObjectStore,
    private readonly session: CdpSession,
    private readonly encoder: ScreenshotFrameVideoEncoder,
    private readonly tempDir: string,
    private readonly input: NormalizedVideoStartInput,
  ) {}

  start(): void {
    this.queueCapture();
    this.captureTimer = setInterval(() => this.queueCapture(), this.input.frameIntervalMs);
  }

  async stopAndPersist(input: VisualEvidenceVideoStopInput): Promise<ArtifactRef | undefined> {
    this.ensureNotFinalized("stopAndPersist");
    this.finalized = true;
    try {
      await this.stopCaptures();
      if (this.frameCount === 0) {
        await this.captureFrameOnce().catch((cause: unknown) => {
          this.captureErrors.push(cause);
        });
      }
      if (this.frameCount === 0) {
        throw new VisualEvidenceError("visual evidence video capture produced no frames", this.captureErrors[0]);
      }

      const outputPath = join(this.tempDir, "run.webm");
      const encoded = await this.encoder.encode({
        framesDir: this.tempDir,
        outputPath,
        frameRate: this.input.frameRate,
        frameCount: this.frameCount,
      });
      if (encoded.bytes.byteLength === 0) {
        throw new VisualEvidenceError("visual evidence video encoder returned empty bytes");
      }
      const durationMs = normalizeDurationMs(encoded.durationMs, this.frameCount, this.input.frameRate);
      const objectRef = await this.store.putBytes(encoded.bytes);
      const artifactRef = randomUUID() as ArtifactRef;
      const sha256 = createHash("sha256").update(encoded.bytes).digest("hex");
      try {
        await withTenantTx(this.pool, this.input.tenantId, async (client) => {
          await client.query(
            `INSERT INTO artifacts
               (id, tenant_id, run_id, step_id, attempt, type, media_type, filename, byte_size,
                duration_ms, redaction_status, sha256, object_ref, retention_until)
             VALUES
               ($1::uuid, $2::uuid, $3::uuid, NULL, NULL, 'video_masked', 'video/webm', $4,
                $5::bigint, $6::int, 'pending', $7, $8, now() + ($9::int * interval '1 day'))`,
            [
              artifactRef,
              this.input.tenantId,
              this.input.runId,
              `run-${safeFilePart(this.input.runId)}-${this.input.policy}-${safeFilePart(input.terminal)}.webm`,
              encoded.bytes.byteLength,
              durationMs,
              sha256,
              objectRef,
              this.input.retentionDays,
            ],
          );
        });
        return artifactRef;
      } catch (cause) {
        await this.store.delete(objectRef);
        throw new VisualEvidenceError("visual evidence video metadata insert failed closed", cause);
      }
    } finally {
      await rm(this.tempDir, { recursive: true, force: true });
    }
  }

  async discard(_input: { reason: string }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    await this.stopCaptures();
    await rm(this.tempDir, { recursive: true, force: true });
  }

  private queueCapture(): void {
    if (this.stopping || this.finalized) return;
    this.captureChain = this.captureChain
      .then(async () => {
        if (this.stopping || this.finalized) return;
        await this.captureFrameOnce();
      })
      .catch((cause: unknown) => {
        this.captureErrors.push(cause);
      });
  }

  private async captureFrameOnce(): Promise<void> {
    const bytes = await captureScreenshotPng(this.session);
    const frameNo = this.frameCount + 1;
    await writeFile(join(this.tempDir, frameFileName(frameNo)), bytes);
    this.frameCount = frameNo;
  }

  private async stopCaptures(): Promise<void> {
    this.stopping = true;
    if (this.captureTimer !== undefined) {
      clearInterval(this.captureTimer);
      this.captureTimer = undefined;
    }
    await this.captureChain;
  }

  private ensureNotFinalized(method: string): void {
    if (this.finalized) {
      throw new VisualEvidenceError(`visual evidence video recording already finalized before ${method}`);
    }
  }
}

class FfmpegScreenshotFrameVideoEncoder implements ScreenshotFrameVideoEncoder {
  constructor(private readonly ffmpegPath: string) {}

  async encode(input: ScreenshotFrameVideoEncodeInput): Promise<ScreenshotFrameVideoEncodeResult> {
    const outputPath = input.outputPath;
    await execFileAsync(
      this.ffmpegPath,
      [
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        String(input.frameRate),
        "-start_number",
        "1",
        "-i",
        join(input.framesDir, "frame-%06d.png"),
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuv420p",
        "-an",
        outputPath,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const [bytes, info] = await Promise.all([readFile(outputPath), stat(outputPath)]);
    if (info.size <= 0 || bytes.byteLength === 0) {
      throw new VisualEvidenceError("visual evidence video encoder produced an empty file");
    }
    return {
      bytes: new Uint8Array(bytes),
      durationMs: estimatedDurationMs(input.frameCount, input.frameRate),
    };
  }
}

export class VisualEvidenceExecutor implements ExecutorPlugin {
  constructor(
    private readonly inner: ExecutorPlugin,
    private readonly sessions: CdpSessionProvider,
    private readonly recorder: VisualEvidenceRecorder,
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return this.inner.capabilities();
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    const result = await this.inner.execute(stepId, action, ctx);
    return appendVisualEvidenceArtifact({ action, result, ctx, sessions: this.sessions, recorder: this.recorder });
  }

  verify(criteria: unknown, ctx: RunContext): Promise<VerifyResult> {
    return this.inner.verify(criteria, ctx);
  }
}

export class VisualEvidenceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message);
    this.name = "VisualEvidenceError";
  }
}

export async function appendVisualEvidenceArtifact(input: {
  readonly action: unknown;
  readonly result: StepResult;
  readonly ctx: RunContext;
  readonly sessions: CdpSessionProvider;
  readonly recorder: VisualEvidenceRecorder;
}): Promise<StepResult> {
  const policy = recordingPolicyFromAction(input.action);
  if (!shouldCapture(policy, input.result)) return input.result;
  return withSpan(SPAN.artifactCapture, spanCommonFromContext(input.ctx), {}, async () => {
    const artifactRef = await input.recorder.captureStepScreenshot({
      session: input.sessions.forLease(input.ctx.leaseId),
      tenantId: input.ctx.tenantId,
      runId: input.ctx.runId,
      nodeId: input.ctx.nodeId,
      stepId: input.result.stepId,
      attempt: input.ctx.attempt,
      result: input.result,
    });
    return { ...input.result, artifacts: [...input.result.artifacts, artifactRef] };
  });
}

function normalizeCaptureInput(
  input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    stepId: string;
    attempt: number;
  },
  cfg: PgVisualEvidenceRecorderConfig,
): { tenantId: string; runId: string; stepId: string; attempt: number; filename: string; retentionDays: number } {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const runId = requireNonEmpty(input.runId, "runId");
  const stepId = requireNonEmpty(input.stepId, "stepId");
  const nodeId = requireNonEmpty(input.nodeId, "nodeId");
  if (!Number.isInteger(input.attempt) || input.attempt < 0) {
    throw new VisualEvidenceError("visual evidence attempt must be a non-negative integer");
  }
  if (!Number.isInteger(cfg.retentionDays) || cfg.retentionDays <= 0) {
    throw new VisualEvidenceError("visual evidence retentionDays must be a positive integer");
  }
  return {
    tenantId,
    runId,
    stepId,
    attempt: input.attempt,
    filename: `${safeFilePart(nodeId)}-${safeFilePart(stepId)}-attempt-${input.attempt}.png`,
    retentionDays: cfg.retentionDays,
  };
}

interface NormalizedVideoStartInput {
  tenantId: string;
  runId: string;
  leaseId: string;
  correlationId: string;
  policy: VisualEvidenceVideoPolicy;
  retentionDays: number;
  ffmpegPath: string;
  frameIntervalMs: number;
  frameRate: number;
}

function normalizeVideoStartInput(
  input: {
    tenantId: string;
    runId: string;
    leaseId: string;
    correlationId: string;
    policy: VisualEvidenceVideoPolicy;
  },
  cfg: PgScreenshotFrameVideoRecorderConfig,
): NormalizedVideoStartInput {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const runId = requireNonEmpty(input.runId, "runId");
  const leaseId = requireNonEmpty(input.leaseId, "leaseId");
  const correlationId = requireNonEmpty(input.correlationId, "correlationId");
  if (input.policy !== "always" && input.policy !== "failure") {
    throw new VisualEvidenceError("visual evidence video policy must be always or failure");
  }
  if (!Number.isInteger(cfg.retentionDays) || cfg.retentionDays <= 0) {
    throw new VisualEvidenceError("visual evidence video retentionDays must be a positive integer");
  }
  const ffmpegPath = requireNonEmpty(cfg.ffmpegPath, "ffmpegPath");
  const frameIntervalMs = cfg.frameIntervalMs ?? 1000;
  if (!Number.isInteger(frameIntervalMs) || frameIntervalMs <= 0) {
    throw new VisualEvidenceError("visual evidence video frameIntervalMs must be a positive integer");
  }
  const frameRate = cfg.frameRate ?? Math.max(1, Math.round(1000 / frameIntervalMs));
  if (!Number.isInteger(frameRate) || frameRate <= 0) {
    throw new VisualEvidenceError("visual evidence video frameRate must be a positive integer");
  }
  return {
    tenantId,
    runId,
    leaseId,
    correlationId,
    policy: input.policy,
    retentionDays: cfg.retentionDays,
    ffmpegPath,
    frameIntervalMs,
    frameRate,
  };
}

function frameFileName(frameNo: number): string {
  return `frame-${String(frameNo).padStart(6, "0")}.png`;
}

function normalizeDurationMs(durationMs: number, frameCount: number, frameRate: number): number {
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    return Math.round(durationMs);
  }
  return estimatedDurationMs(frameCount, frameRate);
}

function estimatedDurationMs(frameCount: number, frameRate: number): number {
  return Math.max(1, Math.round((Math.max(1, frameCount) / Math.max(1, frameRate)) * 1000));
}

async function captureScreenshotPng(session: CdpSession): Promise<Uint8Array> {
  await applyCaptureMask(session);
  let response: { data?: unknown };
  let restoreError: unknown;
  try {
    response = await session.sendCDP<{ data?: unknown }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
    });
  } finally {
    try {
      await clearCaptureMask(session);
    } catch (err) {
      restoreError = err;
    }
  }
  if (restoreError !== undefined) {
    throw new VisualEvidenceError("visual evidence mask restore failed closed", restoreError);
  }
  if (typeof response.data !== "string" || response.data.length === 0) {
    throw new VisualEvidenceError("visual evidence screenshot response missing Page.captureScreenshot data");
  }
  const bytes = new Uint8Array(Buffer.from(response.data, "base64"));
  if (bytes.byteLength === 0) {
    throw new VisualEvidenceError("visual evidence screenshot bytes are empty");
  }
  return bytes;
}

async function applyCaptureMask(session: CdpSession): Promise<void> {
  const response = await session.sendCDP<{ exceptionDetails?: unknown; result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: VISUAL_EVIDENCE_MASK_APPLY_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new VisualEvidenceError("visual evidence mask injection failed closed");
  }
  const value = response.result?.value;
  if (typeof value === "object" && value !== null && "skippedFrames" in value) {
    const skippedFrames = (value as { skippedFrames?: unknown }).skippedFrames;
    if (typeof skippedFrames === "number" && skippedFrames > 0) {
      throw new VisualEvidenceError("visual evidence mask skipped inaccessible frames");
    }
  }
}

async function clearCaptureMask(session: CdpSession): Promise<void> {
  const response = await session.sendCDP<{ exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression: VISUAL_EVIDENCE_MASK_CLEAR_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new VisualEvidenceError("visual evidence mask cleanup failed closed");
  }
}

function recordingPolicyFromAction(action: unknown): VisualRecordingPolicy {
  if (typeof action !== "object" || action === null) return "never";
  const value = (action as { recording?: unknown }).recording;
  if (value === "always" || value === "masked_on_failure" || value === "never") return value;
  return "never";
}

function shouldCapture(policy: VisualRecordingPolicy, result: StepResult): boolean {
  if (policy === "always") return true;
  if (policy === "masked_on_failure") return result.status !== "success";
  return false;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new VisualEvidenceError(`visual evidence ${label} is required`);
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "step";
}

const VISUAL_EVIDENCE_MASK_APPLY_SCRIPT = String.raw`
(() => {
  const KEY = "__rpaVisualEvidenceMask";
  const prior = window[KEY];
  if (prior && typeof prior.restore === "function") prior.restore();

  const originals = [];
  const sensitiveAttr = /(password|passwd|secret|token|otp|api[-_ ]?key|authorization|credential|ssn|rrn|resident|passport|account|iban|card|credit|email|phone|tel)/i;
  const replacements = [
    [/\bAuthorization\s*:\s*\S[^\r\n]*/gi, "Authorization: [REDACTED:credential]"],
    [/\bBearer\s+\S[^\r\n]*/gi, "Bearer [REDACTED:credential]"],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:pii:email]"],
    [/\b\d{6}-\d{7}\b/g, "[REDACTED:pii:rrn]"],
    [/\b(?:\d[ -]?){12,18}\d\b/g, "[REDACTED:pii:number]"],
    [/(?<![\d(])(?<!\d[ -])(?:\+?\d{1,3}[ -])?\(?\d{2,4}\)?[ -]\d{3,4}[ -]?\d{4}(?![ -]?\d)/g, "[REDACTED:pii:phone]"],
  ];

  function maskText(value) {
    let out = value;
    for (const [pattern, label] of replacements) out = out.replace(pattern, label);
    return out;
  }

  function attrText(el) {
    return [
      el.getAttribute("type"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("data-rpa-sensitive"),
    ].filter(Boolean).join(" ");
  }

  const styles = [];
  const visitedRoots = new WeakSet();
  let maskedFields = 0;
  let maskedTextNodes = 0;
  let maskedShadowRoots = 0;
  let maskedFrames = 0;
  let maskedCrossOriginFrames = 0;
  let skippedFrames = 0;

  function installStyle(root) {
    const ownerDocument = root.nodeType === 9 ? root : (root.ownerDocument || document);
    const style = ownerDocument.createElement("style");
    style.id = "__rpa_visual_evidence_mask_style";
    style.textContent = [
      "input[type='password'], input[type='email'], input[type='tel'],",
      "input[autocomplete*='cc-'], input[autocomplete*='password'], input[autocomplete*='one-time-code'],",
      "textarea[data-rpa-sensitive], [data-rpa-sensitive='true'], [contenteditable='true'][data-rpa-sensitive='true'] {",
      "  color: transparent !important; caret-color: transparent !important;",
      "  text-shadow: none !important; background: #111827 !important;",
      "  border-color: #111827 !important;",
      "}",
      "input::placeholder, textarea::placeholder { color: transparent !important; }",
    ].join("\n");
    const target = root.nodeType === 11 ? root : ownerDocument.documentElement;
    if (target) {
      target.appendChild(style);
      styles.push(style);
    }
  }

  function maskFieldsIn(root) {
    const fields = root.querySelectorAll("input, textarea, [contenteditable='true']");
    for (const el of fields) {
      const input = el;
      const type = (input.getAttribute("type") || "").toLowerCase();
      const sensitive = type === "password" || type === "email" || type === "tel" || sensitiveAttr.test(attrText(input));
      if (!sensitive) continue;
      if ("value" in input && typeof input.value === "string") {
        originals.push({ node: input, prop: "value", value: input.value });
        input.value = input.value.length > 0 ? "[REDACTED]" : "";
        maskedFields += 1;
      } else {
        originals.push({ node: input, prop: "textContent", value: input.textContent });
        input.textContent = input.textContent && input.textContent.length > 0 ? "[REDACTED]" : "";
        maskedFields += 1;
      }
    }
  }

  function maskTextNodesIn(root) {
    const doc = root.nodeType === 9 ? root : (root.ownerDocument || document);
    const walkerRoot = root.nodeType === 9 ? (root.body || root.documentElement) : root;
    if (!walkerRoot) return;
    const walker = doc.createTreeWalker(walkerRoot, 4, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return 2;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/i.test(parent.tagName)) return 2;
        const value = node.nodeValue || "";
        return maskText(value) !== value ? 1 : 3;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      originals.push({ node, prop: "nodeValue", value: node.nodeValue });
      node.nodeValue = maskText(node.nodeValue || "");
      maskedTextNodes += 1;
    }
  }

  function maskFrameElement(frame) {
    originals.push({ node: frame, prop: "styleAttribute", value: frame.getAttribute("style") });
    frame.style.visibility = "hidden";
    frame.style.background = "#111827";
    frame.style.borderColor = "#111827";
    maskedCrossOriginFrames += 1;
  }

  function visitRoot(root, isShadowRoot) {
    if (!root || visitedRoots.has(root) || typeof root.querySelectorAll !== "function") return;
    visitedRoots.add(root);
    installStyle(root);
    maskFieldsIn(root);
    maskTextNodesIn(root);
    if (isShadowRoot) maskedShadowRoots += 1;

    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visitRoot(el.shadowRoot, true);
    }
    for (const frame of root.querySelectorAll("iframe, frame")) {
      try {
        const frameDocument = frame.contentDocument;
        if (frameDocument && frameDocument.documentElement) {
          visitRoot(frameDocument, false);
          maskedFrames += 1;
        } else {
          maskFrameElement(frame);
        }
      } catch {
        try {
          maskFrameElement(frame);
        } catch {
          skippedFrames += 1;
        }
      }
    }
  }

  visitRoot(document, false);

  window[KEY] = {
    maskedFields,
    maskedTextNodes,
    maskedShadowRoots,
    maskedFrames,
    maskedCrossOriginFrames,
    skippedFrames,
    restore() {
      for (let i = originals.length - 1; i >= 0; i -= 1) {
        const item = originals[i];
        if (item.prop === "styleAttribute") {
          if (item.value === null) item.node.removeAttribute("style");
          else item.node.setAttribute("style", item.value);
        } else {
          item.node[item.prop] = item.value;
        }
      }
      for (let i = styles.length - 1; i >= 0; i -= 1) styles[i].remove();
      delete window[KEY];
    },
  };

  return { maskedFields, maskedTextNodes, maskedShadowRoots, maskedFrames, maskedCrossOriginFrames, skippedFrames };
})()
`;

const VISUAL_EVIDENCE_MASK_CLEAR_SCRIPT = String.raw`
(() => {
  const KEY = "__rpaVisualEvidenceMask";
  const state = window[KEY];
  if (state && typeof state.restore === "function") {
    state.restore();
    return { restored: true };
  }
  return { restored: false };
})()
`;
