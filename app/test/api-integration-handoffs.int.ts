/**
 * Integration test for /v1/integration-handoffs.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/api-integration-handoffs.int.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import type { RuntimeJobEnqueuePort } from "../src/runtime/executor-ports";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";
import { webhookSigningPayload } from "../src/api/webhook-trigger-auth";
import { createPool, withTenantTx } from "../src/db/pool";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { IntegrationHandoffDispatchPort, RuntimeWorkerJob } from "../../ts/runtime-contract";
import type { CorrelationId, SecretStoreBoundary, SignedCommandRegistry, TenantId } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_integration_handoffs_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SECRET = new TextEncoder().encode("integration-handoffs-int-secret-do-not-use-in-prod");
const CALLBACK_SIGNATURE_SECRET_REF = "secret://tenant-a/integration/uipath/callback-signing" as SecretRef;
const CALLBACK_SIGNATURE_SECRET = "integration-handoff-callback-signing-secret" as PlainSecret;
const DISPATCH_ENDPOINT_SECRET_REF = "secret://tenant-a/integration/uipath/dispatch-endpoint" as SecretRef;

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

const callbackSecretStore: SecretStore = {
  async resolve(ref) {
    if (ref !== CALLBACK_SIGNATURE_SECRET_REF) throw new Error(`unexpected callback secret ref: ${ref}`);
    return CALLBACK_SIGNATURE_SECRET;
  },
};

const callbackBoundaryCalls: Array<{ ref: string; purpose: string; identity: unknown; tenantId: string; connectorId: string | undefined }> = [];
let failCallbackBoundary = false;
const integrationHandoffCallbackSecretBoundary: SecretStoreBoundary = {
  store: callbackSecretStore,
  async authorize(request) {
    return { kind: "allow", ref: request.ref };
  },
  async resolveAuthorized(request) {
    callbackBoundaryCalls.push({
      ref: String(request.ref),
      purpose: request.purpose,
      identity: request.principal.claims.runtime_identity,
      tenantId: request.principal.tenantId,
      connectorId: request.connectorId,
    });
    if (failCallbackBoundary) throw new Error("security audit unavailable");
    return callbackSecretStore.resolve(request.ref);
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

function mint(roles: string[], tenant = TENANT_A, sub = "operator-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function idempotencyCount(pool: Pool, tenant: string, endpoint: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM control_plane_idempotency_keys
        WHERE tenant_id=$1::uuid
          AND endpoint=$2
          AND idempotency_key=$3`,
      [tenant, endpoint, key],
    );
    return Number(result.rows[0]?.n ?? "0");
  });
}

async function handoffReceiptCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_handoff_receipts WHERE tenant_id=$1::uuid`,
      [tenant],
    );
    return Number(result.rows[0]?.n ?? "0");
  });
}

async function dispatchAttemptCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_handoff_dispatch_attempts WHERE tenant_id=$1::uuid`,
      [tenant],
    );
    return Number(result.rows[0]?.n ?? "0");
  });
}

async function dispatchAttemptStatus(pool: Pool, tenant: string, attemptId: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ status: string }>(
      `SELECT status FROM integration_handoff_dispatch_attempts WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenant, attemptId],
    );
    return result.rows[0]?.status ?? null;
  });
}

async function handoffState(
  pool: Pool,
  tenant: string,
  handoffId: string,
): Promise<{ status: string; externalJobId: string | null; latestReceiptId: string | null } | null> {
  return withTenantTx(pool, tenant, async (client) => {
    const result = await client.query<{ status: string; external_job_id: string | null; latest_receipt_id: string | null }>(
      `SELECT status, external_job_id, latest_receipt_id
         FROM integration_handoffs
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenant, handoffId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { status: row.status, externalJobId: row.external_job_id, latestReceiptId: row.latest_receipt_id };
  });
}

function integrationHandoffDispatchJob(attemptId: string): RuntimeWorkerJob {
  return {
    kind: "integration_handoff_dispatch",
    tenantId: TENANT_A as TenantId,
    correlationId: "55000000-0000-4000-8000-000000000123" as CorrelationId,
    integrationHandoff: { attemptId },
  };
}

function signedCallbackHeaders(
  receiptId: string,
  payload: Record<string, unknown>,
  timestamp = String(Math.floor(Date.now() / 1000)),
): Record<string, string> {
  const signature = createHmac("sha256", CALLBACK_SIGNATURE_SECRET)
    .update(webhookSigningPayload(timestamp, receiptId, payload))
    .digest("hex");
  return {
    "x-rpa-integration-event-id": receiptId,
    "x-rpa-integration-timestamp": timestamp,
    "x-rpa-integration-signature": `sha256=${signature}`,
  };
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const dispatchJobs: Array<{ tenantId: string; attemptId: string; correlationId: string }> = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim() {},
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
    async enqueueOpsNotificationSend() {},
    async enqueueIntegrationHandoffDispatch(_client, input) {
      dispatchJobs.push(input);
    },
  };
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer,
    signedCommandRegistry,
    integrationHandoffCallbackSecretBoundary,
  });

  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid), ($2::uuid)`, [TENANT_A, TENANT_B]);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await app.ready();

    const operator = await mint(["operator"], TENANT_A, "operator-a");
    const admin = await mint(["admin"], TENANT_A, "admin-a");
    const viewer = await mint(["viewer"], TENANT_A, "viewer-a");
    const operatorB = await mint(["operator"], TENANT_B, "operator-b");

    const validBody = {
      provider_alias: "uipath-primary",
      job_ref: "queue:invoice-posting",
      payload_ref: "artifact://handoff/invoice-posting-001",
      callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
      callback_signature_secret_ref: CALLBACK_SIGNATURE_SECRET_REF,
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/integration-handoffs",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-create-1" },
      payload: validBody,
    });
    check("operator create handoff -> 202", created.statusCode === 202, created.body);
    const createdBody = created.json() as {
      handoff_id: string;
      status: string;
      provider_alias: string;
      external_job_id: string | null;
      callback_url_secret_ref: string | null;
      callback_signature_secret_ref: string | null;
      request_idempotency_key: string;
    };
    check("create is ledger-only deferred", createdBody.status === "deferred" && createdBody.external_job_id === null, created.body);
    check("SecretRef callback alias is preserved without secret material", createdBody.callback_url_secret_ref === validBody.callback_url_secret_ref, created.body);
    check("callback signing SecretRef is preserved without secret material", createdBody.callback_signature_secret_ref === CALLBACK_SIGNATURE_SECRET_REF, created.body);
    check("request idempotency key is stored", createdBody.request_idempotency_key === "handoff-create-1", created.body);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/integration-handoffs",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-create-1" },
      payload: validBody,
    });
    check("same idempotency key replays same handoff", replay.statusCode === 202 && replay.json().handoff_id === createdBody.handoff_id, replay.body);

    const viewerDenied = await app.inject({
      method: "POST",
      url: "/v1/integration-handoffs",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "handoff-viewer-denied" },
      payload: validBody,
    });
    check("viewer create handoff denied -> 403", viewerDenied.statusCode === 403 && viewerDenied.json().code === "AUTHZ_FORBIDDEN", viewerDenied.body);
    check(
      "viewer denied request did not reserve idempotency",
      (await idempotencyCount(pool, TENANT_A, "createIntegrationHandoff", "handoff-viewer-denied")) === 0,
    );

    const rawUrl = await app.inject({
      method: "POST",
      url: "/v1/integration-handoffs",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-raw-url" },
      payload: { ...validBody, callback_url_secret_ref: "https://callback.example.com/hook" },
    });
    check("raw callback URL rejected -> 422", rawUrl.statusCode === 422 && rawUrl.json().code === "IR_SCHEMA_INVALID", rawUrl.body);
    check(
      "raw callback URL rejection did not reserve idempotency",
      (await idempotencyCount(pool, TENANT_A, "createIntegrationHandoff", "handoff-raw-url")) === 0,
    );

    const secretInline = await app.inject({
      method: "POST",
      url: "/v1/integration-handoffs",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-inline-secret" },
      payload: { ...validBody, job_ref: "queue:invoice token=plain-secret" },
    });
    check("inline token in job_ref rejected -> 422", secretInline.statusCode === 422 && secretInline.json().code === "IR_SCHEMA_INVALID", secretInline.body);

    const list = await app.inject({
      method: "GET",
      url: "/v1/integration-handoffs?provider_alias=uipath-primary",
      headers: { authorization: `Bearer ${operator}` },
    });
    check("operator list handoffs -> 200", list.statusCode === 200, list.body);
    check("list returns tenant A handoff", list.json().items.length === 1 && list.json().items[0].handoff_id === createdBody.handoff_id, list.body);

    const listB = await app.inject({
      method: "GET",
      url: "/v1/integration-handoffs",
      headers: { authorization: `Bearer ${operatorB}` },
    });
    check("tenant B cannot see tenant A handoff", listB.statusCode === 200 && listB.json().items.length === 0, listB.body);

    const dispatch = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/dispatch`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-dispatch-1" },
      payload: {
        endpoint_secret_ref: DISPATCH_ENDPOINT_SECRET_REF,
        allowed_hosts: ["uipath.example.com"],
        max_attempts: 2,
        metadata: { source: "integration-test" },
      },
    });
    check("operator dispatches handoff -> 202", dispatch.statusCode === 202, dispatch.body);
    const dispatchBody = dispatch.json() as {
      attempt_id: string;
      handoff_id: string;
      status: string;
      endpoint_secret_ref: string;
      allowed_hosts: readonly string[];
      request_idempotency_key: string;
      attempt_no: number;
      max_attempts: number;
    };
    check("dispatch attempt is pending and stores only SecretRef endpoint", dispatchBody.status === "pending" && dispatchBody.endpoint_secret_ref === DISPATCH_ENDPOINT_SECRET_REF, dispatch.body);
    check("dispatch attempt records allowed host allow-list", dispatchBody.allowed_hosts.length === 1 && dispatchBody.allowed_hosts[0] === "uipath.example.com", dispatch.body);
    check("dispatch attempt idempotency key is stored", dispatchBody.request_idempotency_key === "handoff-dispatch-1", dispatch.body);
    check("dispatch enqueued one runtime job", dispatchJobs.length === 1 && dispatchJobs[0]?.attemptId === dispatchBody.attempt_id, JSON.stringify(dispatchJobs));
    check("dispatch attempt ledger row persisted", (await dispatchAttemptCount(pool, TENANT_A)) === 1);

    const dispatchReplay = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/dispatch`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-dispatch-1" },
      payload: {
        endpoint_secret_ref: DISPATCH_ENDPOINT_SECRET_REF,
        allowed_hosts: ["uipath.example.com"],
        max_attempts: 2,
        metadata: { source: "integration-test" },
      },
    });
    check("same dispatch idempotency key replays same attempt", dispatchReplay.statusCode === 202 && dispatchReplay.json().attempt_id === dispatchBody.attempt_id, dispatchReplay.body);
    check("dispatch replay does not enqueue duplicate job", dispatchJobs.length === 1, JSON.stringify(dispatchJobs));

    const dispatchRawEndpoint = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/dispatch`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-dispatch-raw-endpoint" },
      payload: { endpoint_secret_ref: "https://uipath.example.com/jobs", allowed_hosts: ["uipath.example.com"] },
    });
    check("raw dispatch endpoint URL rejected -> 422", dispatchRawEndpoint.statusCode === 422 && dispatchRawEndpoint.json().code === "IR_SCHEMA_INVALID", dispatchRawEndpoint.body);
    check(
      "raw dispatch endpoint rejection did not reserve idempotency",
      (await idempotencyCount(pool, TENANT_A, "dispatchIntegrationHandoff", "handoff-dispatch-raw-endpoint")) === 0,
    );

    const dispatchEndpointMetadata = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/dispatch`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-dispatch-endpoint-metadata" },
      payload: {
        endpoint_secret_ref: DISPATCH_ENDPOINT_SECRET_REF,
        allowed_hosts: ["uipath.example.com"],
        metadata: { endpoint_url: "redacted" },
      },
    });
    check(
      "dispatch metadata endpoint-like key rejected -> 422",
      dispatchEndpointMetadata.statusCode === 422 && dispatchEndpointMetadata.json().code === "IR_SCHEMA_INVALID",
      dispatchEndpointMetadata.body,
    );
    check(
      "dispatch metadata key rejection did not reserve idempotency",
      (await idempotencyCount(pool, TENANT_A, "dispatchIntegrationHandoff", "handoff-dispatch-endpoint-metadata")) === 0,
    );

    const dispatchLocalhost = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/dispatch`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "handoff-dispatch-localhost" },
      payload: { endpoint_secret_ref: DISPATCH_ENDPOINT_SECRET_REF, allowed_hosts: ["localhost"] },
    });
    check("localhost dispatch allowed_host rejected -> 422", dispatchLocalhost.statusCode === 422 && dispatchLocalhost.json().code === "IR_SCHEMA_INVALID", dispatchLocalhost.body);

    const viewerDispatchDenied = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/dispatch`,
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "handoff-dispatch-viewer-denied" },
      payload: { endpoint_secret_ref: DISPATCH_ENDPOINT_SECRET_REF, allowed_hosts: ["uipath.example.com"] },
    });
    check("viewer dispatch handoff denied -> 403", viewerDispatchDenied.statusCode === 403 && viewerDispatchDenied.json().code === "AUTHZ_FORBIDDEN", viewerDispatchDenied.body);
    check(
      "viewer dispatch denied did not reserve idempotency",
      (await idempotencyCount(pool, TENANT_A, "dispatchIntegrationHandoff", "handoff-dispatch-viewer-denied")) === 0,
    );

    const dispatchPortCalls: Array<{ attemptId: string; providerAlias: string; endpointSecretRef: string; allowedHosts: readonly string[] }> = [];
    const dispatchPort: IntegrationHandoffDispatchPort = {
      binding: {
        kind: "test_fake",
        backendAlias: "local-test-fake",
        evidenceSchemaRef: "integration/handoff-local-test@1",
        testOnly: true,
      },
      async dispatch(input) {
        dispatchPortCalls.push({
          attemptId: input.attemptId,
          providerAlias: input.providerAlias,
          endpointSecretRef: input.endpointSecretRef,
          allowedHosts: input.allowedHosts,
        });
        return {
          kind: "accepted",
          receiptId: "dispatch-receipt-1",
          providerStatusCode: 202,
          externalJobId: "provider-job-1",
        };
      },
    };
    const retryJobs: Array<{ job: RuntimeWorkerJob; delayMs: number | undefined }> = [];
    const retryEnqueuer: RuntimeJobEnqueuePort = {
      async enqueueRuntimeJob(_client, job, delayMs) {
        retryJobs.push({ job, delayMs });
      },
    };

    let missingPortError: unknown;
    try {
      await new PgRuntimeWorker(pool).handle(integrationHandoffDispatchJob(dispatchBody.attempt_id));
    } catch (err) {
      missingPortError = err;
    }
    check(
      "worker without integration handoff dispatch port fails closed",
      missingPortError instanceof Error && missingPortError.message.includes("requires an injected IntegrationHandoffDispatchPort"),
      missingPortError instanceof Error ? missingPortError.message : String(missingPortError),
    );
    check("missing port leaves dispatch attempt pending", (await dispatchAttemptStatus(pool, TENANT_A, dispatchBody.attempt_id)) === "pending");

    let testFakeWithoutOptInError: unknown;
    try {
      await new PgRuntimeWorker(pool, { integrationHandoffDispatchPort: dispatchPort }).handle(
        integrationHandoffDispatchJob(dispatchBody.attempt_id),
      );
    } catch (err) {
      testFakeWithoutOptInError = err;
    }
    check(
      "test_fake dispatch port without opt-in fails closed",
      testFakeWithoutOptInError instanceof Error &&
        testFakeWithoutOptInError.message.includes("requires explicit allowTestIntegrationHandoffDispatchPort opt-in"),
      testFakeWithoutOptInError instanceof Error ? testFakeWithoutOptInError.message : String(testFakeWithoutOptInError),
    );
    check("test_fake without opt-in leaves dispatch attempt pending", (await dispatchAttemptStatus(pool, TENANT_A, dispatchBody.attempt_id)) === "pending");
    check("test_fake without opt-in does not call dispatch port", dispatchPortCalls.length === 0, JSON.stringify(dispatchPortCalls));

    const workerOutcome = await new PgRuntimeWorker(pool, {
      integrationHandoffDispatchPort: dispatchPort,
      integrationHandoffDispatchMaxAttempts: 2,
      integrationHandoffDispatchRetryAfterMs: 10,
      allowTestIntegrationHandoffDispatchPort: true,
      runtimeJobEnqueuer: retryEnqueuer,
    }).handle(integrationHandoffDispatchJob(dispatchBody.attempt_id));
    check("runtime worker dispatch port accepts provider handoff", workerOutcome.kind === "completed", JSON.stringify(workerOutcome));
    const acceptedHandoffState = await handoffState(pool, TENANT_A, createdBody.handoff_id);
    check(
      "opt-in runtime worker marks attempt and handoff accepted",
      (await dispatchAttemptStatus(pool, TENANT_A, dispatchBody.attempt_id)) === "accepted" &&
        acceptedHandoffState?.status === "accepted" &&
        acceptedHandoffState.externalJobId === "provider-job-1" &&
        acceptedHandoffState.latestReceiptId === "dispatch-receipt-1",
      JSON.stringify(acceptedHandoffState),
    );
    check("runtime dispatch used SecretRef and allowed host boundary inputs", dispatchPortCalls.length === 1 && dispatchPortCalls[0]?.endpointSecretRef === DISPATCH_ENDPOINT_SECRET_REF && dispatchPortCalls[0]?.allowedHosts[0] === "uipath.example.com", JSON.stringify(dispatchPortCalls));
    check("successful runtime dispatch does not schedule retry", retryJobs.length === 0, JSON.stringify(retryJobs));

    const acceptedAfterDispatch = await app.inject({
      method: "GET",
      url: "/v1/integration-handoffs?provider_alias=uipath-primary",
      headers: { authorization: `Bearer ${operator}` },
    });
    check(
      "runtime dispatch acceptance updates handoff state",
      acceptedAfterDispatch.statusCode === 200 &&
        acceptedAfterDispatch.json().items[0]?.status === "accepted" &&
        acceptedAfterDispatch.json().items[0]?.external_job_id === "provider-job-1" &&
        acceptedAfterDispatch.json().items[0]?.latest_receipt_id === "dispatch-receipt-1",
      acceptedAfterDispatch.body,
    );

    const missingError = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/callback`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { external_job_id: "job-123", status: "failed", receipt_id: "receipt-failed" },
    });
    check("failed callback requires redacted error code -> 422", missingError.statusCode === 422 && missingError.json().code === "IR_SCHEMA_INVALID", missingError.body);

    const callback = await app.inject({
      method: "POST",
      url: `/v1/integration-handoffs/${createdBody.handoff_id}/callback`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { external_job_id: "job-123", status: "completed", receipt_id: "receipt-123" },
    });
    check("admin records handoff receipt -> 200", callback.statusCode === 200, callback.body);
    const callbackBody = callback.json() as {
      status: string;
      external_job_id: string | null;
      latest_receipt_id: string | null;
      callback_received_at: string | null;
    };
    check(
      "callback updates latest provider receipt metadata",
      callbackBody.status === "completed" &&
        callbackBody.external_job_id === "job-123" &&
        callbackBody.latest_receipt_id === "receipt-123" &&
        callbackBody.callback_received_at !== null,
      callback.body,
    );

    check("provider receipt ledger row persisted", (await handoffReceiptCount(pool, TENANT_A)) === 1);

    const publicPayload = { external_job_id: "job-456", status: "accepted", receipt_id: "receipt-public-1" };
    failCallbackBoundary = true;
    const auditFail = await app.inject({
      method: "POST",
      url: `/v1/webhooks/integration-handoffs/${TENANT_A}/${createdBody.handoff_id}`,
      headers: signedCallbackHeaders("receipt-public-audit-fail", { ...publicPayload, receipt_id: "receipt-public-audit-fail" }),
      payload: { ...publicPayload, receipt_id: "receipt-public-audit-fail" },
    });
    failCallbackBoundary = false;
    check("public callback secret audit boundary failure is fail-closed -> 500", auditFail.statusCode === 500, auditFail.body);
    check("audit boundary failure creates no receipt ledger", (await handoffReceiptCount(pool, TENANT_A)) === 1);

    const publicCallback = await app.inject({
      method: "POST",
      url: `/v1/webhooks/integration-handoffs/${TENANT_A}/${createdBody.handoff_id}`,
      headers: signedCallbackHeaders("receipt-public-1", publicPayload),
      payload: publicPayload,
    });
    check("signed public handoff callback records receipt without JWT -> 202", publicCallback.statusCode === 202 && publicCallback.json().status === "accepted", publicCallback.body);
    check(
      "public handoff callback resolves signing SecretRef through connector boundary",
      callbackBoundaryCalls.some((call) =>
        call.ref === CALLBACK_SIGNATURE_SECRET_REF &&
        call.purpose === "connector" &&
        call.identity === "api" &&
        call.tenantId === TENANT_A &&
        call.connectorId === "uipath-primary",
      ),
      JSON.stringify(callbackBoundaryCalls),
    );
    check("public callback receipt persisted", (await handoffReceiptCount(pool, TENANT_A)) === 2);

    const replayPublicCallback = await app.inject({
      method: "POST",
      url: `/v1/webhooks/integration-handoffs/${TENANT_A}/${createdBody.handoff_id}`,
      headers: signedCallbackHeaders("receipt-public-1", publicPayload),
      payload: publicPayload,
    });
    check("same signed public receipt replays without duplicate", replayPublicCallback.statusCode === 202 && (await handoffReceiptCount(pool, TENANT_A)) === 2, replayPublicCallback.body);

    const mismatchPayload = { ...publicPayload, status: "completed" };
    const replayMismatch = await app.inject({
      method: "POST",
      url: `/v1/webhooks/integration-handoffs/${TENANT_A}/${createdBody.handoff_id}`,
      headers: signedCallbackHeaders("receipt-public-1", mismatchPayload),
      payload: mismatchPayload,
    });
    check("same public receipt id with different body is rejected -> 412", replayMismatch.statusCode === 412 && replayMismatch.json().code === "SCENARIO_VERSION_CONFLICT", replayMismatch.body);

    const badSignature = await app.inject({
      method: "POST",
      url: `/v1/webhooks/integration-handoffs/${TENANT_A}/${createdBody.handoff_id}`,
      headers: { ...signedCallbackHeaders("receipt-public-bad-sig", { ...publicPayload, receipt_id: "receipt-public-bad-sig" }), "x-rpa-integration-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
      payload: { ...publicPayload, receipt_id: "receipt-public-bad-sig" },
    });
    check("bad public callback signature rejected -> 401", badSignature.statusCode === 401 && badSignature.json().code === "UNAUTHENTICATED", badSignature.body);
    check("bad signature creates no receipt ledger", (await handoffReceiptCount(pool, TENANT_A)) === 2);

    const staleTimestamp = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000));
    const stale = await app.inject({
      method: "POST",
      url: `/v1/webhooks/integration-handoffs/${TENANT_A}/${createdBody.handoff_id}`,
      headers: signedCallbackHeaders("receipt-public-stale", { ...publicPayload, receipt_id: "receipt-public-stale" }, staleTimestamp),
      payload: { ...publicPayload, receipt_id: "receipt-public-stale" },
    });
    check("stale public callback timestamp rejected -> 401", stale.statusCode === 401 && stale.json().code === "UNAUTHENTICATED", stale.body);

    const missing = await app.inject({
      method: "POST",
      url: "/v1/integration-handoffs/00000000-0000-4000-8000-00000000ffff/callback",
      headers: { authorization: `Bearer ${admin}` },
      payload: { external_job_id: "job-999", status: "completed", receipt_id: "receipt-999" },
    });
    check("missing handoff callback -> 404", missing.statusCode === 404 && missing.json().code === "RESOURCE_NOT_FOUND", missing.body);
  } finally {
    await app.close();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`api-integration-handoffs.int: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("api-integration-handoffs.int: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
