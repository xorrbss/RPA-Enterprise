/**
 * Natural-language scenario generation integration.
 *
 * 실행: temp PG15 게이트 위에서
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/api-scenario-generations.int.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { LlmGatewayScenarioPlannerClient, createLlmScenarioPlanner } from "../src/api/llm-scenario-planner";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueueInput, RunEnqueuer, SinkDeliverEnqueueInput } from "../src/api/run-queue";
import { BufferedScenarioGenerationArtifactSink } from "../src/api/scenario-generation-artifacts";
import { PgScenarioGenerationLlmCallIdempotencyStore } from "../src/api/scenario-generation-llm-call-idempotency-store";
import type { ScenarioPlanner } from "../src/api/scenario-generation-types";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { buildServer } from "../src/api/server";
import { ArtifactRedactionContentTransform } from "../src/artifacts/artifact-redaction-content-transform";
import { FsArtifactRedactor } from "../src/artifacts/fs-artifact-lifecycle-store";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import type { CdpSession } from "../src/executor/cdp-session";
import { AjvStructuredOutputValidator } from "../src/gateway/ajv-structured-output-validator";
import { SafeCapabilityGate } from "../src/gateway/capability-gate";
import { PgGatewayArtifactSink, FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import { PgLlmCallIdempotencyStore } from "../src/gateway/pg-llm-call-idempotency-store";
import { LlmGateway } from "../src/gateway/llm-gateway";
import { createDomUtilityExecutorFactory } from "../src/runtime/dom-executor-factory";
import { PgScreenshotFrameVideoRecorder, PgVisualEvidenceRecorder, type ScreenshotFrameVideoEncoder } from "../src/runtime/visual-evidence";
import { pgBrowserLeasePlanResolver } from "../src/worker/pg-browser-lease-plan-resolver";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";
import type { SecretRef } from "../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  type ArtifactRealObjectStorePortBinding,
  type RuntimeWorkerJob,
} from "../../ts/runtime-contract";
import type {
  CorrelationId,
  LLMBackendAdapter,
  LLMRequest,
  LLMStreamEvent,
  ModelCapabilities,
  RunId,
  SignedCommandRegistry,
  TenantId,
} from "../../ts/security-middleware-contract";
import { DeterministicGatewayRedactionBoundary } from "../../gateway/redaction-boundary";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_generation_int";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const SITE = "10000000-0000-4000-8000-0000000000a1";
const IDENTITY = "10000000-0000-4000-8000-0000000000a2";
const NETWORK = "10000000-0000-4000-8000-0000000000a3";
const MODEL_POLICY = "10000000-0000-4000-8000-0000000000a4";
const WORKER = "10000000-0000-4000-8000-0000000000a5";
const VIDEO_IDENTITY = "10000000-0000-4000-8000-0000000000a6";
const OTHER_SITE = "10000000-0000-4000-8000-0000000000b1";
const OTHER_IDENTITY = "10000000-0000-4000-8000-0000000000b2";
const OTHER_NETWORK = "10000000-0000-4000-8000-0000000000b3";
const AMBIGUOUS_NETWORK = "10000000-0000-4000-8000-0000000000c1";
const LIFECYCLE_BYPASS_ROLE = "rpa_generation_lifecycle_bypass";
const LIFECYCLE_BYPASS_PASSWORD = "rpa_generation_lifecycle_bypass";
const SECRET = new TextEncoder().encode("scenario-generation-int-secret-do-not-use-0123456789");

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return {
      kind: "available",
      snapshot: {
        sourceRef: "secret://staging/signed-command-registry" as SecretRef,
        commands: [],
      },
    };
  },
};

const gatewayCaps = (): ModelCapabilities => ({
  domReasoning: true,
  vision: false,
  jsonMode: false,
  toolCall: false,
  sse: true,
  maxContextTokens: 8000,
});

const textDone = (text: string): LLMStreamEvent[] => [
  { type: "text_delta", text },
  { type: "usage", inputTokens: 7, outputTokens: 3, cost: 0 },
  { type: "done", finishReason: "stop" },
];

function promptRunGatewayAdapter(calls: LLMRequest[]): LLMBackendAdapter {
  return {
    id: "prompt-run-fake",
    capabilities: gatewayCaps,
    async *streamCall(req, signal) {
      calls.push(req);
      if (signal.aborted) {
        yield { type: "aborted" };
        return;
      }
      const text =
        req.metadata.primitive === "extract"
          ? JSON.stringify({ summary: "ok", rows: [{ title: "Recent notice", url: "https://example.com/notices/1" }] })
          : "observed prompt-created page";
      for (const event of textDone(text)) yield event;
    },
  };
}

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

class PromptRunFakeCdpSession implements CdpSession {
  private currentUrl = "about:blank";

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async reload(): Promise<void> {}

  async evaluate<R = unknown>(): Promise<R> {
    return {
      flags: {},
      authenticated: false,
      iframeCount: 0,
      networkJson: JSON.stringify({ rows: [{ title: "Recent notice", url: "https://example.com/notices/1" }] }),
      visibleText: "Recent notice https://example.com/notices/1",
      html: "<main><a href=\"/notices/1\">Recent notice</a></main>",
      installed: true,
      already: false,
    } as R;
  }

  async sendCDP<T = unknown>(method: string): Promise<T> {
    if (method === "Runtime.evaluate") {
      return { result: { value: { ok: true, skippedFrames: 0 } } } as T;
    }
    if (method === "Page.captureScreenshot") {
      return { data: PNG_1X1_BASE64 } as T;
    }
    return { nodes: [{ role: { value: "main" }, name: { value: "Notices" } }] } as T;
  }

  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async setInputFiles(): Promise<void> {}
  downloadDir(): string {
    return tmpdir();
  }
  async waitForDownload(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

const fakeVideoEncoder = (): ScreenshotFrameVideoEncoder => ({
  async encode() {
    return { bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]), durationMs: 1200 };
  },
});

interface GeneratedRunTrace {
  readonly status: string | null;
  readonly steps: readonly {
    readonly step_id: string;
    readonly node_id: string;
    readonly action: string;
    readonly status: string;
    readonly artifacts: string[];
    readonly stagehand_call_ids: string[];
  }[];
  readonly calls: readonly {
    readonly id: string;
    readonly step_id: string;
    readonly model: string;
    readonly stream_status: string | null;
    readonly output_ref: string | null;
  }[];
  readonly artifacts: readonly {
    readonly id: string;
    readonly step_id: string | null;
    readonly type: string;
    readonly media_type: string | null;
    readonly redaction_status: string;
  }[];
}

async function generatedRunTrace(pool: ReturnType<typeof createPool>, runId: string): Promise<GeneratedRunTrace> {
  return withTenantTx(pool, TENANT, async (client) => {
    const statusRows = await client.query<{ status: string }>(
      `SELECT status FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [TENANT, runId],
    );
    const stepRows = await client.query<GeneratedRunTrace["steps"][number]>(
      `SELECT step_id, node_id, action, status, artifacts, stagehand_call_ids
         FROM run_steps
        WHERE tenant_id=$1::uuid AND run_id=$2::uuid
        ORDER BY started_at, step_id, attempt`,
      [TENANT, runId],
    );
    const callRows = await client.query<GeneratedRunTrace["calls"][number]>(
      `SELECT id::text, step_id, model, stream_status, output_ref
         FROM stagehand_calls
        WHERE tenant_id=$1::uuid AND run_id=$2::uuid
        ORDER BY step_id, attempt, id`,
      [TENANT, runId],
    );
    const artifactRows = await client.query<GeneratedRunTrace["artifacts"][number]>(
      `SELECT id::text, step_id, type, media_type, redaction_status
         FROM artifacts
        WHERE tenant_id=$1::uuid AND run_id=$2::uuid
        ORDER BY step_id, id`,
      [TENANT, runId],
    );
    return {
      status: statusRows.rows[0]?.status ?? null,
      steps: stepRows.rows,
      calls: callRows.rows,
      artifacts: artifactRows.rows,
    };
  });
}

async function createLifecycleBypassRole(): Promise<void> {
  const admin = createPool({
    host: process.env.PGHOST,
    port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: "postgres",
    password: process.env.PGADMIN_PASSWORD,
    options: `-c search_path=${SCHEMA},public`,
  });
  try {
    await admin.query(`DROP ROLE IF EXISTS ${LIFECYCLE_BYPASS_ROLE}`);
    await admin.query(
      `CREATE ROLE ${LIFECYCLE_BYPASS_ROLE}
         LOGIN
         PASSWORD '${LIFECYCLE_BYPASS_PASSWORD}'
         NOSUPERUSER
         NOCREATEDB
         NOCREATEROLE
         NOINHERIT
         BYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
  } finally {
    await admin.end();
  }
}

function createLifecycleBypassPool(): ReturnType<typeof createPool> {
  return createPool({
    host: process.env.PGHOST,
    port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: LIFECYCLE_BYPASS_ROLE,
    password: LIFECYCLE_BYPASS_PASSWORD,
    options: `-c search_path=${SCHEMA},public`,
  });
}

const artifactObjectBinding: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: "local-fs-int",
  credentialRef: "secret://test/artifact-object-store" as SecretRef,
  evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
};

async function redactPendingRunArtifacts(input: {
  readonly runId: string;
  readonly artifactDir: string;
  readonly expectedPasses: number;
}): Promise<void> {
  const lifecyclePool = createLifecycleBypassPool();
  try {
    const redactionWorker = new PgRuntimeWorker(lifecyclePool, {
      workerId: WORKER,
      artifactRedactor: new FsArtifactRedactor(
        new FsObjectStore(input.artifactDir),
        artifactObjectBinding,
        new ArtifactRedactionContentTransform(),
      ),
      artifactLifecycleClaimTtlMs: 60_000,
      artifactRedactionMaxAttempts: 3,
    });
    for (let index = 0; index < input.expectedPasses; index += 1) {
      const result = await redactionWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT as TenantId,
        runId: input.runId as RunId,
        correlationId: `20000000-0000-4000-8000-00000000aa0${index}` as CorrelationId,
      });
      check(`artifact redaction pass ${index + 1} completes`, result.kind === "completed", JSON.stringify(result));
    }
  } finally {
    await lifecyclePool.end();
  }
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
      await setup.query(
        `INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`,
        [WORKER],
      );
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    await createLifecycleBypassRole();
    console.log("lifecycle BYPASSRLS role ready");

    await withTenantTx(pool, TENANT, async (client) => {
      await client.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1::uuid, $2::uuid, 'demo', 'https://example.com', 'green', false, '{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await client.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1::uuid, $2::uuid, 'other-demo', 'https://other.example', 'green', false, '{"flags":{}}'::jsonb)`,
        [OTHER_SITE, TENANT],
      );
      await client.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'default')`,
        [IDENTITY, TENANT, SITE],
      );
      await client.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'other-default')`,
        [OTHER_IDENTITY, TENANT, OTHER_SITE],
      );
      await client.query(
        `INSERT INTO network_policies (id, tenant_id, allowed_domains)
         VALUES ($1::uuid, $2::uuid, ARRAY['example.com'])`,
        [NETWORK, TENANT],
      );
      await client.query(
        `INSERT INTO network_policies (id, tenant_id, allowed_domains)
         VALUES ($1::uuid, $2::uuid, ARRAY['other.example'])`,
        [OTHER_NETWORK, TENANT],
      );
      await client.query(
        `INSERT INTO gateway_policies (id, tenant_id, model, version, capabilities, budget, is_default)
         VALUES ($1::uuid, $2::uuid, 'codex-gen', 1, '{"jsonMode":true}'::jsonb, '{"maxInputTokens":1000,"maxOutputTokens":1000}'::jsonb, false)`,
        [MODEL_POLICY, TENANT],
      );
    });
    console.log("seeded target rows");

    const enqueuedRuns: RunEnqueueInput[] = [];
    const enqueuedArtifactRedactions: Array<{ tenantId: string; correlationId: string }> = [];
    const enqueuer: RunEnqueuer = {
      async enqueueRunClaim(_client, input) {
        enqueuedRuns.push(input);
      },
      async enqueueRunAbort() {},
      async enqueueSinkDeliver(_client, _input: SinkDeliverEnqueueInput) {},
      async enqueueArtifactRedaction(_client, input) {
        enqueuedArtifactRedactions.push(input);
      },
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: "operator-a", tenant_id: TENANT, roles: ["operator"] });
      const viewer = await mint({ sub: "viewer-a", tenant_id: TENANT, roles: ["viewer"] });

      const blockedPrompt = "공지사항에서 최근 게시글 제목을 수집해줘";
      const blocked = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-blocked-1" },
        payload: {
          prompt: blockedPrompt,
          name: "generated-blocked",
        },
      });
      check("generation without target/start_url saves blocked → 201", blocked.statusCode === 201, blocked.body);
      const blockedBody = blocked.json();
      check("blocked status", blockedBody.status === "blocked", blocked.body);
      check("blocked has no run", blockedBody.run_id === null, blocked.body);
      check(
        "blocked generation command response includes ledger metadata",
        blockedBody.created_by === "operator-a" &&
          typeof blockedBody.created_at === "string" &&
          Number.isFinite(Date.parse(blockedBody.created_at)),
        blocked.body,
      );
      check(
        "blocked explains missing target/start_url",
        Array.isArray(blockedBody.blockers) &&
          blockedBody.blockers.includes("target_required_for_auto_run") &&
          blockedBody.blockers.includes("start_url_required_for_auto_run"),
        blocked.body,
      );
      check("blocked scenario saved", typeof blockedBody.scenario_id === "string" && typeof blockedBody.scenario_version_id === "string", blocked.body);

      const gotBlocked = await app.inject({
        method: "GET",
        url: `/v1/scenario-generations/${blockedBody.generation_id}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer can read generation → 200", gotBlocked.statusCode === 200, gotBlocked.body);
      check("read generation preserves prompt hash", gotBlocked.json().prompt_hash === blockedBody.prompt_hash, gotBlocked.body);
      check(
        "read generation preserves command ledger metadata",
        gotBlocked.json().created_by === blockedBody.created_by && gotBlocked.json().created_at === blockedBody.created_at,
        gotBlocked.body,
      );
      check("read generation redacts prompt instructions", !gotBlocked.body.includes("공지사항에서 최근 게시글 제목"), gotBlocked.body);
      await withTenantTx(pool, TENANT, async (client) => {
        const row = await client.query<{ generation_row: string; scenario_version_ir: string }>(
          `SELECT
              g::text AS generation_row,
              sv.ir::text AS scenario_version_ir
             FROM scenario_generations g
             JOIN scenario_versions sv ON sv.tenant_id = g.tenant_id AND sv.id = g.scenario_version_id
            WHERE g.id=$1::uuid`,
          [blockedBody.generation_id],
        );
        check(
          "scenario generation ledger does not persist prompt plaintext in draft_ir",
          row.rows[0]?.generation_row.includes(blockedPrompt) === false,
          row.rows[0]?.generation_row,
        );
        check(
          "scenario version keeps executable prompt-derived IR outside generation ledger",
          row.rows[0]?.scenario_version_ir.includes(blockedPrompt) === true,
          row.rows[0]?.scenario_version_ir,
        );
      });

      const runnablePayload = {
        prompt: "https://example.com 에서 최근 공지 제목과 링크를 수집해줘",
        name: "generated-runnable",
        model: "codex-gen",
        start_url: "https://example.com/notices",
        target: {
          site_profile_id: SITE,
          browser_identity_id: IDENTITY,
          network_policy_id: NETWORK,
        },
        evidence: { screenshot: "each_step", video: "never" },
      };
      const runnable = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-run-1", "x-correlation-id": "20000000-0000-4000-8000-0000000000a1" },
        payload: runnablePayload,
      });
      check("generation with target/start_url queues run → 201", runnable.statusCode === 201, runnable.body);
      const runBody = runnable.json();
      check("run_queued status", runBody.status === "run_queued", runnable.body);
      check("run model echoed", runBody.model === "codex-gen", runnable.body);
      check("run id returned", typeof runBody.run_id === "string" && /^[0-9a-f-]{36}$/i.test(runBody.run_id), runnable.body);
      check("one run_claim enqueued", enqueuedRuns.length === 1 && enqueuedRuns[0]?.runId === runBody.run_id, JSON.stringify(enqueuedRuns));
      check(
        "generated IR records every-step evidence",
        isRecord(runBody.draft_ir) &&
          isRecord(runBody.draft_ir.nodes) &&
          isRecord(runBody.draft_ir.nodes.open_start_url) &&
          isRecord(runBody.draft_ir.nodes.open_start_url.policy) &&
          runBody.draft_ir.nodes.open_start_url.policy.recording === "always",
        runnable.body,
      );
      check(
        "generated IR preserves requested evidence policy in meta",
        isRecord(runBody.draft_ir) &&
          isRecord(runBody.draft_ir.meta) &&
          isRecord(runBody.draft_ir.meta.evidence) &&
          runBody.draft_ir.meta.evidence.screenshot === "each_step" &&
          runBody.draft_ir.meta.evidence.video === "never",
        runnable.body,
      );
      await withTenantTx(pool, TENANT, async (client) => {
        const rows = await client.query<{ run_count: string; generation_count: string }>(
          `SELECT
             (SELECT count(*)::text FROM runs WHERE id=$1::uuid) AS run_count,
             (SELECT count(*)::text FROM scenario_generations WHERE id=$2::uuid AND run_id=$1::uuid) AS generation_count`,
          [runBody.run_id, runBody.generation_id],
        );
        check("run + generation rows persisted", rows.rows[0]?.run_count === "1" && rows.rows[0]?.generation_count === "1", JSON.stringify(rows.rows[0]));
      });

      const artifactDir = mkdtempSync(join(tmpdir(), "rpa-generation-artifacts-"));
      try {
        const gatewayCalls: LLMRequest[] = [];
        const lifecycleJobs: RuntimeWorkerJob[] = [];
        const artifactStore = new FsObjectStore(artifactDir);
        const gateway = new LlmGateway({
          primary: promptRunGatewayAdapter(gatewayCalls),
          gate: new SafeCapabilityGate(),
          validator: new AjvStructuredOutputValidator(),
          sink: new PgGatewayArtifactSink(pool, artifactStore, { retentionDays: 90 }),
          idempotency: new PgLlmCallIdempotencyStore(pool),
          redactionBoundary: new DeterministicGatewayRedactionBoundary(),
          config: { retryMax: 0, fallbackAttempts: 0, repairAttempts: 0 },
        });
        const worker = new PgRuntimeWorker(pool, {
          workerId: WORKER,
          browserLeasePlanResolver: pgBrowserLeasePlanResolver,
          browserSessionProvider: new TestFakeBrowserSessionProvider({
            makeSession: () => new PromptRunFakeCdpSession(),
          }),
          allowTestBrowserSessionProvider: true,
          executorFactory: createDomUtilityExecutorFactory(gateway, {
            model: "codex-fallback",
            promptTemplateVersion: "prompt-run-int-v1",
            budget: { maxInputTokens: 1000, maxOutputTokens: 1000, maxCost: 1 },
          }),
          visualEvidenceRecorder: new PgVisualEvidenceRecorder(pool, artifactStore, { retentionDays: 90 }),
          runtimeJobEnqueuer: {
            async enqueueRuntimeJob(_client, job) {
              lifecycleJobs.push(job);
            },
          },
        });
        const driven = await worker.handle({
          kind: "run_claim",
          tenantId: TENANT as TenantId,
          runId: runBody.run_id as RunId,
          correlationId: "20000000-0000-4000-8000-0000000000a1" as CorrelationId,
        });
        check("prompt-created run drives through worker -> completed job", driven.kind === "completed", JSON.stringify(driven));
        const trace = await generatedRunTrace(pool, runBody.run_id);
        const byNode = new Map(trace.steps.map((step) => [step.node_id, step]));
        check("prompt-created run status completed", trace.status === "completed", JSON.stringify(trace));
        check(
          "prompt-created run records navigate/observe/extract steps",
          byNode.get("open_start_url")?.action === "navigate" &&
            byNode.get("open_start_url")?.status === "success" &&
            byNode.get("understand_request")?.action === "observe" &&
            byNode.get("understand_request")?.status === "success" &&
            byNode.get("extract_results")?.action === "extract" &&
            byNode.get("extract_results")?.status === "success",
          JSON.stringify(trace.steps),
        );
        check(
          "observe/extract steps store durable stagehand call ids",
          (byNode.get("understand_request")?.stagehand_call_ids.length ?? 0) === 1 &&
            (byNode.get("extract_results")?.stagehand_call_ids.length ?? 0) === 1,
          JSON.stringify(trace.steps),
        );
        check(
          "stagehand_calls persist done rows with selected model and output_ref",
          trace.calls.length === 2 &&
            trace.calls.every((call) => call.stream_status === "done" && call.output_ref !== null && call.model === "codex-gen"),
          JSON.stringify(trace.calls),
        );
        const outputRefs = trace.calls
          .map((call) => call.output_ref)
          .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
        const stepArtifactRefs = [
          ...(byNode.get("open_start_url")?.artifacts ?? []),
          ...(byNode.get("understand_request")?.artifacts ?? []),
          ...(byNode.get("extract_results")?.artifacts ?? []),
        ];
        check(
          "LLM output refs are linked into run_steps artifacts",
          outputRefs.length === 2 && outputRefs.every((ref) => stepArtifactRefs.includes(ref)) && stepArtifactRefs.length === 5,
          JSON.stringify({ outputRefs, stepArtifactRefs }),
        );
        check("pending LLM and screenshot artifacts remain hidden by artifact read RLS", trace.artifacts.length === 0, JSON.stringify(trace.artifacts));
        check(
          "object store receives LLM output and screenshot image files",
          readdirSync(artifactDir).filter((name) => name.endsWith(".bin")).length === 5,
          JSON.stringify(readdirSync(artifactDir)),
        );
        check(
          "gateway calls use run-selected model for observe/extract",
          gatewayCalls.length === 2 && gatewayCalls.every((call) => call.model === "codex-gen"),
          JSON.stringify(gatewayCalls.map((call) => ({ model: call.model, primitive: call.metadata.primitive }))),
        );
        check(
          "artifact lifecycle redaction jobs are enqueued per prompt-created artifact",
          lifecycleJobs.length === 6 &&
            lifecycleJobs.filter((job) => job.kind === "artifact_redaction" && job.runId === runBody.run_id).length === 5 &&
            lifecycleJobs[lifecycleJobs.length - 1]?.kind === "artifact_retention",
          JSON.stringify(lifecycleJobs),
        );
        await redactPendingRunArtifacts({
          runId: runBody.run_id,
          artifactDir,
          expectedPasses: 5,
        });
        const redactedTrace = await generatedRunTrace(pool, runBody.run_id);
        const redactedLlmArtifacts = redactedTrace.artifacts.filter((artifact) => artifact.type === "llm_output");
        const redactedScreenshotArtifacts = redactedTrace.artifacts.filter((artifact) => artifact.type === "screenshot_masked");
        check(
          "redacted LLM and screenshot artifacts become visible to run trace",
          redactedTrace.artifacts.length === 5 &&
            redactedLlmArtifacts.length === 2 &&
            redactedLlmArtifacts.every(
              (artifact) => artifact.media_type === "text/plain; charset=utf-8" && artifact.redaction_status === "redacted",
            ) &&
            redactedScreenshotArtifacts.length === 3 &&
            redactedScreenshotArtifacts.every(
              (artifact) => artifact.media_type === "image/png" && artifact.redaction_status === "redacted",
            ),
          JSON.stringify(redactedTrace.artifacts),
        );
        check(
          "redacted artifact object files are preserved separately",
          readdirSync(artifactDir).filter((name) => name.endsWith(".bin")).length >= 10,
          JSON.stringify(readdirSync(artifactDir)),
        );

        const artifactReadApp = buildServer({
          pool,
          auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
          rbac: new RoleMatrixRbacMiddleware(),
          idempotency: new PgControlPlaneIdempotencyStore(pool),
          enqueuer,
          signedCommandRegistry,
          artifactStore: new FsObjectStore(artifactDir),
          securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
        });
        await artifactReadApp.ready();
        try {
          const listedArtifacts = await artifactReadApp.inject({
            method: "GET",
            url: `/v1/runs/${runBody.run_id}/artifacts`,
            headers: { authorization: `Bearer ${viewer}` },
          });
          check("viewer can list redacted prompt-created artifacts -> 200", listedArtifacts.statusCode === 200, listedArtifacts.body);
          const listedArtifactsBody = listedArtifacts.json();
          const listedItems = Array.isArray(listedArtifactsBody.items) ? listedArtifactsBody.items : [];
          const listedLlmItems = listedItems.filter((item: unknown) => isRecord(item) && item.type === "llm_output");
          const listedScreenshotItems = listedItems.filter((item: unknown) => isRecord(item) && item.type === "screenshot_masked");
          check(
            "artifact list exposes metadata only for LLM outputs and screenshots",
            listedItems.length === 5 &&
              listedLlmItems.length === 2 &&
              listedScreenshotItems.length === 3 &&
              listedItems.every(
                (item: unknown) =>
                  isRecord(item) &&
                  (item.type === "llm_output" || item.type === "screenshot_masked") &&
                  item.redaction_status === "redacted" &&
                  (item.type === "llm_output" ? item.media_type === "text/plain; charset=utf-8" : item.media_type === "image/png") &&
                  !("content" in item) &&
                  !("object_ref" in item),
              ),
            listedArtifacts.body,
          );
          const firstArtifactId = listedItems.find(
            (item: unknown): item is { artifact_id: string } =>
              isRecord(item) && typeof item.artifact_id === "string" && outputRefs.includes(item.artifact_id),
          )?.artifact_id;
          check("artifact list ids match stagehand output refs", typeof firstArtifactId === "string", listedArtifacts.body);
          if (typeof firstArtifactId === "string") {
            const artifactBody = await artifactReadApp.inject({
              method: "GET",
              url: `/v1/artifacts/${firstArtifactId}`,
              headers: { authorization: `Bearer ${viewer}`, "x-correlation-id": "20000000-0000-4000-8000-0000000000a3" },
            });
            check("viewer can read redacted LLM artifact body -> 200", artifactBody.statusCode === 200, artifactBody.body);
            const artifactJson = artifactBody.json();
            check(
              "artifact body is redacted text without internal object ref",
              artifactJson.artifact_id === firstArtifactId &&
                artifactJson.redaction_status === "redacted" &&
                artifactJson.media_type === "text/plain; charset=utf-8" &&
                typeof artifactJson.content === "string" &&
                artifactJson.content.length > 0 &&
                !("object_ref" in artifactJson),
              artifactBody.body,
            );
          }
        } finally {
          await artifactReadApp.close();
        }
      } finally {
        rmSync(artifactDir, { recursive: true, force: true });
      }

      const paginationRun = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-pagination-run-1" },
        payload: {
          ...runnablePayload,
          prompt: "Click next page and collect all pages up to 4 pages from https://example.com/notices and extract notice titles and links",
          name: "generated-pagination-run",
        },
      });
      check("pagination prompt queues run -> 201", paginationRun.statusCode === 201, paginationRun.body);
      const paginationBody = paginationRun.json();
      check("pagination prompt run_queued", paginationBody.status === "run_queued" && typeof paginationBody.run_id === "string", paginationRun.body);
      const paginationIr: Record<string, unknown> = isRecord(paginationBody.draft_ir) ? paginationBody.draft_ir : {};
      const paginationNodes: Record<string, unknown> = isRecord(paginationIr.nodes) ? paginationIr.nodes : {};
      const paginationOpenStart: Record<string, unknown> = isRecord(paginationNodes.open_start_url) ? paginationNodes.open_start_url : {};
      const paginationLoopNodeBody: Record<string, unknown> = isRecord(paginationNodes.paginate_pages) ? paginationNodes.paginate_pages : {};
      const paginationLoop: Record<string, unknown> = isRecord(paginationLoopNodeBody.loop) ? paginationLoopNodeBody.loop : {};
      const paginationExtract: Record<string, unknown> = isRecord(paginationNodes.extract_current_page) ? paginationNodes.extract_current_page : {};
      const paginationAdvance: Record<string, unknown> = isRecord(paginationNodes.advance_page) ? paginationNodes.advance_page : {};
      check(
        "pagination prompt creates bounded loop IR",
        paginationIr.start === "open_start_url" &&
          paginationOpenStart.next === "paginate_pages" &&
          paginationLoop.body_target === "extract_current_page" &&
          paginationLoop.exit_target === "done" &&
          paginationLoop.until === "loop.page_count >= params.max_pages" &&
          paginationLoop.max_iterations === 4 &&
          paginationExtract.next === "advance_page" &&
          paginationAdvance.next === "paginate_pages",
        paginationRun.body,
      );
      const paginationParamsSchema: Record<string, unknown> = isRecord(paginationIr.params_schema) ? paginationIr.params_schema : {};
      const paginationParamProperties: Record<string, unknown> = isRecord(paginationParamsSchema.properties) ? paginationParamsSchema.properties : {};
      const maxPagesSchema: Record<string, unknown> = isRecord(paginationParamProperties.max_pages) ? paginationParamProperties.max_pages : {};
      check(
        "pagination params schema bounds max_pages",
        maxPagesSchema.type === "integer" &&
          maxPagesSchema.minimum === 1 &&
          maxPagesSchema.maximum === 10 &&
          maxPagesSchema.default === 3 &&
          Array.isArray(paginationParamsSchema.required) &&
          paginationParamsSchema.required.includes("max_pages"),
        paginationRun.body,
      );
      check(
        "pagination prompt enqueues second run",
        enqueuedRuns.length === 2 && enqueuedRuns[1]?.runId === paginationBody.run_id,
        JSON.stringify(enqueuedRuns),
      );
      await withTenantTx(pool, TENANT, async (client) => {
        const rows = await client.query<{ run_params: unknown; saved_ir: unknown }>(
          `SELECT r.params AS run_params, sv.ir AS saved_ir
             FROM runs r
             JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
            WHERE r.id=$1::uuid`,
          [paginationBody.run_id],
        );
        const runParams = rows.rows[0]?.run_params;
        const savedIr = rows.rows[0]?.saved_ir;
        const savedNodes: Record<string, unknown> = isRecord(savedIr) && isRecord(savedIr.nodes) ? savedIr.nodes : {};
        const savedLoopNodeBody: Record<string, unknown> = isRecord(savedNodes.paginate_pages) ? savedNodes.paginate_pages : {};
        const savedLoop: Record<string, unknown> = isRecord(savedLoopNodeBody.loop) ? savedLoopNodeBody.loop : {};
        check(
          "pagination run params persist prompt-inferred max_pages",
          isRecord(runParams) && runParams.max_pages === 4 && runParams.start_url === "https://example.com/notices",
          JSON.stringify(runParams),
        );
        check("pagination scenario version persists loop IR", savedLoop.max_iterations === 4, JSON.stringify(savedLoop));
      });

      const nextWeekNotices = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-next-week-notices-1" },
        payload: {
          ...runnablePayload,
          mode: "draft_only",
          prompt: "다음 주 공지 제목을 https://example.com/notices에서 수집해줘",
          name: "generated-next-week-notices",
        },
      });
      check("next-week prompt drafts without pagination -> 200", nextWeekNotices.statusCode === 200, nextWeekNotices.body);
      const nextWeekBody = nextWeekNotices.json();
      const nextWeekIr: Record<string, unknown> = isRecord(nextWeekBody.draft_ir) ? nextWeekBody.draft_ir : {};
      const nextWeekNodes: Record<string, unknown> = isRecord(nextWeekIr.nodes) ? nextWeekIr.nodes : {};
      const nextWeekParamsSchema: Record<string, unknown> = isRecord(nextWeekIr.params_schema) ? nextWeekIr.params_schema : {};
      const nextWeekParamProperties: Record<string, unknown> = isRecord(nextWeekParamsSchema.properties) ? nextWeekParamsSchema.properties : {};
      check(
        "next-week prompt does not create bounded pagination loop",
        nextWeekBody.status === "drafted" &&
          !Object.prototype.hasOwnProperty.call(nextWeekNodes, "paginate_pages") &&
          !Object.prototype.hasOwnProperty.call(nextWeekParamProperties, "max_pages"),
        nextWeekNotices.body,
      );
      check("next-week prompt does not enqueue run", enqueuedRuns.length === 2, JSON.stringify(enqueuedRuns));

      const inferredTarget = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-infer-target-1" },
        payload: {
          prompt: "https://example.com 에서 최근 공지 제목과 링크를 수집해줘",
          name: "generated-inferred-target",
          start_url: "https://example.com/notices",
          evidence: { screenshot: "each_step", video: "never" },
        },
      });
      check("generation infers target from start_url and queues run → 201", inferredTarget.statusCode === 201, inferredTarget.body);
      const inferredBody = inferredTarget.json();
      check("inferred target run_queued", inferredBody.status === "run_queued" && typeof inferredBody.run_id === "string", inferredTarget.body);
      check(
        "inferred target persisted into IR",
        isRecord(inferredBody.draft_ir) &&
          isRecord(inferredBody.draft_ir.target) &&
          inferredBody.draft_ir.target.site_profile_id === SITE &&
          inferredBody.draft_ir.target.browser_identity_id === IDENTITY &&
          inferredBody.draft_ir.target.network_policy_id === NETWORK,
        inferredTarget.body,
      );
      check("inferred target enqueues third run", enqueuedRuns.length === 3 && enqueuedRuns[2]?.runId === inferredBody.run_id, JSON.stringify(enqueuedRuns));

      await withTenantTx(pool, TENANT, async (client) => {
        await client.query(
          `INSERT INTO network_policies (id, tenant_id, allowed_domains)
           VALUES ($1::uuid, $2::uuid, ARRAY['example.com'])`,
          [AMBIGUOUS_NETWORK, TENANT],
        );
      });
      const ambiguousNetworkTarget = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-ambiguous-network-target-1" },
        payload: {
          prompt: "https://example.com 에서 최근 공지 제목과 링크를 수집해줘",
          name: "generated-ambiguous-network-target",
          start_url: "https://example.com/notices",
          evidence: { screenshot: "each_step", video: "never" },
        },
      });
      check("ambiguous network policy target inference saves blocked generation -> 201", ambiguousNetworkTarget.statusCode === 201, ambiguousNetworkTarget.body);
      const ambiguousNetworkBody = ambiguousNetworkTarget.json();
      check(
        "ambiguous network policy does not guess target",
        ambiguousNetworkBody.status === "blocked" &&
          ambiguousNetworkBody.run_id === null &&
          Array.isArray(ambiguousNetworkBody.blockers) &&
          ambiguousNetworkBody.blockers.includes("target_required_for_auto_run"),
        ambiguousNetworkTarget.body,
      );
      check("ambiguous network policy does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));

      const paginationLimit = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-pagination-limit-1" },
        payload: {
          ...runnablePayload,
          prompt: "Collect all pages up to 25 pages from https://example.com/notices and extract notice titles and links",
          name: "generated-pagination-limit",
        },
      });
      check("pagination over-limit saves blocked generation -> 201", paginationLimit.statusCode === 201, paginationLimit.body);
      const paginationLimitBody = paginationLimit.json();
      check(
        "pagination over-limit blocker prevents run enqueue",
        paginationLimitBody.status === "blocked" &&
          paginationLimitBody.run_id === null &&
          Array.isArray(paginationLimitBody.blockers) &&
          paginationLimitBody.blockers.includes("pagination_page_limit_exceeded"),
        paginationLimit.body,
      );
      const paginationLimitIr: Record<string, unknown> = isRecord(paginationLimitBody.draft_ir) ? paginationLimitBody.draft_ir : {};
      const paginationLimitNodes: Record<string, unknown> = isRecord(paginationLimitIr.nodes) ? paginationLimitIr.nodes : {};
      const paginationLimitLoopNodeBody: Record<string, unknown> = isRecord(paginationLimitNodes.paginate_pages) ? paginationLimitNodes.paginate_pages : {};
      const paginationLimitLoop: Record<string, unknown> = isRecord(paginationLimitLoopNodeBody.loop) ? paginationLimitLoopNodeBody.loop : {};
      check("pagination over-limit caps draft loop", paginationLimitLoop.max_iterations === 10, paginationLimit.body);
      check("pagination over-limit does not enqueue another run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));

      const paginationMutatingClick = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-pagination-mutating-click-1" },
        payload: {
          ...runnablePayload,
          prompt: "Click next page and delete old notices from https://example.com/notices",
          name: "generated-pagination-mutating-click",
        },
      });
      check("pagination mutating click saves blocked generation -> 201", paginationMutatingClick.statusCode === 201, paginationMutatingClick.body);
      const paginationMutatingClickBody = paginationMutatingClick.json();
      check(
        "pagination mutating click keeps side-effect blocker",
        paginationMutatingClickBody.status === "blocked" &&
          paginationMutatingClickBody.run_id === null &&
          Array.isArray(paginationMutatingClickBody.blockers) &&
          paginationMutatingClickBody.blockers.includes("side_effect_prompt_requires_review"),
        paginationMutatingClick.body,
      );
      check("pagination mutating click does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));

      const listed = await app.inject({
        method: "GET",
        url: "/v1/scenario-generations?limit=2",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer can list scenario generations with limit -> 200", listed.statusCode === 200, listed.body);
      const listedBody = listed.json();
      check("list returns two generation rows", Array.isArray(listedBody.items) && listedBody.items.length === 2, listed.body);
      check(
        "list does not expose prompt plaintext",
        Array.isArray(listedBody.items) &&
          listedBody.items.every((item: unknown) => isRecord(item) && !("prompt" in item)) &&
          !listed.body.includes("https://example.com 에서 최근 공지 제목과 링크"),
        listed.body,
      );
      check("list returns next_cursor when more rows exist", typeof listedBody.next_cursor === "string" && listedBody.next_cursor.length > 0, listed.body);
      const listedBlocked = await app.inject({
        method: "GET",
        url: "/v1/scenario-generations?status=blocked",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer can filter scenario generations by blocked status -> 200", listedBlocked.statusCode === 200, listedBlocked.body);
      check(
        "blocked filter returns only blocked generations",
        Array.isArray(listedBlocked.json().items) &&
          listedBlocked.json().items.length >= 1 &&
          listedBlocked.json().items.every((item: unknown) => isRecord(item) && item.status === "blocked"),
        listedBlocked.body,
      );
      check(
        "list rows include generation ledger metadata",
        Array.isArray(listedBlocked.json().items) &&
          listedBlocked.json().items.every(
            (item: unknown) =>
              isRecord(item) &&
              item.created_by === "operator-a" &&
              typeof item.created_at === "string" &&
              Number.isFinite(Date.parse(item.created_at)),
          ),
        listedBlocked.body,
      );
      const invalidStatus = await app.inject({
        method: "GET",
        url: "/v1/scenario-generations?status=running",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("invalid generation status filter -> 422", invalidStatus.statusCode === 422, invalidStatus.body);
      check("invalid generation status reason", invalidStatus.body.includes("invalid_generation_status"), invalidStatus.body);
      const nextCursor = typeof listedBody.next_cursor === "string" ? listedBody.next_cursor : "";
      const listedNext = await app.inject({
        method: "GET",
        url: `/v1/scenario-generations?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer can page scenario generations with cursor -> 200", listedNext.statusCode === 200, listedNext.body);
      check("second page contains remaining generation", Array.isArray(listedNext.json().items) && listedNext.json().items.length >= 1, listedNext.body);

      const unconfiguredLlmPlanner = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-unconfigured-1" },
        payload: {
          prompt: "Use the LLM planner for a draft",
          planner: "llm_v1",
          mode: "save",
          name: "generated-llm-unconfigured",
        },
      });
      check("llm_v1 planner request fails closed when not configured -> 404", unconfiguredLlmPlanner.statusCode === 404, unconfiguredLlmPlanner.body);
      check("llm_v1 unconfigured error code", unconfiguredLlmPlanner.json().code === "RESOURCE_NOT_FOUND", unconfiguredLlmPlanner.body);

      const fakeLlmDraftIr = (name: string, evidence: unknown, options?: { omitEvidence?: boolean }): Record<string, unknown> => ({
        meta: {
          name,
          version: 1,
          ir_version: "1.x",
          studio_mode: "easy",
          ...(options?.omitEvidence === true ? {} : { evidence }),
        },
        params_schema: { type: "object", additionalProperties: true },
        start: "extract_results",
        nodes: {
          extract_results: {
            what: [
              {
                action: "extract",
                instruction: "LLM planner generated read-only extraction.",
                schema_ref: "generated/default_result@1",
                args: {
                  schema_version: "1",
                  strict: true,
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["summary", "rows"],
                    properties: {
                      summary: { type: "string" },
                      rows: { type: "array", items: { type: "object", additionalProperties: true } },
                    },
                  },
                },
              },
            ],
            next: "done",
            side_effect: { kind: "read_only" },
            policy: { recording: "never" },
          },
          done: { terminal: "success" },
        },
      });

      let fakeLlmPlannerCalls = 0;
      const fakeLlmPlanner: ScenarioPlanner = {
        id: "llm_v1",
        plan(request) {
          fakeLlmPlannerCalls += 1;
          return {
            planner: "llm_v1",
            request,
            promptHash: "fake-llm-planner-hash",
            blockers: [],
            draftIr: fakeLlmDraftIr(request.name ?? "fake-llm-generated", request.evidence, { omitEvidence: true }),
          };
        },
      };
      const llmPlannerApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        scenarioGenerationPlanner: fakeLlmPlanner,
      });
      await llmPlannerApp.ready();
      try {
        const llmPlanned = await llmPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-planner-1" },
          payload: {
            prompt: "Use the LLM planner for a saved read-only extraction",
            planner: "llm_v1",
            mode: "save",
            name: "generated-llm-planner",
          },
        });
        check("configured llm_v1 planner saves scenario -> 201", llmPlanned.statusCode === 201, llmPlanned.body);
        const llmPlannedBody = llmPlanned.json();
        check(
          "configured llm_v1 planner returns saved generation",
          llmPlannedBody.status === "saved" &&
            llmPlannedBody.planner === "llm_v1" &&
            typeof llmPlannedBody.scenario_id === "string" &&
            typeof llmPlannedBody.scenario_version_id === "string" &&
            llmPlannedBody.run_id === null,
          llmPlanned.body,
        );
        check(
          "configured llm_v1 planner output is server-normalized with requested evidence",
          isRecord(llmPlannedBody.draft_ir) &&
            isRecord(llmPlannedBody.draft_ir.meta) &&
            isRecord(llmPlannedBody.draft_ir.meta.evidence) &&
            llmPlannedBody.draft_ir.meta.evidence.screenshot === "failure" &&
            llmPlannedBody.draft_ir.meta.evidence.video === "never" &&
            isRecord(llmPlannedBody.draft_ir.nodes) &&
            isRecord(llmPlannedBody.draft_ir.nodes.extract_results) &&
            isRecord(llmPlannedBody.draft_ir.nodes.extract_results.policy) &&
            llmPlannedBody.draft_ir.nodes.extract_results.policy.recording === "masked_on_failure",
          llmPlanned.body,
        );
        check("configured llm_v1 planner does not enqueue run in save mode", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));
        await withTenantTx(pool, TENANT, async (client) => {
          const row = await client.query<{ planner: string; version_count: string }>(
            `SELECT g.planner, count(sv.id)::text AS version_count
               FROM scenario_generations g
               JOIN scenario_versions sv ON sv.tenant_id = g.tenant_id AND sv.id = g.scenario_version_id
              WHERE g.id=$1::uuid
              GROUP BY g.planner`,
            [llmPlannedBody.generation_id],
          );
          check(
            "configured llm_v1 planner persists through shared save boundary",
            row.rows[0]?.planner === "llm_v1" && row.rows[0]?.version_count === "1",
            JSON.stringify(row.rows[0]),
          );
        });
        const llmPlannedReplay = await llmPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-planner-1" },
          payload: {
            prompt: "Use the LLM planner for a saved read-only extraction",
            planner: "llm_v1",
            mode: "save",
            name: "generated-llm-planner",
          },
        });
        check("configured llm_v1 planner idempotency replay -> 201", llmPlannedReplay.statusCode === 201, llmPlannedReplay.body);
        check(
          "configured llm_v1 replay returns same generation without re-planning",
          llmPlannedReplay.json().generation_id === llmPlannedBody.generation_id && fakeLlmPlannerCalls === 1,
          JSON.stringify({ replay: llmPlannedReplay.json(), fakeLlmPlannerCalls }),
        );
        const llmMissingTarget = await llmPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-missing-target-1" },
          payload: {
            prompt: "Use the LLM planner to summarize latest notices",
            planner: "llm_v1",
            mode: "save_and_run",
            name: "generated-llm-missing-target",
          },
        });
        check("llm_v1 save_and_run without target/start_url is server-blocked -> 201", llmMissingTarget.statusCode === 201, llmMissingTarget.body);
        const llmMissingTargetBody = llmMissingTarget.json();
        check(
          "llm_v1 server adds missing execution target blockers",
          llmMissingTargetBody.status === "blocked" &&
            llmMissingTargetBody.run_id === null &&
            Array.isArray(llmMissingTargetBody.blockers) &&
            llmMissingTargetBody.blockers.includes("target_required_for_auto_run") &&
            llmMissingTargetBody.blockers.includes("start_url_required_for_auto_run"),
          llmMissingTarget.body,
        );
        check("llm_v1 missing target does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));
        const llmSideEffectBlocked = await llmPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-side-effect-blocked-1" },
          payload: {
            ...runnablePayload,
            prompt: "Delete old notices from https://example.com/notices",
            planner: "llm_v1",
            mode: "save_and_run",
            name: "generated-llm-side-effect-blocked",
          },
        });
        check("llm_v1 side-effect prompt is server-blocked -> 201", llmSideEffectBlocked.statusCode === 201, llmSideEffectBlocked.body);
        const llmSideEffectBlockedBody = llmSideEffectBlocked.json();
        check(
          "llm_v1 server adds side-effect blocker",
          llmSideEffectBlockedBody.status === "blocked" &&
            llmSideEffectBlockedBody.run_id === null &&
            Array.isArray(llmSideEffectBlockedBody.blockers) &&
            llmSideEffectBlockedBody.blockers.includes("side_effect_prompt_requires_review"),
          llmSideEffectBlocked.body,
        );
        check("llm_v1 side-effect blocker does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));
        const llmVideoBlocked = await llmPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-video-blocked-1" },
          payload: {
            ...runnablePayload,
            planner: "llm_v1",
            mode: "save_and_run",
            name: "generated-llm-video-blocked",
            evidence: { screenshot: "each_step", video: "always" },
          },
        });
        check("llm_v1 video request without recorder capability is blocked by server -> 201", llmVideoBlocked.statusCode === 201, llmVideoBlocked.body);
        const llmVideoBlockedBody = llmVideoBlocked.json();
        check(
          "llm_v1 server adds missing video capability blocker and skips run",
          llmVideoBlockedBody.status === "blocked" &&
            llmVideoBlockedBody.run_id === null &&
            Array.isArray(llmVideoBlockedBody.blockers) &&
            llmVideoBlockedBody.blockers.includes("video_recording_port_not_configured"),
          llmVideoBlocked.body,
        );
        check(
          "llm_v1 blocked video IR still carries requested evidence and recording policy",
          isRecord(llmVideoBlockedBody.draft_ir) &&
            isRecord(llmVideoBlockedBody.draft_ir.meta) &&
            isRecord(llmVideoBlockedBody.draft_ir.meta.evidence) &&
            llmVideoBlockedBody.draft_ir.meta.evidence.screenshot === "each_step" &&
            llmVideoBlockedBody.draft_ir.meta.evidence.video === "always" &&
            isRecord(llmVideoBlockedBody.draft_ir.nodes) &&
            isRecord(llmVideoBlockedBody.draft_ir.nodes.extract_results) &&
            isRecord(llmVideoBlockedBody.draft_ir.nodes.extract_results.policy) &&
            llmVideoBlockedBody.draft_ir.nodes.extract_results.policy.recording === "always",
          llmVideoBlocked.body,
        );
        check("llm_v1 video blocker does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));
      } finally {
        await llmPlannerApp.close();
      }

      let mutatingPlannerCalls = 0;
      const mutatingLlmPlanner: ScenarioPlanner = {
        id: "llm_v1",
        plan(request) {
          mutatingPlannerCalls += 1;
          return {
            planner: "llm_v1",
            request: { ...request, mode: "save_and_run" },
            promptHash: "fake-llm-mutating-mode-hash",
            blockers: [],
            draftIr: fakeLlmDraftIr(request.name ?? "fake-llm-mutating-mode", request.evidence),
          };
        },
      };
      const mutatingPlannerApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        scenarioGenerationPlanner: mutatingLlmPlanner,
      });
      await mutatingPlannerApp.ready();
      try {
        const mutatingPlannerResult = await mutatingPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-mutating-mode-1" },
          payload: {
            prompt: "Use the LLM planner for save-only generation",
            planner: "llm_v1",
            mode: "save",
            name: "generated-llm-mutating-mode",
          },
        });
        check("llm_v1 planner cannot escalate save to save_and_run -> 422", mutatingPlannerResult.statusCode === 422, mutatingPlannerResult.body);
        check(
          "llm_v1 planner mutation returns explicit closed error",
          mutatingPlannerResult.json().code === "IR_SCHEMA_INVALID" &&
            mutatingPlannerResult.body.includes("planner_request_mutation_forbidden") &&
            mutatingPlannerResult.body.includes("mode"),
          mutatingPlannerResult.body,
        );
        check("llm_v1 planner mutation does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));
        await withTenantTx(pool, TENANT, async (client) => {
          const row = await client.query<{ scenario_count: string; generation_count: string }>(
            `SELECT
                (SELECT count(*)::text FROM scenarios WHERE tenant_id=$1::uuid AND name=$2) AS scenario_count,
                (SELECT count(*)::text FROM scenario_generations WHERE tenant_id=$1::uuid AND prompt_hash='fake-llm-mutating-mode-hash') AS generation_count`,
            [TENANT, "generated-llm-mutating-mode"],
          );
          check(
            "llm_v1 planner mutation does not save scenario or generation ledger",
            row.rows[0]?.scenario_count === "0" && row.rows[0]?.generation_count === "0" && mutatingPlannerCalls === 1,
            JSON.stringify({ row: row.rows[0], mutatingPlannerCalls }),
          );
        });
      } finally {
        await mutatingPlannerApp.close();
      }

      const plannerArtifactDir = mkdtempSync(join(tmpdir(), "rpa-generation-planner-artifacts-"));
      const gatewayPlannerArtifactSink = new BufferedScenarioGenerationArtifactSink(new FsObjectStore(plannerArtifactDir), {
        retentionDays: 90,
      });
      const gatewayPlannerCalls: LLMRequest[] = [];
      const gatewayPlannerLlmCalls = new PgScenarioGenerationLlmCallIdempotencyStore(pool, { retentionDays: 90 });
      const gatewayBackedPlannerGateway = new LlmGateway({
        primary: {
          id: "scenario-generation-planner-fake",
          capabilities: gatewayCaps,
          async *streamCall(req) {
            gatewayPlannerCalls.push(req);
            const parsedJson = {
              draft_ir: fakeLlmDraftIr("generated-llm-gateway-planner", { screenshot: "failure", video: "never" }),
              blockers: [],
              params: {},
            };
            for (const event of textDone(JSON.stringify(parsedJson))) yield event;
          },
        },
        gate: new SafeCapabilityGate(),
        validator: new AjvStructuredOutputValidator(),
        sink: gatewayPlannerArtifactSink,
        idempotency: gatewayPlannerLlmCalls,
        redactionBoundary: new DeterministicGatewayRedactionBoundary(),
        config: { retryMax: 0, fallbackAttempts: 0, repairAttempts: 0 },
      });
      const gatewayBackedPlanner = createLlmScenarioPlanner(
        new LlmGatewayScenarioPlannerClient(gatewayBackedPlannerGateway, {
          model: "codex-planner",
          promptTemplateVersion: "scenario-generation-int@1",
          budget: { maxInputTokens: 2000, maxOutputTokens: 1000, maxCost: 1 },
        }),
      );
      const gatewayBackedPlannerApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        scenarioGenerationPlanner: gatewayBackedPlanner,
        scenarioGenerationArtifacts: gatewayPlannerArtifactSink,
        scenarioGenerationLlmCalls: gatewayPlannerLlmCalls,
      });
      await gatewayBackedPlannerApp.ready();
      try {
        const gatewayPlannerPayload = {
          prompt: "Use the real llm_v1 planner bridge and persist its planner output artifact",
          planner: "llm_v1",
          mode: "save",
          name: "generated-llm-gateway-planner",
        };
        const gatewayPlanned = await gatewayBackedPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-gateway-planner-1" },
          payload: gatewayPlannerPayload,
        });
        check("gateway-backed llm_v1 planner saves scenario -> 201", gatewayPlanned.statusCode === 201, gatewayPlanned.body);
        const gatewayPlannedBody = gatewayPlanned.json();
        check(
          "gateway-backed llm_v1 planner returns saved generation",
          gatewayPlannedBody.status === "saved" &&
            gatewayPlannedBody.planner === "llm_v1" &&
            typeof gatewayPlannedBody.generation_id === "string" &&
            gatewayPlannerCalls.length === 1,
          JSON.stringify({ body: gatewayPlannedBody, gatewayPlannerCalls: gatewayPlannerCalls.length }),
        );
        const lifecyclePool = createLifecycleBypassPool();
        try {
          const artifacts = await lifecyclePool.query<{ artifact_count: string; run_count: string; type: string | null }>(
            `SELECT
                count(*)::text AS artifact_count,
                count(run_id)::text AS run_count,
                max(type) AS type
               FROM artifacts
              WHERE tenant_id=$1::uuid AND generation_id=$2::uuid`,
            [TENANT, gatewayPlannedBody.generation_id],
          );
          check(
            "gateway-backed llm_v1 planner flushes generation-scoped planner artifact",
            artifacts.rows[0]?.artifact_count === "1" &&
              artifacts.rows[0]?.run_count === "0" &&
              artifacts.rows[0]?.type === "scenario_generation_llm_output",
            JSON.stringify(artifacts.rows[0]),
          );
          check(
            "gateway-backed llm_v1 planner enqueues tenant-scoped artifact redaction",
            enqueuedArtifactRedactions.length === 1 &&
              enqueuedArtifactRedactions[0]?.tenantId === TENANT &&
              enqueuedArtifactRedactions[0]?.correlationId.length === 36,
            JSON.stringify(enqueuedArtifactRedactions),
          );
          const llmCalls = await lifecyclePool.query<{ call_count: string; done_count: string; output_ref_count: string; parsed_count: string }>(
            `SELECT
                count(*)::text AS call_count,
                count(*) FILTER (WHERE stream_status='done')::text AS done_count,
                count(output_ref)::text AS output_ref_count,
                count(parsed_json)::text AS parsed_count
               FROM scenario_generation_llm_calls
              WHERE tenant_id=$1::uuid AND generation_id=$2::uuid`,
            [TENANT, gatewayPlannedBody.generation_id],
          );
          check(
            "gateway-backed llm_v1 planner persists generation-scoped llm call ledger",
            llmCalls.rows[0]?.call_count === "1" &&
              llmCalls.rows[0]?.done_count === "1" &&
              llmCalls.rows[0]?.output_ref_count === "1" &&
              llmCalls.rows[0]?.parsed_count === "1",
            JSON.stringify(llmCalls.rows[0]),
          );
        } finally {
          await lifecyclePool.end();
        }
        const gatewayPlannedReplay = await gatewayBackedPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-gateway-planner-1" },
          payload: gatewayPlannerPayload,
        });
        check("gateway-backed llm_v1 planner replay -> 201", gatewayPlannedReplay.statusCode === 201, gatewayPlannedReplay.body);
        check(
          "gateway-backed llm_v1 replay does not call planner or duplicate artifacts",
          gatewayPlannedReplay.json().generation_id === gatewayPlannedBody.generation_id && gatewayPlannerCalls.length === 1,
          JSON.stringify({ replay: gatewayPlannedReplay.json(), gatewayPlannerCalls: gatewayPlannerCalls.length }),
        );
        const replayLifecyclePool = createLifecycleBypassPool();
        try {
          const replayArtifacts = await replayLifecyclePool.query<{ artifact_count: string; call_count: string }>(
            `SELECT (SELECT count(*)::text
                       FROM artifacts
                      WHERE tenant_id=$1::uuid AND generation_id=$2::uuid) AS artifact_count,
                    (SELECT count(*)::text
                       FROM scenario_generation_llm_calls
                      WHERE tenant_id=$1::uuid AND generation_id=$2::uuid) AS call_count`,
            [TENANT, gatewayPlannedBody.generation_id],
          );
          check(
            "gateway-backed llm_v1 replay keeps one artifact and one llm call",
            replayArtifacts.rows[0]?.artifact_count === "1" && replayArtifacts.rows[0]?.call_count === "1",
            JSON.stringify(replayArtifacts.rows[0]),
          );
        } finally {
          await replayLifecyclePool.end();
        }
      } finally {
        await gatewayBackedPlannerApp.close();
        rmSync(plannerArtifactDir, { recursive: true, force: true });
      }

      let repairPlanCalls = 0;
      let repairCalls = 0;
      const repairingLlmPlanner: ScenarioPlanner = {
        id: "llm_v1",
        plan(request) {
          repairPlanCalls += 1;
          return {
            planner: "llm_v1",
            request,
            promptHash: "fake-llm-repair-hash",
            blockers: [],
            draftIr: {
              meta: { name: request.name ?? "fake-llm-repair", version: 1 },
              start: "missing_node",
              nodes: {
                done: { terminal: "success" },
              },
            },
          };
        },
        repair(input) {
          repairCalls += 1;
          check("llm_v1 repair receives compile failure", input.compileError.ok === false && input.attempt === 1, JSON.stringify(input.compileError));
          return {
            planner: "llm_v1",
            request: input.request,
            promptHash: "fake-llm-repair-hash",
            blockers: [],
            draftIr: fakeLlmDraftIr(input.request.name ?? "fake-llm-repaired", input.request.evidence),
          };
        },
      };
      const repairingPlannerApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        scenarioGenerationPlanner: repairingLlmPlanner,
      });
      await repairingPlannerApp.ready();
      try {
        const repaired = await repairingPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-repair-1" },
          payload: {
            prompt: "Use the LLM planner and repair invalid IR once",
            planner: "llm_v1",
            mode: "save",
            name: "generated-llm-repair",
          },
        });
        check("llm_v1 planner repairs invalid IR once -> 201", repaired.statusCode === 201, repaired.body);
        check(
          "llm_v1 repaired generation saved",
          repaired.json().status === "saved" &&
            repaired.json().planner === "llm_v1" &&
            repairPlanCalls === 1 &&
            repairCalls === 1,
          JSON.stringify({ body: repaired.json(), repairPlanCalls, repairCalls }),
        );
      } finally {
        await repairingPlannerApp.close();
      }

      let failingRepairPlanCalls = 0;
      let failingRepairCalls = 0;
      const failingRepairLlmPlanner: ScenarioPlanner = {
        id: "llm_v1",
        plan(request) {
          failingRepairPlanCalls += 1;
          return {
            planner: "llm_v1",
            request,
            promptHash: "fake-llm-repair-fail-hash",
            blockers: [],
            draftIr: {
              meta: { name: request.name ?? "fake-llm-repair-fail", version: 1 },
              start: "missing_node",
              nodes: {
                done: { terminal: "success" },
              },
            },
          };
        },
        repair(input) {
          failingRepairCalls += 1;
          const details = input.compileError.details;
          check(
            "llm_v1 failed repair receives static compile error",
            input.compileError.ok === false &&
              input.compileError.code === "IR_SCHEMA_INVALID" &&
              input.attempt === 1 &&
              isRecord(details) &&
              details.stage === "static",
            JSON.stringify(input.compileError),
          );
          return {
            planner: "llm_v1",
            request: input.request,
            promptHash: "fake-llm-repair-fail-hash",
            blockers: [],
            draftIr: {
              meta: { name: input.request.name ?? "fake-llm-repair-fail", version: 1 },
              start: "still_missing",
              nodes: {
                done: { terminal: "success" },
              },
            },
          };
        },
      };
      const failingRepairPlannerApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        scenarioGenerationPlanner: failingRepairLlmPlanner,
      });
      await failingRepairPlannerApp.ready();
      try {
        const failingRepairPayload = {
          prompt: "Use the LLM planner and fail repair for invalid IR",
          planner: "llm_v1",
          mode: "save",
          name: "generated-llm-repair-fail",
        };
        const failedRepair = await failingRepairPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-repair-fail-1" },
          payload: failingRepairPayload,
        });
        check("llm_v1 planner failed repair returns compile error -> 422", failedRepair.statusCode === 422, failedRepair.body);
        check(
          "llm_v1 planner failed repair is bounded to one repair attempt",
          failedRepair.json().code === "IR_SCHEMA_INVALID" && failingRepairPlanCalls === 1 && failingRepairCalls === 1,
          JSON.stringify({ body: failedRepair.json(), failingRepairPlanCalls, failingRepairCalls }),
        );
        await withTenantTx(pool, TENANT, async (client) => {
          const row = await client.query<{ scenario_count: string; generation_count: string }>(
            `SELECT
                (SELECT count(*)::text FROM scenarios WHERE tenant_id=$1::uuid AND name=$2) AS scenario_count,
                (SELECT count(*)::text FROM scenario_generations WHERE tenant_id=$1::uuid AND prompt_hash='fake-llm-repair-fail-hash') AS generation_count`,
            [TENANT, "generated-llm-repair-fail"],
          );
          check(
            "llm_v1 failed repair does not save scenario or generation ledger",
            row.rows[0]?.scenario_count === "0" && row.rows[0]?.generation_count === "0",
            JSON.stringify(row.rows[0]),
          );
        });
        const failedRepairReplay = await failingRepairPlannerApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-llm-repair-fail-1" },
          payload: failingRepairPayload,
        });
        check("llm_v1 failed repair idempotency replay -> 422", failedRepairReplay.statusCode === 422, failedRepairReplay.body);
        check(
          "llm_v1 failed repair replay does not re-plan or re-repair",
          failedRepairReplay.json().code === "IR_SCHEMA_INVALID" && failingRepairPlanCalls === 1 && failingRepairCalls === 1,
          JSON.stringify({ body: failedRepairReplay.json(), failingRepairPlanCalls, failingRepairCalls }),
        );
      } finally {
        await failingRepairPlannerApp.close();
      }

      const wrongStartUrl = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-wrong-start-url-1" },
        payload: {
          ...runnablePayload,
          name: "generated-wrong-start-url",
          start_url: "https://other.example/notices",
        },
      });
      check("target/start_url origin mismatch blocks auto-run -> 201", wrongStartUrl.statusCode === 201, wrongStartUrl.body);
      check(
        "target/start_url origin mismatch blocker",
        wrongStartUrl.json().status === "blocked" &&
          wrongStartUrl.json().run_id === null &&
          wrongStartUrl.json().blockers.includes("target_start_url_site_mismatch"),
        wrongStartUrl.body,
      );

      const wrongIdentity = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-wrong-identity-1" },
        payload: {
          ...runnablePayload,
          name: "generated-wrong-identity",
          target: {
            site_profile_id: SITE,
            browser_identity_id: OTHER_IDENTITY,
            network_policy_id: NETWORK,
          },
        },
      });
      check("cross-site browser identity blocks auto-run → 201", wrongIdentity.statusCode === 201, wrongIdentity.body);
      check(
        "cross-site browser identity blocker",
        wrongIdentity.json().status === "blocked" &&
          wrongIdentity.json().run_id === null &&
          wrongIdentity.json().blockers.includes("browser_identity_site_mismatch"),
        wrongIdentity.body,
      );

      const wrongNetwork = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-wrong-network-1" },
        payload: {
          ...runnablePayload,
          name: "generated-wrong-network",
          target: {
            site_profile_id: SITE,
            browser_identity_id: IDENTITY,
            network_policy_id: OTHER_NETWORK,
          },
        },
      });
      check("network policy domain mismatch blocks auto-run → 201", wrongNetwork.statusCode === 201, wrongNetwork.body);
      check(
        "network policy domain mismatch blocker",
        wrongNetwork.json().status === "blocked" &&
          wrongNetwork.json().run_id === null &&
          wrongNetwork.json().blockers.includes("network_policy_domain_mismatch"),
        wrongNetwork.body,
      );
      check("invalid target blockers do not enqueue runs", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));

      const videoRequested = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-video-blocked-1" },
        payload: {
          ...runnablePayload,
          name: "generated-video-blocked",
          evidence: { screenshot: "each_step", video: "always" },
        },
      });
      check("video evidence request is blocked until recorder port exists → 201", videoRequested.statusCode === 201, videoRequested.body);
      const videoBody = videoRequested.json();
      check("video blocker status", videoBody.status === "blocked" && videoBody.run_id === null, videoRequested.body);
      check(
        "video blocker explains missing runtime port",
        Array.isArray(videoBody.blockers) && videoBody.blockers.includes("video_recording_port_not_configured"),
        videoRequested.body,
      );
      check("video blocker does not enqueue run", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));

      const replay = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-run-1", "x-correlation-id": "20000000-0000-4000-8000-0000000000a1" },
        payload: runnablePayload,
      });
      check("generation idempotency replay → 201", replay.statusCode === 201, replay.body);
      check("replay returns same generation/run", replay.json().generation_id === runBody.generation_id && replay.json().run_id === runBody.run_id, replay.body);
      check("replay does not enqueue again", enqueuedRuns.length === 3, JSON.stringify(enqueuedRuns));

      const explicitModel = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-model-explicit-1" },
        payload: {
          ...runnablePayload,
          name: "generated-model-explicit",
          model: "codex-gen",
        },
      });
      check("explicit model generation queues run → 201", explicitModel.statusCode === 201, explicitModel.body);
      const explicitModelBody = explicitModel.json();
      check(
        "explicit model echoed and run_queued",
        explicitModelBody.status === "run_queued" && explicitModelBody.model === "codex-gen" && typeof explicitModelBody.run_id === "string",
        explicitModel.body,
      );
      check("explicit model enqueues fourth run", enqueuedRuns.length === 4 && enqueuedRuns[3]?.runId === explicitModelBody.run_id, JSON.stringify(enqueuedRuns));
      await withTenantTx(pool, TENANT, async (client) => {
        const rows = await client.query<{ run_model: string | null; generation_model: string | null }>(
          `SELECT
             (SELECT model FROM runs WHERE id=$1::uuid) AS run_model,
             (SELECT model FROM scenario_generations WHERE id=$2::uuid) AS generation_model`,
          [explicitModelBody.run_id, explicitModelBody.generation_id],
        );
        check(
          "explicit model persisted on run + generation",
          rows.rows[0]?.run_model === "codex-gen" && rows.rows[0]?.generation_model === "codex-gen",
          JSON.stringify(rows.rows[0]),
        );
      });

      await withTenantTx(pool, TENANT, async (client) => {
        await client.query(
          `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'video-default')`,
          [VIDEO_IDENTITY, TENANT, SITE],
        );
      });

      const videoEnabledApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new RoleMatrixRbacMiddleware(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
        scenarioGenerationCapabilities: { videoRecording: true },
      });
      await videoEnabledApp.ready();
      try {
        const videoRunnable = await videoEnabledApp.inject({
          method: "POST",
          url: "/v1/scenario-generations",
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": "gen-video-runnable-1" },
          payload: {
            ...runnablePayload,
            name: "generated-video-runnable",
            target: {
              site_profile_id: SITE,
              browser_identity_id: VIDEO_IDENTITY,
              network_policy_id: NETWORK,
            },
            evidence: { screenshot: "each_step", video: "always" },
          },
        });
        check("video evidence request queues when recorder capability is enabled ??201", videoRunnable.statusCode === 201, videoRunnable.body);
        const videoRunnableBody = videoRunnable.json();
        check(
          "video capability run queued",
          videoRunnableBody.status === "run_queued" &&
            typeof videoRunnableBody.run_id === "string" &&
            Array.isArray(videoRunnableBody.blockers) &&
            videoRunnableBody.blockers.length === 0,
          videoRunnable.body,
        );
        check(
          "video capability draft IR preserves evidence policy",
          isRecord(videoRunnableBody.draft_ir) &&
            isRecord(videoRunnableBody.draft_ir.meta) &&
            isRecord(videoRunnableBody.draft_ir.meta.evidence) &&
            videoRunnableBody.draft_ir.meta.evidence.video === "always",
          videoRunnable.body,
        );
        check("video capability enqueues run", enqueuedRuns.length === 5, JSON.stringify(enqueuedRuns));
        const videoArtifactDir = mkdtempSync(join(tmpdir(), "rpa-generation-video-artifacts-"));
        try {
          const videoGatewayCalls: LLMRequest[] = [];
          const videoLifecycleJobs: RuntimeWorkerJob[] = [];
          const videoStore = new FsObjectStore(videoArtifactDir);
          const videoGateway = new LlmGateway({
            primary: promptRunGatewayAdapter(videoGatewayCalls),
            gate: new SafeCapabilityGate(),
            validator: new AjvStructuredOutputValidator(),
            sink: new PgGatewayArtifactSink(pool, videoStore, { retentionDays: 90 }),
            idempotency: new PgLlmCallIdempotencyStore(pool),
            redactionBoundary: new DeterministicGatewayRedactionBoundary(),
            config: { retryMax: 0, fallbackAttempts: 0, repairAttempts: 0 },
          });
          const videoWorker = new PgRuntimeWorker(pool, {
            workerId: WORKER,
            browserLeasePlanResolver: pgBrowserLeasePlanResolver,
            browserSessionProvider: new TestFakeBrowserSessionProvider({
              makeSession: () => new PromptRunFakeCdpSession(),
            }),
            allowTestBrowserSessionProvider: true,
            executorFactory: createDomUtilityExecutorFactory(videoGateway, {
              model: "codex-fallback",
              promptTemplateVersion: "prompt-run-int-v1",
              budget: { maxInputTokens: 1000, maxOutputTokens: 1000, maxCost: 1 },
            }),
            visualEvidenceVideoRecorderFactory: (provider) =>
              new PgScreenshotFrameVideoRecorder(pool, videoStore, provider, {
                ffmpegPath: "unused-in-test",
                encoder: fakeVideoEncoder(),
                retentionDays: 90,
                frameIntervalMs: 60_000,
                frameRate: 1,
                tempRootDir: videoArtifactDir,
              }),
            runtimeJobEnqueuer: {
              async enqueueRuntimeJob(_client, job) {
                videoLifecycleJobs.push(job);
              },
            },
          });
          const videoDriven = await videoWorker.handle({
            kind: "run_claim",
            tenantId: TENANT as TenantId,
            runId: videoRunnableBody.run_id as RunId,
            correlationId: "20000000-0000-4000-8000-0000000000a2" as CorrelationId,
          });
          check("video capability prompt-created run drives through worker", videoDriven.kind === "completed", JSON.stringify(videoDriven));
          const videoTrace = await generatedRunTrace(pool, videoRunnableBody.run_id);
          check("video capability prompt-created run status completed", videoTrace.status === "completed", JSON.stringify(videoTrace));
          check(
            "video capability run records observe/extract stagehand calls",
            videoTrace.calls.length === 2 && videoTrace.calls.every((call) => call.stream_status === "done"),
            JSON.stringify(videoTrace.calls),
          );
          check(
            "video capability run stores LLM outputs plus masked WebM bytes",
            readdirSync(videoArtifactDir).filter((name) => name.endsWith(".bin")).length === 3,
            JSON.stringify(readdirSync(videoArtifactDir)),
          );
          check("video capability pending artifacts remain hidden by RLS", videoTrace.artifacts.length === 0, JSON.stringify(videoTrace.artifacts));
          check(
            "video capability run enqueues redaction per artifact",
            videoLifecycleJobs.length === 4 &&
              videoLifecycleJobs.filter((job) => job.kind === "artifact_redaction" && job.runId === videoRunnableBody.run_id).length === 3 &&
              videoLifecycleJobs[videoLifecycleJobs.length - 1]?.kind === "artifact_retention",
            JSON.stringify(videoLifecycleJobs),
          );
          await redactPendingRunArtifacts({
            runId: videoRunnableBody.run_id,
            artifactDir: videoArtifactDir,
            expectedPasses: 3,
          });
          const videoRedactedTrace = await generatedRunTrace(pool, videoRunnableBody.run_id);
          const visibleVideoArtifacts = videoRedactedTrace.artifacts.filter((artifact) => artifact.type === "video_masked");
          const visibleVideoLlmArtifacts = videoRedactedTrace.artifacts.filter((artifact) => artifact.type === "llm_output");
          check(
            "video capability redaction exposes LLM outputs and masked WebM metadata",
            videoRedactedTrace.artifacts.length === 3 &&
              visibleVideoLlmArtifacts.length === 2 &&
              visibleVideoLlmArtifacts.every(
                (artifact) => artifact.media_type === "text/plain; charset=utf-8" && artifact.redaction_status === "redacted",
              ) &&
              visibleVideoArtifacts.length === 1 &&
              visibleVideoArtifacts[0]?.media_type === "video/webm" &&
              visibleVideoArtifacts[0]?.redaction_status === "redacted",
            JSON.stringify(videoRedactedTrace.artifacts),
          );
          check(
            "video capability redaction preserves redacted object copies",
            readdirSync(videoArtifactDir).filter((name) => name.endsWith(".bin")).length >= 6,
            JSON.stringify(readdirSync(videoArtifactDir)),
          );

          const videoArtifactReadApp = buildServer({
            pool,
            auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
            rbac: new RoleMatrixRbacMiddleware(),
            idempotency: new PgControlPlaneIdempotencyStore(pool),
            enqueuer,
            signedCommandRegistry,
            artifactStore: new FsObjectStore(videoArtifactDir),
            securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
          });
          await videoArtifactReadApp.ready();
          try {
            const videoArtifactList = await videoArtifactReadApp.inject({
              method: "GET",
              url: `/v1/runs/${videoRunnableBody.run_id}/artifacts`,
              headers: { authorization: `Bearer ${viewer}` },
            });
            check("viewer can list redacted video-run artifacts -> 200", videoArtifactList.statusCode === 200, videoArtifactList.body);
            const videoArtifactItems = Array.isArray(videoArtifactList.json().items) ? videoArtifactList.json().items : [];
            const videoArtifactId = videoArtifactItems.find(
              (item: unknown): item is { artifact_id: string; media_type: string } =>
                isRecord(item) &&
                item.type === "video_masked" &&
                item.redaction_status === "redacted" &&
                item.media_type === "video/webm" &&
                typeof item.artifact_id === "string",
            )?.artifact_id;
            check("video artifact list includes redacted WebM metadata", typeof videoArtifactId === "string", videoArtifactList.body);
            if (typeof videoArtifactId === "string") {
              const videoBlob = await videoArtifactReadApp.inject({
                method: "GET",
                url: `/v1/artifacts/${videoArtifactId}/blob`,
                headers: { authorization: `Bearer ${viewer}`, "x-correlation-id": "20000000-0000-4000-8000-0000000000a4" },
              });
              check("viewer can download redacted WebM blob -> 200", videoBlob.statusCode === 200, videoBlob.body);
              check("redacted WebM blob keeps video content-type", videoBlob.headers["content-type"] === "video/webm", String(videoBlob.headers["content-type"]));
              check(
                "redacted WebM blob preserves EBML header bytes",
                Buffer.from(videoBlob.rawPayload).subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
                Buffer.from(videoBlob.rawPayload).toString("hex"),
              );
            }
          } finally {
            await videoArtifactReadApp.close();
          }
        } finally {
          rmSync(videoArtifactDir, { recursive: true, force: true });
        }
      } finally {
        await videoEnabledApp.close();
      }

      const denied = await app.inject({
        method: "POST",
        url: "/v1/scenario-generations",
        headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "gen-denied-1" },
        payload: { prompt: "읽기만 해줘", name: "viewer-denied" },
      });
      check("viewer cannot generate scenario → 403", denied.statusCode === 403, denied.body);
      check("viewer denial code AUTHZ_FORBIDDEN", denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) {
    throw new Error(`api-scenario-generations.int: ${failures} failures`);
  }
  console.log("\nPASS: api-scenario-generations.int");
}

main().catch((err) => {
  console.error("api-scenario-generations.int fatal:", err);
  process.exitCode = 1;
});
