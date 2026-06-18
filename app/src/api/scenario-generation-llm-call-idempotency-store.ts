/**
 * PostgreSQL LLM idempotency store for natural-language scenario generation.
 *
 * Scenario planning runs before run_steps exist, so it must not write to the
 * run-step scoped stagehand_calls table. This store uses generation_id as the
 * durable logical key and replays only when the planner output JSON and its
 * generation artifact metadata are both durable.
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
import { withTenantTx, type PgClient, type PgPool } from "../db/pool";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RETENTION_DAYS = 90;

export interface ScenarioGenerationLlmCallCleanup {
  discardGenerationLlmCalls(input: { readonly tenantId: string; readonly generationId: string }): Promise<void>;
}

export interface PgScenarioGenerationLlmCallIdempotencyStoreConfig {
  readonly retentionDays?: number;
}

interface ScenarioGenerationLlmCallRow {
  id: string;
  generation_id: string;
  request_hash: string;
  stream_status: string;
  output_ref: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: string | null;
  finish_reason: LLMResponse["finishReason"] | null;
  parsed_json: unknown;
}

export class PgScenarioGenerationLlmCallIdempotencyStore implements LLMCallIdempotencyStore, ScenarioGenerationLlmCallCleanup {
  private readonly tenantsByCallId = new Map<string, string>();
  private readonly retentionDays: number;

  constructor(
    private readonly pool: PgPool,
    cfg: PgScenarioGenerationLlmCallIdempotencyStoreConfig = {},
  ) {
    this.retentionDays = normalizeRetentionDays(cfg.retentionDays);
  }

  async reserve(req: LLMRequest): Promise<LLMIdempotencyReservation> {
    return withTenantTx(this.pool, req.metadata.tenantId, async (client) => {
      const callId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO scenario_generation_llm_calls (
           id, tenant_id, generation_id, correlation_id, step_id, attempt,
           idempotency_key, request_hash, model, prompt_template_version,
           transport, stream_status, retention_until
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int,
           $7, $8, $9, $10, 'sse', 'open',
           now() + ($11::int * interval '1 day')
         )
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          callId,
          req.metadata.tenantId,
          req.metadata.runId,
          req.metadata.correlationId,
          req.metadata.stepId,
          req.metadata.attempt,
          req.idempotencyKey,
          req.requestHash,
          req.model,
          req.promptTemplateVersion,
          this.retentionDays,
        ],
      );
      if (inserted.rowCount === 1) {
        this.tenantsByCallId.set(callId, req.metadata.tenantId);
        return { kind: "reserved", callId, idempotencyKey: req.idempotencyKey };
      }

      const existing = await client.query<ScenarioGenerationLlmCallRow>(
        `SELECT id, generation_id, request_hash, stream_status, output_ref,
                input_tokens, output_tokens, cost, finish_reason, parsed_json
           FROM scenario_generation_llm_calls
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

      if (row.stream_status === "done" && row.output_ref !== null && row.parsed_json !== null) {
        const hasArtifact = await durableGenerationArtifactExists(client, req.metadata.tenantId, row.generation_id, row.output_ref);
        if (hasArtifact) {
          return { kind: "replay", response: responseFromRow(row) };
        }
        await reopenCall(client, req, row.id, this.retentionDays);
        return { kind: "reserved", callId: row.id, idempotencyKey: req.idempotencyKey };
      }

      if (row.stream_status === "error" || row.stream_status === "aborted") {
        await reopenCall(client, req, row.id, this.retentionDays);
        return { kind: "reserved", callId: row.id, idempotencyKey: req.idempotencyKey };
      }
      return { kind: "in_flight", callId: row.id };
    });
  }

  async complete(callId: string, response: LLMResponse): Promise<void> {
    const tenantId = this.requireTenant(callId);
    await withTenantTx(this.pool, tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE scenario_generation_llm_calls
            SET stream_status='done',
                input_tokens=$3::int,
                output_tokens=$4::int,
                cost=$5::numeric,
                output_ref=$6,
                finish_reason=$7,
                parsed_json=$8::jsonb,
                error_code=NULL,
                updated_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          RETURNING id`,
        [
          tenantId,
          callId,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage.cost,
          response.outputRef,
          response.finishReason,
          response.parsedJson === undefined ? null : JSON.stringify(response.parsedJson),
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`scenario generation llm call complete expected 1 row, got ${updated.rowCount ?? 0}`);
      }
    });
  }

  async fail(callId: string, error: AdapterErrorCode): Promise<void> {
    const tenantId = this.requireTenant(callId);
    await withTenantTx(this.pool, tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE scenario_generation_llm_calls
            SET stream_status='error',
                error_code=$3,
                updated_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          RETURNING id`,
        [tenantId, callId, error],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`scenario generation llm call fail expected 1 row, got ${updated.rowCount ?? 0}`);
      }
    });
  }

  async discardGenerationLlmCalls(input: { readonly tenantId: string; readonly generationId: string }): Promise<void> {
    await withTenantTx(this.pool, input.tenantId, async (client) => {
      await client.query(
        `DELETE FROM scenario_generation_llm_calls
          WHERE tenant_id=$1::uuid AND generation_id=$2::uuid`,
        [input.tenantId, input.generationId],
      );
    });
  }

  private requireTenant(callId: string): string {
    const tenantId = this.tenantsByCallId.get(callId);
    if (tenantId === undefined) {
      throw new Error(`scenario generation llm call '${callId}' has no tenant reservation in this process`);
    }
    return tenantId;
  }
}

async function reopenCall(
  client: PgClient,
  req: LLMRequest,
  callId: string,
  retentionDays: number,
): Promise<void> {
  await client.query(
    `UPDATE scenario_generation_llm_calls
        SET stream_status='open',
            output_ref=NULL,
            input_tokens=NULL,
            output_tokens=NULL,
            cost=NULL,
            finish_reason=NULL,
            parsed_json=NULL,
            error_code=NULL,
            model=$3,
            prompt_template_version=$4,
            correlation_id=$5::uuid,
            updated_at=now(),
            retention_until=now() + ($6::int * interval '1 day')
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [req.metadata.tenantId, callId, req.model, req.promptTemplateVersion, req.metadata.correlationId, retentionDays],
  );
}

async function durableGenerationArtifactExists(
  client: PgClient,
  tenantId: string,
  generationId: string,
  outputRef: string,
): Promise<boolean> {
  if (!UUID_RE.test(outputRef)) return false;
  const found = await client.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM artifacts
      WHERE tenant_id=$1::uuid
        AND generation_id=$2::uuid
        AND id=$3::uuid
      LIMIT 1`,
    [tenantId, generationId, outputRef],
  );
  return found.rowCount === 1;
}

function responseFromRow(row: ScenarioGenerationLlmCallRow): LLMResponse {
  return {
    outputRef: row.output_ref as ArtifactRef,
    usage: {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cost: row.cost === null ? 0 : Number(row.cost),
    },
    finishReason: row.finish_reason ?? "stop",
    parsedJson: row.parsed_json,
    stagehandCallId: row.id,
  };
}

function normalizeRetentionDays(value: number | undefined): number {
  const days = value ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("scenario generation llm call retentionDays must be a positive integer");
  }
  return days;
}
