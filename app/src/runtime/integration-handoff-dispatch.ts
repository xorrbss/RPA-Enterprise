import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { SecretRef } from "../../../ts/core-types";
import type {
  IntegrationHandoffDispatchDecision,
  IntegrationHandoffDispatchPort,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import type { CorrelationId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import type { RuntimeJobEnqueuePort } from "./executor-ports";

type IntegrationHandoffDispatchAttemptStatus = "pending" | "sending" | "accepted" | "failed" | "dead_letter";

interface IntegrationHandoffDispatchAttemptRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly provider_alias: string;
  readonly status: IntegrationHandoffDispatchAttemptStatus;
  readonly endpoint_secret_ref: string;
  readonly allowed_hosts: readonly string[];
  readonly request_idempotency_key: string;
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly payload: unknown;
  readonly requested_by: string;
  readonly retention_until: Date;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffDispatchPolicy {
  readonly source: "ops-defaults.md#integration.handoff.dispatch";
  readonly maxAttempts: number;
}

export interface IntegrationHandoffDispatchDeps {
  readonly pool: pg.Pool;
  readonly port: IntegrationHandoffDispatchPort;
  readonly policy: IntegrationHandoffDispatchPolicy;
  readonly retryAfterMs: number;
  readonly enqueuer: RuntimeJobEnqueuePort;
}

export type IntegrationHandoffDispatchOutcome =
  | { readonly status: "accepted"; readonly emitted?: undefined }
  | { readonly status: "failed"; readonly nextAttemptId: string }
  | { readonly status: "dead_letter"; readonly emitted?: undefined }
  | { readonly status: "already_completed"; readonly emitted?: undefined };

export async function dispatchIntegrationHandoffAttempt(
  deps: IntegrationHandoffDispatchDeps,
  input: { readonly tenantId: string; readonly attemptId: string; readonly correlationId: string },
): Promise<IntegrationHandoffDispatchOutcome> {
  const leaseToken = randomUUID();
  const attempt = await claimPendingAttempt(deps.pool, input.tenantId, input.attemptId, leaseToken, deps.policy.maxAttempts);
  if (attempt === null) return { status: "already_completed" };
  if (!isRecord(attempt.payload)) {
    const decision: IntegrationHandoffDispatchDecision = { kind: "permanent_failed", reason: "payload_not_object" };
    await completeFailedAttempt(deps, input, attempt, leaseToken, decision, true);
    return { status: "dead_letter" };
  }

  const decision = await deps.port.dispatch({
    tenantId: input.tenantId as TenantId,
    correlationId: input.correlationId as CorrelationId,
    attemptId: attempt.id,
    handoffId: attempt.handoff_id,
    providerAlias: attempt.provider_alias,
    endpointSecretRef: attempt.endpoint_secret_ref as SecretRef,
    allowedHosts: attempt.allowed_hosts,
    payload: attempt.payload,
    attemptNo: attempt.attempt_no,
  });

  if (decision.kind === "accepted") {
    await completeAcceptedAttempt(deps.pool, input.tenantId, attempt, leaseToken, decision);
    return { status: "accepted" };
  }

  const finalFailure = decision.kind === "permanent_failed" || attempt.attempt_no >= attempt.max_attempts;
  if (finalFailure) {
    await completeFailedAttempt(deps, input, attempt, leaseToken, decision, true);
    return { status: "dead_letter" };
  }
  const nextAttemptId = await completeFailedAttempt(deps, input, attempt, leaseToken, decision, false);
  return { status: "failed", nextAttemptId };
}

async function claimPendingAttempt(
  pool: pg.Pool,
  tenantId: string,
  attemptId: string,
  leaseToken: string,
  configuredMaxAttempts: number,
): Promise<IntegrationHandoffDispatchAttemptRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<IntegrationHandoffDispatchAttemptRow>(
      `UPDATE integration_handoff_dispatch_attempts
          SET status='sending',
              lease_token=$3::uuid,
              started_at=now(),
              updated_at=now()
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid
          AND status='pending'
          AND next_attempt_at <= now()
          AND deleted_at IS NULL
        RETURNING id::text, tenant_id::text, handoff_id::text, provider_alias, status,
                  endpoint_secret_ref, allowed_hosts, request_idempotency_key,
                  attempt_no, LEAST(max_attempts, $4::int) AS max_attempts,
                  payload, requested_by, retention_until, legal_hold`,
      [tenantId, attemptId, leaseToken, configuredMaxAttempts],
    );
    return result.rows[0] ?? null;
  });
}

