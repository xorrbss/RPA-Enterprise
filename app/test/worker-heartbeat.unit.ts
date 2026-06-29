import { startWorkerHeartbeat, upsertWorkerHeartbeat } from "../src/main-worker";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
  }
}

const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
const pool = {
  query: async (sql: string, params: readonly unknown[]) => {
    calls.push({ sql, params });
    return { rows: [] };
  },
};

const workerId = "10000000-0000-4000-8000-0000000000aa";

await upsertWorkerHeartbeat(pool as unknown as Parameters<typeof upsertWorkerHeartbeat>[0], {
  workerId,
  kind: "browser",
});

check("upsert writes browser worker id", calls[0]?.params[0] === workerId, JSON.stringify(calls[0]));
check("upsert writes worker kind", calls[0]?.params[1] === "browser", JSON.stringify(calls[0]));
check("upsert revives only dead workers and preserves draining", calls[0]?.sql.includes("WHEN workers.status = 'dead'"), calls[0]?.sql);
check("upsert uses conflict-safe registration", calls[0]?.sql.includes("ON CONFLICT (id) DO UPDATE"), calls[0]?.sql);

const heartbeat = await startWorkerHeartbeat(pool as unknown as Parameters<typeof startWorkerHeartbeat>[0], {
  workerId,
  kind: "sweeper",
  intervalMs: 10,
});
heartbeat.stop();

check("startWorkerHeartbeat performs initial registration", calls[1]?.params[1] === "sweeper", JSON.stringify(calls[1]));

try {
  await startWorkerHeartbeat(pool as unknown as Parameters<typeof startWorkerHeartbeat>[0], {
    workerId,
    kind: "browser",
    intervalMs: 0,
  });
  check("invalid interval throws", false, "expected throw");
} catch (err) {
  check("invalid interval throws", String(err).includes("positive integer"), String(err));
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: worker heartbeat unit green");
