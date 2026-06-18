/**
 * Artifact sink for pre-run scenario generation LLM calls.
 *
 * Run-step gateway artifacts use (run_id, step_id, attempt). Natural-language
 * planning happens before any run or step exists, so this sink stores the model
 * output as a generation-scoped artifact instead of pretending the generation id
 * is a run id.
 */
import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { safeSerialize } from "../../../security/compliance-scaffold";
import type { ArtifactId, ArtifactRef } from "../../../ts/core-types";
import type { LLMRequest } from "../../../ts/security-middleware-contract";
import { withTenantTx, type PgPool } from "../db/pool";
import type { ObjectStore } from "../gateway/pg-gateway-artifact-sink";
import type { GatewayArtifactSink } from "../gateway/llm-gateway";

type ScenarioGenerationArtifactMeta = Pick<LLMRequest["metadata"], "tenantId" | "runId" | "attempt">;

export interface PgScenarioGenerationArtifactSinkConfig {
  readonly type?: string;
  readonly retentionDays: number;
}

export interface ScenarioGenerationArtifactBuffer {
  flushGenerationArtifacts(
    client: PoolClient,
    input: { readonly tenantId: string; readonly generationId: string },
  ): Promise<readonly ArtifactRef[]>;
  discardGenerationArtifacts(generationId: string): Promise<void>;
}

export class PgScenarioGenerationArtifactSink implements GatewayArtifactSink {
  constructor(
    private readonly pool: PgPool,
    private readonly objectStore: ObjectStore,
    private readonly cfg: PgScenarioGenerationArtifactSinkConfig,
  ) {}

  async put(content: string, meta: ScenarioGenerationArtifactMeta): Promise<ArtifactRef> {
    const normalized = validateInput(content, meta, this.cfg);
    const objectRef = await this.objectStore.put(normalized.content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const artifactId = randomUUID() as ArtifactId;

    try {
      await withTenantTx(this.pool, normalized.tenantId, async (client) => {
        await insertScenarioGenerationArtifact(client, {
          artifactId,
          tenantId: normalized.tenantId,
          generationId: normalized.generationId,
          type: normalized.type,
          content: normalized.content,
          sha256,
          objectRef,
          retentionDays: normalized.retentionDays,
        });
      });
      return artifactId;
    } catch (cause) {
      await this.objectStore.delete(objectRef);
      throw new PgScenarioGenerationArtifactSinkError("scenario generation artifact metadata insert failed closed", cause);
    }
  }
}

interface BufferedScenarioGenerationArtifact {
  readonly artifactId: ArtifactId;
  readonly normalized: NormalizedScenarioGenerationArtifactInput;
}

export class BufferedScenarioGenerationArtifactSink implements GatewayArtifactSink, ScenarioGenerationArtifactBuffer {
  private readonly pending = new Map<string, BufferedScenarioGenerationArtifact[]>();

  constructor(
    private readonly objectStore: ObjectStore,
    private readonly cfg: PgScenarioGenerationArtifactSinkConfig,
  ) {}

  async put(content: string, meta: ScenarioGenerationArtifactMeta): Promise<ArtifactRef> {
    const normalized = validateInput(content, meta, this.cfg);
    const artifactId = randomUUID() as ArtifactId;
    const existing = this.pending.get(normalized.generationId) ?? [];
    existing.push({ artifactId, normalized });
    this.pending.set(normalized.generationId, existing);
    return artifactId;
  }

  async flushGenerationArtifacts(
    client: PoolClient,
    input: { readonly tenantId: string; readonly generationId: string },
  ): Promise<readonly ArtifactRef[]> {
    const buffered = this.pending.get(input.generationId) ?? [];
    if (buffered.length === 0) return [];

    const objectRefs: Array<{ readonly artifactId: ArtifactId; readonly objectRef: Awaited<ReturnType<ObjectStore["put"]>> }> = [];
    try {
      for (const item of buffered) {
        if (item.normalized.tenantId !== input.tenantId || item.normalized.generationId !== input.generationId) {
          throw new PgScenarioGenerationArtifactSinkError("buffered generation artifact tenant/generation mismatch");
        }
        const objectRef = await this.objectStore.put(item.normalized.content);
        objectRefs.push({ artifactId: item.artifactId, objectRef });
        await insertScenarioGenerationArtifact(client, {
          artifactId: item.artifactId,
          tenantId: item.normalized.tenantId,
          generationId: item.normalized.generationId,
          type: item.normalized.type,
          content: item.normalized.content,
          sha256: createHash("sha256").update(item.normalized.content).digest("hex"),
          objectRef,
          retentionDays: item.normalized.retentionDays,
        });
      }
    } catch (cause) {
      for (const item of objectRefs) {
        await this.objectStore.delete(item.objectRef);
      }
      throw new PgScenarioGenerationArtifactSinkError("buffered scenario generation artifact flush failed closed", cause);
    }

    this.pending.delete(input.generationId);
    return buffered.map((item) => item.artifactId);
  }

  async discardGenerationArtifacts(generationId: string): Promise<void> {
    this.pending.delete(generationId);
  }
}

export class PgScenarioGenerationArtifactSinkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PgScenarioGenerationArtifactSinkError";
  }
}

interface NormalizedScenarioGenerationArtifactInput {
  readonly content: string;
  readonly tenantId: string;
  readonly generationId: string;
  readonly type: string;
  readonly retentionDays: number;
}

function validateInput(
  content: string,
  meta: ScenarioGenerationArtifactMeta,
  cfg: PgScenarioGenerationArtifactSinkConfig,
): NormalizedScenarioGenerationArtifactInput {
  const type = requireString(cfg.type ?? "scenario_generation_llm_output", "type");
  try {
    safeSerialize({ content, meta, type });
  } catch (cause) {
    throw new PgScenarioGenerationArtifactSinkError("scenario generation artifact content must not contain PlainSecret", cause);
  }

  const tenantId = requireString(meta.tenantId, "metadata.tenantId");
  const generationId = requireString(meta.runId, "metadata.runId/generationId");
  if (!Number.isInteger(meta.attempt) || meta.attempt < 0) {
    throw new PgScenarioGenerationArtifactSinkError("scenario generation artifact metadata.attempt must be a non-negative integer");
  }
  const retentionDays = cfg.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new PgScenarioGenerationArtifactSinkError("scenario generation artifact retentionDays must be a positive integer");
  }

  return { content, tenantId, generationId, type, retentionDays };
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new PgScenarioGenerationArtifactSinkError(`scenario generation artifact ${label} is required`);
}

async function insertScenarioGenerationArtifact(
  client: PoolClient,
  input: {
    readonly artifactId: ArtifactId;
    readonly tenantId: string;
    readonly generationId: string;
    readonly type: string;
    readonly content: string;
    readonly sha256: string;
    readonly objectRef: Awaited<ReturnType<ObjectStore["put"]>>;
    readonly retentionDays: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO artifacts
       (id, tenant_id, generation_id, type, media_type, byte_size, redaction_status, sha256, object_ref, retention_until)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, 'pending', $7, $8, now() + ($9::int * interval '1 day'))`,
    [
      input.artifactId,
      input.tenantId,
      input.generationId,
      input.type,
      "text/plain; charset=utf-8",
      Buffer.byteLength(input.content, "utf8"),
      input.sha256,
      input.objectRef,
      input.retentionDays,
    ],
  );
}
