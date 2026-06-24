/**
 * Run 실행 드라이버 통합 (D3 가동 1단계 — 증분2). 실 PostgreSQL.
 *
 * 인터프리터 ↔ DB 전이 배선을 격리 검증한다: claimed run + 시나리오(ir+compiled_ast) → driveClaimedRun →
 * run이 claimed→running→completing→completed 로 전이하는지(실 CAS + outbox). 브라우저는 증분1(ir-interpreter.int)
 * 에서 검증했으므로 여기선 결정형 fake 실행기/resolver로 DB 경로만 본다.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/run-step-driver.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PoolClient } from "pg";
import type {
  ArtifactRef,
  ExecutorPlugin,
  IRActionType,
  ObjectRef,
  PageState,
  PageStateResolver,
  PlainSecret,
  SecretRef,
  SecretStore,
  StepResult,
  VerifyResult,
} from "../../ts/core-types";
import type { RunVideoRecording, RuntimeWorkerJob, VisualEvidenceVideoRecorder } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import type { CdpSession, CdpSessionProvider } from "../src/executor/cdp-session";
import type { ObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { PgMergedExtractArtifactSink } from "../src/runtime/merged-extract-artifact";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { driveClaimedRun, type ClaimedRun } from "../src/runtime/run-step-driver";
import type { VisualEvidenceRecorder } from "../src/runtime/visual-evidence";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_driver_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000d1";
const SVER = "70000000-0000-0000-0000-0000000000d2";
const RUN = "71000000-0000-0000-0000-0000000000d1";
const RUN_FAIL_BIZ = "71000000-0000-0000-0000-0000000000d3";
const RUN_FAIL_SYS = "71000000-0000-0000-0000-0000000000d4";
const RUN_SUSPEND = "71000000-0000-0000-0000-0000000000d5";
const RUN_HUMAN_TASK = "71000000-0000-0000-0000-0000000000d6";
const RUN_ARTIFACT = "71000000-0000-0000-0000-0000000000d7";
const RUN_VIDEO_ALWAYS = "71000000-0000-0000-0000-0000000000d8";
const RUN_VIDEO_FAILURE_SUCCESS = "71000000-0000-0000-0000-0000000000d9";
const RUN_VIDEO_FAILURE_FAIL = "71000000-0000-0000-0000-0000000000da";
const RUN_VIDEO_NO_RECORDER = "71000000-0000-0000-0000-0000000000db";
const RUN_VIDEO_STOP_FAIL = "71000000-0000-0000-0000-0000000000dc";
const RUN_VIDEO_DRIVE_THROW = "71000000-0000-0000-0000-0000000000de";
const RUN_VISUAL_NO_ENQUEUER = "71000000-0000-0000-0000-0000000000df";
const RUN_VIDEO_NO_ENQUEUER = "71000000-0000-0000-0000-0000000000e0";
const RUN_VISUAL_DRIVE_THROW = "71000000-0000-0000-0000-0000000000e1";
const RUN_GENERATED_LIKE = "71000000-0000-0000-0000-0000000000dd";
const SCEN2 = "70000000-0000-0000-0000-0000000000e1"; // @human_task(R5) 시나리오(별도 IR)
const SVER2 = "70000000-0000-0000-0000-0000000000e2";
const SCEN_VIDEO_ALWAYS = "70000000-0000-0000-0000-0000000000f1";
const SVER_VIDEO_ALWAYS = "70000000-0000-0000-0000-0000000000f2";
const SCEN_VIDEO_FAILURE = "70000000-0000-0000-0000-0000000000f3";
const SVER_VIDEO_FAILURE = "70000000-0000-0000-0000-0000000000f4";
const SCEN_GENERATED_LIKE = "70000000-0000-0000-0000-0000000000f5";
const SVER_GENERATED_LIKE = "70000000-0000-0000-0000-0000000000f6";
const SCEN_VISUAL_FAILURE = "70000000-0000-0000-0000-0000000000f7";
const SVER_VISUAL_FAILURE = "70000000-0000-0000-0000-0000000000f8";
const WORKER = "9a000000-0000-0000-0000-0000000000a1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 결정형 fake 실행기: 모든 액션 success(브라우저 미사용). 본 시나리오는 navigate 1회만 호출.
const fakeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = new Date().toISOString();
    return {
      stepId,
      action: "navigate",
      status: "success",
      pageStateBefore: "ref",
      pageStateAfter: "ref",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in driver int");
  },
};

// 실패 terminal 구동 검증용: 첫 스텝(navigate)에서 지정 StepStatus 반환 → 인터프리터가 fail_business/fail_system terminal 로 매핑.
const artifactExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = new Date().toISOString();
    return {
      stepId,
      action: "navigate",
      status: "success",
      pageStateBefore: "ref",
      pageStateAfter: "ref",
      artifacts: ["72000000-0000-0000-0000-0000000000d7" as ArtifactRef],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in driver int");
  },
};

const echoActionExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: true, vision: false, utility: true }),
  async execute(stepId, action) {
    const now = new Date().toISOString();
    const actionType = executorActionType(action);
    return {
      stepId,
      action: actionType,
      status: "success",
      output: actionType === "extract" ? { rowCount: 1 } : undefined,
      extracted: actionType === "extract" ? { summary: "ok", rows: [{ title: "generated" }] } : undefined,
      pageStateBefore: "ref",
      pageStateAfter: "ref",
      artifacts: [],
      cache: { mode: "bypass" },
      sideEffect: { kind: actionType === "act" ? "update" : "read_only", committed: true },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in driver int");
  },
};

function executorActionType(action: unknown): IRActionType {
  if (typeof action === "object" && action !== null && "type" in action) {
    const type = (action as { type?: unknown }).type;
    if (
      type === "act" ||
      type === "observe" ||
      type === "extract" ||
      type === "navigate" ||
      type === "download" ||
      type === "upload" ||
      type === "api_call" ||
      type === "file" ||
      type === "human_task" ||
      type === "shell"
    ) {
      return type;
    }
  }
  return "navigate";
}

class FakeRuntimeJobEnqueuer {
  readonly jobs: RuntimeWorkerJob[] = [];

  async enqueueRuntimeJob(_client: PoolClient, job: RuntimeWorkerJob): Promise<void> {
    this.jobs.push(job);
  }
}

class FakeObjectStore implements ObjectStore {
  readonly puts: { ref: ObjectRef; content: string }[] = [];
  readonly deletes: ObjectRef[] = [];

  async put(content: string): Promise<ObjectRef> {
    const ref = `object://merged-extract-${this.puts.length + 1}` as ObjectRef;
    this.puts.push({ ref, content });
    return ref;
  }

  async putBytes(content: Uint8Array): Promise<ObjectRef> {
    return this.put(new TextDecoder().decode(content));
  }

  async get(objectRef: ObjectRef): Promise<string | null> {
    return this.puts.find((put) => put.ref === objectRef)?.content ?? null;
  }

  async getBytes(objectRef: ObjectRef): Promise<Uint8Array | null> {
    const content = await this.get(objectRef);
    return content === null ? null : new TextEncoder().encode(content);
  }

  async delete(objectRef: ObjectRef): Promise<void> {
    this.deletes.push(objectRef);
  }
}

class CountingSuccessExecutor implements ExecutorPlugin {
  readonly calls: string[] = [];

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: false, vision: false, utility: true };
  }

  async execute(stepId: string): Promise<StepResult> {
    this.calls.push(stepId);
    const now = new Date().toISOString();
    return {
      stepId,
      action: "navigate",
      status: "success",
      pageStateBefore: "ref",
      pageStateAfter: "ref",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  }

  async verify(): Promise<VerifyResult> {
    throw new Error("verify not used in driver int");
  }
}

class FakeVisualEvidenceRecorder implements VisualEvidenceRecorder {
  readonly captures: Parameters<VisualEvidenceRecorder["captureStepScreenshot"]>[0][] = [];

  constructor(private readonly artifactRef: ArtifactRef = "72000000-0000-0000-0000-0000000000df" as ArtifactRef) {}

  async captureStepScreenshot(input: Parameters<VisualEvidenceRecorder["captureStepScreenshot"]>[0]): Promise<ArtifactRef> {
    this.captures.push(input);
    return this.artifactRef;
  }
}

const fakeCdpSession: CdpSession = {
  url: () => "about:blank",
  async goto() {},
  async reload() {},
  async evaluate<R = unknown>(_expression: string): Promise<R> {
    return undefined as R;
  },
  async sendCDP<T = unknown>(_method: string, _params?: object): Promise<T> {
    return {} as T;
  },
  async click() {},
  async fill() {},
  async selectOption() {},
  async setInputFiles() {},
  downloadDir: () => "",
  async waitForDownload() {
    return false;
  },
  async close() {},
};

class CountingSessionProvider implements CdpSessionProvider {
  readonly leaseIds: string[] = [];

  forLease(leaseId: string): CdpSession {
    this.leaseIds.push(leaseId);
    return fakeCdpSession;
  }
}

class FakeRunVideoRecording implements RunVideoRecording {
  readonly stops: string[] = [];
  readonly discards: string[] = [];

  constructor(private readonly artifactRef: ArtifactRef | undefined) {}

  async stopAndPersist(input: Parameters<RunVideoRecording["stopAndPersist"]>[0]): Promise<ArtifactRef | undefined> {
    this.stops.push(input.terminal);
    return this.artifactRef;
  }

  async discard(input: Parameters<RunVideoRecording["discard"]>[0]): Promise<void> {
    this.discards.push(input.reason);
  }
}

class FakeVideoRecorder implements VisualEvidenceVideoRecorder {
  readonly starts: Parameters<VisualEvidenceVideoRecorder["startRunVideo"]>[0][] = [];
  readonly recordings: FakeRunVideoRecording[] = [];

  constructor(private readonly artifactRef: ArtifactRef | undefined) {}

  async startRunVideo(input: Parameters<VisualEvidenceVideoRecorder["startRunVideo"]>[0]): Promise<RunVideoRecording> {
    this.starts.push(input);
    const recording = new FakeRunVideoRecording(this.artifactRef);
    this.recordings.push(recording);
    return recording;
  }
}

class ThrowingRunVideoRecording implements RunVideoRecording {
  readonly discards: string[] = [];

  async stopAndPersist(_input: Parameters<RunVideoRecording["stopAndPersist"]>[0]): Promise<ArtifactRef | undefined> {
    throw new Error("video persist failed");
  }

  async discard(input: Parameters<RunVideoRecording["discard"]>[0]): Promise<void> {
    this.discards.push(input.reason);
  }
}

class ThrowingVideoRecorder implements VisualEvidenceVideoRecorder {
  readonly recordings: ThrowingRunVideoRecording[] = [];

  async startRunVideo(_input: Parameters<VisualEvidenceVideoRecorder["startRunVideo"]>[0]): Promise<RunVideoRecording> {
    const recording = new ThrowingRunVideoRecording();
    this.recordings.push(recording);
    return recording;
  }
}

function failingExecutor(status: "failed_business" | "failed_system"): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    async execute(stepId) {
      const now = new Date().toISOString();
      return {
        stepId,
        action: "navigate",
        status,
        pageStateBefore: "ref",
        pageStateAfter: "ref",
        artifacts: [],
        cache: { mode: "bypass" },
        timings: { startedAt: now, endedAt: now, durationMs: 0 },
      };
    },
    async verify() {
      throw new Error("verify not used in driver int");
    },
  };
}

function throwingExecutor(): ExecutorPlugin {
  return {
    capabilities: () => ({ dom: false, vision: false, utility: true }),
    async execute(): Promise<never> {
      throw new Error("executor exploded before step result");
    },
    async verify() {
      throw new Error("verify not used in driver int");
    },
  };
}

// fake resolver: reviews_visible=true → on[] 분기가 done(terminal)으로 라우팅.
const fakeResolver: PageStateResolver = {
  async resolvePageState(): Promise<PageState> {
    return {
      url: { raw: "x", canonical: "x", pattern: "x" },
      dom: { structuralHash: "h", visibleTextHash: "h", landmarks: [], frames: [] },
      auth: "authenticated",
      flags: { not_found: false, reviews_visible: true },
      matchedWhere: [],
    };
  },
};

async function runSteps(
  pool: ReturnType<typeof createPool>,
  runId: string,
): Promise<readonly { step_id: string; node_id: string; action: string; status: string; artifacts: string[] }[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const rows = await c.query<{ step_id: string; node_id: string; action: string; status: string; artifacts: string[] }>(
      `SELECT step_id, node_id, action, status, artifacts
         FROM run_steps
        WHERE tenant_id=$1::uuid AND run_id=$2::uuid
        ORDER BY step_id, attempt`,
      [TENANT, runId],
    );
    return rows.rows;
  });
}

// suspend 구동 검증용(트리거 i): 첫 스텝에서 status='suspended' → 인터프리터 suspend outcome → driver R4+포트+R11.
async function artifactCount(pool: ReturnType<typeof createPool>, runId: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const rows = await c.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM artifacts
        WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
      [TENANT, runId],
    );
    return rows.rows[0]?.count ?? 0;
  });
}

const suspendingExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = new Date().toISOString();
    return {
      stepId,
      action: "navigate",
      status: "suspended",
      // ②③: status='suspended' 는 executor 가 감지한 challenge(captcha|mfa)를 운반해야 한다(인터프리터가 challengeKind 유도).
      challenge: { type: "captcha", detectedBy: "dom", confidence: 1 },
      pageStateBefore: "ref",
      pageStateAfter: "ps_suspend_after",
      artifacts: [],
      cache: { mode: "bypass" },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() {
    throw new Error("verify not used in driver int");
  },
};
// mock SecretStore: resume_token HMAC 서명키 {kid,key} 반환(실 Vault SecretStore 대역). 키 자료는 테스트 로컬.
const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-test", key: "int-resume-signing-key" }) as unknown as PlainSecret,
};
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);

const scenarioIr = {
  meta: { name: "driver-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
    check: {
      what: [{ action: "observe" }],
      on: [
        { when: "flags.not_found", target: "done", priority: 2 },
        { when: "flags.reviews_visible", target: "done", priority: 1 },
      ],
    },
    done: { terminal: "success" },
  },
};

// @human_task(R5, 트리거 ii) 시나리오: what-less task 노드 → next=@human_task → suspend. on_timeout=escalate(비기본값 → 포트 경유 실증).
const scenarioIrVideoAlways = {
  ...scenarioIr,
  meta: { name: "driver-video-always-test", version: 1, evidence: { screenshot: "never", video: "always" } },
};
const scenarioIrVideoFailure = {
  ...scenarioIr,
  meta: { name: "driver-video-failure-test", version: 1, evidence: { screenshot: "never", video: "failure" } },
};
const scenarioIrVisualFailure = {
  meta: { name: "driver-visual-failure-test", version: 1, evidence: { screenshot: "failure", video: "never" } },
  start: "open",
  nodes: {
    open: {
      policy: { recording: "masked_on_failure" },
      what: [{ action: "navigate", url_ref: "entry_url" }],
      next: "check",
    },
    check: scenarioIr.nodes.check,
    done: { terminal: "success" },
  },
};

const generatedLikeIr = {
  meta: {
    name: "generated-like-driver-test",
    version: 1,
    ir_version: "1.x",
    studio_mode: "easy",
    evidence: { screenshot: "never", video: "never" },
  },
  params_schema: {
    type: "object",
    additionalProperties: true,
    required: ["start_url"],
    properties: { start_url: { type: "string", format: "uri" } },
  },
  start: "open_start_url",
  nodes: {
    open_start_url: {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: "understand_request",
      policy: { recording: "never" },
      side_effect: { kind: "read_only" },
    },
    understand_request: {
      what: [{ action: "observe", instruction: "Collect visible notices from the current page." }],
      next: "extract_results",
      policy: { recording: "never" },
      side_effect: { kind: "read_only" },
    },
    extract_results: {
      what: [
        {
          action: "extract",
          instruction: "Return { summary: string, rows: object[] } for the visible notices.",
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
      policy: { recording: "never" },
      side_effect: { kind: "read_only" },
    },
    done: { terminal: "success" },
  },
};

const humanTaskIr = {
  meta: { name: "human-task-test", version: 1 },
  start: "task",
  nodes: {
    task: {
      what: [],
      next: {
        handler: "@human_task",
        input: {
          kind: "approval",
          assignee_role: "approver",
          on_timeout: "escalate",
          payload: { invoice_id: "INV-42" },
          result_schema: {
            version: "business_form_v1",
            fields: [{ key: "invoice_id", label: "Invoice ID", type: "text", required: true }],
          },
          artifact_refs: ["artifact.invoice.scan"],
        },
        return_node: "after",
      },
    },
    after: { terminal: "success" },
  },
};

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    // 시나리오 컴파일(실 API 파이프라인) → ir + compiled_ast 캐시. 무효면 테스트 자체 실패.
    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles (ajv→IREL→V1–V11)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");
    const compiledHt = compileScenario(humanTaskIr, {});
    check("@human_task scenario compiles (reservedHandlerCall next-target)", compiledHt.ok, compiledHt.ok ? "" : JSON.stringify(compiledHt.details));
    if (!compiledHt.ok) throw new Error("@human_task scenario did not compile");
    const compiledVideoAlways = compileScenario(scenarioIrVideoAlways, {});
    check("video always scenario compiles", compiledVideoAlways.ok, compiledVideoAlways.ok ? "" : JSON.stringify(compiledVideoAlways.details));
    if (!compiledVideoAlways.ok) throw new Error("video always scenario did not compile");
    const compiledVideoFailure = compileScenario(scenarioIrVideoFailure, {});
    check("video failure scenario compiles", compiledVideoFailure.ok, compiledVideoFailure.ok ? "" : JSON.stringify(compiledVideoFailure.details));
    if (!compiledVideoFailure.ok) throw new Error("video failure scenario did not compile");
    const compiledVisualFailure = compileScenario(scenarioIrVisualFailure, {});
    check("visual failure scenario compiles", compiledVisualFailure.ok, compiledVisualFailure.ok ? "" : JSON.stringify(compiledVisualFailure.details));
    if (!compiledVisualFailure.ok) throw new Error("visual failure scenario did not compile");
    const compiledGeneratedLike = compileScenario(generatedLikeIr, {});
    check("generated-like scenario compiles", compiledGeneratedLike.ok, compiledGeneratedLike.ok ? "" : JSON.stringify(compiledGeneratedLike.details));
    if (!compiledGeneratedLike.ok) throw new Error("generated-like scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'driver')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      // @human_task(R5) 시나리오는 별도 scenario_version(SVER2, 별도 SCEN2).
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'human-task')`, [SCEN2, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER2, TENANT, SCEN2, JSON.stringify(compiledHt.ir), compiledHt.compiledAst],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'video-always')`, [SCEN_VIDEO_ALWAYS, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER_VIDEO_ALWAYS, TENANT, SCEN_VIDEO_ALWAYS, JSON.stringify(compiledVideoAlways.ir), compiledVideoAlways.compiledAst],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'video-failure')`, [SCEN_VIDEO_FAILURE, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER_VIDEO_FAILURE, TENANT, SCEN_VIDEO_FAILURE, JSON.stringify(compiledVideoFailure.ir), compiledVideoFailure.compiledAst],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'generated-like')`, [SCEN_GENERATED_LIKE, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER_GENERATED_LIKE, TENANT, SCEN_GENERATED_LIKE, JSON.stringify(compiledGeneratedLike.ir), compiledGeneratedLike.compiledAst],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'visual-failure')`, [SCEN_VISUAL_FAILURE, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER_VISUAL_FAILURE, TENANT, SCEN_VISUAL_FAILURE, JSON.stringify(compiledVisualFailure.ir), compiledVisualFailure.compiledAst],
      );
      // R1을 우회해 claimed 상태로 직접 시드(드라이버는 R2부터). correlation_id=run_id.
      for (const rid of [RUN, RUN_FAIL_BIZ, RUN_FAIL_SYS, RUN_SUSPEND, RUN_ARTIFACT, RUN_VISUAL_NO_ENQUEUER]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
           VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
          [rid, TENANT, SVER, WORKER],
        );
      }
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
         VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
        [RUN_HUMAN_TASK, TENANT, SVER2, WORKER],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of, params)
         VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z','{"start_url":"https://example.com/generated"}'::jsonb)`,
        [RUN_GENERATED_LIKE, TENANT, SVER_GENERATED_LIKE, WORKER],
      );
      for (const [rid, sver] of [
        [RUN_VIDEO_ALWAYS, SVER_VIDEO_ALWAYS],
        [RUN_VIDEO_FAILURE_SUCCESS, SVER_VIDEO_FAILURE],
        [RUN_VIDEO_FAILURE_FAIL, SVER_VIDEO_FAILURE],
        [RUN_VIDEO_NO_RECORDER, SVER_VIDEO_ALWAYS],
        [RUN_VIDEO_STOP_FAIL, SVER_VIDEO_ALWAYS],
        [RUN_VIDEO_DRIVE_THROW, SVER_VIDEO_ALWAYS],
        [RUN_VIDEO_NO_ENQUEUER, SVER_VIDEO_ALWAYS],
      ] as const) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
           VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
          [rid, TENANT, sver, WORKER],
        );
      }
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, worker_id, as_of)
         VALUES ($1,$2,$3,'claimed',$1,1,$4::uuid,'2026-06-16T00:00:00Z')`,
        [RUN_VISUAL_DRIVE_THROW, TENANT, SVER_VISUAL_FAILURE, WORKER],
      );
    });

    const run: ClaimedRun = {
      runId: RUN,
      tenantId: TENANT,
      scenarioVersionId: SVER,
      correlationId: RUN,
      leaseId: "lease-1",
      siteProfileId: "site-1",
      browserIdentityId: "bid-1",
      networkPolicyId: "np-1",
      params: { entry_url: "https://example.com" },
    };
    const result = await driveClaimedRun(run, { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER });

    check("driver returns completed", result.state === "completed", result.state);
    check("interpreter visited open→check→done", result.outcome.visited.join(",") === "open,check,done", result.outcome.visited.join(","));
    check("terminal=success", result.outcome.terminal === "success", result.outcome.terminal);

    // DB 실제 상태 확인.
    const dbStatus = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; started_at: Date | null }>(
        `SELECT status, started_at FROM runs WHERE id=$1::uuid`,
        [RUN],
      );
      return r.rows[0] ?? null;
    });
    check("DB runs.status = completed", dbStatus?.status === "completed", JSON.stringify(dbStatus));
    check("R2 started_at 기록됨", dbStatus?.started_at !== null && dbStatus?.started_at !== undefined);

    // outbox 이벤트(전이별 emit) 확인.
    const generatedLikeStore = new FakeObjectStore();
    const generatedLikeEnqueuer = new FakeRuntimeJobEnqueuer();
    const generatedLike = await driveClaimedRun(
      {
        runId: RUN_GENERATED_LIKE,
        tenantId: TENANT,
        scenarioVersionId: SVER_GENERATED_LIKE,
        correlationId: RUN_GENERATED_LIKE,
        leaseId: "lease-generated",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { start_url: "https://example.com/generated" },
      },
      {
        pool,
        executor: echoActionExecutor,
        resolver: fakeResolver,
        workerId: WORKER,
        recordExecutorSteps: true,
        mergedExtractArtifactSink: new PgMergedExtractArtifactSink(pool, generatedLikeStore, { retentionDays: 90 }),
        runtimeJobEnqueuer: generatedLikeEnqueuer,
      },
    );
    check("generated-like driver returns completed", generatedLike.state === "completed", generatedLike.state);
    check(
      "generated-like visited open->observe->extract->done",
      generatedLike.outcome.visited.join(",") === "open_start_url,understand_request,extract_results,done",
      generatedLike.outcome.visited.join(","),
    );
    const generatedSteps = await runSteps(pool, RUN_GENERATED_LIKE);
    check(
      "generated-like persists observe/extract run_steps trace",
      generatedSteps.some((s) => s.node_id === "understand_request" && s.action === "observe" && s.status === "success") &&
        generatedSteps.some((s) => s.node_id === "extract_results" && s.action === "extract" && s.status === "success"),
      JSON.stringify(generatedSteps),
    );
    check(
      "generated-like outcome includes merged extract artifact ref",
      generatedLike.outcome.artifacts.length === 1 && generatedLike.outcome.mergedExtract?.records.length === 1,
      JSON.stringify(generatedLike.outcome),
    );
    check(
      "generated-like merged extract artifact content is final run-level JSON",
      generatedLikeStore.puts.length === 1 &&
        JSON.parse(generatedLikeStore.puts[0]?.content ?? "{}").kind === "merged_extract_result" &&
        JSON.parse(generatedLikeStore.puts[0]?.content ?? "{}").records?.[0]?.title === "generated",
      generatedLikeStore.puts[0]?.content,
    );
    check(
      "generated-like merged extract artifact triggers lifecycle jobs",
      generatedLikeEnqueuer.jobs.length === 2 &&
        generatedLikeEnqueuer.jobs[0]?.kind === "artifact_redaction" &&
        generatedLikeEnqueuer.jobs[0]?.runId === RUN_GENERATED_LIKE &&
        generatedLikeEnqueuer.jobs[1]?.kind === "artifact_retention",
      JSON.stringify(generatedLikeEnqueuer.jobs),
    );

    const artifactEnqueuer = new FakeRuntimeJobEnqueuer();
    const artifactRun = await driveClaimedRun(
      {
        runId: RUN_ARTIFACT,
        tenantId: TENANT,
        scenarioVersionId: SVER,
        correlationId: RUN_ARTIFACT,
        leaseId: "lease-art",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      { pool, executor: artifactExecutor, resolver: fakeResolver, workerId: WORKER, runtimeJobEnqueuer: artifactEnqueuer },
    );
    check("driver preserves produced artifact refs in outcome", artifactRun.outcome.artifacts.length > 0, JSON.stringify(artifactRun.outcome.artifacts));
    check(
      "driver enqueues artifact redaction + retention jobs",
      artifactEnqueuer.jobs.length === 2 &&
        artifactEnqueuer.jobs[0]?.kind === "artifact_redaction" &&
        artifactEnqueuer.jobs[0]?.runId === RUN_ARTIFACT &&
        artifactEnqueuer.jobs[0]?.artifactId === artifactRun.outcome.artifacts[0] &&
        artifactEnqueuer.jobs[1]?.kind === "artifact_retention",
      JSON.stringify(artifactEnqueuer.jobs),
    );

    const visualNoEnqueuerExecutor = new CountingSuccessExecutor();
    const visualNoEnqueuerRecorder = new FakeVisualEvidenceRecorder();
    const visualNoEnqueuerSessions = new CountingSessionProvider();
    const visualNoEnqueuer = await driveClaimedRun(
      {
        runId: RUN_VISUAL_NO_ENQUEUER,
        tenantId: TENANT,
        scenarioVersionId: SVER,
        correlationId: RUN_VISUAL_NO_ENQUEUER,
        leaseId: "lease-visual-no-enqueuer",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: visualNoEnqueuerExecutor,
        resolver: fakeResolver,
        workerId: WORKER,
        sessionProvider: visualNoEnqueuerSessions,
        visualEvidenceRecorder: visualNoEnqueuerRecorder,
      },
    );
    check(
      "visual recorder without lifecycle enqueuer fails before executor/session/recorder",
      visualNoEnqueuer.state === "failed_system" &&
        visualNoEnqueuer.outcome.terminal === "fail_system" &&
        visualNoEnqueuerExecutor.calls.length === 0 &&
        visualNoEnqueuerSessions.leaseIds.length === 0 &&
        visualNoEnqueuerRecorder.captures.length === 0,
      JSON.stringify({
        state: visualNoEnqueuer.state,
        calls: visualNoEnqueuerExecutor.calls,
        sessions: visualNoEnqueuerSessions.leaseIds,
        captures: visualNoEnqueuerRecorder.captures.length,
      }),
    );
    check("visual recorder without lifecycle enqueuer creates no artifact rows", (await artifactCount(pool, RUN_VISUAL_NO_ENQUEUER)) === 0);

    const videoNoEnqueuerExecutor = new CountingSuccessExecutor();
    const videoNoEnqueuerRecorder = new FakeVideoRecorder("72000000-0000-0000-0000-0000000000e0" as ArtifactRef);
    const videoNoEnqueuer = await driveClaimedRun(
      {
        runId: RUN_VIDEO_NO_ENQUEUER,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_ALWAYS,
        correlationId: RUN_VIDEO_NO_ENQUEUER,
        leaseId: "lease-video-no-enqueuer",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: videoNoEnqueuerExecutor,
        resolver: fakeResolver,
        workerId: WORKER,
        visualEvidenceVideoRecorder: videoNoEnqueuerRecorder,
      },
    );
    check(
      "video recorder without lifecycle enqueuer fails before executor/recorder",
      videoNoEnqueuer.state === "failed_system" &&
        videoNoEnqueuer.outcome.terminal === "fail_system" &&
        videoNoEnqueuerExecutor.calls.length === 0 &&
        videoNoEnqueuerRecorder.starts.length === 0,
      JSON.stringify({ state: videoNoEnqueuer.state, calls: videoNoEnqueuerExecutor.calls, starts: videoNoEnqueuerRecorder.starts }),
    );
    check("video recorder without lifecycle enqueuer creates no artifact rows", (await artifactCount(pool, RUN_VIDEO_NO_ENQUEUER)) === 0);

    const videoAlwaysRecorder = new FakeVideoRecorder("72000000-0000-0000-0000-0000000000d8" as ArtifactRef);
    const videoAlwaysEnqueuer = new FakeRuntimeJobEnqueuer();
    const videoAlways = await driveClaimedRun(
      {
        runId: RUN_VIDEO_ALWAYS,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_ALWAYS,
        correlationId: RUN_VIDEO_ALWAYS,
        leaseId: "lease-video-always",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: fakeExecutor,
        resolver: fakeResolver,
        workerId: WORKER,
        visualEvidenceVideoRecorder: videoAlwaysRecorder,
        runtimeJobEnqueuer: videoAlwaysEnqueuer,
      },
    );
    check("video always starts run-level recorder", videoAlwaysRecorder.starts[0]?.policy === "always" && videoAlwaysRecorder.starts[0]?.leaseId === "lease-video-always", JSON.stringify(videoAlwaysRecorder.starts));
    check("video always persists artifact on success", videoAlways.outcome.artifacts.includes("72000000-0000-0000-0000-0000000000d8" as ArtifactRef) && videoAlwaysRecorder.recordings[0]?.stops[0] === "success", JSON.stringify(videoAlways.outcome.artifacts));
    check(
      "video always artifact triggers targeted lifecycle jobs",
      videoAlwaysEnqueuer.jobs.length === 2 &&
        videoAlwaysEnqueuer.jobs[0]?.kind === "artifact_redaction" &&
        videoAlwaysEnqueuer.jobs[0]?.artifactId === "72000000-0000-0000-0000-0000000000d8",
      JSON.stringify(videoAlwaysEnqueuer.jobs),
    );

    const videoFailureSuccessRecorder = new FakeVideoRecorder("72000000-0000-0000-0000-0000000000d9" as ArtifactRef);
    const videoFailureSuccessEnqueuer = new FakeRuntimeJobEnqueuer();
    const videoFailureSuccess = await driveClaimedRun(
      {
        runId: RUN_VIDEO_FAILURE_SUCCESS,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_FAILURE,
        correlationId: RUN_VIDEO_FAILURE_SUCCESS,
        leaseId: "lease-video-failure-success",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: fakeExecutor,
        resolver: fakeResolver,
        workerId: WORKER,
        visualEvidenceVideoRecorder: videoFailureSuccessRecorder,
        runtimeJobEnqueuer: videoFailureSuccessEnqueuer,
      },
    );
    check("video failure policy discards successful run recording", videoFailureSuccess.state === "completed" && videoFailureSuccessRecorder.recordings[0]?.discards[0] === "terminal_success" && videoFailureSuccess.outcome.artifacts.length === 0, JSON.stringify({ artifacts: videoFailureSuccess.outcome.artifacts, recordings: videoFailureSuccessRecorder.recordings }));

    const videoFailureRecorder = new FakeVideoRecorder("72000000-0000-0000-0000-0000000000da" as ArtifactRef);
    const videoFailureEnqueuer = new FakeRuntimeJobEnqueuer();
    const videoFailure = await driveClaimedRun(
      {
        runId: RUN_VIDEO_FAILURE_FAIL,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_FAILURE,
        correlationId: RUN_VIDEO_FAILURE_FAIL,
        leaseId: "lease-video-failure-fail",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: failingExecutor("failed_system"),
        resolver: fakeResolver,
        workerId: WORKER,
        visualEvidenceVideoRecorder: videoFailureRecorder,
        runtimeJobEnqueuer: videoFailureEnqueuer,
      },
    );
    check("video failure policy persists failed run recording", videoFailure.state === "failed_system" && videoFailure.outcome.artifacts.includes("72000000-0000-0000-0000-0000000000da" as ArtifactRef) && videoFailureRecorder.recordings[0]?.stops[0] === "fail_system", JSON.stringify(videoFailure.outcome.artifacts));
    check(
      "video failure artifact triggers targeted lifecycle jobs",
      videoFailureEnqueuer.jobs.length === 2 &&
        videoFailureEnqueuer.jobs[0]?.kind === "artifact_redaction" &&
        videoFailureEnqueuer.jobs[0]?.artifactId === "72000000-0000-0000-0000-0000000000da",
      JSON.stringify(videoFailureEnqueuer.jobs),
    );

    const videoDriveThrowRecorder = new FakeVideoRecorder("72000000-0000-0000-0000-0000000000de" as ArtifactRef);
    const videoDriveThrowEnqueuer = new FakeRuntimeJobEnqueuer();
    const videoDriveThrow = await driveClaimedRun(
      {
        runId: RUN_VIDEO_DRIVE_THROW,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_ALWAYS,
        correlationId: RUN_VIDEO_DRIVE_THROW,
        leaseId: "lease-video-drive-throw",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: throwingExecutor(),
        resolver: fakeResolver,
        workerId: WORKER,
        visualEvidenceVideoRecorder: videoDriveThrowRecorder,
        runtimeJobEnqueuer: videoDriveThrowEnqueuer,
      },
    );
    check(
      "video always persists failed run recording when executor throws",
      videoDriveThrow.state === "failed_system" &&
        videoDriveThrow.outcome.artifacts.includes("72000000-0000-0000-0000-0000000000de" as ArtifactRef) &&
        videoDriveThrowRecorder.recordings[0]?.stops[0] === "fail_system",
      JSON.stringify({ state: videoDriveThrow.state, artifacts: videoDriveThrow.outcome.artifacts, stops: videoDriveThrowRecorder.recordings[0]?.stops }),
    );
    check(
      "video drive exception artifact triggers lifecycle jobs",
      videoDriveThrowEnqueuer.jobs.length === 2 &&
        videoDriveThrowEnqueuer.jobs[0]?.kind === "artifact_redaction" &&
        videoDriveThrowEnqueuer.jobs[0]?.artifactId === "72000000-0000-0000-0000-0000000000de",
      JSON.stringify(videoDriveThrowEnqueuer.jobs),
    );

    const visualDriveThrowArtifact = "72000000-0000-4000-8000-0000000000e1" as ArtifactRef;
    const visualDriveThrowRecorder = new FakeVisualEvidenceRecorder(visualDriveThrowArtifact);
    const visualDriveThrowSessions = new CountingSessionProvider();
    const visualDriveThrowEnqueuer = new FakeRuntimeJobEnqueuer();
    const visualDriveThrow = await driveClaimedRun(
      {
        runId: RUN_VISUAL_DRIVE_THROW,
        tenantId: TENANT,
        scenarioVersionId: SVER_VISUAL_FAILURE,
        correlationId: RUN_VISUAL_DRIVE_THROW,
        leaseId: "lease-visual-drive-throw",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: throwingExecutor(),
        resolver: fakeResolver,
        workerId: WORKER,
        sessionProvider: visualDriveThrowSessions,
        visualEvidenceRecorder: visualDriveThrowRecorder,
        runtimeJobEnqueuer: visualDriveThrowEnqueuer,
        recordExecutorSteps: true,
      },
    );
    check(
      "visual failure policy captures screenshot when executor throws",
      visualDriveThrow.state === "failed_system" &&
        visualDriveThrow.outcome.artifacts.includes(visualDriveThrowArtifact) &&
        visualDriveThrowRecorder.captures.length === 1 &&
        visualDriveThrowRecorder.captures[0]?.result.status === "failed_system" &&
        visualDriveThrowRecorder.captures[0]?.attempt === 0 &&
        visualDriveThrowSessions.leaseIds[0] === "lease-visual-drive-throw",
      JSON.stringify({
        state: visualDriveThrow.state,
        artifacts: visualDriveThrow.outcome.artifacts,
        captures: visualDriveThrowRecorder.captures,
        sessions: visualDriveThrowSessions.leaseIds,
      }),
    );
    const visualThrowSteps = await runSteps(pool, RUN_VISUAL_DRIVE_THROW);
    check(
      "visual throw screenshot ref is preserved on run_steps",
      visualThrowSteps.some(
        (s) =>
          s.step_id === "open.0" &&
          s.node_id === "open" &&
          s.action === "navigate" &&
          s.status === "failed_system" &&
          s.artifacts.includes(visualDriveThrowArtifact),
      ),
      JSON.stringify(visualThrowSteps),
    );
    check(
      "visual throw artifact triggers lifecycle jobs",
      visualDriveThrowEnqueuer.jobs.length === 2 &&
        visualDriveThrowEnqueuer.jobs[0]?.kind === "artifact_redaction" &&
        visualDriveThrowEnqueuer.jobs[0]?.artifactId === visualDriveThrowArtifact,
      JSON.stringify(visualDriveThrowEnqueuer.jobs),
    );

    const videoNoRecorder = await driveClaimedRun(
      {
        runId: RUN_VIDEO_NO_RECORDER,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_ALWAYS,
        correlationId: RUN_VIDEO_NO_RECORDER,
        leaseId: "lease-video-no-recorder",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER },
    );
    const videoNoRecorderDb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_VIDEO_NO_RECORDER]);
      return r.rows[0] ?? null;
    });
    check("video policy without recorder returns failed_system", videoNoRecorder.state === "failed_system" && videoNoRecorder.outcome.terminal === "fail_system", JSON.stringify(videoNoRecorder));
    check("video policy without recorder closes DB run", videoNoRecorderDb?.status === "failed_system", JSON.stringify(videoNoRecorderDb));

    const throwingVideoRecorder = new ThrowingVideoRecorder();
    const videoStopFailEnqueuer = new FakeRuntimeJobEnqueuer();
    const videoStopFail = await driveClaimedRun(
      {
        runId: RUN_VIDEO_STOP_FAIL,
        tenantId: TENANT,
        scenarioVersionId: SVER_VIDEO_ALWAYS,
        correlationId: RUN_VIDEO_STOP_FAIL,
        leaseId: "lease-video-stop-fail",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      {
        pool,
        executor: fakeExecutor,
        resolver: fakeResolver,
        workerId: WORKER,
        visualEvidenceVideoRecorder: throwingVideoRecorder,
        runtimeJobEnqueuer: videoStopFailEnqueuer,
      },
    );
    const videoStopFailDb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_VIDEO_STOP_FAIL]);
      return r.rows[0] ?? null;
    });
    check(
      "video persist failure returns failed_system and discards recording",
      videoStopFail.state === "failed_system" &&
        videoStopFail.outcome.terminal === "fail_system" &&
        throwingVideoRecorder.recordings[0]?.discards[0] === "run_drive_error",
      JSON.stringify({ state: videoStopFail.state, outcome: videoStopFail.outcome, discards: throwingVideoRecorder.recordings[0]?.discards }),
    );
    check("video persist failure closes DB run", videoStopFailDb?.status === "failed_system", JSON.stringify(videoStopFailDb));

    const events = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(
        `SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`,
        [RUN],
      );
      return r.rows.map((x) => x.event_type);
    });
    check("outbox에 run 전이 이벤트 emit됨", events.length >= 1, events.join(","));

    // 실패 terminal 구동(2a): fail_business → failed_business(R9 단일 전이), fail_system → failed_system(R8 단일 전이).
    // applyRunTransition 이 run.failed_* emit + ended_at 설정 — 드라이버는 단일 전이만 적용(success 의 2-hop 과 비대칭).
    for (const f of [
      { rid: RUN_FAIL_BIZ, status: "failed_business" as const, terminal: "fail_business", state: "failed_business", event: "run.failed_business" },
      { rid: RUN_FAIL_SYS, status: "failed_system" as const, terminal: "fail_system", state: "failed_system", event: "run.failed_system" },
    ]) {
      const fres = await driveClaimedRun(
        {
          runId: f.rid,
          tenantId: TENANT,
          scenarioVersionId: SVER,
          correlationId: f.rid,
          leaseId: "lease-f",
          siteProfileId: "site-1",
          browserIdentityId: "bid-1",
          networkPolicyId: "np-1",
          params: { entry_url: "https://example.com" },
        },
        { pool, executor: failingExecutor(f.status), resolver: fakeResolver, workerId: WORKER },
      );
      check(`driver(${f.status}) → state=${f.state}`, fres.state === f.state, fres.state);
      check(`${f.status} → terminal=${f.terminal}`, fres.outcome.terminal === f.terminal, fres.outcome.terminal);
      const fdb = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ status: string; ended_at: Date | null }>(
          `SELECT status, ended_at FROM runs WHERE id=$1::uuid`,
          [f.rid],
        );
        return r.rows[0] ?? null;
      });
      check(`DB runs.status = ${f.state}`, fdb?.status === f.state, JSON.stringify(fdb));
      check(`${f.state} ended_at 기록(terminal)`, fdb?.ended_at !== null && fdb?.ended_at !== undefined);
      const fevents = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ event_type: string }>(
          `SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`,
          [f.rid],
        );
        return r.rows.map((x) => x.event_type);
      });
      check(`outbox에 ${f.event}`, fevents.includes(f.event), fevents.join(","));
    }

    // suspend 구동(step2+3): suspended → suspending(R4)+human_task 포트 → resume-token 발행+R11 → suspended.
    const susp = await driveClaimedRun(
      {
        runId: RUN_SUSPEND,
        tenantId: TENANT,
        scenarioVersionId: SVER,
        correlationId: RUN_SUSPEND,
        leaseId: "lease-s",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: { entry_url: "https://example.com" },
      },
      { pool, executor: suspendingExecutor, resolver: fakeResolver, workerId: WORKER, suspensionPort, resumeTokenCodec },
    );
    check("driver(suspended) → state=suspended", susp.state === "suspended", susp.state);
    check(
      "outcome.terminal=suspend + suspend.resumeNodeId=open(같은 노드)",
      susp.outcome.terminal === "suspend" && susp.outcome.suspend?.resumeNodeId === "open",
      susp.outcome.suspend?.resumeNodeId,
    );
    const sdb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; resume_token: { kid?: string; hmac?: string } | null; bookmark: { reason?: string } | null }>(
        `SELECT status, resume_token, bookmark FROM runs WHERE id=$1::uuid`,
        [RUN_SUSPEND],
      );
      return r.rows[0] ?? null;
    });
    check("DB runs.status = suspended", sdb?.status === "suspended", String(sdb?.status));
    check("runs.resume_token 발행(kid+hmac)", typeof sdb?.resume_token?.kid === "string" && typeof sdb?.resume_token?.hmac === "string", JSON.stringify(sdb?.resume_token));
    check("runs.bookmark 영속(reason=challenge)", sdb?.bookmark?.reason === "challenge", JSON.stringify(sdb?.bookmark));
    const sht = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ kind: string; state: string }>(`SELECT kind, state FROM human_tasks WHERE run_id=$1::uuid`, [RUN_SUSPEND]);
      return r.rows;
    });
    check("human_tasks 1건 kind=captcha state=open", sht.length === 1 && sht[0]?.kind === "captcha" && sht[0]?.state === "open", JSON.stringify(sht));
    const sevs = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`, [RUN_SUSPEND]);
      return r.rows.map((x) => x.event_type);
    });
    check("outbox: human_task.created + run.suspended", sevs.includes("human_task.created") && sevs.includes("run.suspended"), sevs.join(","));
    // 발행·저장된 토큰이 verify 라운드트립(서명 유효) — DB 봉투 무결성 증명.
    if (sdb?.resume_token) {
      const v = await resumeTokenCodec.verify(sdb.resume_token as unknown as Parameters<typeof resumeTokenCodec.verify>[0]);
      check("저장된 resume_token verify → valid(round-trip)", v.kind === "valid", v.kind);
    } else {
      check("저장된 resume_token verify → valid(round-trip)", false, "resume_token 부재");
    }

    // 멱등 재구동: 이미 completed → claimed→running CAS 0 rows → 표면화(조용한 false 금지).
    let reDriveThrew = false;
    try {
      await driveClaimedRun(run, { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER });
    } catch {
      reDriveThrew = true;
    }
    check("이미 종료된 run 재구동 → CAS 충돌 표면화(throw)", reDriveThrew);

    // @human_task suspend 구동(트리거 ii, R5): what-less @human_task 노드 → R5(human_task_required)+포트→resume-token+R11→suspended.
    const htRun = await driveClaimedRun(
      {
        runId: RUN_HUMAN_TASK,
        tenantId: TENANT,
        scenarioVersionId: SVER2,
        correlationId: RUN_HUMAN_TASK,
        leaseId: "lease-ht",
        siteProfileId: "site-1",
        browserIdentityId: "bid-1",
        networkPolicyId: "np-1",
        params: {},
      },
      { pool, executor: fakeExecutor, resolver: fakeResolver, workerId: WORKER, suspensionPort, resumeTokenCodec },
    );
    check("driver(@human_task) → state=suspended", htRun.state === "suspended", htRun.state);
    check(
      "@human_task outcome: terminal=suspend·kind=human_task·resumeNodeId=after(return_node)",
      htRun.outcome.terminal === "suspend" && htRun.outcome.suspend?.kind === "human_task" && htRun.outcome.suspend.resumeNodeId === "after",
      JSON.stringify(htRun.outcome.suspend),
    );
    const htdb = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; resume_token: { resumeNodeId?: string } | null; bookmark: { reason?: string } | null }>(
        `SELECT status, resume_token, bookmark FROM runs WHERE id=$1::uuid`,
        [RUN_HUMAN_TASK],
      );
      return r.rows[0] ?? null;
    });
    check("@human_task DB runs.status = suspended", htdb?.status === "suspended", String(htdb?.status));
    check("@human_task resume_token.resumeNodeId = after(return_node)", htdb?.resume_token?.resumeNodeId === "after", JSON.stringify(htdb?.resume_token));
    check("@human_task bookmark reason = human_task", htdb?.bookmark?.reason === "human_task", JSON.stringify(htdb?.bookmark));
    const htTask = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{
        kind: string;
        state: string;
        assignee_role: string | null;
        on_timeout: string;
        payload: Record<string, unknown>;
        result_schema: Record<string, unknown>;
        artifact_refs: string[];
      }>(
        `SELECT kind, state, assignee_role, on_timeout, payload, result_schema, artifact_refs FROM human_tasks WHERE run_id=$1::uuid`,
        [RUN_HUMAN_TASK],
      );
      return r.rows;
    });
    check(
      "@human_task human_tasks 1건 kind=approval·assignee_role=approver·on_timeout=escalate·state=open",
      htTask.length === 1 &&
        htTask[0]?.kind === "approval" &&
        htTask[0]?.assignee_role === "approver" &&
        htTask[0]?.on_timeout === "escalate" &&
        htTask[0]?.state === "open",
      JSON.stringify(htTask),
    );
    check("@human_task payload/result_schema/artifact_refs 보존", htTask[0]?.payload.invoice_id === "INV-42" && htTask[0]?.result_schema.version === "business_form_v1" && htTask[0]?.artifact_refs[0] === "artifact.invoice.scan", JSON.stringify(htTask));
    const htEvents = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid ORDER BY created_at`, [RUN_HUMAN_TASK]);
      return r.rows.map((x) => x.event_type);
    });
    check("@human_task outbox: human_task.created + run.suspended", htEvents.includes("human_task.created") && htEvents.includes("run.suspended"), htEvents.join(","));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run 실행 드라이버 — claimed→running→completing→completed + suspend(challenge R4 / @human_task R5) (인터프리터↔DB 전이, D3 가동 1단계)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-step-driver int fatal:", e);
  process.exit(1);
});
