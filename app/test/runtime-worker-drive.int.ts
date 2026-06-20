/**
 * runtime-worker run-drive 통합 (A.1 step4). 실 PostgreSQL.
 *
 * handleRunClaim 이 browserSessionProvider 주입 시 queued run 을 claim 후 driveClaimedRun 으로 구동해 completed
 * 까지 가는지 검증한다. test_fake BrowserSessionProvider(무-Chrome)로 실 UtilityExecutor + SitePageStateResolver 를
 * 빌드 → navigate→terminal success 시나리오를 구동. provider 미주입 시 claimed 까지만(기존 동작 회귀). test_fake 는
 * allowTestBrowserSessionProvider opt-in 없이는 fail-closed throw.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-drive.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ArtifactRef } from "../../ts/core-types";
import type { RuntimeWorkerJob } from "../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { UtilityExecutor } from "../src/executor/utility-executor";
import { PgRuntimeWorker, type BrowserLeasePlanResolver, type RunExecutorContext } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_drive_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9a000000-0000-0000-0000-0000000000a1";
const SITE = "40000000-0000-0000-0000-0000000000e1";
const IDENTITY = "40000000-0000-0000-0000-0000000000e2";
const NETWORK_POLICY = "40000000-0000-0000-0000-0000000000e3";
// 회귀 run(미구동)은 별도 site/identity — drive run 의 lease 와 충돌(SESSION_LOCKED) 방지.
// (drive 완료 시 세션은 release 되나 DB lease drain 은 Phase 1 범위 밖 → TTL/sweeper 회수. 동일 identity 면 즉시 재-claim 불가.)
const SITE2 = "40000000-0000-0000-0000-0000000000e4";
const IDENTITY2 = "40000000-0000-0000-0000-0000000000e5";
const SITE3 = "40000000-0000-0000-0000-0000000000e6";
const IDENTITY3 = "40000000-0000-0000-0000-0000000000e7";
// workitem-연결 drive run(W2 정산 검증) — 별도 site/identity 로 lease 충돌 방지.
const SITE4 = "40000000-0000-0000-0000-0000000000e8";
const IDENTITY4 = "40000000-0000-0000-0000-0000000000e9";
// C3 좀비-run 폴백 검증 run — 별도 site/identity.
const SITE5 = "40000000-0000-0000-0000-0000000000ea";
const IDENTITY5 = "40000000-0000-0000-0000-0000000000eb";
const SCEN = "70000000-0000-0000-0000-0000000000e1";
const SVER = "70000000-0000-0000-0000-0000000000e2";
const SCEN_VIDEO = "70000000-0000-0000-0000-0000000000e3";
const SVER_VIDEO = "70000000-0000-0000-0000-0000000000e4";
const RUN_DRIVE = "71000000-0000-0000-0000-0000000000e1";
const RUN_NODRIVE = "71000000-0000-0000-0000-0000000000e2";
const RUN_VIDEO = "71000000-0000-0000-0000-0000000000e3";
const RUN_WORKITEM = "71000000-0000-0000-0000-0000000000e4";
const RUN_ZOMBIE = "71000000-0000-0000-0000-0000000000e5";
const WORKITEM_OK = "72000000-0000-0000-0000-0000000000e1";
const WORKITEM_FAIL = "72000000-0000-0000-0000-0000000000e2";
// 유효 FK·유효 ir, 그러나 compiled_ast 가 비-JSON → driveScenario 가 R2(running) 이후 throw(좀비 트리거).
const SVER_BAD = "70000000-0000-0000-0000-0000000000e5";
const CORRELATION = "20000000-0000-0000-0000-0000000000e1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async (_client, input) =>
  input.runId === RUN_NODRIVE
    ? { siteProfileId: SITE2, browserIdentityId: IDENTITY2, networkPolicyId: NETWORK_POLICY }
    : input.runId === RUN_VIDEO
      ? { siteProfileId: SITE3, browserIdentityId: IDENTITY3, networkPolicyId: NETWORK_POLICY }
      : input.runId === RUN_WORKITEM
        ? { siteProfileId: SITE4, browserIdentityId: IDENTITY4, networkPolicyId: NETWORK_POLICY }
        : input.runId === RUN_ZOMBIE
          ? { siteProfileId: SITE5, browserIdentityId: IDENTITY5, networkPolicyId: NETWORK_POLICY }
    : { siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY };

// navigate → next → terminal success. on[]/observe 없음 → pageState 해소 불요(FakeCdpSession no-op goto 로 충분).
const scenarioIr = {
  meta: { name: "drive-worker-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

const scenarioVideoIr = {
  ...scenarioIr,
  meta: { name: "drive-worker-video-test", version: 1, evidence: { screenshot: "never", video: "always" } },
};

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
  });
}

async function runSteps(pool: ReturnType<typeof createPool>, runId: string): Promise<readonly { step_id: string; node_id: string; action: string; status: string; artifacts: string[] }[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ step_id: string; node_id: string; action: string; status: string; artifacts: string[] }>(
      `SELECT step_id, node_id, action, status, artifacts
         FROM run_steps
        WHERE tenant_id=$1::uuid AND run_id=$2::uuid
        ORDER BY step_id, attempt`,
      [TENANT, runId],
    );
    return r.rows;
  });
}

async function workitemStatus(pool: ReturnType<typeof createPool>, workitemId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM workitems WHERE id=$1::uuid`, [workitemId]);
    return r.rows[0]?.status ?? null;
  });
}

async function deadLetterCount(pool: ReturnType<typeof createPool>, workitemId: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM dead_letter WHERE workitem_id=$1::uuid`, [workitemId]);
    return r.rows[0]?.n ?? 0;
  });
}

async function workitemEventTypes(pool: ReturnType<typeof createPool>, workitemId: string): Promise<readonly string[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ event_type: string }>(
      `SELECT event_type FROM events_outbox WHERE workitem_id=$1::uuid ORDER BY event_type`,
      [workitemId],
    );
    return r.rows.map((row) => row.event_type);
  });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

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
      // workers 는 tenantless → raw 연결로 시드(search_path 는 pool options).
      await setup.query(
        `INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`,
        [WORKER],
      );
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles (ajv→IREL→V1–V11)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");
    const compiledVideo = compileScenario(scenarioVideoIr, {});
    check("video scenario compiles", compiledVideo.ok, compiledVideo.ok ? "" : JSON.stringify(compiledVideo.details));
    if (!compiledVideo.ok) throw new Error("video scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok2','https://ok2.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE2, TENANT],
      );
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok3','https://ok3.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE3, TENANT],
      );
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok4','https://ok4.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE4, TENANT],
      );
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok5','https://ok5.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE5, TENANT],
      );
      // IDENTITY(RUN_DRIVE 용) version=7(비기본) — executorFactory seam 이 browser_identity.version JOIN 결과를 받는지 핀고정.
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version)
         VALUES ($1,$2,$3,'ok',7), ($4,$2,$5,'ok2',1), ($6,$2,$7,'ok3',1), ($8,$2,$9,'ok4',1), ($10,$2,$11,'ok5',1)`,
        [IDENTITY, TENANT, SITE, IDENTITY2, SITE2, IDENTITY3, SITE3, IDENTITY4, SITE4, IDENTITY5, SITE5],
      );
      await c.query(
        `INSERT INTO network_policies (id, tenant_id, allowed_domains)
         VALUES ($1,$2,ARRAY['ok.example','ok2.example','ok3.example','ok4.example','ok5.example'])`,
        [NETWORK_POLICY, TENANT],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'drive')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'drive-video')`, [SCEN_VIDEO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER_VIDEO, TENANT, SCEN_VIDEO, JSON.stringify(compiledVideo.ir), compiledVideo.compiledAst],
      );
      for (const rid of [RUN_DRIVE, RUN_NODRIVE]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
           VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
          [rid, TENANT, SVER, CORRELATION],
        );
      }
      await c.query(`UPDATE runs SET model='codex-run-override' WHERE tenant_id=$1::uuid AND id=$2::uuid`, [TENANT, RUN_DRIVE]);
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
         VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok3.example/landing"}'::jsonb)`,
        [RUN_VIDEO, TENANT, SVER_VIDEO, CORRELATION],
      );
      // workitem-연결 drive run: checkout(W1)으로 processing 인 workitem 에 run 을 연결 → driveClaimedRun 종결 시 W2 정산 검증.
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
         VALUES ($1,$2,'drive-connector','wi-ok-1','processing',0)`,
        [WORKITEM_OK, TENANT],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id, params)
         VALUES ($1,$2,$3,$4,'queued',$5,'{"entry_url":"https://ok4.example/landing"}'::jsonb)`,
        [RUN_WORKITEM, TENANT, SVER, WORKITEM_OK, CORRELATION],
      );
      // C3: compiled_ast 가 비-JSON 인 scenario_version → driveScenario 가 R2(running) 이후 JSON.parse throw → 폴백 검증.
      //     workitem attempts=2(max 3) → system 정산 시 W5(abandoned + dead_letter).
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,2,'draft',$4::jsonb,$5)`,
        [SVER_BAD, TENANT, SCEN, JSON.stringify(compiled.ir), "NOT-VALID-JSON{"],
      );
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
         VALUES ($1,$2,'drive-connector','wi-fail-1','processing',2)`,
        [WORKITEM_FAIL, TENANT],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id, params)
         VALUES ($1,$2,$3,$4,'queued',$5,'{"entry_url":"https://ok5.example/landing"}'::jsonb)`,
        [RUN_ZOMBIE, TENANT, SVER_BAD, WORKITEM_FAIL, CORRELATION],
      );
    });

    // 1) provider 주입 → claim 후 driveClaimedRun 으로 completed + 세션 release(close).
    let driveSession: FakeCdpSession | null = null;
    const sessionProvider = new TestFakeBrowserSessionProvider({
      makeSession: (downloadDir) => {
        driveSession = new FakeCdpSession(downloadDir);
        return driveSession;
      },
    });
    // executorFactory seam(P5b): run 단위로 (provider, run-scoped 컨텍스트)를 받는지 캡처. UtilityExecutor 반환 → 구동은 기존대로.
    let capturedRunCtx: RunExecutorContext | null = null;
    const driving = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: sessionProvider,
      allowTestBrowserSessionProvider: true,
      executorFactory: (provider, run) => {
        capturedRunCtx = run;
        return new UtilityExecutor(provider);
      },
    });
    const driven = await driving.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_DRIVE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim+drive → job completed", driven.kind === "completed", JSON.stringify(driven));
    check("DB runs.status = completed (driven to terminal)", (await runStatus(pool, RUN_DRIVE)) === "completed", String(await runStatus(pool, RUN_DRIVE)));
    {
      const steps = await runSteps(pool, RUN_DRIVE);
      check(
        "run_claim+drive persists executor run_steps trace",
        steps.length === 1 && steps[0]?.step_id === "open.0" && steps[0]?.node_id === "open" && steps[0]?.action === "navigate" && steps[0]?.status === "success",
        JSON.stringify(steps),
      );
    }
    check("세션 release(close) 호출됨", driveSession !== null && (driveSession as FakeCdpSession).closeCalls === 1, `closeCalls=${driveSession === null ? "no-session" : (driveSession as FakeCdpSession).closeCalls}`);

    // executorFactory seam: run-scoped 컨텍스트 전달 핀고정(P5b) — scenarioVersionId + browser_identity.version JOIN(=7).
    check("executorFactory 가 run-scoped 컨텍스트 수신(scenarioVersionId=SVER)", (capturedRunCtx as RunExecutorContext | null)?.scenarioVersionId === SVER, JSON.stringify(capturedRunCtx));
    check("executorFactory 가 browser_identity.version JOIN 결과 수신(=7, 비기본)", (capturedRunCtx as RunExecutorContext | null)?.browserIdentityVersion === 7, JSON.stringify(capturedRunCtx));
    check("executorFactory 가 runs.model override 수신", (capturedRunCtx as RunExecutorContext | null)?.model === "codex-run-override", JSON.stringify(capturedRunCtx));

    // 1b) workitem-연결 run drive → completed 시 연결 Workitem W2(successful) 정산 + workitem.completed 이벤트, dead_letter 없음.
    //     (프로덕션 driveClaimedRun 경로가 Workitem 을 단말 정산하는지 직접 검증 — 두 완료 경로 단절 회귀 가드.)
    const workitemProvider = new TestFakeBrowserSessionProvider({ makeSession: (downloadDir) => new FakeCdpSession(downloadDir) });
    const drivingWorkitem = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: workitemProvider,
      allowTestBrowserSessionProvider: true,
      executorFactory: (provider) => new UtilityExecutor(provider),
    });
    const drivenWorkitem = await drivingWorkitem.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_WORKITEM as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("workitem-연결 run_claim+drive → job completed", drivenWorkitem.kind === "completed", JSON.stringify(drivenWorkitem));
    check("DB runs.status = completed (workitem run)", (await runStatus(pool, RUN_WORKITEM)) === "completed", String(await runStatus(pool, RUN_WORKITEM)));
    check("연결 Workitem W2 정산: status=successful", (await workitemStatus(pool, WORKITEM_OK)) === "successful", String(await workitemStatus(pool, WORKITEM_OK)));
    check("Workitem 단말정산 후 dead_letter 없음", (await deadLetterCount(pool, WORKITEM_OK)) === 0, String(await deadLetterCount(pool, WORKITEM_OK)));
    {
      const events = await workitemEventTypes(pool, WORKITEM_OK);
      check("workitem.completed 이벤트 발행", events.includes("workitem.completed"), JSON.stringify(events));
    }

    // 1c) C3 좀비-run 폴백: R2(running) 이후 drive 본문 throw(compiled_ast 비-JSON) → 폴백이 failed_system 으로 종결.
    //     run 이 running 에 영구 잔류(좀비)하지 않고, 연결 Workitem 은 system 정산(W5 abandoned + dead_letter)됨.
    const zombieProvider = new TestFakeBrowserSessionProvider({ makeSession: (downloadDir) => new FakeCdpSession(downloadDir) });
    const drivingZombie = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: zombieProvider,
      allowTestBrowserSessionProvider: true,
      executorFactory: (provider) => new UtilityExecutor(provider),
    });
    const drivenZombie = await drivingZombie.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_ZOMBIE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("좀비 폴백: job 이 throw 없이 completed 반환", drivenZombie.kind === "completed", JSON.stringify(drivenZombie));
    check("좀비 폴백: run 이 running 잔류 아니라 failed_system 종결", (await runStatus(pool, RUN_ZOMBIE)) === "failed_system", String(await runStatus(pool, RUN_ZOMBIE)));
    check("좀비 폴백: 연결 Workitem W5 abandoned 정산", (await workitemStatus(pool, WORKITEM_FAIL)) === "abandoned", String(await workitemStatus(pool, WORKITEM_FAIL)));
    check("좀비 폴백: dead_letter 1건 생성", (await deadLetterCount(pool, WORKITEM_FAIL)) === 1, String(await deadLetterCount(pool, WORKITEM_FAIL)));
    {
      const events = await workitemEventTypes(pool, WORKITEM_FAIL);
      check("좀비 폴백: workitem.dead_lettered 이벤트 발행", events.includes("workitem.dead_lettered"), JSON.stringify(events));
    }

    // 2) provider 미주입 → claimed 까지만(회귀: 기존 동작 보존, 구동 안 함).
    let videoSession: FakeCdpSession | null = null;
    const videoSessionProvider = new TestFakeBrowserSessionProvider({
      makeSession: (downloadDir) => {
        videoSession = new FakeCdpSession(downloadDir);
        return videoSession;
      },
    });
    const videoStarts: unknown[] = [];
    const videoStops: unknown[] = [];
    const videoLifecycleJobs: RuntimeWorkerJob[] = [];
    const drivingWithVideo = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: videoSessionProvider,
      allowTestBrowserSessionProvider: true,
      executorFactory: (provider) => new UtilityExecutor(provider),
      visualEvidenceVideoRecorderFactory: (provider) => ({
        async startRunVideo(input) {
          videoStarts.push(input);
          provider.forLease(input.leaseId);
          return {
            async stopAndPersist(stopInput) {
              videoStops.push(stopInput);
              return "90000000-0000-0000-0000-0000000000e1" as ArtifactRef;
            },
            async discard() {},
          };
        },
      }),
      runtimeJobEnqueuer: {
        async enqueueRuntimeJob(_client, job) {
          videoLifecycleJobs.push(job);
        },
      },
    });
    const drivenWithVideo = await drivingWithVideo.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_VIDEO as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim+video drive ??job completed", drivenWithVideo.kind === "completed", JSON.stringify(drivenWithVideo));
    check("DB runs.status = completed for video drive", (await runStatus(pool, RUN_VIDEO)) === "completed", String(await runStatus(pool, RUN_VIDEO)));
    {
      const steps = await runSteps(pool, RUN_VIDEO);
      check("video drive also persists run_steps trace", steps.length === 1 && steps[0]?.status === "success", JSON.stringify(steps));
    }
    check("video recorder factory starts run-level recording", videoStarts.length === 1);
    check("video recorder start receives policy always", (videoStarts[0] as { policy?: unknown } | undefined)?.policy === "always", JSON.stringify(videoStarts));
    check("video recorder persists on success", (videoStops[0] as { terminal?: unknown } | undefined)?.terminal === "success", JSON.stringify(videoStops));
    check(
      "video artifact lifecycle jobs are enqueued",
      videoLifecycleJobs.map((job) => job.kind).join(",") === "artifact_redaction,artifact_retention",
      JSON.stringify(videoLifecycleJobs),
    );
    check("video drive releases session", videoSession !== null && (videoSession as FakeCdpSession).closeCalls === 1);

    const claimOnly = new PgRuntimeWorker(pool, { workerId: WORKER, browserLeasePlanResolver: planResolver });
    const claimed = await claimOnly.handle({
      kind: "run_claim",
      tenantId: TENANT as TenantId,
      runId: RUN_NODRIVE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim (provider 미주입) → job completed", claimed.kind === "completed", JSON.stringify(claimed));
    check("DB runs.status = claimed (미구동, 기존 동작)", (await runStatus(pool, RUN_NODRIVE)) === "claimed", String(await runStatus(pool, RUN_NODRIVE)));

    // 3) test_fake provider 를 opt-in 없이 주입 → fail-closed throw(gateBrowserSessionProvider, claim 전).
    const ungated = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
    });
    const gateErr = await caught(
      ungated.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_NODRIVE as RunId, correlationId: CORRELATION as CorrelationId }),
    );
    check("test_fake without allowTest opt-in → fail-closed throw", gateErr instanceof Error, String(gateErr));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker run-drive — queued→(claim)→driveClaimedRun→completed (A.1 step4)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-drive int fatal:", e);
  process.exit(1);
});
