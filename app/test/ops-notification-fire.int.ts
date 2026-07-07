/**
 * Integration test for S4a/S4b ops-alert auto-fire producer (runOpsNotificationFire).
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/ops-notification-fire.int.ts
 *
 * 검증: (1) 정체된 run 의 run_sla 알림이 매칭 라우트로 pending attempt + 발송 잡 인큐로 발화된다,
 *      (2) 같은 세대는 두 번째 틱에서 재발화되지 않는다(멱등), (3) min_severity 필터,
 *      (4) 라우트 없음 no-op, (5) 라우트 있는데 대상 테넌트 없음 → 휴면 loud 경고,
 *      (6) S4b 테넌트 저장형 라우트(ops_alert_notification_routes)가 env 라우트 없이도 발화된다
 *          (disabled/soft-deleted 는 제외), (7) 저장형 라우트 테넌트가 maintenance 테넌트 발견에 포함된다,
 *      (8) session_expiry 소스가 attempt 파이프라인(source/subject_type CHECK 포함)으로 발화된다.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PoolClient } from "pg";

import type { OpsNotificationSendEnqueueInput } from "../src/api/run-queue";
import { createPool, withTenantTx } from "../src/db/pool";
import { runOpsNotificationFire, type OpsNotificationFireEnqueuer } from "../src/worker/ops-notification-fire";
import { resolveMaintenanceTenantIds } from "../src/worker/maintenance-scheduler";
import type { OpsAlertRoute } from "../src/api/ops-alert-routes";
import {
  insertOpsNotificationAttempt,
  type ComputedOpsAlert,
  type OpsNotificationWebhookSendInput,
} from "../src/api/ops-alerts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_ops_fire_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const SCEN_A = "9a000000-0000-4000-8000-000000000001";
const SVER_A = "9a000000-0000-4000-8000-000000000002";
const RUN_STUCK = "9a100000-0000-4000-8000-000000000001";
const SITE_A = "9a200000-0000-4000-8000-000000000001";
const IDENTITY_A = "9a200000-0000-4000-8000-000000000002";
const STORED_ROUTE_ENABLED = "9a300000-0000-4000-8000-000000000001";
const STORED_ROUTE_DISABLED = "9a300000-0000-4000-8000-000000000002";
const STORED_ROUTE_DELETED = "9a300000-0000-4000-8000-000000000003";
// 테스트 전용 BYPASSRLS 역할(rpa_lifecycle_bypass 패턴) — maintenance 테넌트 발견 쿼리 검증용.
const LIFECYCLE_BYPASS_ROLE = "rpa_ops_fire_bypass";
const LIFECYCLE_BYPASS_PASSWORD = "rpa_ops_fire_bypass";

const ROUTE_ALL_WARNING: OpsAlertRoute = {
  minSeverity: "warning",
  providerAlias: "oncall-webhook",
  endpointSecretRef: "secret://ops/oncall-webhook",
  allowedHosts: ["hooks.example.com"],
  routePolicyRef: "route:oncall",
  callbackSignatureSecretRef: "secret://ops/oncall-callback",
};

const ROUTE_CRITICAL_ONLY: OpsAlertRoute = {
  source: "run_sla",
  minSeverity: "critical",
  providerAlias: "oncall-critical",
  endpointSecretRef: "secret://ops/critical-webhook",
  allowedHosts: ["hooks.example.com"],
  routePolicyRef: "route:critical",
};

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

type Pool = ReturnType<typeof createPool>;

function capturingEnqueuer(sink: OpsNotificationSendEnqueueInput[]): OpsNotificationFireEnqueuer {
  return {
    async enqueueOpsNotificationSend(_client: PoolClient, input: OpsNotificationSendEnqueueInput) {
      sink.push(input);
    },
  };
}

async function attemptRows(pool: Pool): Promise<Array<{ id: string; alert_id: string; detected_at: Date; provider_alias: string; status: string; endpoint_secret_ref: string; allowed_hosts: string[]; requested_by: string; metadata: Record<string, unknown> }>> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query(
      `SELECT id::text, alert_id, detected_at, provider_alias, status, endpoint_secret_ref, allowed_hosts, requested_by, metadata
         FROM ops_notification_attempts WHERE tenant_id=$1::uuid AND deleted_at IS NULL
        ORDER BY provider_alias`,
      [TENANT_A],
    );
    return result.rows as never;
  });
}

async function seed(pool: Pool): Promise<void> {
  const setup = await pool.connect();
  try {
    await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await setup.query(`SET search_path = ${SCHEMA}, public`);
    await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
    await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid)`, [TENANT_A]);
    await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
    await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
  } finally {
    setup.release();
  }
  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'ops fire')`, [SCEN_A, TENANT_A]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[],"target":{"site_profile_id":"00000000-0000-4000-8000-000000000001","browser_identity_id":"00000000-0000-4000-8000-000000000002","network_policy_id":"00000000-0000-4000-8000-000000000003"}}'::jsonb)`,
      [SVER_A, TENANT_A, SCEN_A],
    );
    // 정체 run: 240분 초과 → run_sla critical. created_at 오래 전, updated_at 도 고정(안정 detected_at).
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'queued',$1,$4::timestamptz,$5::timestamptz)`,
      [RUN_STUCK, TENANT_A, SVER_A, isoMinutesFromNow(-300), isoMinutesFromNow(-300)],
    );
  });
}

// maintenance 테넌트 발견 쿼리는 전용 non-superuser BYPASSRLS 역할로만 실행된다(assertLifecycleBypassUse).
async function createLifecycleBypassRole(): Promise<void> {
  const admin = createPool({
    host: process.env.PGHOST,
    port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: "postgres",
    // CI(비밀번호 인증)는 superuser 비밀번호 필요(PGADMIN_PASSWORD). 로컬 temp-PG(trust)는 무시.
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
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
  } finally {
    await admin.end();
  }
}

async function insertStoredRoute(
  pool: Pool,
  routeId: string,
  providerAlias: string,
  state: "enabled" | "disabled" | "deleted",
): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO ops_alert_notification_routes (
         id, tenant_id, source, min_severity, provider_alias, endpoint_secret_ref,
         route_policy_ref, allowed_hosts, enabled, created_by, updated_by, deleted_at
       )
       VALUES ($1::uuid,$2::uuid,NULL,'warning',$3,$4,'route:stored',$5::text[],$6,'ops-test','ops-test',$7)`,
      [
        routeId,
        TENANT_A,
        providerAlias,
        `secret://ops/${providerAlias}`,
        ["hooks.example.com"],
        state === "enabled",
        state === "deleted" ? new Date().toISOString() : null,
      ],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    await seed(pool);

    // 1) env·저장 라우트 모두 없음 → 발화 0. S4b 부터는 저장형 라우트 확인을 위해 테넌트를 방문한다(tenantsProcessed 1).
    const noRoutes = await runOpsNotificationFire(pool, {
      tenantIds: [TENANT_A],
      routes: [],
      enqueuer: capturingEnqueuer([]),
      correlationId: () => "corr-none",
    });
    check("no routes anywhere → visits tenant, creates nothing", noRoutes.created === 0 && noRoutes.skipped === 0 && noRoutes.tenantsProcessed === 1, JSON.stringify(noRoutes));
    check("no routes → no attempts persisted", (await attemptRows(pool)).length === 0);

    // 2) 라우트 있는데 대상 테넌트 없음 → 휴면 loud 경고 + no-op.
    let dormantWarned: string | null = null;
    const dormant = await runOpsNotificationFire(pool, {
      tenantIds: [],
      routes: [ROUTE_ALL_WARNING],
      enqueuer: capturingEnqueuer([]),
      correlationId: () => "corr-dormant",
      onWarn: (m) => { dormantWarned = m; },
    });
    check("dormant (routes but no tenants) → warns loud", dormantWarned !== null && (dormantWarned as string).includes("MAINTENANCE_TENANT_IDS"), String(dormantWarned));
    check("dormant → no attempts, tenantsProcessed 0", dormant.created === 0 && dormant.tenantsProcessed === 0);

    // 3) run_sla critical 이 warning 라우트로 발화 → 1 attempt(pending) + 1 enqueue.
    const enqueued: OpsNotificationSendEnqueueInput[] = [];
    const fire1 = await runOpsNotificationFire(pool, {
      tenantIds: [TENANT_A],
      routes: [ROUTE_ALL_WARNING],
      enqueuer: capturingEnqueuer(enqueued),
      correlationId: () => "corr-fire-1",
    });
    check("fire → created 1", fire1.created === 1, JSON.stringify(fire1));
    check("fire → enqueued once", enqueued.length === 1 && enqueued[0]?.tenantId === TENANT_A, JSON.stringify(enqueued));
    const rows1 = await attemptRows(pool);
    check("attempt persisted pending with route secret refs + allowed hosts", rows1.length === 1
      && rows1[0]!.status === "pending"
      && rows1[0]!.provider_alias === "oncall-webhook"
      && rows1[0]!.endpoint_secret_ref === "secret://ops/oncall-webhook"
      && JSON.stringify(rows1[0]!.allowed_hosts) === JSON.stringify(["hooks.example.com"]), JSON.stringify(rows1[0]));
    check("attempt attributed to system auto-fire + metadata.auto_fired", rows1[0]!.requested_by === "system:ops-alert-auto-fire"
      && rows1[0]!.metadata?.auto_fired === true, JSON.stringify(rows1[0]?.metadata));
    check("enqueued attempt id matches persisted row (delivery consumer will pick it up)", rows1.length === 1);

    // 4) DB 하드닝 — SELECT guard 를 뚫고 같은 세대 insert 가 재시도되어도 unique+ON CONFLICT 가 기존 attempt 를 반환한다.
    const duplicateAttempt = await withTenantTx(pool, TENANT_A, async (client) => {
      const duplicateAlert: ComputedOpsAlert = {
        alert_id: rows1[0]!.alert_id,
        severity: "critical",
        source: "run_sla",
        title: "장시간 실행 위험",
        detail: "same generation race simulation",
        subject_type: "run",
        subject_id: RUN_STUCK,
        recommended_action: "실행 기록에서 단계 지연과 마지막 업데이트를 확인하세요.",
        route: `#runTrace?run=${RUN_STUCK}`,
        detected_at: rows1[0]!.detected_at.toISOString(),
        due_at: null,
      };
      const duplicateInput: OpsNotificationWebhookSendInput = {
        providerAlias: "oncall-webhook",
        endpointSecretRef: "secret://ops/oncall-webhook",
        callbackSignatureSecretRef: "secret://ops/oncall-callback",
        routePolicyRef: "route:oncall",
        recipientGroupRef: null,
        allowedHosts: ["hooks.example.com"],
        summary: null,
        metadata: { auto_fired: true, severity: "critical", source: "run_sla" },
        legalHold: false,
      };
      return insertOpsNotificationAttempt(client, TENANT_A, duplicateAlert, "system:ops-alert-auto-fire", duplicateInput);
    });
    check("same generation insert conflict returns existing attempt", duplicateAttempt.attempt_id === rows1[0]!.id, JSON.stringify(duplicateAttempt));
    check("same generation insert conflict does not mutate requested_by", (await attemptRows(pool))[0]!.requested_by === "system:ops-alert-auto-fire");
    check("same generation insert conflict leaves exactly 1 attempt", (await attemptRows(pool)).length === 1);

    // 5) 두 번째 틱 → 같은 세대 멱등, 재발화 없음(폭주 방지).
    const enqueued2: OpsNotificationSendEnqueueInput[] = [];
    const fire2 = await runOpsNotificationFire(pool, {
      tenantIds: [TENANT_A],
      routes: [ROUTE_ALL_WARNING],
      enqueuer: capturingEnqueuer(enqueued2),
      correlationId: () => "corr-fire-2",
    });
    check("second tick → created 0 (idempotent generation)", fire2.created === 0 && fire2.skipped >= 1, JSON.stringify(fire2));
    check("second tick → no new enqueue", enqueued2.length === 0);
    check("still exactly 1 attempt (no flood)", (await attemptRows(pool)).length === 1);

    // 6) min_severity 필터 — critical-only 라우트를 별도 provider 로 적용. run_sla 는 240분 초과라 critical → 발화됨.
    //    이 라우트가 매칭돼 새 provider 로 1건 추가되면 severity 게이트가 동작함을 증명(warning 알림이었다면 skip).
    const enqueued3: OpsNotificationSendEnqueueInput[] = [];
    const fire3 = await runOpsNotificationFire(pool, {
      tenantIds: [TENANT_A],
      routes: [ROUTE_CRITICAL_ONLY],
      enqueuer: capturingEnqueuer(enqueued3),
      correlationId: () => "corr-fire-3",
    });
    check("critical route matches critical run_sla → created 1 (new provider)", fire3.created === 1, JSON.stringify(fire3));
    const rows3 = await attemptRows(pool);
    check("now 2 attempts across 2 providers (per-provider generation)", rows3.length === 2 && rows3.some((r) => r.provider_alias === "oncall-critical"), JSON.stringify(rows3.map((r) => r.provider_alias)));

    // 7) S4b — 저장형 라우트 테넌트의 maintenance 발견(실 PG 쿼리, BYPASSRLS 역할).
    await createLifecycleBypassRole();
    const lifecycleBypassPool = createPool({
      host: process.env.PGHOST,
      port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: LIFECYCLE_BYPASS_ROLE,
      password: LIFECYCLE_BYPASS_PASSWORD,
      options: `-c search_path=${SCHEMA},public`,
    });
    try {
      const beforeRoutes = await resolveMaintenanceTenantIds(pool, [], new Date(), { lifecycleBypassPool });
      check("tenant without stored routes or due work is not discovered", !beforeRoutes.includes(TENANT_A), JSON.stringify(beforeRoutes));

      // 8) 저장형 라우트 3종: enabled(발화) / disabled / soft-deleted(발화 금지).
      await insertStoredRoute(pool, STORED_ROUTE_ENABLED, "stored-webhook", "enabled");
      await insertStoredRoute(pool, STORED_ROUTE_DISABLED, "stored-disabled", "disabled");
      await insertStoredRoute(pool, STORED_ROUTE_DELETED, "stored-deleted", "deleted");

      const afterRoutes = await resolveMaintenanceTenantIds(pool, [], new Date(), { lifecycleBypassPool });
      check("stored-route tenant is discovered for maintenance/fire poll", afterRoutes.includes(TENANT_A), JSON.stringify(afterRoutes));

      // 9) env 라우트 없이 저장형 라우트만으로 발화된다(S4b 코어).
      const enqueuedStored: OpsNotificationSendEnqueueInput[] = [];
      const fireStored = await runOpsNotificationFire(pool, {
        tenantIds: [TENANT_A],
        routes: [],
        enqueuer: capturingEnqueuer(enqueuedStored),
        correlationId: () => "corr-stored-1",
      });
      check("stored route fires without env routes → created 1", fireStored.created === 1 && enqueuedStored.length === 1, JSON.stringify(fireStored));
      const storedRows = await attemptRows(pool);
      check("stored route attempt persisted with stored refs", storedRows.some((r) =>
        r.provider_alias === "stored-webhook" &&
        r.status === "pending" &&
        r.endpoint_secret_ref === "secret://ops/stored-webhook" &&
        r.requested_by === "system:ops-alert-auto-fire",
      ), JSON.stringify(storedRows.map((r) => r.provider_alias)));
      check("disabled/deleted stored routes never fire", !storedRows.some((r) => r.provider_alias === "stored-disabled" || r.provider_alias === "stored-deleted"), JSON.stringify(storedRows.map((r) => r.provider_alias)));

      // 10) 저장형 라우트도 세대 멱등(두 번째 틱 재발화 없음).
      const fireStored2 = await runOpsNotificationFire(pool, {
        tenantIds: [TENANT_A],
        routes: [],
        enqueuer: capturingEnqueuer([]),
        correlationId: () => "corr-stored-2",
      });
      check("stored route second tick idempotent", fireStored2.created === 0 && fireStored2.skipped >= 1, JSON.stringify(fireStored2));

      // 11) 저장형 라우트 soft-delete → 발화·발견 모두 제외.
      await withTenantTx(pool, TENANT_A, async (client) => {
        await client.query(
          `UPDATE ops_alert_notification_routes SET enabled=false, deleted_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [TENANT_A, STORED_ROUTE_ENABLED],
        );
      });
      const fireAfterDelete = await runOpsNotificationFire(pool, {
        tenantIds: [TENANT_A],
        routes: [],
        enqueuer: capturingEnqueuer([]),
        correlationId: () => "corr-stored-3",
      });
      check("soft-deleted stored route stops firing", fireAfterDelete.created === 0, JSON.stringify(fireAfterDelete));
      const afterDelete = await resolveMaintenanceTenantIds(pool, [], new Date(), { lifecycleBypassPool });
      check("soft-deleted stored route leaves maintenance discovery", !afterDelete.includes(TENANT_A), JSON.stringify(afterDelete));
    } finally {
      await lifecycleBypassPool.end();
    }

    // 12) session_expiry — 만료 임박 세션이 attempt 파이프라인으로 발화된다(DDL source/subject_type CHECK 실증).
    const sessionExpiresAt = isoMinutesFromNow(360);
    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'ops-fire-site','https://ops-fire.example/*')`, [SITE_A, TENANT_A]);
      await client.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ops-fire')`, [IDENTITY_A, TENANT_A, SITE_A]);
      await client.query(
        `INSERT INTO browser_sessions (tenant_id, site_profile_id, browser_identity_id, identity_key, ciphertext, enc_kid, expires_at)
         VALUES ($1,$2,$3,'',$4::bytea,'dev-plaintext-v1',$5::timestamptz)`,
        [TENANT_A, SITE_A, IDENTITY_A, Buffer.from([0]), sessionExpiresAt],
      );
    });
    const sessionRoute: OpsAlertRoute = {
      source: "session_expiry",
      minSeverity: "warning",
      providerAlias: "session-webhook",
      endpointSecretRef: "secret://ops/session-webhook",
      allowedHosts: ["hooks.example.com"],
      routePolicyRef: "route:session",
    };
    const enqueuedSession: OpsNotificationSendEnqueueInput[] = [];
    const fireSession = await runOpsNotificationFire(pool, {
      tenantIds: [TENANT_A],
      routes: [sessionRoute],
      enqueuer: capturingEnqueuer(enqueuedSession),
      correlationId: () => "corr-session-1",
    });
    check("session_expiry route fires due-soon session → created 1", fireSession.created === 1 && enqueuedSession.length === 1, JSON.stringify(fireSession));
    const sessionRows = (await attemptRows(pool)).filter((r) => r.provider_alias === "session-webhook");
    check("session_expiry attempt persists browser_session subject through DDL CHECK", sessionRows.length === 1
      && sessionRows[0]!.alert_id === `session_expiry:${SITE_A}:${IDENTITY_A}:d41d8cd98f00b204e9800998ecf8427e`
      && sessionRows[0]!.detected_at.toISOString() === sessionExpiresAt
      && sessionRows[0]!.metadata?.source === "session_expiry", JSON.stringify(sessionRows[0]));
    const sessionSubject = await withTenantTx(pool, TENANT_A, async (client) => {
      const result = await client.query<{ source: string; subject_type: string; subject_id: string | null }>(
        `SELECT source, subject_type, subject_id FROM ops_notification_attempts WHERE tenant_id=$1::uuid AND provider_alias='session-webhook'`,
        [TENANT_A],
      );
      return result.rows[0];
    });
    check("session_expiry attempt row source/subject_type/subject_id are contract values", sessionSubject !== undefined
      && sessionSubject.source === "session_expiry"
      && sessionSubject.subject_type === "browser_session"
      && sessionSubject.subject_id === SITE_A, JSON.stringify(sessionSubject));
    const fireSession2 = await runOpsNotificationFire(pool, {
      tenantIds: [TENANT_A],
      routes: [sessionRoute],
      enqueuer: capturingEnqueuer([]),
      correlationId: () => "corr-session-2",
    });
    check("session_expiry second tick idempotent (stable expires_at generation)", fireSession2.created === 0 && fireSession2.skipped >= 1, JSON.stringify(fireSession2));
  } finally {
    await pool.end();
  }
}

await main();
if (failures > 0) process.exit(1);
console.log("PASS: ops-notification-fire producer integration green");
