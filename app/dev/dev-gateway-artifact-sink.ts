/**
 * DevVisibleGatewayArtifactSink — dev:serve 전용 LLM 출력 저장소.
 *
 * 프로덕션 PgGatewayArtifactSink는 canonical run_steps 행을 전제로 pending artifact를 만들고 redaction job이 뒤따른다.
 * dev run-loop는 run_steps를 기록하더라도, 데모/로컬 검증 LLM 출력은 run-level artifact로 저장하고
 * redaction_status='not_required'로 즉시 조회 가능하게 둔다. 기록된 step은 반환된 UUID artifact ref만 보존한다.
 * 운영 entrypoint에서는 사용하지 않는다.
 */
import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { safeSerialize } from "../../security/compliance-scaffold";
import type { ArtifactId, ArtifactRef } from "../../ts/core-types";
import type { LLMRequest } from "../../ts/security-middleware-contract";
import { withTenantTx } from "../src/db/pool";
import type { GatewayArtifactSink } from "../src/gateway/llm-gateway";
import type { ObjectStore } from "../src/gateway/pg-gateway-artifact-sink";

type ArtifactMeta = Pick<LLMRequest["metadata"], "tenantId" | "runId" | "stepId" | "attempt">;

export interface DevVisibleGatewayArtifactSinkConfig {
  readonly type?: string;
  readonly retentionDays: number;
}

export class DevVisibleGatewayArtifactSink implements GatewayArtifactSink {
  constructor(
    private readonly pool: Pool,
    private readonly objectStore: ObjectStore,
    private readonly cfg: DevVisibleGatewayArtifactSinkConfig,
  ) {}

  async put(content: string, meta: ArtifactMeta): Promise<ArtifactRef> {
    const normalized = validateInput(content, meta, this.cfg);
    const objectRef = await this.objectStore.put(normalized.content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const artifactId = randomUUID() as ArtifactId;

    try {
      await withTenantTx(this.pool, normalized.tenantId, async (c) => {
        await c.query(
          `INSERT INTO artifacts
             (id, tenant_id, run_id, type, redaction_status, sha256, object_ref, retention_until)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'not_required', $5, $6, now() + ($7::int * interval '1 day'))`,
          [
            artifactId,
            normalized.tenantId,
            normalized.runId,
            normalized.type,
            sha256,
            objectRef,
            normalized.retentionDays,
          ],
        );
      });
      return artifactId;
    } catch (cause) {
      await this.objectStore.delete(objectRef);
      throw new DevVisibleGatewayArtifactSinkError("dev gateway artifact metadata insert failed closed", cause);
    }
  }
}

export class DevVisibleGatewayArtifactSinkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DevVisibleGatewayArtifactSinkError";
  }
}

interface NormalizedDevArtifactInput {
  readonly content: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly type: string;
  readonly retentionDays: number;
}

function validateInput(
  content: string,
  meta: ArtifactMeta,
  cfg: DevVisibleGatewayArtifactSinkConfig,
): NormalizedDevArtifactInput {
  const type = cfg.type ?? "llm_output";
  try {
    safeSerialize({ content, meta, type });
  } catch (cause) {
    throw new DevVisibleGatewayArtifactSinkError("dev gateway artifact content must not contain PlainSecret", cause);
  }

  const tenantId = requireString(meta.tenantId, "metadata.tenantId");
  const runId = requireString(meta.runId, "metadata.runId");
  const retentionDays = cfg.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new DevVisibleGatewayArtifactSinkError("dev gateway artifact retentionDays must be a positive integer");
  }
  return { content, tenantId, runId, type: requireString(type, "type"), retentionDays };
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new DevVisibleGatewayArtifactSinkError(`dev gateway artifact ${label} is required`);
}
