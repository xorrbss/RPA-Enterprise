/**
 * PgGatewayArtifactSink — GatewayArtifactSink 의 PostgreSQL 구현 (D5 — llm-gateway-adapter.md §6 / db artifacts).
 *
 * LLM 출력(누적 텍스트/추출 JSON)을 object store(바이트)에 쓰고 artifacts(메타) 행을 insert 한 뒤
 * artifacts.id 를 outputRef(ArtifactRef)로 반환한다. object_ref 는 raw storage locator 이며 redaction/RBAC
 * 전 실행 결과로 노출하지 않는다. withTenantTx(RLS strict app.tenant_id) 위에서 동작한다.
 *
 * `LLMRequest.metadata` 의 canonical `(run_id, step_id, attempt)`를 artifacts에 저장한다.
 * 해당 `run_steps` row가 없으면 FK로 실패한다. 이 sink는 redaction_status='pending'
 * metadata만 만들고 redaction/retention job을 대체하지 않는다.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeSerialize } from "../../../security/compliance-scaffold";
import type { ArtifactId, ArtifactRef, ObjectRef } from "../../../ts/core-types";
import type { LLMRequest } from "../../../ts/security-middleware-contract";
import type { PgPool } from "../db/pool";
import { withTenantTx } from "../db/pool";
import type { GatewayArtifactSink } from "./llm-gateway";

type ArtifactMeta = Pick<LLMRequest["metadata"], "tenantId" | "runId" | "stepId" | "attempt">;

/** 바이트 저장소 경계 — object_ref 반환. 프로덕션은 S3/오브젝트 스토리지, 본 구현은 파일시스템. */
export interface ObjectStore {
  put(content: string): Promise<ObjectRef>;
  putBytes(content: Uint8Array): Promise<ObjectRef>;
  /**
   * object 를 **UTF-8 텍스트**로 반환(텍스트 read 경로 — artifact read route 등). 부재 시 null.
   * 비-UTF8 바이트는 lossy 디코드될 수 있으므로 redaction/무결성 경로는 `getBytes()`(raw)를 써야 한다.
   */
  get(objectRef: ObjectRef): Promise<string | null>;
  /**
   * object 의 **RAW 바이트**를 디코드 없이 반환(부재 시 null). redaction 파이프라인은 이 경로로 읽어야
   * 바이너리 fail-closed 가 성립한다 — `get()`(텍스트)은 U+FFFD 치환으로 binary 를 손상시켜 fatal 디코드
   * 가드를 무력화하므로 raw-byte discipline 이 필수다.
   */
  getBytes(objectRef: ObjectRef): Promise<Uint8Array | null>;
  delete(objectRef: ObjectRef): Promise<void>;
}

/** 파일시스템 object store(node:fs). object_ref = file:// URI. */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  async put(content: string): Promise<ObjectRef> {
    const path = join(this.dir, `${randomUUID()}.bin`);
    writeFileSync(path, content, "utf8");
    return pathToFileURL(path).href as ObjectRef;
  }

  async putBytes(content: Uint8Array): Promise<ObjectRef> {
    const path = join(this.dir, `${randomUUID()}.bin`);
    writeFileSync(path, content);
    return pathToFileURL(path).href as ObjectRef;
  }

  async get(objectRef: ObjectRef): Promise<string | null> {
    const target = this.resolveWithinDir(objectRef); // 경로 이탈은 throw(전파 — 무결성/공격 오류, not-found 아님).
    try {
      return readFileSync(target, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // object bytes 부재 → null
      throw err; // 그 외(권한 등)는 전파
    }
  }

  async getBytes(objectRef: ObjectRef): Promise<Uint8Array | null> {
    const target = this.resolveWithinDir(objectRef); // 경로 이탈은 throw(전파 — 무결성/공격 오류, not-found 아님).
    try {
      // 인코딩 미지정 → Buffer(raw 바이트). 디코드/치환 없음(바이너리 fail-closed 보존).
      return new Uint8Array(readFileSync(target));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // object bytes 부재 → null
      throw err; // 그 외(권한 등)는 전파
    }
  }

  async delete(objectRef: ObjectRef): Promise<void> {
    rmSync(this.resolveWithinDir(objectRef), { force: true });
  }

  /** object_ref(file://) → 구성된 디렉터리 내부 경로로 해소(경로 이탈 차단). */
  private resolveWithinDir(objectRef: ObjectRef): string {
    const root = resolve(this.dir);
    const target = resolve(fileURLToPath(objectRef));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new PgGatewayArtifactSinkError("object_ref is outside the configured artifact directory");
    }
    return target;
  }
}

export interface PgGatewayArtifactSinkConfig {
  /** artifacts.type(개방형) — LLM 출력. */
  type?: string;
  /** retention_until = now() + N일(ops-defaults artifact 보존). */
  retentionDays: number;
}

export class PgGatewayArtifactSink implements GatewayArtifactSink {
  constructor(
    private readonly pool: PgPool,
    private readonly objectStore: ObjectStore,
    private readonly cfg: PgGatewayArtifactSinkConfig,
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
             (id, tenant_id, run_id, step_id, attempt, type, media_type, byte_size, redaction_status, sha256, object_ref, retention_until)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7, $8::bigint, 'pending', $9, $10, now() + ($11::int * interval '1 day'))`,
          [
            artifactId,
            normalized.tenantId,
            normalized.runId,
            normalized.stepId,
            normalized.attempt,
            normalized.type,
            "text/plain; charset=utf-8",
            Buffer.byteLength(content, "utf8"),
            sha256,
            objectRef,
            normalized.retentionDays,
          ],
        );
      });
      return artifactId;
    } catch (cause) {
      await this.objectStore.delete(objectRef);
      throw new PgGatewayArtifactSinkError("gateway artifact metadata insert failed closed", cause);
    }
  }
}

export class PgGatewayArtifactSinkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PgGatewayArtifactSinkError";
  }
}

interface NormalizedGatewayArtifactInput {
  content: string;
  tenantId: string;
  runId: string;
  stepId: string;
  attempt: number;
  type: string;
  retentionDays: number;
}

function validateInput(
  content: string,
  meta: ArtifactMeta,
  cfg: PgGatewayArtifactSinkConfig,
): NormalizedGatewayArtifactInput {
  try {
    safeSerialize({ content, meta, type: cfg.type ?? "llm_output" });
  } catch (cause) {
    throw new PgGatewayArtifactSinkError("gateway artifact content must not contain PlainSecret", cause);
  }

  const tenantId = requireString(meta.tenantId, "metadata.tenantId");
  const runId = requireString(meta.runId, "metadata.runId");
  const stepId = requireString(meta.stepId, "metadata.stepId");
  const attempt = meta.attempt;
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new PgGatewayArtifactSinkError("gateway artifact metadata.attempt must be a non-negative integer");
  }
  const type = requireString(cfg.type ?? "llm_output", "type");
  const retentionDays = cfg.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new PgGatewayArtifactSinkError("gateway artifact retentionDays must be a positive integer");
  }

  return { content, tenantId, runId, stepId, attempt, type, retentionDays };
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new PgGatewayArtifactSinkError(`gateway artifact ${label} is required`);
}
