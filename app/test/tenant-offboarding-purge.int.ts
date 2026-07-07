/**
 * 통합 — tenant_offboarding_purge (오프보딩 hard 삭제, 설계 O4). 실 PostgreSQL + BYPASSRLS lifecycle role.
 *
 * 핵심 게이트(설계 §7): 2-테넌트 시드 → grace 경과(과거 purge_after 시드) → purge →
 *   대상 테넌트 행 0 / 타 테넌트 불변 / legal_hold artifact 잔존(+FK 부모 스파인) + held_rows 보고 /
 *   audit_log 불변(WORM — 기존 행 잔존, purge 감사는 append) / object store 본문 삭제(held 제외) /
 *   원장 purged 증빙 / per-tick cap deferred 재개(멱등) / 미만기·purged 재실행 no-op.
 * + 레지스트리 CI 잠금: 정보스키마 tenant 테이블 == 레지스트리∪제외, FK(child→parent) 순서 불변식
 *   (유일 예외 = connector 상호 FK 사이클, NULL-out 프리스텝으로 절단).
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/tenant-offboarding-purge.int.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";
import { RUNTIME_LIFECYCLE_JOB_TASK, runtimeJobTaskIdentifier } from "../src/runtime/runtime-job-routing";
import { resolveDueOffboardingPurgeTenantIds } from "../src/worker/maintenance-scheduler";
import {
  TENANT_PURGE_EXCLUDED_TABLES,
  TENANT_PURGE_TABLE_ORDER,
} from "../src/worker/tenant-offboarding-purge";
import {
  ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
  type ArtifactObjectIoPortBinding,
  type ArtifactRetentionStore,
  type RuntimeWorkerJob,
} from "../../ts/runtime-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_offboarding_purge_sweeper_int";
const BYPASS_ROLE = "rpa_obd_purge_bypass";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const TENANT_FUTURE = "00000000-0000-4000-8000-0000000000c3";
const WORKER = "90000000-0000-4000-8000-000000000001";
const CORR = "91000000-0000-4000-8000-000000000001";

const A = {
  scen: "10000000-0000-4000-8000-0000000000a1",
  sver: "11000000-0000-4000-8000-0000000000a1",
  workitem: "1f000000-0000-4000-8000-0000000000a1",
  runPlain: "12000000-0000-4000-8000-0000000000a1",
  runHeld: "12000000-0000-4000-8000-0000000000a2",
  task: "13000000-0000-4000-8000-0000000000a1",
  artPlain: "14000000-0000-4000-8000-0000000000a1",
  artHeld: "14000000-0000-4000-8000-0000000000a2",
  site: "15000000-0000-4000-8000-0000000000a1",
  identity: "16000000-0000-4000-8000-0000000000a1",
  trigger: "17000000-0000-4000-8000-0000000000a1",
  fire: "18000000-0000-4000-8000-0000000000a1",
  ledger: "19000000-0000-4000-8000-0000000000a1",
} as const;

const B = {
  scen: "20000000-0000-4000-8000-0000000000b1",
  sver: "21000000-0000-4000-8000-0000000000b1",
  run: "22000000-0000-4000-8000-0000000000b1",
  task: "23000000-0000-4000-8000-0000000000b1",
  art: "24000000-0000-4000-8000-0000000000b1",
} as const;

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const localTestPortBinding = {
  kind: "test_fake",
  backendAlias: "local-test-fake",
  evidenceSchemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
  testOnly: true,
} as const satisfies ArtifactObjectIoPortBinding;

type Pool = ReturnType<typeof createPool>;

async function seedTenantA(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'purge-a')`, [A.scen, TENANT_A]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
      [A.sver, TENANT_A, A.scen],
    );
    await c.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status)
       VALUES ($1,$2,'seed-connector','purge-a-1','processing')`,
      [A.workitem, TENANT_A],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, params, correlation_id, attempts)
       VALUES ($1,$2,$3,$4,'completed','{"k":"plain"}'::jsonb,$1,1),
              ($5,$2,$3,NULL,'completed','{"k":"held"}'::jsonb,$5,1)`,
      [A.runPlain, TENANT_A, A.sver, A.workitem, A.runHeld],
    );
    await c.query(
      `INSERT INTO run_steps (id, tenant_id, run_id, step_id, node_id, attempt, action, status, cache_mode)
       VALUES ($1,$2,$3,'s1','s1',0,'extract','success','bypass')`,
      [randomUUID(), TENANT_A, A.runPlain],
    );
    await c.query(
      `INSERT INTO stagehand_calls (id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model)
       VALUES ($1,$2,$3,'s1',0,'purge-a-call-1','hash-1','gpt-test')`,
      [randomUUID(), TENANT_A, A.runPlain],
    );
    await c.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, payload)
       VALUES ($1,$2,$3,'validation','resolved','{"secret":"purge-me"}'::jsonb)`,
      [A.task, TENANT_A, A.runPlain],
    );
    await c.query(
      `INSERT INTO events_outbox (event_id, event_type, event_version, tenant_id, run_id, correlation_id, occurred_at, idempotency_key, payload_schema_ref, payload, retention_until)
       VALUES ($1,'run.completed',1,$2,$3,$4,now(),'purge-a-evt-1','events/run.completed@1','{}'::jsonb, now() + interval '90 days')`,
      [randomUUID(), TENANT_A, A.runPlain, randomUUID()],
    );
    await c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk)
       VALUES ($1,$2,'purge-site','https://purge.example.com/*','green')`,
      [A.site, TENANT_A],
    );
    await c.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES ($1,$2,$3,'purge-identity')`,
      [A.identity, TENANT_A, A.site],
    );
    await c.query(
      `INSERT INTO browser_sessions (tenant_id, site_profile_id, browser_identity_id, identity_key, ciphertext, enc_kid)
       VALUES ($1,$2,$3,'', decode('deadbeef','hex'), 'kid-1')`,
      [TENANT_A, A.site, A.identity],
    );
    await c.query(
      `INSERT INTO run_triggers (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params, catchup_policy, max_concurrent_runs, next_fire_at, created_by)
       VALUES ($1,$2,$3,'enabled','0 8 * * *','Asia/Seoul','{}'::jsonb,'skip_missed',1,'2026-07-01T08:00:00Z','seed')`,
      [A.trigger, TENANT_A, A.sver],
    );
    await c.query(
      `INSERT INTO run_trigger_fires (id, tenant_id, trigger_id, fire_key, status, scheduled_for, correlation_id)
       VALUES ($1,$2,$3,'2026-07-01T08:00:00.000Z','queued','2026-07-01T08:00:00Z',$4)`,
      [A.fire, TENANT_A, A.trigger, randomUUID()],
    );
    // artifacts: plain(객체 삭제 대상) + legal_hold(잔존 — runHeld 를 FK 로 물고 있어 hold 스파인 재현).
    await c.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, type, redaction_status, sha256, object_ref, retention_until, legal_hold)
       VALUES ($1,$2,$3,'screenshot','redacted','sha-plain','obj://plain','2099-01-01T00:00:00Z',false),
              ($4,$2,$5,'screenshot','redacted','sha-held','obj://held','2099-01-01T00:00:00Z',true)`,
      [A.artPlain, TENANT_A, A.runPlain, A.artHeld, A.runHeld],
    );
    // WORM 증거(audit_log) — purge 가 지우지 않아야 한다. 더미 체인(검증자 미대상, 잔존만 단언).
    await c.query(
      `INSERT INTO audit_log (id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id, idempotency_key, occurred_at, payload_schema_ref, payload, retention_until, previous_hash, hash)
       VALUES ($1,$2,1,'{"kind":"system"}'::jsonb,'artifact.read','allow','seed-1',$3,'seed-audit-1',now(),'audit/security-boundary-decision@1','{}'::jsonb,now() + interval '90 days',NULL,'seed-hash-1'),
              ($4,$2,2,'{"kind":"system"}'::jsonb,'artifact.read','allow','seed-2',$5,'seed-audit-2',now(),'audit/security-boundary-decision@1','{}'::jsonb,now() + interval '90 days','seed-hash-1','seed-hash-2')`,
      [randomUUID(), TENANT_A, randomUUID(), randomUUID(), randomUUID()],
    );
    // 만기 원장(승인 + grace 경과 — sim-clock: 과거 purge_after 직접 시드).
    await c.query(
      `INSERT INTO tenant_offboarding_requests (id, tenant_id, status, reason, requested_by, decided_by, decided_at, purge_after)
       VALUES ($1,$2,'approved','계약 종료','admin-1','admin-2', now() - interval '8 days', now() - interval '1 hour')`,
      [A.ledger, TENANT_A],
    );
  });
}

async function seedTenantB(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_B, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'keep-b')`, [B.scen, TENANT_B]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
      [B.sver, TENANT_B, B.scen],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, correlation_id, attempts)
       VALUES ($1,$2,$3,'completed','{"k":"b"}'::jsonb,$1,1)`,
      [B.run, TENANT_B, B.sver],
    );
    await c.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, payload)
       VALUES ($1,$2,$3,'validation','open','{"keep":"b"}'::jsonb)`,
      [B.task, TENANT_B, B.run],
    );
    await c.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, type, redaction_status, sha256, object_ref, retention_until, legal_hold)
       VALUES ($1,$2,$3,'screenshot','redacted','sha-b','obj://b','2099-01-01T00:00:00Z',false)`,
      [B.art, TENANT_B, B.run],
    );
  });
}

async function tenantRowCount(pool: Pool, tenant: string, table: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1::uuid`, [tenant]);
    return r.rows[0]?.n ?? -1;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  let bypassPool: Pool | undefined;
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
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`, [WORKER]);
    } finally {
      setup.release();
    }

    // ===== 레지스트리 CI 잠금: 정보스키마 대조 + FK 순서 불변식 =====
    const tenantTablesRes = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = 'tenant_id'
        GROUP BY table_name ORDER BY table_name`,
      [SCHEMA],
    );
    const actualTables = new Set(tenantTablesRes.rows.map((r) => r.table_name));
    const registrySet = new Set([...TENANT_PURGE_TABLE_ORDER, ...TENANT_PURGE_EXCLUDED_TABLES]);
    const missingFromRegistry = [...actualTables].filter((t) => !registrySet.has(t));
    const staleInRegistry = [...registrySet].filter((t) => !actualTables.has(t));
    check(
      "레지스트리 = 전체 tenant 테이블(정보스키마 대조 — 신규 테이블 누락 시 CI 실패)",
      missingFromRegistry.length === 0 && staleInRegistry.length === 0,
      `missing=${JSON.stringify(missingFromRegistry)} stale=${JSON.stringify(staleInRegistry)}`,
    );
    const fkRes = await pool.query<{ child: string; parent: string }>(
      `SELECT tc.table_name AS child, ccu.table_name AS parent
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
        GROUP BY tc.table_name, ccu.table_name`,
      [SCHEMA],
    );
    const orderIndex = new Map(TENANT_PURGE_TABLE_ORDER.map((t, i) => [t, i]));
    const violations = fkRes.rows
      .filter((e) => e.child !== e.parent && orderIndex.has(e.child) && orderIndex.has(e.parent))
      .filter((e) => (orderIndex.get(e.child) ?? 0) > (orderIndex.get(e.parent) ?? 0))
      .map((e) => `${e.child}->${e.parent}`);
    check(
      "FK children-first 순서 불변식(유일 예외 = connector 상호 FK 사이클)",
      violations.length === 1 && violations[0] === "connector_profiles->connector_certifications",
      JSON.stringify(violations),
    );
    check(
      "잡 라우팅: tenant_offboarding_purge 는 BYPASSRLS lifecycle task",
      runtimeJobTaskIdentifier({ kind: "tenant_offboarding_purge" }) === RUNTIME_LIFECYCLE_JOB_TASK,
    );

    await seedTenantA(pool);
    await seedTenantB(pool);
    // 미만기 테넌트(승인됐지만 grace 미경과) — no-op 검증용.
    await withTenantTx(pool, TENANT_FUTURE, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'keep-c')`, [randomUUID(), TENANT_FUTURE]);
      await c.query(
        `INSERT INTO tenant_offboarding_requests (id, tenant_id, status, reason, requested_by, decided_by, decided_at, purge_after)
         VALUES ($1,$2,'approved','미만기','admin-1','admin-2', now(), now() + interval '7 days')`,
        [randomUUID(), TENANT_FUTURE],
      );
    });

    const bTablesSnapshot: Record<string, number> = {};
    for (const table of ["scenarios", "scenario_versions", "runs", "human_tasks", "artifacts"]) {
      bTablesSnapshot[table] = await tenantRowCount(pool, TENANT_B, table);
    }

    // ===== 스케줄러 due 집합(구성 목록 + BYPASSRLS 발견 둘 다) =====
    const dueConfigured = await resolveDueOffboardingPurgeTenantIds(pool, [TENANT_A, TENANT_B, TENANT_FUTURE], new Date());
    check("scheduler due(구성 목록): 만기 A 만", dueConfigured.length === 1 && dueConfigured[0] === TENANT_A, JSON.stringify(dueConfigured));

    // ===== BYPASSRLS role 준비 =====
    const admin = new pg.Pool({
      host: process.env.PGHOST,
      port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: "postgres",
      password: process.env.PGADMIN_PASSWORD,
      options: `-c search_path=${SCHEMA},public`,
    });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${BYPASS_ROLE}`);
      await admin.query(
        `CREATE ROLE ${BYPASS_ROLE} LOGIN PASSWORD '${BYPASS_ROLE}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${BYPASS_ROLE}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${BYPASS_ROLE}`);
    } finally {
      await admin.end();
    }
    bypassPool = createPool({
      host: process.env.PGHOST,
      port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: BYPASS_ROLE,
      password: BYPASS_ROLE,
      options: `-c search_path=${SCHEMA},public`,
    });

    const dueDiscovered = await resolveDueOffboardingPurgeTenantIds(pool, [], new Date(), { lifecycleBypassPool: bypassPool });
    check("scheduler due(BYPASSRLS 발견): 만기 A 만", dueDiscovered.length === 1 && dueDiscovered[0] === TENANT_A, JSON.stringify(dueDiscovered));

    // ===== 비-BYPASSRLS(superuser) 거부 — 파괴 작업은 전용 운영 role 로만 =====
    const deleteCalls: string[] = [];
    const retentionStore: ArtifactRetentionStore = {
      binding: localTestPortBinding,
      deleteObject: async (input) => {
        deleteCalls.push(String(input.artifact.artifactRef));
        return {
          kind: "deleted",
          evidence: {
            schemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
            portKind: "test_fake",
            backendAlias: "local-test-fake",
            operation: "delete",
            artifactRef: input.artifact.artifactRef,
            correlationId: input.correlationId,
            receiptId: `receipt-${String(input.artifact.artifactRef)}`,
            objectRefInternalOnly: true,
            mayBeUsedAsStagingEvidence: false,
          },
        };
      },
    };
    const job: RuntimeWorkerJob = {
      kind: "tenant_offboarding_purge",
      tenantId: TENANT_A as RuntimeWorkerJob["tenantId"],
      correlationId: CORR as RuntimeWorkerJob["correlationId"],
    };
    let superuserRejected = false;
    try {
      await new PgRuntimeWorker(pool, {
        workerId: WORKER,
        artifactRetentionStore: retentionStore,
        allowTestArtifactLifecyclePorts: true,
      }).handle(job);
    } catch (err) {
      superuserRejected = String(err).includes("BYPASSRLS");
    }
    check("superuser/application role 거부(전용 BYPASSRLS 운영 role 강제)", superuserRejected);

    // ===== purge 실행(작은 cap → deferred 재개로 멱등 배치 증명) =====
    const worker = new PgRuntimeWorker(bypassPool, {
      workerId: WORKER,
      artifactRetentionStore: retentionStore,
      allowTestArtifactLifecyclePorts: true,
      offboardingPurgeRowCapPerTick: 7,
      offboardingPurgeArtifactCapPerTick: 5,
    });
    let deferredCount = 0;
    let rounds = 0;
    for (;;) {
      rounds += 1;
      if (rounds > 200) throw new Error("purge did not converge in 200 rounds");
      const result = await worker.handle(job);
      if (result.kind === "completed") break;
      if (result.kind === "deferred") {
        deferredCount += 1;
        continue;
      }
      throw new Error(`purge failed: ${JSON.stringify(result)}`);
    }
    check("per-tick cap: deferred 재개로 배치 연속(1회 이상 발생)", deferredCount >= 1, `deferred=${deferredCount} rounds=${rounds}`);

    // ===== 결과: 대상 테넌트 0행(held 스파인 제외) =====
    const expectedHeld: Record<string, number> = { artifacts: 1, runs: 1, scenario_versions: 1, scenarios: 1 };
    let strayRows = "";
    for (const table of TENANT_PURGE_TABLE_ORDER) {
      const n = await tenantRowCount(pool, TENANT_A, table);
      const expected = expectedHeld[table] ?? 0;
      if (n !== expected) strayRows += `${table}=${n}(want ${expected}) `;
    }
    check("테넌트 A: 전 레지스트리 테이블 0행(legal_hold 스파인 4행 제외)", strayRows === "", strayRows);
    const heldArtifact = await withTenantTx(pool, TENANT_A, async (c) => {
      const r = await c.query<{ id: string; legal_hold: boolean }>(`SELECT id, legal_hold FROM artifacts WHERE tenant_id=$1::uuid`, [TENANT_A]);
      return r.rows;
    });
    check("잔존 artifact = legal_hold 행 그 자체", heldArtifact.length === 1 && heldArtifact[0]?.id === A.artHeld && heldArtifact[0]?.legal_hold === true, JSON.stringify(heldArtifact));

    // object 삭제: plain 만 — held object 는 삭제 호출 자체가 없어야 한다.
    check("object store: plain artifact 만 삭제(held 미호출)", deleteCalls.includes(A.artPlain) && !deleteCalls.includes(A.artHeld), JSON.stringify(deleteCalls));

    // 타 테넌트 불변.
    let bChanged = "";
    for (const [table, before] of Object.entries(bTablesSnapshot)) {
      const after = await tenantRowCount(pool, TENANT_B, table);
      if (after !== before) bChanged += `${table}:${before}->${after} `;
    }
    check("테넌트 B 불변", bChanged === "", bChanged);

    // WORM: 기존 audit 행 잔존 + purge 감사 append 존재.
    const auditRows = await withTenantTx(pool, TENANT_A, async (c) => {
      const r = await c.query<{ reason: string }>(`SELECT reason FROM audit_log WHERE tenant_id=$1::uuid ORDER BY sequence_no`, [TENANT_A]);
      return r.rows.map((row) => row.reason);
    });
    check(
      "audit_log 불변(WORM) + purge 완료 감사 append",
      auditRows.includes("seed-1") && auditRows.includes("seed-2") && auditRows.includes("tenant_offboarding.purge.completed"),
      JSON.stringify(auditRows.slice(0, 10)),
    );

    // 원장 증빙: purged + purged_at + held_rows.
    const ledger = await withTenantTx(pool, TENANT_A, async (c) => {
      const r = await c.query<{ status: string; purged_at: Date | null; held_rows: Record<string, number> }>(
        `SELECT status, purged_at, held_rows FROM tenant_offboarding_requests WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [TENANT_A, A.ledger],
      );
      return r.rows[0];
    });
    check(
      "원장 purged + purged_at + held_rows 보고",
      ledger?.status === "purged" && ledger.purged_at !== null
        && JSON.stringify(Object.fromEntries(Object.entries(ledger.held_rows).sort())) === JSON.stringify(expectedHeld),
      JSON.stringify(ledger),
    );

    // 재실행 = no-op(purged 원장은 claim 안 됨) — 멱등.
    const rerun = await worker.handle(job);
    const auditCountAfter = auditRows.length;
    const auditCountRerun = await withTenantTx(pool, TENANT_A, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1::uuid`, [TENANT_A]);
      return r.rows[0]?.n ?? -1;
    });
    check("purged 후 재실행 no-op(원장/감사 불변)", rerun.kind === "completed" && auditCountRerun === auditCountAfter, `${rerun.kind} audit=${auditCountRerun}/${auditCountAfter}`);

    // 미만기 테넌트 no-op: 데이터·원장 그대로.
    const futureJob: RuntimeWorkerJob = {
      kind: "tenant_offboarding_purge",
      tenantId: TENANT_FUTURE as RuntimeWorkerJob["tenantId"],
      correlationId: CORR as RuntimeWorkerJob["correlationId"],
    };
    const futureResult = await worker.handle(futureJob);
    const futureScenarios = await tenantRowCount(pool, TENANT_FUTURE, "scenarios");
    const futureLedger = await withTenantTx(pool, TENANT_FUTURE, async (c) => {
      const r = await c.query<{ status: string }>(`SELECT status FROM tenant_offboarding_requests WHERE tenant_id=$1::uuid`, [TENANT_FUTURE]);
      return r.rows[0]?.status;
    });
    check(
      "미만기(approved, grace 미경과) no-op — 데이터/원장 불변",
      futureResult.kind === "completed" && futureScenarios === 1 && futureLedger === "approved",
      `${futureResult.kind} scenarios=${futureScenarios} ledger=${futureLedger}`,
    );
  } finally {
    if (bypassPool !== undefined) await bypassPool.end();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: tenant offboarding purge integration green");
}

main().catch((err) => {
  console.error("FAIL: tenant offboarding purge int threw:", err);
  process.exit(1);
});
