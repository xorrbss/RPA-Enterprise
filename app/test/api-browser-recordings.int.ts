/**
 * Integration test for Browser Recorder API.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-browser-recordings.int.ts
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
const SCHEMA = "rpa_browser_recordings_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SITE_A = "71000000-0000-4000-8000-0000000000a1";
const SITE_B = "71000000-0000-4000-8000-0000000000b2";
const IDENTITY_A = "72000000-0000-4000-8000-0000000000a1";
const IDENTITY_B = "72000000-0000-4000-8000-0000000000b2";
const ELEMENT_A_SUBMIT = "73000000-0000-4000-8000-0000000000a1";
const ELEMENT_A_CUSTOMER = "73000000-0000-4000-8000-0000000000a2";
const ELEMENT_B_SUBMIT = "73000000-0000-4000-8000-0000000000b1";
const OPERATOR_SUB = "11111111-0000-4000-8000-000000000001";

const SECRET = new TextEncoder().encode("browser-recordings-int-secret-do-not-use-in-prod-0123456789");
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

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedSite(pool: Pool, tenantId: string, siteId: string, identityId: string, name: string): Promise<void> {
  await withTenantTx(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'green', true)`,
      [siteId, tenantId, name, `https://${name}.example.com`],
    );
    await client.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [identityId, tenantId, siteId, `${name}-identity`],
    );
  });
}

async function seedSiteElement(
  pool: Pool,
  tenantId: string,
  siteId: string,
  elementId: string,
  elementKey: string,
  label: string,
  selector: string,
): Promise<void> {
  await withTenantTx(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO site_element_repository
         (id, tenant_id, site_profile_id, element_key, label, selector, element_type, stability, source)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'button', 'stable', 'manual')`,
      [elementId, tenantId, siteId, elementKey, label, selector],
    );
  });
}

async function recordingCount(pool: Pool, tenantId: string, siteId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM browser_recording_sessions WHERE site_profile_id=$1::uuid`,
      [siteId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

async function eventCount(pool: Pool, tenantId: string, recordingId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM browser_recording_events WHERE recording_session_id=$1::uuid`,
      [recordingId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

async function siteElementUsageCount(pool: Pool, tenantId: string, siteId: string, elementKey: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<{ usage_count: number }>(
      `SELECT usage_count
         FROM site_element_repository
        WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid AND element_key=$3`,
      [tenantId, siteId, elementKey],
    );
    return result.rows[0]?.usage_count ?? 0;
  });
}

async function idempotencyCount(pool: Pool, tenant: string, endpoint: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM control_plane_idempotency_keys
        WHERE tenant_id=$1::uuid AND endpoint=$2 AND idempotency_key=$3`,
      [tenant, endpoint, key],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }

    await seedSite(pool, TENANT_A, SITE_A, IDENTITY_A, "portal-a");
    await seedSite(pool, TENANT_B, SITE_B, IDENTITY_B, "portal-b");
    await seedSiteElement(pool, TENANT_A, SITE_A, ELEMENT_A_SUBMIT, "SubmitButton", "저장소 제출 버튼", "button.repo-submit");
    await seedSiteElement(pool, TENANT_A, SITE_A, ELEMENT_A_CUSTOMER, "CustomerInput", "저장소 고객 입력", "input.repo-customer");
    await seedSiteElement(pool, TENANT_B, SITE_B, ELEMENT_B_SUBMIT, "SubmitButton", "다른 테넌트 버튼", "button.wrong-tenant");

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: OPERATOR_SUB, tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "viewer-a", tenant_id: TENANT_A, roles: ["viewer"] });
      const operatorB = await mint({ sub: "11111111-0000-4000-8000-0000000000b1", tenant_id: TENANT_B, roles: ["operator"] });

      const list = (token: string, siteId = SITE_A) =>
        app.inject({ method: "GET", url: `/v1/sites/${siteId}/recordings`, headers: { authorization: `Bearer ${token}` } });
      const start = (token: string, key?: string, body?: Record<string, unknown>, siteId = SITE_A) =>
        app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/recordings`,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });
      const append = (token: string, recordingId: string, key?: string, body?: Record<string, unknown>, siteId = SITE_A) =>
        app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/recordings/${recordingId}/events`,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: body ?? {},
        });
      const events = (token: string, recordingId: string, siteId = SITE_A, query = "") =>
        app.inject({ method: "GET", url: `/v1/sites/${siteId}/recordings/${recordingId}/events${query}`, headers: { authorization: `Bearer ${token}` } });
      const complete = (token: string, recordingId: string, key?: string, siteId = SITE_A) =>
        app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/recordings/${recordingId}/complete`,
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: {},
        });

      const empty = await list(viewer);
      check("viewer list empty recordings -> 200", empty.statusCode === 200 && JSON.parse(empty.body).items.length === 0, empty.body);

      const created = await start(operator, "rec-start-1", { name: "주문 등록 녹화" });
      const createdBody = JSON.parse(created.body) as { recording_session_id: string; status: string; start_url: string };
      check("operator start recording -> 201", created.statusCode === 201 && createdBody.status === "recording", created.body);
      check("start defaults to site url_pattern", createdBody.start_url === "https://portal-a.example.com", created.body);

      const outsideStart = await start(operator, "rec-start-outside-site", { name: "외부 사이트 녹화", start_url: "https://evil.example.net/orders" });
      check("start_url outside site origin rejected -> 422", outsideStart.statusCode === 422 && outsideStart.body.includes("start_url_site_mismatch"), outsideStart.body);

      const replayStart = await start(operator, "rec-start-1", { name: "주문 등록 녹화" });
      check("start replay returns same recording", replayStart.statusCode === 201 && JSON.parse(replayStart.body).recording_session_id === createdBody.recording_session_id, replayStart.body);
      check("start replay does not duplicate rows", (await recordingCount(pool, TENANT_A, SITE_A)) === 1);

      const appended = await append(operator, createdBody.recording_session_id, "rec-events-1", {
        events: [
          { event_type: "navigate", url: "https://portal-a.example.com/orders/new", label: "주문 등록 페이지" },
          { event_type: "click", selector: "button[type=submit]", element_key: "SubmitButton", label: "제출 버튼" },
          { event_type: "input", selector: "input[name=customer]", element_key: "CustomerInput", label: "고객명", value_preview: "홍*" },
        ],
      });
      check("append events -> 200", appended.statusCode === 200 && JSON.parse(appended.body).event_count === 3, appended.body);

      const replayAppend = await append(operator, createdBody.recording_session_id, "rec-events-1", {
        events: [
          { event_type: "navigate", url: "https://portal-a.example.com/orders/new", label: "주문 등록 페이지" },
          { event_type: "click", selector: "button[type=submit]", element_key: "SubmitButton", label: "제출 버튼" },
          { event_type: "input", selector: "input[name=customer]", element_key: "CustomerInput", label: "고객명", value_preview: "홍*" },
        ],
      });
      check("append replay returns same count", replayAppend.statusCode === 200 && JSON.parse(replayAppend.body).event_count === 3, replayAppend.body);
      check("append replay does not duplicate events", (await eventCount(pool, TENANT_A, createdBody.recording_session_id)) === 3);

      const listedEvents = await events(viewer, createdBody.recording_session_id);
      check("viewer list recording events -> 200", listedEvents.statusCode === 200 && JSON.parse(listedEvents.body).items[1]?.event_type === "click", listedEvents.body);
      check("recording events hide raw sensitive value", !listedEvents.body.includes("password") && !listedEvents.body.includes("token") && !listedEvents.body.includes("cookie"), listedEvents.body);
      const listedEventsPage1 = await events(viewer, createdBody.recording_session_id, SITE_A, "?limit=2");
      const listedEventsPage1Body = JSON.parse(listedEventsPage1.body);
      check("recording events page 1 exposes seq cursor", listedEventsPage1.statusCode === 200 && listedEventsPage1Body.items.length === 2 && listedEventsPage1Body.next_cursor === "2", listedEventsPage1.body);
      const listedEventsPage2 = await events(viewer, createdBody.recording_session_id, SITE_A, `?limit=2&cursor=${listedEventsPage1Body.next_cursor}`);
      check("recording events cursor returns next page", listedEventsPage2.statusCode === 200 && JSON.parse(listedEventsPage2.body).items[0]?.seq === 3 && JSON.parse(listedEventsPage2.body).next_cursor === null, listedEventsPage2.body);

      const sensitive = await append(operator, createdBody.recording_session_id, "rec-events-sensitive", {
        events: [{ event_type: "input", selector: "#pw", value: "plaintext-secret" }],
      });
      check("sensitive raw value field rejected -> 422", sensitive.statusCode === 422 && sensitive.body.includes("sensitive_recording_field_rejected"), sensitive.body);
      check("sensitive rejected before idempotency reserve", (await idempotencyCount(pool, TENANT_A, "appendBrowserRecordingEvents", "rec-events-sensitive")) === 0);

      const redactionRecording = await start(operator, "rec-start-redaction", { name: "Redaction recording" });
      const redactionRecordingId = String(JSON.parse(redactionRecording.body).recording_session_id);
      const redactedAppend = await append(operator, redactionRecordingId, "rec-events-redacted-preview", {
        events: [
          { event_type: "input", selector: "#password", label: "비밀번호", value_preview: "Bearer should-not-persist" },
          { event_type: "input", selector: "#otp", label: "OTP", value_preview: "123456" },
        ],
      });
      check("sensitive value_preview accepted only after server redaction -> 200", redactedAppend.statusCode === 200, redactedAppend.body);
      const redactedEvents = await events(viewer, redactionRecordingId);
      check("redacted value_preview hides bearer token", redactedEvents.statusCode === 200 && redactedEvents.body.includes("[redacted]") && !redactedEvents.body.includes("should-not-persist"), redactedEvents.body);
      check("redacted value_preview hides OTP", !redactedEvents.body.includes("123456"), redactedEvents.body);

      const viewerDenied = await append(viewer, createdBody.recording_session_id, "viewer-append-denied", {
        events: [{ event_type: "click", selector: "#v" }],
      });
      check("viewer append denied -> 403", viewerDenied.statusCode === 403, viewerDenied.body);
      check("viewer denied append did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "appendBrowserRecordingEvents", "viewer-append-denied")) === 0);

      const completed = await complete(operator, createdBody.recording_session_id, "rec-complete-1");
      const completedBody = JSON.parse(completed.body) as {
        status: string;
        event_count: number;
        draft_ir: { start: string; nodes: Record<string, unknown> };
        validation_report: { errors: unknown[]; warnings: unknown[] };
      };
      check("complete recording -> 200", completed.statusCode === 200 && completedBody.status === "completed", completed.body);
      check("complete includes draft ir", completedBody.draft_ir.start === "step_01" && completed.body.includes("click_selector") && completed.body.includes("fill_selector"), completed.body);
      check("complete includes static validation report", Array.isArray(completedBody.validation_report.errors) && Array.isArray(completedBody.validation_report.warnings), completed.body);
      check("complete prefers object repository selector", completed.body.includes("button.repo-submit") && completed.body.includes("input.repo-customer"), completed.body);
      check("complete does not use cross-tenant object selector", !completed.body.includes("button.wrong-tenant"), completed.body);
      check("complete persists event_count", completedBody.event_count === 3, completed.body);
      const submitUsage = await siteElementUsageCount(pool, TENANT_A, SITE_A, "SubmitButton");
      const customerUsage = await siteElementUsageCount(pool, TENANT_A, SITE_A, "CustomerInput");
      const crossTenantUsage = await siteElementUsageCount(pool, TENANT_B, SITE_B, "SubmitButton");
      check("complete increments object repository usage once", submitUsage === 1 && customerUsage === 1, `submit=${submitUsage} customer=${customerUsage}`);
      check("complete leaves cross-tenant object usage untouched", crossTenantUsage === 0, `crossTenant=${crossTenantUsage}`);

      const completedAgain = await complete(operator, createdBody.recording_session_id, "rec-complete-again");
      const submitUsageAfterReplay = await siteElementUsageCount(pool, TENANT_A, SITE_A, "SubmitButton");
      const customerUsageAfterReplay = await siteElementUsageCount(pool, TENANT_A, SITE_A, "CustomerInput");
      check("repeat complete on completed recording -> 200", completedAgain.statusCode === 200 && JSON.parse(completedAgain.body).status === "completed", completedAgain.body);
      check(
        "repeat complete does not increment object repository usage",
        submitUsageAfterReplay === 1 && customerUsageAfterReplay === 1,
        `submit=${submitUsageAfterReplay} customer=${customerUsageAfterReplay}`,
      );

      const selectorRecording = await start(operator, "rec-start-selector", { name: "Selector only recording" });
      const selectorRecordingId = String(JSON.parse(selectorRecording.body).recording_session_id);
      await append(operator, selectorRecordingId, "rec-events-selector", {
        events: [
          { event_type: "click", selector: "button.repo-submit", label: "제출 후보" },
        ],
      });
      const selectorCompleted = await complete(operator, selectorRecordingId, "rec-complete-selector");
      const submitUsageAfterSelector = await siteElementUsageCount(pool, TENANT_A, SITE_A, "SubmitButton");
      check("complete matches object repository by selector without element_key", selectorCompleted.statusCode === 200 && selectorCompleted.body.includes("저장소 제출 버튼 클릭"), selectorCompleted.body);
      check("selector-only recording increments matched object usage", submitUsageAfterSelector === 2, `submit=${submitUsageAfterSelector}`);

      const crossList = await list(operatorB, SITE_A);
      check("cross-tenant list recordings -> 404", crossList.statusCode === 404, crossList.body);
      const crossStart = await start(operatorB, "cross-rec-start", { name: "Cross" }, SITE_A);
      check("cross-tenant start recording -> 404", crossStart.statusCode === 404, crossStart.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} browser recording API checks failed`);
    process.exit(1);
  }
  console.log("PASS: browser recording API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
