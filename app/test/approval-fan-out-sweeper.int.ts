/**
 * 통합 — approval_fan_out_sweeper (결재 fan-out 자동 트리거 ②). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/approval-fan-out-sweeper.int.ts
 * 검증: auto_fan_out=true 수집 시나리오의 최근 완료 run → 자동 fan-out(검토 run 스폰+claim), auto_fan_out=false 는 무시,
 *       재-sweep 멱등(claim 있으면 재스폰 없음), reader/enqueuer 미구성 → loud throw(조용한 no-op 금지).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PgRuntimeWorker, type PgRuntimeWorkerOptions } from "../src/worker/runtime-worker";
import { createPool, withTenantTx } from "../src/db/pool";
import type { RuntimeWorkerJob } from "../../ts/runtime-contract";
import type { ObjectRef } from "../../ts/core-types";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_fanout_sweeper_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const CORR = "55000000-0000-4000-8000-000000000099";
// auto_fan_out=true 수집 + 완료 run + artifact.
const AUTO_SCEN = "70000000-0000-0000-0000-0000000000a1";
const AUTO_SVER = "70000000-0000-0000-0000-0000000000a2";
const AUTO_RUN = "70000000-0000-0000-0000-0000000000a3";
const AUTO_ART = "70000000-0000-0000-0000-0000000000a4";
const OBJECT_REF_AUTO = "file://fanout-sweeper/auto-rows" as ObjectRef;
// auto_fan_out=false 수집 + 완료 run + artifact(무시되어야 함).
const OFF_SCEN = "70000000-0000-0000-0000-0000000000b1";
const OFF_SVER = "70000000-0000-0000-0000-0000000000b2";
const OFF_RUN = "70000000-0000-0000-0000-0000000000b3";
const OFF_ART = "70000000-0000-0000-0000-0000000000b4";
const OBJECT_REF_OFF = "file://fanout-sweeper/off-rows" as ObjectRef;
// REVIEW 시나리오(prod).
const REVIEW_SCEN = "70000000-0000-0000-0000-0000000000c1";
const REVIEW_SVER = "70000000-0000-0000-0000-0000000000c2";

const DOC_A = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/990001";
const DOC_B = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/990002";
const DOC_OFF = "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/990003";

const rowsJson = (docs: string[]): string =>
  JSON.stringify({
    rows: docs.map((d, i) => ({ doc_ref: d, approval_id: `IB-SWEEP-${i}`, title: `문서 ${i}`, drafter: "김기안", doc_type: "결재", status: "대기" })),
  });
const ROWS_AUTO = rowsJson([DOC_A, DOC_B]);
const ROWS_OFF = rowsJson([DOC_OFF]);

const TARGET_IR = `{"target":{"site_profile_id":"00000000-0000-4000-8000-0000000000a1","browser_identity_id":"00000000-0000-4000-8000-0000000000a2","network_policy_id":"00000000-0000-4000-8000-0000000000a3"}}`;

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof createPool>;

async function seed(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    // auto_fan_out=true 수집 시나리오 + 최근 완료 run + artifact.
    await c.query(`INSERT INTO scenarios (id, tenant_id, name, auto_fan_out) VALUES ($1,$2,'하이웍스 결재 수집(auto)',true)`, [AUTO_SCEN, TENANT]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod',$4::jsonb)`, [AUTO_SVER, TENANT, AUTO_SCEN, TARGET_IR]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status, ended_at) VALUES ($1,$2,$3,$4,'completed',now())`, [AUTO_RUN, TENANT, AUTO_SVER, AUTO_RUN]);
    await c.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, type, media_type, object_ref, redaction_status, retention_until)
       VALUES ($1,$2,$3,'approval_inbox','application/json; charset=utf-8',$4,'redacted','2099-12-31T00:00:00Z')`,
      [AUTO_ART, TENANT, AUTO_RUN, OBJECT_REF_AUTO],
    );
    // auto_fan_out=false 수집(스위퍼 무시 대상).
    await c.query(`INSERT INTO scenarios (id, tenant_id, name, auto_fan_out) VALUES ($1,$2,'하이웍스 결재 수집(off)',false)`, [OFF_SCEN, TENANT]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod',$4::jsonb)`, [OFF_SVER, TENANT, OFF_SCEN, TARGET_IR]);
    await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, correlation_id, status, ended_at) VALUES ($1,$2,$3,$4,'completed',now())`, [OFF_RUN, TENANT, OFF_SVER, OFF_RUN]);
    await c.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, type, media_type, object_ref, redaction_status, retention_until)
       VALUES ($1,$2,$3,'approval_inbox','application/json; charset=utf-8',$4,'redacted','2099-12-31T00:00:00Z')`,
      [OFF_ART, TENANT, OFF_RUN, OBJECT_REF_OFF],
    );
    // REVIEW 시나리오(prod) — fan-out 이 스폰하는 검토 run.
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 검토·승인')`, [REVIEW_SCEN, TENANT]);
    await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod',$4::jsonb)`, [REVIEW_SVER, TENANT, REVIEW_SCEN, TARGET_IR]);
  });
}

async function counts(pool: Pool, sourceRunId: string): Promise<{ claims: number; spawned: number }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const cl = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_row_claims WHERE source_run_id=$1::uuid`, [sourceRunId]);
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM runs WHERE scenario_version_id=$1::uuid`, [REVIEW_SVER]);
    return { claims: Number(cl.rows[0]!.n), spawned: Number(r.rows[0]!.n) };
  });
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
    } finally {
      setup.release();
    }
    await seed(pool);

    const enqueued: RuntimeWorkerJob[] = [];
    const artifactReader = {
      async get(ref: ObjectRef): Promise<string | null> {
        return ref === OBJECT_REF_AUTO ? ROWS_AUTO : ref === OBJECT_REF_OFF ? ROWS_OFF : null;
      },
      async getBytes(): Promise<Uint8Array | null> {
        return null;
      },
    };
    const options: PgRuntimeWorkerOptions = {
      runtimeJobEnqueuer: {
        async enqueueRuntimeJob(_client, job) {
          enqueued.push(job);
        },
      },
      approvalFanOutArtifactReader: artifactReader,
    };
    const worker = new PgRuntimeWorker(pool, options);

    // 0) 오프보딩 잠금(O3): approved 원장이 있으면 auto_fan_out 후보에서 제외(신규 활동 금지) — 취소 후 재개(step 1).
    const OFFBOARDING_ID = "88000000-0000-4000-8000-000000000001";
    await withTenantTx(pool, TENANT, (c) => c.query(
      `INSERT INTO tenant_offboarding_requests (id, tenant_id, status, reason, requested_by, decided_by, decided_at, purge_after)
       VALUES ($1::uuid, $2::uuid, 'approved', 'lock test', 'admin-1', 'admin-2', now(), now() + interval '7 days')`,
      [OFFBOARDING_ID, TENANT],
    ));
    const r0 = await worker.handle({
      kind: "approval_fan_out_sweeper",
      tenantId: TENANT as RuntimeWorkerJob["tenantId"],
      correlationId: CORR as RuntimeWorkerJob["correlationId"],
    });
    check("오프보딩 잠금: sweep completed(에러 아님)", r0.kind === "completed", JSON.stringify(r0));
    const auto0 = await counts(pool, AUTO_RUN);
    check("오프보딩 잠금: auto run fan-out 제외(claim/스폰 0)", auto0.claims === 0 && auto0.spawned === 0, JSON.stringify(auto0));
    check("오프보딩 잠금: run_claim enqueue 0", enqueued.length === 0, `enqueued=${enqueued.length}`);
    await withTenantTx(pool, TENANT, (c) => c.query(
      `UPDATE tenant_offboarding_requests SET status = 'cancelled', updated_at = now() WHERE id = $1::uuid`,
      [OFFBOARDING_ID],
    ));

    // 1) sweep → auto_fan_out run 만 fan-out.
    const r1 = await worker.handle({
      kind: "approval_fan_out_sweeper",
      tenantId: TENANT as RuntimeWorkerJob["tenantId"],
      correlationId: CORR as RuntimeWorkerJob["correlationId"],
    });
    check("sweeper completed", r1.kind === "completed", JSON.stringify(r1));
    const auto1 = await counts(pool, AUTO_RUN);
    check("auto run: claim 2 + REVIEW run 2 스폰", auto1.claims === 2 && auto1.spawned === 2, JSON.stringify(auto1));
    const off1 = await withTenantTx(pool, TENANT, (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_row_claims WHERE source_run_id=$1::uuid`, [OFF_RUN]));
    check("off(auto_fan_out=false) run: fan-out 안 됨(claim 0)", Number(off1.rows[0]!.n) === 0, JSON.stringify(off1.rows));
    check("run_claim enqueue 2회(스폰된 검토 run)", enqueued.filter((j) => j.kind === "run_claim").length === 2, `enqueued=${enqueued.length}`);

    // 2) 재-sweep 멱등 → 재스폰 없음(claim 있으면 NOT EXISTS 로 대상서 제외).
    const before = enqueued.length;
    const r2 = await worker.handle({
      kind: "approval_fan_out_sweeper",
      tenantId: TENANT as RuntimeWorkerJob["tenantId"],
      correlationId: CORR as RuntimeWorkerJob["correlationId"],
    });
    check("재-sweep completed", r2.kind === "completed", JSON.stringify(r2));
    const auto2 = await counts(pool, AUTO_RUN);
    check("재-sweep: claim/스폰 증가 없음(2/2)", auto2.claims === 2 && auto2.spawned === 2, JSON.stringify(auto2));
    check("재-sweep: run_claim 추가 enqueue 없음", enqueued.length === before, `enqueued=${enqueued.length} before=${before}`);

    // 3) reader/enqueuer 미구성 → loud throw(조용한 no-op 금지).
    const misconfigured = new PgRuntimeWorker(pool, {});
    let threw = false;
    try {
      await misconfigured.handle({
        kind: "approval_fan_out_sweeper",
        tenantId: TENANT as RuntimeWorkerJob["tenantId"],
        correlationId: CORR as RuntimeWorkerJob["correlationId"],
      });
    } catch {
      threw = true;
    }
    check("미구성 sweeper → throw(loud)", threw);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: approval_fan_out_sweeper integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
