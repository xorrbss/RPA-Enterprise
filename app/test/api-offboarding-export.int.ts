/**
 * Integration test for /v1/offboarding/export.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-offboarding-export.int.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_offboarding_export_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const TENANT_EMPTY = "00000000-0000-4000-8000-0000000000c3";
const SCEN_A = "10000000-0000-4000-8000-0000000000a1";
const SVER_A = "11000000-0000-4000-8000-0000000000a1";
const RUN_A = "12000000-0000-4000-8000-0000000000a1";
const RUN_OLD = "12000000-0000-4000-8000-0000000000a2";
const TASK_A = "13000000-0000-4000-8000-0000000000a1";
const TASK_OLD = "13000000-0000-4000-8000-0000000000a2";
const ART_VISIBLE = "14000000-0000-4000-8000-0000000000a1";
const ART_PENDING = "14000000-0000-4000-8000-0000000000a2";
const ART_QUARANTINED = "14000000-0000-4000-8000-0000000000a3";
const ART_DELETED = "14000000-0000-4000-8000-0000000000a4";
const ART_OLD = "14000000-0000-4000-8000-0000000000a5";
const SCEN_B = "10000000-0000-4000-8000-0000000000b1";
const SVER_B = "11000000-0000-4000-8000-0000000000b1";
const RUN_B = "12000000-0000-4000-8000-0000000000b1";
const TASK_B = "13000000-0000-4000-8000-0000000000b1";
const ART_B = "14000000-0000-4000-8000-0000000000b1";

const SECRET = new TextEncoder().encode("offboarding-export-int-secret-do-not-use-in-prod");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function mint(roles: string[], tenant = TENANT_A, sub = "admin-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

/** jsonb 는 키 순서를 보존하지 않으므로 정렬 canonical JSON 으로 원문 왕복 동등성을 비교한다. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJsonl(body: string): Record<string, unknown>[] {
  return body.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 다운로드 스크립트 실행 — spawnSync 는 부모 이벤트 루프를 멈춰 같은 프로세스의 서버가 응답 불가(행). 비동기 spawn 필수. */
function runDownloadScript(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ status: code, stdout, stderr }));
  });
}

type Pool = ReturnType<typeof createPool>;

