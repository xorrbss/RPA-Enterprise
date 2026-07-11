/**
 * 실 graphile 스키마 + 실 PgGraphileRunEnqueuer 로 add_job flags 경로를 검증한다.
 *
 * 기존 int 테스트는 enqueueRuntimeJob 을 전부 fake 로 대체해, 실제로 graphile 에 무엇이 저장되는지 아무도 보지
 * 않았다. 큐 깊이(api/ops-health.ts readQueueDepth)가 `tenant:<uuid>` flag 에만 의존하므로 그 flag 의 생성은
 * 실 DB 로 못 박아야 한다. 특히 tenantId 없는 유지보수 잡(lease_sweeper 등)은 flags=[] 로 인큐되는데,
 * 빈 배열이 add_job 에서 깨지면 스위퍼 전체가 죽는다.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/graphile-enqueue-flags.int.ts
 */
import { createPool, withTenantTx } from "../src/db/pool";
import { PgGraphileRunEnqueuer } from "../src/runtime/run-queue";
import { installGraphileSchema } from "./graphile-schema";

const TENANT = "00000000-0000-4000-8000-0000000000f1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS graphile_worker CASCADE`);
    } finally {
      setup.release();
    }
    await installGraphileSchema();

    const enqueuer = new PgGraphileRunEnqueuer();

    // 1) 테넌트 있는 잡: tenant flag 가 붙어 큐 깊이에 잡힌다.
    await withTenantTx(pool, TENANT, async (client) => {
      await enqueuer.enqueueRuntimeJob(client, {
        kind: "outbox_relay",
        tenantId: TENANT as never,
        correlationId: "00000000-0000-4000-8000-0000000000f2" as never,
      });
    });

    // 2) 테넌트 없는 유지보수 잡: flags=[] 로 인큐된다(빈 배열이 add_job 을 깨지 않아야 한다).
    await withTenantTx(pool, TENANT, async (client) => {
      await enqueuer.enqueueRuntimeJob(client, { kind: "lease_sweeper" });
    });

    // 3) 지연 인큐(delayMs) 경로도 같은 flags 인자를 쓴다.
    await withTenantTx(pool, TENANT, async (client) => {
      await enqueuer.enqueueRuntimeJob(
        client,
        { kind: "ops_notification_send", tenantId: TENANT as never, opsNotification: { attemptId: "a1" } },
        5_000,
      );
    });

    const read = await pool.connect();
    try {
      const total = await read.query<{ n: number }>(`SELECT count(*)::int AS n FROM graphile_worker.jobs`);
      check("세 잡 모두 인큐됨(빈 flags 가 add_job 을 깨지 않음)", total.rows[0]?.n === 3, JSON.stringify(total.rows[0]));

      const tenantScoped = await read.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE flags ? $1`,
        [`tenant:${TENANT}`],
      );
      check("테넌트 잡 2건에만 tenant flag", tenantScoped.rows[0]?.n === 2, JSON.stringify(tenantScoped.rows[0]));

      // 미잠금 대기 수 = readQueueDepth 와 동일 질의.
      const pending = await read.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE locked_at IS NULL AND flags ? $1`,
        [`tenant:${TENANT}`],
      );
      check("readQueueDepth 질의가 테넌트 대기 2건을 센다", pending.rows[0]?.n === 2, JSON.stringify(pending.rows[0]));
    } finally {
      read.release();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} graphile enqueue flag check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: graphile enqueue flags (tenant flag 생성 · 빈 flags 안전) green");
}

main().catch((err: unknown) => {
  console.error("FAIL: graphile enqueue flags verification threw:", err);
  process.exit(1);
});
