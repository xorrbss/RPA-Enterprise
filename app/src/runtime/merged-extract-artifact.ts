import { createHash, randomUUID } from "node:crypto";

import { safeSerialize } from "../../../security/compliance-scaffold";
import type { ArtifactRef } from "../../../ts/core-types";
import type { PgPool } from "../db/pool";
import { withTenantTx } from "../db/pool";
import type { ObjectStore } from "../gateway/pg-gateway-artifact-sink";
import type { ExtractResultPage, MergedExtractResult } from "./extract-result-merge";

export interface MergedExtractArtifactInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly extractPages: readonly ExtractResultPage[];
  readonly mergedExtract: MergedExtractResult;
}

export interface MergedExtractArtifactSink {
  put(input: MergedExtractArtifactInput): Promise<ArtifactRef>;
}

export interface PgMergedExtractArtifactSinkConfig {
  readonly retentionDays: number;
}

export class PgMergedExtractArtifactSink implements MergedExtractArtifactSink {
  constructor(
    private readonly pool: PgPool,
    private readonly objectStore: ObjectStore,
    private readonly cfg: PgMergedExtractArtifactSinkConfig,
  ) {}

  async put(input: MergedExtractArtifactInput): Promise<ArtifactRef> {
    const normalized = normalizeInput(input, this.cfg);
    const content = JSON.stringify({
      schema_version: 1,
      kind: "merged_extract_result",
      run_id: normalized.runId,
      page_count: normalized.mergedExtract.pageCount,
      input_count: normalized.mergedExtract.inputCount,
      duplicate_count: normalized.mergedExtract.duplicateCount,
      natural_keys: normalized.mergedExtract.naturalKeys,
      records: normalized.mergedExtract.records,
      source_pages: normalized.extractPages.map((page) => ({
        node_id: page.nodeId,
        step_id: page.stepId,
        ...(page.artifactRef !== undefined ? { artifact_ref: page.artifactRef } : {}),
      })),
    });
    safeSerialize({ content, tenantId: normalized.tenantId, runId: normalized.runId });

    const objectRef = await this.objectStore.put(content);
    const artifactRef = randomUUID() as ArtifactRef;
    const sha256 = createHash("sha256").update(content).digest("hex");
    try {
      await withTenantTx(this.pool, normalized.tenantId, async (client) => {
        await client.query(
          `INSERT INTO artifacts
             (id, tenant_id, run_id, step_id, attempt, type, media_type, filename, byte_size,
              redaction_status, sha256, object_ref, retention_until)
           VALUES
             ($1::uuid, $2::uuid, $3::uuid, NULL, NULL, 'extract_result_json',
              'application/json; charset=utf-8', $4, $5::bigint, 'pending', $6, $7,
              now() + ($8::int * interval '1 day'))`,
          [
            artifactRef,
            normalized.tenantId,
            normalized.runId,
            `run-${safeFilePart(normalized.runId)}-merged-extract.json`,
            Buffer.byteLength(content, "utf8"),
            sha256,
            objectRef,
            normalized.retentionDays,
          ],
        );
      });
      return artifactRef;
    } catch (cause) {
      await this.objectStore.delete(objectRef);
      throw new MergedExtractArtifactError("merged extract artifact metadata insert failed closed", cause);
    }
  }
}

export class MergedExtractArtifactError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message);
    this.name = "MergedExtractArtifactError";
  }
}

interface NormalizedMergedExtractArtifactInput extends MergedExtractArtifactInput {
  readonly retentionDays: number;
}

function normalizeInput(
  input: MergedExtractArtifactInput,
  cfg: PgMergedExtractArtifactSinkConfig,
): NormalizedMergedExtractArtifactInput {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const runId = requireNonEmpty(input.runId, "runId");
  const correlationId = requireNonEmpty(input.correlationId, "correlationId");
  if (!Number.isInteger(cfg.retentionDays) || cfg.retentionDays <= 0) {
    throw new MergedExtractArtifactError("merged extract artifact retentionDays must be a positive integer");
  }
  return {
    tenantId,
    runId,
    correlationId,
    extractPages: input.extractPages,
    mergedExtract: input.mergedExtract,
    retentionDays: cfg.retentionDays,
  };
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new MergedExtractArtifactError(`merged extract artifact ${label} is required`);
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "run";
}