async function seedTenant(pool: Pool, tenant: string, scen: string, sver: string, run: string, task: string, artifact: string, objectRef: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [scen, tenant, `offboarding-${tenant.slice(-2)}`]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scen],
    );
    await client.query(
      `INSERT INTO runs
         (id, tenant_id, scenario_version_id, status, priority, params, resume_token, bookmark, failure_reason, correlation_id, attempts, as_of, started_at, ended_at, created_at, updated_at)
       VALUES
         ($1,$2,$3,'completed','high',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$1,2,'2026-06-15T08:00:00Z','2026-06-15T08:00:01Z','2026-06-15T08:01:00Z','2026-06-15T08:00:00Z','2026-06-15T08:01:00Z')`,
      [
        run,
        tenant,
        sver,
        JSON.stringify({ api_token: `PARAMS-SECRET-${tenant}`, customer_id: tenant }),
        JSON.stringify({ runId: run, kid: "k1", hmac: `RESUME-TOKEN-SECRET-${tenant}` }),
        JSON.stringify({ stepId: `BOOKMARK-SECRET-${tenant}`, attempt: 1 }),
        JSON.stringify({ code: "EXPORT_OK", message: `FAILURE-MESSAGE-SECRET-${tenant}` }),
      ],
    );
    await client.query(
      `INSERT INTO human_tasks
         (id, tenant_id, run_id, kind, state, assignee, assignee_role, payload_ref, payload, result_schema, result, artifact_refs, created_at, resolved_at, updated_at, resolved_by)
       VALUES
         ($1,$2,$3,'validation','resolved',$4,'reviewer',$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,'2026-06-15T08:02:00Z','2026-06-15T08:03:00Z','2026-06-15T08:03:00Z','reviewer-1')`,
      [
        task,
        tenant,
        run,
        `=csv-assignee-${tenant}`,
        `ref://payload/${tenant.slice(-2)}`,
        JSON.stringify({ secret: `PAYLOAD-SECRET-${tenant}` }),
        JSON.stringify({ type: "object", title: `schema-${tenant.slice(-2)}` }),
        JSON.stringify({ decision: "approve", secret: `RESULT-SECRET-${tenant}` }),
        JSON.stringify([artifact]),
      ],
    );
    await client.query(
      `INSERT INTO run_steps
         (id, tenant_id, run_id, step_id, node_id, attempt, action, status, cache_mode, created_at)
       VALUES
         ($1,$2,$3,'extract','extract',0,'extract','success','bypass','2026-06-15T08:03:30Z')`,
      [artifact, tenant, run],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, run_id, step_id, attempt, type, media_type, filename, byte_size, duration_ms,
          redaction_status, sha256, object_ref, retention_until, created_at)
       VALUES
         ($1,$2,$3,'extract',0,'screenshot','image/png','visible.png',123,456,
          'redacted',$4,$5,'2026-09-15T00:00:00Z','2026-06-15T08:04:00Z')`,
      [artifact, tenant, run, `SHA-SECRET-${tenant}`, objectRef],
    );
  });
}

async function seedTenantAEdgeRows(pool: Pool, oldArtifactObjectRef: string): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO runs
         (id, tenant_id, scenario_version_id, status, priority, params, correlation_id, attempts, created_at, updated_at)
       VALUES ($1,$2,$3,'completed','medium','{"secret":"OLD-PARAMS-SECRET"}'::jsonb,$1,1,'2026-06-01T00:00:00Z','2026-06-01T00:01:00Z')`,
      [RUN_OLD, TENANT_A, SVER_A],
    );
    await client.query(
      `INSERT INTO human_tasks
         (id, tenant_id, run_id, kind, state, payload, created_at, updated_at)
       VALUES ($1,$2,$3,'validation','open','{"secret":"OLD-PAYLOAD-SECRET"}'::jsonb,'2026-06-01T00:02:00Z','2026-06-01T00:02:00Z')`,
      [TASK_OLD, TENANT_A, RUN_OLD],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, run_id, type, redaction_status, sha256, object_ref, retention_until, created_at, quarantine, deleted_at)
       VALUES
         ($1,$2,$3,'screenshot','pending','SHA-SECRET-PENDING','obj://OBJECT-SECRET-PENDING','2026-09-15T00:00:00Z','2026-06-15T08:05:00Z',false,NULL),
         ($4,$2,$3,'screenshot','redacted','SHA-SECRET-QUARANTINED','obj://OBJECT-SECRET-QUARANTINED','2026-09-15T00:00:00Z','2026-06-15T08:06:00Z',true,NULL),
         ($5,$2,$3,'screenshot','redacted','SHA-SECRET-DELETED','obj://OBJECT-SECRET-DELETED','2026-09-15T00:00:00Z','2026-06-15T08:07:00Z',false,'2026-06-16T00:00:00Z'),
         ($6,$2,$7,'screenshot','redacted','SHA-SECRET-OLD',$8,'2026-09-15T00:00:00Z','2026-06-01T00:03:00Z',false,NULL)`,
      [ART_PENDING, TENANT_A, RUN_A, ART_QUARANTINED, ART_DELETED, ART_OLD, RUN_OLD, oldArtifactObjectRef],
    );
  });
}

function seedObjectFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return pathToFileURL(path).href;
}

async function main(): Promise<void> {
  // artifact 본문 object store(FsObjectStore) — object_ref 에 OBJECT-SECRET 마커를 유지하면서 blob 로 실제 서빙 가능하게 시드.
  const artifactDir = mkdtempSync(join(tmpdir(), "rpa-obd-artifacts-"));
  const store = new FsObjectStore(artifactDir);
  const objectRefA = seedObjectFile(artifactDir, `OBJECT-SECRET-${TENANT_A}.bin`, "BLOB-BYTES-A");
  const objectRefB = seedObjectFile(artifactDir, `OBJECT-SECRET-${TENANT_B}.bin`, "BLOB-BYTES-B");
  // 파일을 만들지 않은 ref — blob 404(fail-closed) 재현용(다운로드 스크립트 부분 실패 loud 검증).
  const objectRefOldMissing = pathToFileURL(join(artifactDir, "OBJECT-SECRET-OLD-missing.bin")).href;
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
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
    } finally {
      setup.release();
    }
    await seedTenant(pool, TENANT_A, SCEN_A, SVER_A, RUN_A, TASK_A, ART_VISIBLE, objectRefA);
    await seedTenantAEdgeRows(pool, objectRefOldMissing);
    await seedTenant(pool, TENANT_B, SCEN_B, SVER_B, RUN_B, TASK_B, ART_B, objectRefB);
    console.log("seeded offboarding export rows across tenants");

    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort() {},
      async enqueueSinkDeliver() {},
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
      artifactStore: store,
      securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
    });
    await app.ready();
    try {
      const admin = await mint(["admin"]);
      const viewer = await mint(["viewer"], TENANT_A, "viewer-a");
      const adminB = await mint(["admin"], TENANT_B, "admin-b");

      const exported = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export?created_at_from=2026-06-15T00%3A00%3A00.000Z&created_at_to=2026-06-15T23%3A59%3A59.999Z",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("admin offboarding export -> 200 csv", exported.statusCode === 200 && String(exported.headers["content-type"] ?? "").includes("text/csv"), exported.body);
      check("offboarding export starts with UTF-8 BOM", exported.body.startsWith(String.fromCharCode(0xfeff)), JSON.stringify(exported.body.slice(0, 12)));
      check("offboarding export content-disposition filename", String(exported.headers["content-disposition"] ?? "").includes("offboarding-export-"), JSON.stringify(exported.headers));
      check("offboarding export includes all metadata sections", ["manifest", "runs", "human_tasks", "artifacts"].every((section) => exported.body.includes(`\"section\",\"${section}\"`)), exported.body);
      check("offboarding export includes in-range tenant A rows", exported.body.includes(RUN_A) && exported.body.includes(TASK_A) && exported.body.includes(ART_VISIBLE), exported.body);
      check("offboarding export applies date range", !exported.body.includes(RUN_OLD) && !exported.body.includes(TASK_OLD) && !exported.body.includes(ART_OLD), exported.body);
      check("offboarding export hides cross-tenant rows", !exported.body.includes(RUN_B) && !exported.body.includes(TASK_B) && !exported.body.includes(ART_B), exported.body);
      check("offboarding export hides non-visible artifacts", !exported.body.includes(ART_PENDING) && !exported.body.includes(ART_QUARANTINED) && !exported.body.includes(ART_DELETED), exported.body);
      for (const secret of [
        "PARAMS-SECRET",
        "PAYLOAD-SECRET",
        "RESULT-SECRET",
        "FAILURE-MESSAGE-SECRET",
        "OBJECT-SECRET",
        "SHA-SECRET",
      ]) {
        check(`offboarding export omits ${secret}`, !exported.body.includes(secret), exported.body);
      }
      check("offboarding export neutralizes spreadsheet formula cells", exported.body.includes("\"'=csv-assignee-"), exported.body);

      const invalidFormat = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export?format=json",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("invalid offboarding export format -> 422", invalidFormat.statusCode === 422 && invalidFormat.json().code === "IR_SCHEMA_INVALID", invalidFormat.body);

      const invalidRange = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export?created_at_from=2026-06-16T00%3A00%3A00.000Z&created_at_to=2026-06-15T00%3A00%3A00.000Z",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("invalid offboarding export date range -> 422", invalidRange.statusCode === 422 && invalidRange.json().code === "IR_SCHEMA_INVALID", invalidRange.body);

      const denied = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer offboarding export denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);

      const tenantB = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export",
        headers: { authorization: `Bearer ${adminB}` },
      });
      check("tenant B export sees tenant B only", tenantB.statusCode === 200 && tenantB.body.includes(RUN_B) && !tenantB.body.includes(RUN_A), tenantB.body);

      // ===== O1: 원문(raw) JSONL 반출 =====
      const auditCount = async (tenant: string): Promise<number> =>
        withTenantTx(pool, tenant, async (client) => {
          const result = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_log WHERE action = 'tenant_data.export'`,
          );
          return result.rows[0]?.n ?? -1;
        });

      const auditBeforeRaw = await auditCount(TENANT_A);

      const rawRuns = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs",
        headers: { authorization: `Bearer ${admin}` },
      });
      check(
        "raw runs export -> 200 ndjson attachment",
        rawRuns.statusCode === 200
          && String(rawRuns.headers["content-type"] ?? "").includes("application/x-ndjson")
          && String(rawRuns.headers["content-disposition"] ?? "").includes("offboarding-raw-runs-"),
        rawRuns.body,
      );
      const rawRunRows = parseJsonl(rawRuns.body);
      check("raw runs returns tenant A runs DESC", rawRunRows.length === 2 && rawRunRows[0]?.run_id === RUN_A && rawRunRows[1]?.run_id === RUN_OLD, rawRuns.body);
      const rawRunA = rawRunRows.find((row) => row.run_id === RUN_A);
      check(
        "raw runs round-trips params 원문",
        canonical(rawRunA?.params) === canonical({ api_token: `PARAMS-SECRET-${TENANT_A}`, customer_id: TENANT_A }),
        rawRuns.body,
      );
      check(
        "raw runs carries scenario identity + created_at",
        rawRunA?.scenario_id === SCEN_A && rawRunA?.scenario_name === "offboarding-a1" && rawRunA?.created_at === "2026-06-15T08:00:00.000Z",
        rawRuns.body,
      );
      for (const secret of ["RESUME-TOKEN-SECRET", "BOOKMARK-SECRET", "FAILURE-MESSAGE-SECRET", "OBJECT-SECRET", "SHA-SECRET"]) {
        check(`raw runs omits ${secret}`, !rawRuns.body.includes(secret), rawRuns.body);
      }
      check("raw runs single page -> no next cursor", rawRuns.headers["x-next-cursor"] === undefined, JSON.stringify(rawRuns.headers));

      const rawTasks = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=human_tasks",
        headers: { authorization: `Bearer ${admin}` },
      });
      const rawTaskRows = parseJsonl(rawTasks.body);
      const rawTaskA = rawTaskRows.find((row) => row.human_task_id === TASK_A);
      const rawTaskOld = rawTaskRows.find((row) => row.human_task_id === TASK_OLD);
      check("raw human_tasks -> 200 + 2 rows", rawTasks.statusCode === 200 && rawTaskRows.length === 2, rawTasks.body);
      check(
        "raw human_tasks round-trips payload/result/result_schema 원문",
        canonical(rawTaskA?.payload) === canonical({ secret: `PAYLOAD-SECRET-${TENANT_A}` })
          && canonical(rawTaskA?.result) === canonical({ decision: "approve", secret: `RESULT-SECRET-${TENANT_A}` })
          && canonical(rawTaskA?.result_schema) === canonical({ type: "object", title: "schema-a1" }),
        rawTasks.body,
      );
      check(
        "raw human_tasks carries kind/state/payload_ref/timestamps",
        rawTaskA?.kind === "validation" && rawTaskA?.state === "resolved" && rawTaskA?.payload_ref === "ref://payload/a1"
          && rawTaskA?.resolved_at === "2026-06-15T08:03:00.000Z" && rawTaskOld?.result === null && rawTaskOld?.resolved_at === null,
        rawTasks.body,
      );
      check("raw human_tasks omits assignee(메타데이터 전용 컬럼)", !rawTasks.body.includes("csv-assignee-"), rawTasks.body);

      // keyset 커서 정합(limit=1): 순서 보존·중복/누락 없음.
      const page1 = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs&limit=1",
        headers: { authorization: `Bearer ${admin}` },
      });
      const page1Rows = parseJsonl(page1.body);
      const nextCursor = page1.headers["x-next-cursor"];
      check(
        "raw cursor page1 -> 1행 + next cursor",
        page1.statusCode === 200 && page1Rows.length === 1 && page1Rows[0]?.run_id === RUN_A && typeof nextCursor === "string" && nextCursor.length > 0,
        page1.body,
      );
      const page2 = await app.inject({
        method: "GET",
        url: `/v1/offboarding/export/raw?section=runs&limit=1&cursor=${encodeURIComponent(String(nextCursor))}`,
        headers: { authorization: `Bearer ${admin}` },
      });
      const page2Rows = parseJsonl(page2.body);
      check(
        "raw cursor page2 -> 나머지 1행, 중복/누락 없음",
        page2.statusCode === 200 && page2Rows.length === 1 && page2Rows[0]?.run_id === RUN_OLD && page2.headers["x-next-cursor"] === undefined,
        page2.body,
      );

      const rangedRaw = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs&created_at_from=2026-06-10T00%3A00%3A00.000Z",
        headers: { authorization: `Bearer ${admin}` },
      });
      const rangedRows = parseJsonl(rangedRaw.body);
      check("raw created_at 범위 필터", rangedRaw.statusCode === 200 && rangedRows.length === 1 && rangedRows[0]?.run_id === RUN_A, rangedRaw.body);

      const auditAfterRaw = await auditCount(TENANT_A);
      check("raw export 마다 audit_log 증가(+5)", auditAfterRaw === auditBeforeRaw + 5, `before=${auditBeforeRaw} after=${auditAfterRaw}`);

      const invalidSection = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=artifacts",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("raw invalid section -> 422", invalidSection.statusCode === 422 && invalidSection.json().code === "IR_SCHEMA_INVALID", invalidSection.body);
      const missingSection = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("raw missing section -> 422", missingSection.statusCode === 422, missingSection.body);
      const badLimit = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs&limit=0",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("raw limit=0 -> 422", badLimit.statusCode === 422, badLimit.body);
      const badCursor = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs&cursor=not-a-cursor",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("raw invalid cursor -> 422", badCursor.statusCode === 422, badCursor.body);
      const rawDenied = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer raw export denied -> 403", rawDenied.statusCode === 403 && rawDenied.json().code === "AUTHZ_FORBIDDEN", rawDenied.body);
      check("실패/거부 경로는 audit 미기록", (await auditCount(TENANT_A)) === auditAfterRaw);

      const rawRunsB = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export/raw?section=runs",
        headers: { authorization: `Bearer ${adminB}` },
      });
      check(
        "tenant B raw sees tenant B only",
        rawRunsB.statusCode === 200 && rawRunsB.body.includes(RUN_B) && !rawRunsB.body.includes(RUN_A) && !rawRunsB.body.includes(TENANT_A),
        rawRunsB.body,
      );

      const auditBeforeMeta = await auditCount(TENANT_A);
      const metaAgain = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("metadata export 도 fail-closed audit 기록", metaAgain.statusCode === 200 && (await auditCount(TENANT_A)) === auditBeforeMeta + 1, metaAgain.body.slice(0, 200));
      const lastAudit = await withTenantTx(pool, TENANT_A, async (client) => {
        const result = await client.query<{ reason: string; payload: unknown }>(
          `SELECT reason, payload FROM audit_log WHERE action = 'tenant_data.export' ORDER BY sequence_no DESC LIMIT 1`,
        );
        return result.rows[0];
      });
      check(
        "audit payload 는 범위/건수만(원문 미포함)",
        lastAudit?.reason === "offboarding_metadata_export_disclosed" && !JSON.stringify(lastAudit?.payload ?? {}).includes("PARAMS-SECRET"),
        JSON.stringify(lastAudit),
      );

      // ===== O1: 다운로드 스크립트 e2e (실 HTTP + 커서 체이닝 + 부분 실패 loud) =====
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const apiBase = `http://127.0.0.1:${port}`;
      const scriptPath = `${ROOT}scripts/offboarding-download.mjs`;

      const outB = mkdtempSync(join(tmpdir(), "rpa-obd-dl-b-"));
      const scriptB = await runDownloadScript([scriptPath, "--api", apiBase, "--out", outB, "--limit", "1"], {
        ...process.env,
        RPA_OPERATOR_TOKEN: adminB,
      });
      check("download script(테넌트 B) exit 0", scriptB.status === 0, `${scriptB.stdout}\n${scriptB.stderr}`);
      const manifestB = JSON.parse(readFileSync(join(outB, "manifest.json"), "utf8")) as {
        counts: Record<string, number>;
        failures: { artifact_id: string; status: number }[];
      };
      check(
        "script B: manifest 건수 정합",
        manifestB.counts.runs === 1 && manifestB.counts.human_tasks === 1 && manifestB.counts.artifacts_listed === 1
          && manifestB.counts.artifacts_downloaded === 1 && manifestB.counts.artifacts_failed === 0,
        JSON.stringify(manifestB),
      );
      const runsJsonlB = parseJsonl(readFileSync(join(outB, "runs.jsonl"), "utf8"));
      check(
        "script B: runs.jsonl 원문 왕복",
        runsJsonlB.length === 1 && runsJsonlB[0]?.run_id === RUN_B
          && canonical(runsJsonlB[0]?.params) === canonical({ api_token: `PARAMS-SECRET-${TENANT_B}`, customer_id: TENANT_B }),
        JSON.stringify(runsJsonlB),
      );
      check("script B: metadata CSV 저장", readFileSync(join(outB, "offboarding-metadata.csv"), "utf8").includes(RUN_B));
      const artifactFilesB = readdirSync(join(outB, "artifacts"));
      check(
        "script B: artifact blob 저장(본문 일치)",
        artifactFilesB.length === 1 && artifactFilesB[0]!.startsWith(ART_B) && readFileSync(join(outB, "artifacts", artifactFilesB[0]!), "utf8") === "BLOB-BYTES-B",
        JSON.stringify(artifactFilesB),
      );

      const outA = mkdtempSync(join(tmpdir(), "rpa-obd-dl-a-"));
      const scriptA = await runDownloadScript([scriptPath, "--api", apiBase, "--out", outA, "--limit", "1"], {
        ...process.env,
        RPA_OPERATOR_TOKEN: admin,
      });
      check("download script(테넌트 A) 부분 실패 -> exit 1 (loud)", scriptA.status === 1, `${scriptA.stdout}\n${scriptA.stderr}`);
      const manifestA = JSON.parse(readFileSync(join(outA, "manifest.json"), "utf8")) as {
        counts: Record<string, number>;
        failures: { artifact_id: string; status: number }[];
      };
      check(
        "script A: 커서 체이닝 2건 + 실패 artifact 보고(404)",
        manifestA.counts.runs === 2 && manifestA.counts.human_tasks === 2 && manifestA.counts.artifacts_listed === 2
          && manifestA.counts.artifacts_downloaded === 1 && manifestA.counts.artifacts_failed === 1
          && manifestA.failures[0]?.artifact_id === ART_OLD && manifestA.failures[0]?.status === 404,
        JSON.stringify(manifestA),
      );

      const adminEmpty = await mint(["admin"], TENANT_EMPTY, "admin-empty");
      const outEmpty = mkdtempSync(join(tmpdir(), "rpa-obd-dl-empty-"));
      const scriptEmpty = await runDownloadScript([scriptPath, "--api", apiBase, "--out", outEmpty], {
        ...process.env,
        RPA_OPERATOR_TOKEN: adminEmpty,
      });
      check("download script(빈 테넌트) exit 0 + 0건 명시", scriptEmpty.status === 0 && scriptEmpty.stderr.includes("0건"), `${scriptEmpty.stdout}\n${scriptEmpty.stderr}`);
      const manifestEmpty = JSON.parse(readFileSync(join(outEmpty, "manifest.json"), "utf8")) as { counts: Record<string, number> };
      check(
        "script empty: manifest 0건 + 빈 jsonl 파일 존재",
        manifestEmpty.counts.runs === 0 && manifestEmpty.counts.human_tasks === 0 && manifestEmpty.counts.artifacts_listed === 0
          && existsSync(join(outEmpty, "runs.jsonl")) && readFileSync(join(outEmpty, "runs.jsonl"), "utf8") === "",
        JSON.stringify(manifestEmpty),
      );

      rmSync(outB, { recursive: true, force: true });
      rmSync(outA, { recursive: true, force: true });
      rmSync(outEmpty, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
    rmSync(artifactDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: offboarding export API integration green");
}

main().catch((err) => {
  console.error("FAIL: offboarding export int threw:", err);
  process.exit(1);
});
