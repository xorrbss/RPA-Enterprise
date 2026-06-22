// impl-contracts-bundle.md §B artifact_orphan_sweeper(일배치): object-store 에 있으나 어떤 artifacts.object_ref
// 행도 참조하지 않는 object(=orphan)를 회수한다. orphan 원천: AUD-9 redaction superseded 원본(즉시삭제 실패분)
// + put 성공 후 artifacts INSERT 실패한 부분실패 객체. 모든 put 경로가 put→artifacts INSERT(object_ref)→ArtifactRef
// 반환이고 교차참조(stagehand_calls.output_ref 등)는 ArtifactRef(artifacts.id)이므로, artifacts.object_ref 가
// "참조된 object" 의 완전한 단일 진실원천이다.
//
// ⚠ 안전: 전역 스캔(전 테넌트)이라 **반드시 BYPASSRLS 역할**에서 실행해야 한다(tenant 역할이면 RLS 가 타 테넌트
// 참조 ref 를 숨겨→오판→참조 중 객체 삭제). 따라서 스캔 전 assertLifecycleBypassUse 로 rolbypassrls 를 자기검증한다.
// + grace period(최근 생성 객체는 artifacts INSERT 가 in-flight 일 수 있어 제외) + per-tick 삭제 상한(폭주 방지).
import type pg from "pg";

