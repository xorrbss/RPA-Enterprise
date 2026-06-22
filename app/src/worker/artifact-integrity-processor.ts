// impl-contracts-bundle.md §B artifact_integrity_checker(일배치): 저장된 sha256 ↔ object 실제 해시 대조,
// 불일치 → quarantine(+ 알림). read-only 스캔 + idempotent quarantine 플래그라 claim lease 불필요(중복 실행 안전).
// object I/O(getBytes)는 retention/redaction 과 동일하게 DB tx 밖에서 수행한다.
import { createHash } from "node:crypto";

import type pg from "pg";

import type { ObjectRef } from "../../../ts/core-types";
import type { RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { requireString } from "./runtime-worker-parse";

/** integrity_checker 가 요구하는 최소 object 능력(raw 바이트 read). ObjectStore(Fs/S3)가 구조적으로 충족. */
export interface IntegrityObjectStore {
  getBytes(objectRef: ObjectRef): Promise<Uint8Array | null>;
}

export interface ArtifactIntegrityProcessorDeps {
  readonly workerId?: string;
  readonly artifactIntegrityObjectStore?: IntegrityObjectStore;
  /** 한 틱에서 검사할 최대 artifact 수(상한). 기본 1000. 가득 차면 더 남았음을 loud 로그(no silent cap). */
  readonly artifactIntegrityBatchLimit?: number;
  /** 불일치 알림 채널(테스트 주입). 기본 stderr 구조화 로그. */
  readonly onIntegrityMismatch?: (info: IntegrityMismatch) => void;
}

export interface IntegrityMismatch {
  readonly tenantId: string;
  readonly artifactId: string;
  readonly correlationId: string;
  /** 'hash_mismatch' = 해시 불일치(변조), 'object_missing' = 비-삭제 행인데 object 부재. */
  readonly reason: "hash_mismatch" | "object_missing";
}

const DEFAULT_INTEGRITY_BATCH_LIMIT = 1000;

interface IntegrityCandidate {
  readonly id: string;
  readonly object_ref: string;
  readonly sha256: string;
}

export class ArtifactIntegrityProcessor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: ArtifactIntegrityProcessorDeps,
  ) {}

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_integrity.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_integrity.correlationId");
    requireString(this.deps.workerId, "PgRuntimeWorkerOptions.workerId for artifact_integrity");
    const objectStore = this.deps.artifactIntegrityObjectStore;
    if (objectStore === undefined) {
      throw new Error("RuntimeWorker: artifact_integrity requires an explicit IntegrityObjectStore");
    }
    const limit = this.deps.artifactIntegrityBatchLimit ?? DEFAULT_INTEGRITY_BATCH_LIMIT;
    const onMismatch = this.deps.onIntegrityMismatch ?? defaultMismatchAlert;

    // 검사 대상: read API 가 서빙하는 안정 상태(redacted/not_required), 미삭제·미격리, 기준 sha256 보유.
    const candidates = await withTenantTx(this.pool, tenantId, async (client) => {
      const result = await client.query<IntegrityCandidate>(
        `SELECT id::text, object_ref, sha256
           FROM artifacts
          WHERE tenant_id = $1::uuid
            AND deleted_at IS NULL
            AND quarantine = false
            AND redaction_status IN ('redacted','not_required')
            AND sha256 IS NOT NULL
          ORDER BY created_at ASC, id ASC
          LIMIT $2`,
        [tenantId, limit + 1],
      );
      return result.rows;
    });

    const truncated = candidates.length > limit;
    const batch = truncated ? candidates.slice(0, limit) : candidates;

    let checked = 0;
    let quarantined = 0;
    for (const candidate of batch) {
      const reason = await this.classifyIntegrity(objectStore, candidate);
      checked += 1;
      if (reason === undefined) continue;
      const flagged = await this.quarantineArtifact(tenantId, candidate.id);
      if (!flagged) continue; // 동시 삭제/격리로 CAS 실패 — idempotent skip.
      quarantined += 1;
      onMismatch({ tenantId, artifactId: candidate.id, correlationId, reason });
    }

    if (truncated) {
      // no silent cap: 상한에 걸려 일부 미검사 — 다음 틱이 (격리된 것을 제외하고) 계속 검사한다.
      console.error(
        JSON.stringify({
          at: "artifact_integrity_checker",
          msg: "batch limit reached; remaining artifacts deferred to next tick",
          tenantId,
          correlationId,
          limit,
          checked,
          quarantined,
        }),
      );
    }

    return { kind: "completed", emittedEvents: [] };
  }

  /** 불일치면 reason, 일치(또는 transient read 실패로 판정 보류)면 undefined. transient(getBytes throw)는 격리하지 않고 다음 틱으로. */
  private async classifyIntegrity(
    objectStore: IntegrityObjectStore,
    candidate: IntegrityCandidate,
  ): Promise<IntegrityMismatch["reason"] | undefined> {
    let bytes: Uint8Array | null;
    try {
      bytes = await objectStore.getBytes(candidate.object_ref as ObjectRef);
    } catch {
      // transient object-store 오류(네트워크 등)는 변조 증거가 아니다 — 격리하지 않고 보류(다음 틱 재검사).
      return undefined;
    }
    if (bytes === null) {
      // 비-삭제 행인데 object 부재 = 무결성 실패(바이트 소실). 명시 격리.
      return "object_missing";
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    return actual === candidate.sha256 ? undefined : "hash_mismatch";
  }

  private async quarantineArtifact(tenantId: string, artifactId: string): Promise<boolean> {
    const updated = await withTenantTx(this.pool, tenantId, async (client) =>
      client.query(
        `UPDATE artifacts
            SET quarantine = true
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND deleted_at IS NULL
            AND quarantine = false`,
        [tenantId, artifactId],
      ),
    );
    return updated.rowCount === 1;
  }
}

function defaultMismatchAlert(info: IntegrityMismatch): void {
  // 조용한 false 금지: 불일치는 quarantine(영속 read-차단) + loud 구조화 로그로 알린다.
  console.error(
    JSON.stringify({
      at: "artifact_integrity_checker",
      msg: "artifact integrity mismatch — quarantined",
      tenantId: info.tenantId,
      artifactId: info.artifactId,
      correlationId: info.correlationId,
      reason: info.reason,
    }),
  );
}
