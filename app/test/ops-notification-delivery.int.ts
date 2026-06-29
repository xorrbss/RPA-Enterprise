/**
 * Integration test for ops notification sender attempt ledger.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/ops-notification-delivery.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { deliverOpsNotificationAttempt } from "../src/runtime/ops-notification-delivery";
import type { RuntimeJobEnqueuePort } from "../src/runtime/executor-ports";
import type {
  OpsNotificationDeliveryDecision,
  OpsNotificationDeliveryPort,
  OpsNotificationDeliveryRequest,
  RuntimeWorkerJob,
} from "../../ts/runtime-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_ops_notification_delivery_int";
const TENANT_A = "00000000-0000-4000-8000-00000000d111";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

class FakeNotificationPort implements OpsNotificationDeliveryPort {
  readonly binding = {
    kind: "test_fake",
    backendAlias: "local-test-fake",
    evidenceSchemaRef: "ops/notification-local-test@1",
    testOnly: true,
  } as const;

  readonly requests: OpsNotificationDeliveryRequest[] = [];

  constructor(private readonly decision: OpsNotificationDeliveryDecision) {}

  async deliver(input: OpsNotificationDeliveryRequest): Promise<OpsNotificationDeliveryDecision> {
    this.requests.push(input);
    return this.decision;
  }
}

async function seedAttempt(pool: ReturnType<typeof createPool>, attemptId: string, attemptNo = 1, maxAttempts = 3): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO ops_notification_attempts (
         id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
         channel, provider_alias, status, endpoint_secret_ref, route_policy_ref,
         recipient_group_ref, allowed_hosts, attempt_no, max_attempts, next_attempt_at, payload, summary,
         metadata, requested_by, retention_until
       )
       VALUES (
         $1::uuid,$2::uuid,'bot_pool:browser-default',now(),'bot_pool','bot_pool','browser-default',
         'webhook','webhook-primary','pending','secret://rpa/test/notification-sender/notification/webhook/ops-primary',
         'ops-alerts-webhook-primary','ops-primary-oncall',$3::text[],$4,$5,now() - interval '1 second',
         $6::jsonb,'Worker notification attempt.', '{}'::jsonb, 'admin-a', now() + interval '365 days'
       )`,
      [
        attemptId,
        TENANT_A,
        ["hooks.example.com"],
        attemptNo,
        maxAttempts,
        JSON.stringify({ schema: "ops-alert-webhook@1", alert_id: "bot_pool:browser-default" }),
      ],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const enqueued: Array<{ job: RuntimeWorkerJob; delayMs: number | undefined }> = [];
  const enqueuer: RuntimeJobEnqueuePort = {
    async enqueueRuntimeJob(_client, job, delayMs) {
      enqueued.push({ job, delayMs });
    },
  };

  try {
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

    const sentAttemptId = "10000000-0000-4000-8000-000000000001";
    await seedAttempt(pool, sentAttemptId);
    const sentPort = new FakeNotificationPort({ kind: "sent", receiptId: "provider-receipt-1", providerStatusCode: 202 });
    const sentOutcome = await deliverOpsNotificationAttempt(
      {
        pool,
        port: sentPort,
        enqueuer,
        retryAfterMs: 5_000,
        policy: { source: "ops-defaults.md#ops.notification.delivery", maxAttempts: 3 },
      },
      { tenantId: TENANT_A, attemptId: sentAttemptId, correlationId: sentAttemptId },
    );
    const sentRows = await withTenantTx(pool, TENANT_A, async (client) => {
      const attempt = await client.query<{ status: string; receipt_id: string | null }>(
        `SELECT status, receipt_id FROM ops_notification_attempts WHERE id=$1::uuid`,
        [sentAttemptId],
      );
      const delivery = await client.query<{ status: string; receipt_id: string | null; endpoint_secret_ref: string; recipient_group_ref: string | null }>(
        `SELECT status, receipt_id, endpoint_secret_ref, recipient_group_ref FROM ops_notification_deliveries WHERE alert_id='bot_pool:browser-default' ORDER BY recorded_at DESC LIMIT 1`,
      );
      return { attempt: attempt.rows[0], delivery: delivery.rows[0] };
    });
    check("sent attempt updates attempt and records sent receipt",
      sentOutcome.status === "sent" &&
        sentRows.attempt?.status === "sent" &&
        sentRows.attempt.receipt_id === "provider-receipt-1" &&
        sentRows.delivery?.status === "sent" &&
        sentRows.delivery.receipt_id === "provider-receipt-1" &&
        sentRows.delivery.recipient_group_ref === "ops-primary-oncall" &&
        sentPort.requests[0]?.recipientGroupRef === "ops-primary-oncall" &&
        sentRows.delivery.endpoint_secret_ref.startsWith("secret://"),
      JSON.stringify(sentRows));

    const retryAttemptId = "10000000-0000-4000-8000-000000000002";
    await seedAttempt(pool, retryAttemptId, 1, 2);
    const retryPort = new FakeNotificationPort({ kind: "transient_failed", reason: "webhook_http_503", providerStatusCode: 503 });
    const retryOutcome = await deliverOpsNotificationAttempt(
      {
        pool,
        port: retryPort,
        enqueuer,
        retryAfterMs: 7_000,
        policy: { source: "ops-defaults.md#ops.notification.delivery", maxAttempts: 2 },
      },
      { tenantId: TENANT_A, attemptId: retryAttemptId, correlationId: retryAttemptId },
    );
    const retryRows = await withTenantTx(pool, TENANT_A, async (client) => {
      const attempts = await client.query<{ id: string; status: string; attempt_no: number; error_code: string | null; recipient_group_ref: string | null }>(
        `SELECT id::text, status, attempt_no, error_code, recipient_group_ref
           FROM ops_notification_attempts
          WHERE alert_id='bot_pool:browser-default' AND provider_alias='webhook-primary'
          ORDER BY requested_at DESC, attempt_no DESC`,
      );
      const failedReceipt = await client.query<{ status: string; error_code: string | null; recipient_group_ref: string | null }>(
        `SELECT status, error_code, recipient_group_ref
           FROM ops_notification_deliveries
          WHERE status='failed' AND alert_id='bot_pool:browser-default'
          ORDER BY recorded_at DESC LIMIT 1`,
      );
      return { attempts: attempts.rows, failedReceipt: failedReceipt.rows[0] };
    });
    check("transient failure records failed receipt and enqueues next pending attempt",
      retryOutcome.status === "failed" &&
        retryRows.attempts.some((row) => row.id === retryAttemptId && row.status === "failed" && row.error_code === "WEBHOOK_HTTP_503") &&
        retryRows.attempts.some((row) => row.status === "pending" && row.attempt_no === 2 && row.recipient_group_ref === "ops-primary-oncall") &&
        retryRows.failedReceipt?.status === "failed" &&
        retryRows.failedReceipt.error_code === "WEBHOOK_HTTP_503" &&
        retryRows.failedReceipt.recipient_group_ref === "ops-primary-oncall" &&
        enqueued.some((item) => item.job.kind === "ops_notification_send" && item.delayMs === 7_000),
      JSON.stringify(retryRows));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`FAIL: ${failures} ops notification delivery check(s) failed`);
    process.exit(1);
  }
  console.log("ops notification delivery tests: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