import type { ObjectRef } from "../../../ts/core-types";
import type { RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { ObjectInventoryEntry } from "../gateway/pg-gateway-artifact-sink";
import { requireString } from "./runtime-worker-parse";
import { assertLifecycleBypassUse } from "./runtime-worker-lifecycle-audit";

/** orphan sweeper 가 요구하는 최소 object 능력: 인벤토리 열거 + 삭제. ObjectStore(Fs/S3)가 구조적으로 충족. */
export interface OrphanInventoryStore {
  list(): Promise<readonly ObjectInventoryEntry[]>;
  delete(objectRef: ObjectRef): Promise<void>;
}

export interface ArtifactOrphanProcessorDeps {
  readonly workerId?: string;
  readonly artifactOrphanInventoryStore?: OrphanInventoryStore;
  /** 최근 생성 객체 보호 유예(ms). 기본 ops-defaults §6. now-lastModified < grace 면 삭제 후보에서 제외. */
  readonly artifactOrphanGraceMs?: number;
  /** object_ref 존재검사 ANY() 배치 크기. 기본 500. */
  readonly artifactOrphanBatchLimit?: number;
  /** 1틱 최대 삭제 수(폭주 안전판). 초과 시 loud 로그 + 중단(no silent cap; 다음 틱 재개). 기본 10000. */
  readonly artifactOrphanMaxDeletesPerTick?: number;
  /** grace 판정 clock(테스트 주입). 기본 Date.now. */
  readonly now?: () => number;
  /** orphan 삭제 알림(테스트 주입). 기본 stderr 구조화 로그. */
  readonly onOrphanDeleted?: (ref: string) => void;
}

// ops-defaults §6 artifact.orphan_grace_default = 24h. 최근 생성 객체(artifacts INSERT in-flight)를 orphan 으로 오판하지 않도록.
const DEFAULT_ARTIFACT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARTIFACT_ORPHAN_BATCH_LIMIT = 500;
const DEFAULT_ARTIFACT_ORPHAN_MAX_DELETES_PER_TICK = 10000;

export class ArtifactOrphanProcessor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: ArtifactOrphanProcessorDeps,
  ) {}

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const correlationId = requireString(job.correlationId, "artifact_orphan.correlationId");
    requireString(this.deps.workerId, "PgRuntimeWorkerOptions.workerId for artifact_orphan");
    const store = this.deps.artifactOrphanInventoryStore;
    if (store === undefined) {
      throw new Error("RuntimeWorker: artifact_orphan requires an explicit OrphanInventoryStore");
    }
    const graceMs = this.deps.artifactOrphanGraceMs ?? DEFAULT_ARTIFACT_ORPHAN_GRACE_MS;
    const batchLimit = this.deps.artifactOrphanBatchLimit ?? DEFAULT_ARTIFACT_ORPHAN_BATCH_LIMIT;
    const maxDeletes = this.deps.artifactOrphanMaxDeletesPerTick ?? DEFAULT_ARTIFACT_ORPHAN_MAX_DELETES_PER_TICK;
    const nowMs = (this.deps.now ?? Date.now)();
    const onDeleted = this.deps.onOrphanDeleted ?? defaultOrphanDeletedAlert;

    // grace 이전(충분히 오래된) 객체만 후보 — 최근 객체는 artifacts INSERT 가 아직 커밋 안 됐을 수 있다.
    const inventory = await store.list();
    const candidates = inventory
      .filter((entry) => nowMs - entry.lastModifiedMs >= graceMs)
      .map((entry) => String(entry.ref));

    const orphanRefs = await this.findOrphanRefs(candidates, batchLimit, correlationId);

    let deleted = 0;
    let capped = false;
    for (const ref of orphanRefs) {
      if (deleted >= maxDeletes) {
        capped = true;
        break;
      }
      await store.delete(ref as ObjectRef);
      deleted += 1;
      onDeleted(ref);
    }

    if (capped) {
      // no silent cap: 1틱 상한 도달 — 나머지는 다음 틱이 회수(idempotent). 폭주/오판 가능성을 운영자에게 알린다.
      console.error(
        JSON.stringify({
          at: "artifact_orphan_sweeper",
          msg: "per-tick delete cap reached; remaining orphans deferred to next tick",
          correlationId,
          scanned: inventory.length,
          candidates: candidates.length,
          orphansFound: orphanRefs.length,
          deleted,
          maxDeletes,
        }),
      );
    }

    return { kind: "completed", emittedEvents: [] };
  }

  /**
   * 후보 ref 중 어떤 artifacts.object_ref 행도 참조하지 않는 것(=orphan)을 가린다. **전역**(전 테넌트) 조회라
   * 스캔 전 BYPASSRLS 역할을 자기검증한다(rolbypassrls; tenant 역할이면 RLS 가 참조 ref 를 숨겨 오판→참조 객체 삭제).
   */
  private async findOrphanRefs(
    candidates: readonly string[],
    batchLimit: number,
    correlationId: string,
  ): Promise<readonly string[]> {
    if (candidates.length === 0) return [];
    const orphans: string[] = [];
    const client = await this.pool.connect();
    try {
      await assertLifecycleBypassUse(client, "artifact_orphan_sweeper", "artifact_lifecycle.orphan.scan");
      void correlationId;
      for (let i = 0; i < candidates.length; i += batchLimit) {
        const batch = candidates.slice(i, i + batchLimit);
        // 전역(테넌트 무필터) — BYPASSRLS 가 전 테넌트 행을 본다. 참조된 ref 집합을 받아 차집합으로 orphan 산출.
        const referenced = await client.query<{ object_ref: string }>(
          `SELECT DISTINCT object_ref FROM artifacts WHERE object_ref = ANY($1::text[])`,
          [batch],
        );
        const referencedSet = new Set(referenced.rows.map((row) => row.object_ref));
        for (const ref of batch) {
          if (!referencedSet.has(ref)) orphans.push(ref);
        }
      }
    } finally {
      client.release();
    }
    return orphans;
  }
}

function defaultOrphanDeletedAlert(ref: string): void {
  // 조용한 false 금지: orphan 삭제를 loud 구조화 로그로 알린다(ObjectRef 는 내부 locator — 운영 로그엔 허용).
  console.error(
    JSON.stringify({ at: "artifact_orphan_sweeper", msg: "unreferenced object reclaimed", objectRef: ref }),
  );
}