async function completeAcceptedAttempt(
  pool: pg.Pool,
  tenantId: string,
  attempt: IntegrationHandoffDispatchAttemptRow,
  leaseToken: string,
  decision: Extract<IntegrationHandoffDispatchDecision, { kind: "accepted" }>,
): Promise<void> {
  await withTenantTx(pool, tenantId, async (client) => {
    const updatedAttempt = await client.query(
      `UPDATE integration_handoff_dispatch_attempts
          SET status='accepted',
              receipt_id=$4,
              external_job_id=$5,
              provider_status_code=$6,
              error_code=NULL,
              completed_at=now(),
              updated_at=now()
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid
          AND lease_token=$3::uuid
          AND status='sending'`,
      [tenantId, attempt.id, leaseToken, decision.receiptId, decision.externalJobId ?? null, decision.providerStatusCode],
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new Error(`integration handoff accepted CAS expected 1 row, got ${updatedAttempt.rowCount ?? 0}`);
    }
    const updatedHandoff = await client.query(
      `UPDATE integration_handoffs
          SET status='accepted',
              external_job_id=$3,
              latest_receipt_id=$4,
              latest_error_code=NULL,
              updated_at=now(),
              legal_hold=legal_hold OR $5
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid`,
      [tenantId, attempt.handoff_id, decision.externalJobId ?? null, decision.receiptId, attempt.legal_hold],
    );
    if (updatedHandoff.rowCount !== 1) {
      throw new Error(`integration handoff accepted state update expected 1 row, got ${updatedHandoff.rowCount ?? 0}`);
    }
  });
}

async function completeFailedAttempt(
  deps: IntegrationHandoffDispatchDeps,
  input: { readonly tenantId: string; readonly attemptId: string; readonly correlationId: string },
  attempt: IntegrationHandoffDispatchAttemptRow,
  leaseToken: string,
  decision: Exclude<IntegrationHandoffDispatchDecision, { kind: "accepted" }>,
  finalFailure: boolean,
): Promise<string> {
  const errorCode = redactedErrorCode(decision.reason);
  return withTenantTx(deps.pool, input.tenantId, async (client) => {
    const status: IntegrationHandoffDispatchAttemptStatus = finalFailure ? "dead_letter" : "failed";
    const updatedAttempt = await client.query(
      `UPDATE integration_handoff_dispatch_attempts
          SET status=$4,
              error_code=$5,
              provider_status_code=$6,
              completed_at=now(),
              updated_at=now()
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid
          AND lease_token=$3::uuid
          AND status='sending'`,
      [input.tenantId, attempt.id, leaseToken, status, errorCode, decision.providerStatusCode ?? null],
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new Error(`integration handoff failure CAS expected 1 row, got ${updatedAttempt.rowCount ?? 0}`);
    }

    if (finalFailure) {
      const updatedHandoff = await client.query(
        `UPDATE integration_handoffs
            SET status='failed',
                latest_error_code=$3,
                updated_at=now(),
                legal_hold=legal_hold OR $4
          WHERE tenant_id=$1::uuid
            AND id=$2::uuid`,
        [input.tenantId, attempt.handoff_id, errorCode, attempt.legal_hold],
      );
      if (updatedHandoff.rowCount !== 1) {
        throw new Error(`integration handoff failed state update expected 1 row, got ${updatedHandoff.rowCount ?? 0}`);
      }
      return attempt.id;
    }

    const nextAttemptId = randomUUID();
    await client.query(
      `INSERT INTO integration_handoff_dispatch_attempts (
         id, tenant_id, handoff_id, provider_alias, status,
         endpoint_secret_ref, allowed_hosts, request_idempotency_key,
         attempt_no, max_attempts, next_attempt_at, payload,
         requested_by, retention_until, legal_hold
       )
       VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4,'pending',
         $5,$6::text[],$7,
         $8,$9,now() + ($10::double precision * interval '1 millisecond'),$11::jsonb,
         $12,$13::timestamptz,$14
       )`,
      [
        nextAttemptId,
        input.tenantId,
        attempt.handoff_id,
        attempt.provider_alias,
        attempt.endpoint_secret_ref,
        attempt.allowed_hosts,
        attempt.request_idempotency_key,
        attempt.attempt_no + 1,
        attempt.max_attempts,
        deps.retryAfterMs,
        JSON.stringify(attempt.payload),
        attempt.requested_by,
        attempt.retention_until.toISOString(),
        attempt.legal_hold,
      ],
    );
    const job: RuntimeWorkerJob = {
      kind: "integration_handoff_dispatch",
      tenantId: input.tenantId as TenantId,
      correlationId: input.correlationId as CorrelationId,
      integrationHandoff: { attemptId: nextAttemptId },
    };
    await deps.enqueuer.enqueueRuntimeJob(client, job, deps.retryAfterMs);
    return nextAttemptId;
  });
}

function redactedErrorCode(reason: string): string {
  const normalized = reason
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return (normalized.length === 0 ? "INTEGRATION_HANDOFF_DISPATCH_FAILED" : normalized).slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
