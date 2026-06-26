/**
 * Integration test for monthly automation performance reports.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-automation-performance-report.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_perf_report_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A1 = "41000000-0000-4000-8000-000000000001";
const SVER_A1 = "41000000-0000-4000-8000-000000000011";
const SCENARIO_A2 = "41000000-0000-4000-8000-000000000002";
const SVER_A2 = "41000000-0000-4000-8000-000000000012";
const SCENARIO_B = "42000000-0000-4000-8000-000000000001";
const SVER_B = "42000000-0000-4000-8000-000000000011";
const RUN_COMPLETED = "43000000-0000-4000-8000-000000000001";
const RUN_FAILED_BUSINESS = "43000000-0000-4000-8000-000000000002";
const RUN_FAILED_SYSTEM = "43000000-0000-4000-8000-000000000003";
const RUN_RERUN_CHILD = "43000000-0000-4000-8000-000000000004";
const RUN_OUTSIDE = "43000000-0000-4000-8000-000000000005";
const RUN_TENANT_B = "44000000-0000-4000-8000-000000000001";
const IDEA_A1 = "45000000-0000-4000-8000-000000000001";
const ROI_A1 = "45000000-0000-4000-8000-000000000011";
const IDEA_A2 = "45000000-0000-4000-8000-000000000002";
const ROI_A2 = "45000000-0000-4000-8000-000000000012";
const IDEA_B = "46000000-0000-4000-8000-000000000001";
const ROI_B = "46000000-0000-4000-8000-000000000011";
const RERUN_ID = "47000000-0000-4000-8000-000000000001";
const SECRET = new TextEncoder().encode("automation-performance-report-secret-do-not-use-0123456789");

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
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.000001;
}

function mint(roles: string[], tenant = TENANT_A, sub = "viewer-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedScenario(pool: Pool, tenant: string, scenarioId: string, versionId: string, name: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)`, [
      scenarioId,
      tenant,
      name,
    ]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'prod', '{"nodes":[]}'::jsonb)`,
      [versionId, tenant, scenarioId],
    );
  });
}

async function seed(pool: Pool): Promise<void> {
  await seedScenario(pool, TENANT_A, SCENARIO_A1, SVER_A1, "Vendor invoice lookup");
  await seedScenario(pool, TENANT_A, SCENARIO_A2, SVER_A2, "=Formula [workflow](javascript:alert(1)) <script>");
  await seedScenario(pool, TENANT_B, SCENARIO_B, SVER_B, "Tenant B hidden workflow");

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, failure_reason, usage_cost, correlation_id, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'completed', '{}'::jsonb, NULL, 1.500000, $1::uuid, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z'),
         ($4::uuid, $2::uuid, $3::uuid, 'failed_business', '{}'::jsonb, '{"code":"BUSINESS_RULE","message":"blocked"}'::jsonb, 0.250000, $4::uuid, '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z'),
         ($5::uuid, $2::uuid, $3::uuid, 'failed_system', '{}'::jsonb, '{"code":"SITE_DOWN","message":"offline"}'::jsonb, 0.500000, $5::uuid, '2026-06-04T00:00:00Z', '2026-06-04T00:00:00Z'),
         ($6::uuid, $2::uuid, $3::uuid, 'completed', '{}'::jsonb, NULL, 0.750000, $6::uuid, '2026-06-05T00:00:00Z', '2026-06-05T00:00:00Z'),
         ($7::uuid, $2::uuid, $3::uuid, 'completed', '{}'::jsonb, NULL, 9.000000, $7::uuid, '2026-05-31T14:59:59Z', '2026-05-31T14:59:59Z')`,
      [RUN_COMPLETED, TENANT_A, SVER_A1, RUN_FAILED_BUSINESS, RUN_FAILED_SYSTEM, RUN_RERUN_CHILD, RUN_OUTSIDE],
    );
    await client.query(
      `INSERT INTO run_reruns (id, tenant_id, source_run_id, child_run_id, mode, params, requested_by, reason, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'same_input', '{}'::jsonb, 'operator-a', 'retry report check', '2026-06-05T00:00:01Z')`,
      [RERUN_ID, TENANT_A, RUN_FAILED_SYSTEM, RUN_RERUN_CHILD],
    );
    await client.query(
      `INSERT INTO automation_ideas (id, tenant_id, title, description, business_owner, department, stage, scenario_id, created_by)
       VALUES
         ($1::uuid, $2::uuid, 'invoice lookup', 'lookup', 'finance owner', 'finance', 'operate', $3::uuid, 'operator-a'),
         ($4::uuid, $2::uuid, 'formula workflow', 'guard csv', 'ops owner', 'ops', 'approved', $5::uuid, 'operator-a')`,
      [IDEA_A1, TENANT_A, SCENARIO_A1, IDEA_A2, SCENARIO_A2],
    );
    await client.query(
      `INSERT INTO roi_estimates
         (id, tenant_id, automation_idea_id, frequency_per_month, minutes_per_case, exception_rate, hourly_cost,
          implementation_effort, monthly_hours_saved, estimated_monthly_value, payback_months, confidence, created_by)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 100, 12, 0, 50000, 1000000, 20, 1000000, 1, 'high', 'operator-a'),
         ($4::uuid, $2::uuid, $5::uuid, 10, 30, 0, 50000, 250000, 5, 250000, 1, 'medium', 'operator-a')`,
      [ROI_A1, TENANT_A, IDEA_A1, ROI_A2, IDEA_A2],
    );
  });

  await withTenantTx(pool, TENANT_B, async (client) => {
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, failure_reason, usage_cost, correlation_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'failed_system', '{}'::jsonb, '{"code":"TENANT_B_ONLY","message":"hidden"}'::jsonb, 99.000000, $1::uuid, '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z')`,
      [RUN_TENANT_B, TENANT_B, SVER_B],
    );
    await client.query(
      `INSERT INTO automation_ideas (id, tenant_id, title, description, business_owner, department, stage, scenario_id, created_by)
       VALUES ($1::uuid, $2::uuid, 'hidden', 'hidden', 'b owner', 'b dept', 'operate', $3::uuid, 'operator-b')`,
      [IDEA_B, TENANT_B, SCENARIO_B],
    );
    await client.query(
      `INSERT INTO roi_estimates
         (id, tenant_id, automation_idea_id, frequency_per_month, minutes_per_case, exception_rate, hourly_cost,
          implementation_effort, monthly_hours_saved, estimated_monthly_value, payback_months, confidence, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 100, 60, 0, 100000, 1000000, 100, 10000000, 0.1, 'high', 'operator-b')`,
      [ROI_B, TENANT_B, IDEA_B],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
  });
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
    await app.ready();

    const viewer = await mint(["viewer"]);
    const noRole = await mint([]);

    const getReport = (token: string, query = "month=2026-06") =>
      app.inject({ method: "GET", url: `/v1/reports/automation-performance?${query}`, headers: { authorization: `Bearer ${token}` } });
    const exportReport = (token: string, query = "month=2026-06&format=csv") =>
      app.inject({ method: "GET", url: `/v1/reports/automation-performance/export?${query}`, headers: { authorization: `Bearer ${token}` } });

    const report = await getReport(viewer);
    const body = report.json();
    check("viewer can read monthly report", report.statusCode === 200 && body.month === "2026-06", report.body);
    check("KST month boundary is returned", body.period_start === "2026-05-31T15:00:00.000Z" && body.period_end === "2026-06-30T15:00:00.000Z", report.body);
    check("summary totals tenant-scoped monthly runs", body.summary.total_runs === 4 && body.summary.completed === 2, JSON.stringify(body.summary));
    check("success rate uses completed / terminal outcomes", approx(body.summary.success_rate, 0.5), String(body.summary.success_rate));
    check("rerun count and rate are included", body.summary.rerun_count === 1 && approx(body.summary.reprocessing_rate, 0.25), JSON.stringify(body.summary));
    check("ROI and gateway cost are summed", body.summary.estimated_hours_saved === 25 && body.summary.estimated_value === 1250000 && body.summary.gateway_cost === 3, JSON.stringify(body.summary));
    check("failure top excludes cross-tenant rows", body.failure_top.every((r: { code: string }) => r.code !== "TENANT_B_ONLY"), JSON.stringify(body.failure_top));
    const workflowNames = (body.by_workflow as Array<{ scenario_name: string }>).map((row) => row.scenario_name);
    check("ROI-only workflow is present", workflowNames.includes("=Formula [workflow](javascript:alert(1)) <script>"), JSON.stringify(workflowNames));

    const csv = await exportReport(viewer);
    check("CSV export returns text/csv", csv.statusCode === 200 && csv.headers["content-type"]?.toString().includes("text/csv") === true, csv.body);
    check("CSV includes workflow section", csv.body.includes("Workflow ROI"), csv.body);
    check("CSV guards spreadsheet formulas", csv.body.includes("\"'=Formula [workflow](javascript:alert(1)) <script>\""), csv.body);

    const xlsx = await exportReport(viewer, "month=2026-06&format=xlsx");
    const xlsxBody = Buffer.from(xlsx.rawPayload);
    const xlsxText = xlsxBody.toString("utf8");
    check("XLSX export returns workbook media type", xlsx.statusCode === 200 && xlsx.headers["content-type"]?.toString().includes("spreadsheetml.sheet") === true, xlsx.body);
    check("XLSX export uses xlsx attachment filename", xlsx.headers["content-disposition"]?.toString().includes("automation-performance-2026-06.xlsx") === true, String(xlsx.headers["content-disposition"]));
    check("XLSX export returns zip container", xlsxBody.subarray(0, 2).equals(Buffer.from("PK")), xlsxBody.subarray(0, 4).toString("hex"));
    check("XLSX includes workflow worksheet", xlsxText.includes("xl/worksheets/sheet3.xml") && xlsxText.includes("Workflow ROI"), xlsxText);
    check("XLSX guards spreadsheet formulas", xlsxText.includes("&apos;=Formula [workflow](javascript:alert(1)) &lt;script&gt;"), xlsxText);

    const poc = await exportReport(viewer, "month=2026-06&format=poc_markdown");
    check("PoC Markdown export returns markdown", poc.statusCode === 200 && poc.headers["content-type"]?.toString().includes("text/markdown") === true, poc.body);
    check("PoC Markdown export uses md attachment filename", poc.headers["content-disposition"]?.toString().includes("automation-performance-poc-2026-06.md") === true, String(poc.headers["content-disposition"]));
    check("PoC Markdown includes summary, failures, workflow ROI, and decision guide", poc.body.includes("## Summary Metrics") && poc.body.includes("## Failure Top N") && poc.body.includes("## Workflow ROI / Cost") && poc.body.includes("## Decision Guide"), poc.body);
    check("PoC Markdown includes report month and decision recommendation", poc.body.includes("2026\\-06") && poc.body.includes("Recommended decision"), poc.body);
    check("PoC Markdown guards spreadsheet formulas", poc.body.includes("'=Formula"), poc.body);
    check("PoC Markdown escapes markdown links", !poc.body.includes("[workflow](javascript:alert(1))") && poc.body.includes("\\[workflow\\]"), poc.body);
    check("PoC Markdown escapes HTML tags", !poc.body.includes("<script>") && poc.body.includes("&lt;script&gt;"), poc.body);
    check("PoC Markdown does not expose secret refs or resolved secret material", !/secret:\/\/|staging\/registry|automation-performance-report-secret/i.test(poc.body), poc.body);

    const invalidMonth = await getReport(viewer, "month=2026-13");
    check("invalid month -> 422", invalidMonth.statusCode === 422 && invalidMonth.json().details?.reason === "invalid_month", invalidMonth.body);

    const invalidFormat = await exportReport(viewer, "month=2026-06&format=pdf");
    check("invalid export format -> 422", invalidFormat.statusCode === 422 && invalidFormat.json().details?.reason === "invalid_export_format", invalidFormat.body);

    const denied = await getReport(noRole);
    check("missing role denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} automation performance report check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: automation performance report integration green");
}

main().catch((err) => {
  console.error("api-automation-performance-report integration fatal:", err);
  process.exit(1);
});
