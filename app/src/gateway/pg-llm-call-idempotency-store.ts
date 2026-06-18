/**
 * PostgreSQL LLM idempotency store backed by stagehand_calls.
 *
 * The executor records StepResult.stagehandCallIds, and the recorder verifies
 * those IDs against this table. Keeping the idempotency reservation here makes
 * LLM replay, run_steps, and RunTrace point at the same durable row.
 */
import { randomUUID } from "node:crypto";

import type {
  AdapterErrorCode,
  LLMCallIdempotencyStore,
  LLMIdempotencyReservation,
  LLMRequest,
  LLMResponse,
} from "../../../ts/security-middleware-contract";
import type { ArtifactRef } from "../../../ts/core-types";
import type { PgPool } from "../db/pool";
import { withTenantTx } from "../db/pool";

interface StagehandCallRow {
  id: string;
  request_hash: string;
  stream_status: string | null;
  output_ref: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: string | null;
}

export class PgLlmCallIdempotencyStore implements LLMCallIdempotencyStore {
  private readonly tenantsByCallId = new Map<string, string>();

  constructor(private readonly pool: PgPool) {}

  async reserve(req: LLMRequest): Promise<LLMIdempotencyReservation> {
    return withTenantTx(this.pool, req.metadata.tenantId, async (client) => {
      const callId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO stagehand_calls (
           id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash,
           model, transport, stream_status, prompt_template_version
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7, $8, 'sse', 'open', $9)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          callId,
          req.metadata.tenantId,
          req.metadata.runId,
          req.metadata.stepId,
          req.metadata.attempt,
          req.idempotencyKey,
          req.requestHash,
          req.model,
          req.promptTemplateVersion,
        ],
      );
      if (inserted.rowCount === 1) {
        this.tenantsByCallId.set(callId, req.metadata.tenantId);
        return { kind: "reserved", callId, idempotencyKey: req.idempotencyKey };
      }

      const existing = await client.query<StagehandCallRow>(
        `SELECT id, request_hash, stream_status, output_ref, input_tokens, output_tokens, cost
           FROM stagehand_calls
          WHERE tenant_id=$1::uuid AND idempotency_key=$2`,
        [req.metadata.tenantId, req.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        return { kind: "in_flight", callId };
      }
      if (row.request_hash !== req.requestHash) {
        return { kind: "blocked", reason: "request_hash_mismatch" };
      }
      this.tenantsByCallId.set(row.id, req.metadata.tenantId);
      if (row.stream_status === "done" && row.output_ref !== null) {
        return { kind: "replay", response: responseFromRow(row) };
      }
      if (row.stream_status === "error" || row.stream_status === "aborted") {
        await client.query(
          `UPDATE stagehand_calls
              SET stream_status='open',
                  output_ref=NULL,
                  input_tokens=NULL,
                  output_tokens=NULL,
                  cost=NULL,
                  model=$3,
                  prompt_template_version=$4
            WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [req.metadata.tenantId, row.id, req.model, req.promptTemplateVersion],
        );
        return { kind: "reserved", callId: row.id, idempotencyKey: req.idempotencyKey };
      }
      return { kind: "in_flight", callId: row.id };
    });
  }

  async complete(callId: string, response: LLMResponse): Promise<void> {
    const tenantId = this.requireTenant(callId);
    await withTenantTx(this.pool, tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE stagehand_calls
            SET stream_status='done',
                input_tokens=$3::int,
                output_tokens=$4::int,
                cost=$5::numeric,
                output_ref=$6
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          RETURNING id`,
        [
          tenantId,
          callId,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage.cost,
          response.outputRef,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`stagehand call complete expected 1 row, got ${updated.rowCount ?? 0}`);
      }
    });
  }

  async fail(callId: string, _error: AdapterErrorCode): Promise<void> {
    const tenantId = this.requireTenant(callId);
    await withTenantTx(this.pool, tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE stagehand_calls
            SET stream_status='error'
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          RETURNING id`,
        [tenantId, callId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`stagehand call fail expected 1 row, got ${updated.rowCount ?? 0}`);
      }
    });
  }

  private requireTenant(callId: string): string {
    const tenantId = this.tenantsByCallId.get(callId);
    if (tenantId === undefined) {
      throw new Error(`stagehand call '${callId}' has no tenant reservation in this process`);
    }
    return tenantId;
  }
}

function responseFromRow(row: StagehandCallRow): LLMResponse {
  return {
    outputRef: row.output_ref as ArtifactRef,
    usage: {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cost: row.cost === null ? 0 : Number(row.cost),
    },
    finishReason: "stop",
    stagehandCallId: row.id,
  };
}
