import {
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
  "maintenance poll fanout enqueues lease sweeper and redaction per tenant",
  pollJobs.length === 4 &&
    pollJobs[0]?.kind === "lease_sweeper" &&
    pollJobs[0]?.tenantId === TENANT_A &&
    pollJobs[1]?.kind === "artifact_redaction" &&
    pollJobs[1]?.tenantId === TENANT_A &&
    pollJobs[1]?.correlationId === "20000000-0000-4000-8000-000000000001" &&
    pollJobs[2]?.kind === "lease_sweeper" &&
    pollJobs[3]?.kind === "artifact_redaction" &&
    pollJobs[3]?.tenantId === TENANT_B,
  JSON.stringify(pollJobs),
);

const retentionJobs = buildRetentionSweeperJobs([TENANT_A], nextCorrelation);
check(
  "retention fanout enqueues tenant-scoped artifact retention with correlation",
  retentionJobs.length === 1 &&
    retentionJobs[0]?.kind === "artifact_retention" &&
    retentionJobs[0]?.tenantId === TENANT_A &&
    retentionJobs[0]?.correlationId === "20000000-0000-4000-8000-000000000003",
  JSON.stringify(retentionJobs),
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
