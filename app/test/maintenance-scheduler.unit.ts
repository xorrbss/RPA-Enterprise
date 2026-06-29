import {
  AUDIT_VERIFIER_INTERVAL_MS,
  buildAuditVerifierJobs,
  buildDailySweeperJobs,
  buildIntegritySweeperJobs,
  buildMaintenancePollJobs,
  buildOrphanSweeperJob,
  buildRetentionSweeperJobs,
  millisecondsUntilNextKstHour,
  resolveAuditVerifierTenantIds,
  resolveDailyLifecycleTenantIds,
  resolveMaintenanceTenantIds,
  resolveRunTriggerTenantIds,
  runAuditVerifier,
  runDailySweeper,
} from "../src/worker/maintenance-scheduler";
import type { RuntimeWorkerJob } from "../../ts/runtime-contract";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000a2";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
  }
}

let seq = 0;
const nextCorrelation = (): string => `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const pollJobs = buildMaintenancePollJobs([TENANT_A, TENANT_B], nextCorrelation);
check(
  "maintenance poll fanout enqueues lease + human task timeout + checkout sweeper + redaction per tenant",
  pollJobs.length === 8 &&
    pollJobs[0]?.kind === "lease_sweeper" &&
    pollJobs[0]?.tenantId === TENANT_A &&
    pollJobs[1]?.kind === "human_task_timeout_sweeper" &&
    pollJobs[1]?.tenantId === TENANT_A &&
    pollJobs[1]?.correlationId === "20000000-0000-4000-8000-000000000001" &&
    pollJobs[2]?.kind === "workitem_checkout_sweeper" &&
    pollJobs[2]?.tenantId === TENANT_A &&
    pollJobs[2]?.correlationId === "20000000-0000-4000-8000-000000000002" &&
    pollJobs[3]?.kind === "artifact_redaction" &&
    pollJobs[3]?.tenantId === TENANT_A &&
    pollJobs[3]?.correlationId === "20000000-0000-4000-8000-000000000003" &&
    pollJobs[3]?.runId === undefined &&
    pollJobs[3]?.artifactId === undefined &&
    pollJobs[3]?.generationId === undefined &&
    pollJobs[4]?.kind === "lease_sweeper" &&
    pollJobs[4]?.tenantId === TENANT_B &&
    pollJobs[5]?.kind === "human_task_timeout_sweeper" &&
    pollJobs[5]?.tenantId === TENANT_B &&
    pollJobs[6]?.kind === "workitem_checkout_sweeper" &&
    pollJobs[6]?.tenantId === TENANT_B &&
    pollJobs[7]?.kind === "artifact_redaction" &&
    pollJobs[7]?.tenantId === TENANT_B &&
    pollJobs[7]?.artifactId === undefined &&
    pollJobs[7]?.generationId === undefined,
  JSON.stringify(pollJobs),
);

// pollJobs 가 4회 correlation()을 소비(테넌트당 checkout_sweeper+redaction) → 다음은 005.
{
  let auditSeq = 0;
  const auditCorrelation = (): string => `21000000-0000-4000-8000-${String(++auditSeq).padStart(12, "0")}`;
  const auditJobs = buildAuditVerifierJobs([TENANT_A, TENANT_B], auditCorrelation);
  check(
    "audit verifier fanout enqueues tenant-scoped verifier jobs with correlation",
    auditJobs.length === 2 &&
      auditJobs[0]?.kind === "audit_verifier" &&
      auditJobs[0]?.tenantId === TENANT_A &&
      auditJobs[0]?.correlationId === "21000000-0000-4000-8000-000000000001" &&
      auditJobs[1]?.kind === "audit_verifier" &&
      auditJobs[1]?.tenantId === TENANT_B &&
      auditJobs[1]?.correlationId === "21000000-0000-4000-8000-000000000002",
    JSON.stringify(auditJobs),
  );
}

const retentionJobs = buildRetentionSweeperJobs([TENANT_A], nextCorrelation);
check(
  "retention fanout enqueues tenant-scoped artifact retention with correlation",
  retentionJobs.length === 1 &&
    retentionJobs[0]?.kind === "artifact_retention" &&
    retentionJobs[0]?.tenantId === TENANT_A &&
    retentionJobs[0]?.correlationId === "20000000-0000-4000-8000-000000000007",
  JSON.stringify(retentionJobs),
);

// AUD-10: integrity_checker 도 일배치(retention 과 같은 cadence). 전용 fanout + daily 묶음에 포함.
const integrityJobs = buildIntegritySweeperJobs([TENANT_A, TENANT_B]);
check(
  "integrity fanout enqueues tenant-scoped artifact_integrity per tenant",
  integrityJobs.length === 2 &&
    integrityJobs[0]?.kind === "artifact_integrity" &&
    integrityJobs[0]?.tenantId === TENANT_A &&
    integrityJobs[1]?.kind === "artifact_integrity" &&
    integrityJobs[1]?.tenantId === TENANT_B,
  JSON.stringify(integrityJobs),
);

const orphanJob = buildOrphanSweeperJob();
check(
  "orphan fanout is a single global job (no tenantId — store is not tenant-partitioned)",
  orphanJob.kind === "artifact_orphan" && orphanJob.tenantId === undefined,
  JSON.stringify(orphanJob),
);

const dailyJobs = buildDailySweeperJobs([TENANT_A, TENANT_B]);
check(
  "daily sweeper batch includes per-tenant retention+integrity and one global orphan",
  dailyJobs.length === 5 &&
    dailyJobs.filter((j) => j.kind === "artifact_retention").length === 2 &&
    dailyJobs.filter((j) => j.kind === "artifact_integrity").length === 2 &&
    dailyJobs.filter((j) => j.kind === "artifact_orphan").length === 1,
  JSON.stringify(dailyJobs),
);

const emptyDailyJobs = buildDailySweeperJobs([]);
check(
  "daily sweeper batch with no tenant ids still includes one global orphan job",
  emptyDailyJobs.length === 1 &&
    emptyDailyJobs[0]?.kind === "artifact_orphan" &&
    emptyDailyJobs[0]?.tenantId === undefined,
  JSON.stringify(emptyDailyJobs),
);

{
  let released = false;
  let queryCount = 0;
  let queryNow = "";
  const appPool = {
    connect: async () => {
      throw new Error("app-role pool must not be used for cross-tenant run trigger discovery");
    },
  };
  const lifecycleBypassPool = {
    connect: async () => ({
      query: async (_sql: string, params: readonly unknown[]) => {
        queryCount += 1;
        if (_sql.includes("pg_roles")) {
          return { rows: [{ rolsuper: false, rolbypassrls: true }] };
        }
        queryNow = String(params[0]);
        return { rows: [{ tenant_id: TENANT_A }, { tenant_id: TENANT_B }] };
      },
      release: () => { released = true; },
    }),
  };
  const pool = appPool as unknown as Parameters<typeof resolveRunTriggerTenantIds>[0];
  const bypassPool = lifecycleBypassPool as unknown as NonNullable<Parameters<typeof resolveRunTriggerTenantIds>[3]>["lifecycleBypassPool"];
  const discovered = await resolveRunTriggerTenantIds(pool, [], new Date("2026-06-24T01:02:03.000Z"), { lifecycleBypassPool: bypassPool });
  check(
    "empty maintenance tenant list discovers due cron trigger tenants through lifecycle BYPASSRLS",
    discovered.length === 2 &&
      discovered[0] === TENANT_A &&
      discovered[1] === TENANT_B &&
      released &&
      queryNow === "2026-06-24T01:02:03.000Z" &&
      queryCount === 2,
    JSON.stringify({ discovered, released, queryNow, queryCount }),
  );
  const configured = await resolveRunTriggerTenantIds(pool, [TENANT_B], new Date("2026-06-24T01:02:03.000Z"));
  check(
    "configured maintenance tenant list bypasses discovery query",
    configured.length === 1 && configured[0] === TENANT_B && queryCount === 2,
    JSON.stringify({ configured, queryCount }),
  );
}

{
  let threw = false;
  const appPool = {
    connect: async () => {
      throw new Error("app-role pool must not be used for missing run trigger discovery config");
    },
  };
  try {
    await resolveRunTriggerTenantIds(appPool as unknown as Parameters<typeof resolveRunTriggerTenantIds>[0], [], new Date("2026-06-24T01:02:03.000Z"));
  } catch (err) {
    threw = String(err).includes("dedicated BYPASSRLS lifecycle pool");
  }
  check("empty cron trigger tenant discovery fails closed without lifecycle BYPASSRLS pool", threw);
}

{
  let released = false;
  let queryCount = 0;
  let queryNow = "";
  let intervalMs = 0;
  const lifecycleBypassPool = {
    connect: async () => ({
      query: async (sql: string, params: readonly unknown[]) => {
        queryCount += 1;
        if (sql.includes("pg_roles")) {
          return { rows: [{ rolsuper: false, rolbypassrls: true }] };
        }
        queryNow = String(params[0]);
        intervalMs = Number(params[1]);
        return { rows: [{ tenant_id: TENANT_A }, { tenant_id: TENANT_B }] };
      },
      release: () => { released = true; },
    }),
  } as unknown as NonNullable<Parameters<typeof resolveAuditVerifierTenantIds>[2]>["lifecycleBypassPool"];
  const discovered = await resolveAuditVerifierTenantIds([], new Date("2026-06-24T01:02:03.000Z"), { lifecycleBypassPool });
  check(
    "empty audit verifier tenant list discovers due audit tenants through lifecycle BYPASSRLS",
    discovered.length === 2 &&
      discovered[0] === TENANT_A &&
      discovered[1] === TENANT_B &&
      released &&
      queryNow === "2026-06-24T01:02:03.000Z" &&
      intervalMs === AUDIT_VERIFIER_INTERVAL_MS &&
      queryCount === 2,
    JSON.stringify({ discovered, released, queryNow, intervalMs, queryCount }),
  );
  const configured = await resolveAuditVerifierTenantIds([TENANT_B], new Date("2026-06-24T01:02:03.000Z"));
  check(
    "configured audit verifier tenant list bypasses discovery query",
    configured.length === 1 && configured[0] === TENANT_B && queryCount === 2,
    JSON.stringify({ configured, queryCount }),
  );
}

{
  let threw = false;
  try {
    await resolveAuditVerifierTenantIds([], new Date("2026-06-24T01:02:03.000Z"));
  } catch (err) {
    threw = String(err).includes("dedicated BYPASSRLS lifecycle pool");
  }
  check("empty audit verifier tenant discovery fails closed without lifecycle BYPASSRLS pool", threw);
}

{
  let released = false;
  let queryCount = 0;
  let queryNow = "";
  let threshold = 0;
  const appPool = {
    connect: async () => {
      throw new Error("app-role pool must not be used for cross-tenant maintenance discovery");
    },
  };
  const lifecycleBypassPool = {
    connect: async () => ({
      query: async (sql: string, params: readonly unknown[]) => {
        queryCount += 1;
        if (sql.includes("pg_roles")) {
          return { rows: [{ rolsuper: false, rolbypassrls: true }] };
        }
        queryNow = String(params[0]);
        threshold = Number(params[1]);
        return {
          rows: sql.includes("due_tenants")
            ? [{ tenant_id: TENANT_A }, { tenant_id: TENANT_B }]
            : [],
        };
      },
      release: () => { released = true; },
    }),
  };
  const pool = appPool as unknown as Parameters<typeof resolveMaintenanceTenantIds>[0];
  const bypassPool = lifecycleBypassPool as unknown as NonNullable<Parameters<typeof resolveMaintenanceTenantIds>[3]>["lifecycleBypassPool"];
  const discovered = await resolveMaintenanceTenantIds(pool, [], new Date("2026-06-24T01:02:03.000Z"), { lifecycleBypassPool: bypassPool });
  check(
    "empty maintenance tenant list uses lifecycle BYPASSRLS discovery with ops-defaults redaction threshold",
    discovered.length === 2 &&
      discovered[0] === TENANT_A &&
      discovered[1] === TENANT_B &&
      released &&
      queryNow === "2026-06-24T01:02:03.000Z" &&
      threshold === 5 &&
      queryCount === 2,
    JSON.stringify({ discovered, released, queryNow, threshold, queryCount }),
  );
  const configured = await resolveMaintenanceTenantIds(pool, [TENANT_B], new Date("2026-06-24T01:02:03.000Z"));
  check(
    "configured maintenance tenant list bypasses due-work discovery query",
    configured.length === 1 && configured[0] === TENANT_B && queryCount === 2,
    JSON.stringify({ configured, queryCount }),
  );
}

{
  let threw = false;
  const appPool = {
    connect: async () => {
      throw new Error("app-role pool must not be used for missing lifecycle discovery config");
    },
  };
  try {
    await resolveMaintenanceTenantIds(appPool as unknown as Parameters<typeof resolveMaintenanceTenantIds>[0], [], new Date("2026-06-24T01:02:03.000Z"));
  } catch (err) {
    threw = String(err).includes("dedicated BYPASSRLS lifecycle pool");
  }
  check("empty maintenance tenant discovery fails closed without lifecycle BYPASSRLS pool", threw);
}

{
  let released = false;
  let queryCount = 0;
  let queryNow = "";
  const lifecycleBypassPool = {
    connect: async () => ({
      query: async (sql: string, params: readonly unknown[]) => {
        queryCount += 1;
        if (sql.includes("pg_roles")) {
          return { rows: [{ rolsuper: false, rolbypassrls: true }] };
        }
        queryNow = String(params[0]);
        return { rows: [{ tenant_id: TENANT_B }, { tenant_id: TENANT_A }] };
      },
      release: () => { released = true; },
    }),
  } as unknown as NonNullable<Parameters<typeof resolveDailyLifecycleTenantIds>[2]>["lifecycleBypassPool"];
  const discovered = await resolveDailyLifecycleTenantIds([], new Date("2026-06-24T01:02:03.000Z"), { lifecycleBypassPool });
  check(
    "empty daily lifecycle tenant list discovers lifecycle tenants through BYPASSRLS role assertion",
    discovered.length === 2 &&
      discovered[0] === TENANT_B &&
      discovered[1] === TENANT_A &&
      released &&
      queryNow === "2026-06-24T01:02:03.000Z" &&
      queryCount === 2,
    JSON.stringify({ discovered, released, queryNow, queryCount }),
  );
  const configured = await resolveDailyLifecycleTenantIds([TENANT_A], new Date("2026-06-24T01:02:03.000Z"));
  check(
    "configured daily lifecycle tenant list bypasses discovery query",
    configured.length === 1 && configured[0] === TENANT_A && queryCount === 2,
    JSON.stringify({ configured, queryCount }),
  );
}

{
  const jobs: RuntimeWorkerJob[] = [];
  const fakePool = {
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    }),
  };
  const fakeEnqueuer = {
    enqueueRuntimeJob: async (_client: unknown, job: RuntimeWorkerJob) => {
      jobs.push(job);
    },
  };
  let auditSeq = 0;
  await runAuditVerifier(fakePool as never, {
    tenantIds: [TENANT_A, TENANT_B],
    enqueuer: fakeEnqueuer as never,
    correlationId: () => `22000000-0000-4000-8000-${String(++auditSeq).padStart(12, "0")}`,
    now: () => new Date("2026-06-24T01:02:03.000Z"),
  });
  check(
    "audit verifier runner enqueues configured tenant verifier jobs",
    jobs.length === 2 &&
      jobs[0]?.kind === "audit_verifier" &&
      jobs[0]?.tenantId === TENANT_A &&
      jobs[1]?.kind === "audit_verifier" &&
      jobs[1]?.tenantId === TENANT_B,
    JSON.stringify(jobs),
  );
}

{
  const jobs: RuntimeWorkerJob[] = [];
  const fakePool = {
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    }),
  };
  const fakeEnqueuer = {
    enqueueRuntimeJob: async (_client: unknown, job: RuntimeWorkerJob) => {
      jobs.push(job);
    },
  };
  let threw = false;
  try {
    await runDailySweeper(fakePool as never, {
      tenantIds: [],
      enqueuer: fakeEnqueuer as never,
      correlationId: nextCorrelation,
      now: () => new Date("2026-06-24T01:02:03.000Z"),
    });
  } catch (err) {
    threw = String(err).includes("dedicated BYPASSRLS lifecycle pool");
  }
  check(
    "daily sweeper still enqueues global orphan once when tenant discovery is deferred",
    threw &&
      jobs.length === 1 &&
      jobs[0]?.kind === "artifact_orphan" &&
      jobs[0]?.tenantId === undefined,
    JSON.stringify({ threw, jobs }),
  );
}

check(
  "next KST 02:00 from prior minute is one minute",
  millisecondsUntilNextKstHour(new Date("2026-06-18T16:59:00.000Z"), 2) === 60_000,
);
check(
  "next KST 02:00 at exact tick rolls to next day",
  millisecondsUntilNextKstHour(new Date("2026-06-18T17:00:00.000Z"), 2) === 24 * 60 * 60 * 1000,
);

try {
  millisecondsUntilNextKstHour(new Date("2026-06-18T16:59:00.000Z"), 24);
  check("invalid KST hour throws", false, "expected throw");
} catch (err) {
  check("invalid KST hour throws", String(err).includes("0..23"), String(err));
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: maintenance scheduler unit green");
