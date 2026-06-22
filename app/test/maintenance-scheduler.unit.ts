import {
  buildDailySweeperJobs,
  buildIntegritySweeperJobs,
  buildMaintenancePollJobs,
  buildRetentionSweeperJobs,
  millisecondsUntilNextKstHour,
} from "../src/worker/maintenance-scheduler";

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
  "maintenance poll fanout enqueues lease + checkout sweeper + redaction per tenant",
  pollJobs.length === 6 &&
    pollJobs[0]?.kind === "lease_sweeper" &&
    pollJobs[0]?.tenantId === TENANT_A &&
    pollJobs[1]?.kind === "workitem_checkout_sweeper" &&
    pollJobs[1]?.tenantId === TENANT_A &&
    pollJobs[1]?.correlationId === "20000000-0000-4000-8000-000000000001" &&
    pollJobs[2]?.kind === "artifact_redaction" &&
    pollJobs[2]?.tenantId === TENANT_A &&
    pollJobs[2]?.correlationId === "20000000-0000-4000-8000-000000000002" &&
    pollJobs[2]?.runId === undefined &&
    pollJobs[2]?.artifactId === undefined &&
    pollJobs[2]?.generationId === undefined &&
    pollJobs[3]?.kind === "lease_sweeper" &&
    pollJobs[3]?.tenantId === TENANT_B &&
    pollJobs[4]?.kind === "workitem_checkout_sweeper" &&
    pollJobs[4]?.tenantId === TENANT_B &&
    pollJobs[5]?.kind === "artifact_redaction" &&
    pollJobs[5]?.tenantId === TENANT_B &&
    pollJobs[5]?.artifactId === undefined &&
    pollJobs[5]?.generationId === undefined,
  JSON.stringify(pollJobs),
);

// pollJobs 가 4회 correlation()을 소비(테넌트당 checkout_sweeper+redaction) → 다음은 005.
const retentionJobs = buildRetentionSweeperJobs([TENANT_A], nextCorrelation);
check(
  "retention fanout enqueues tenant-scoped artifact retention with correlation",
  retentionJobs.length === 1 &&
    retentionJobs[0]?.kind === "artifact_retention" &&
    retentionJobs[0]?.tenantId === TENANT_A &&
    retentionJobs[0]?.correlationId === "20000000-0000-4000-8000-000000000005",
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

const dailyJobs = buildDailySweeperJobs([TENANT_A, TENANT_B]);
check(
  "daily sweeper batch includes both retention and integrity for every tenant",
  dailyJobs.length === 4 &&
    dailyJobs.filter((j) => j.kind === "artifact_retention").length === 2 &&
    dailyJobs.filter((j) => j.kind === "artifact_integrity").length === 2,
  JSON.stringify(dailyJobs),
);

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
