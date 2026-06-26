/**
 * Run 큐 enqueue 경계 (D4.3 — run create 시 run_claim 잡을 동일 트랜잭션으로 인큐).
 *
 * 계약: architecture §0/§5 · README §결정2 — 큐=Graphile 전용, 상태변경+job 동일 트랜잭션.
 *   D2 graphile-runner의 task `process_runtime_job`(RUNTIME_JOB_TASK)이 RuntimeWorkerJob을 소비한다.
 *   run_claim 잡은 configured PgRuntimeWorker가 소비할 수 있다. D4는 run
 *   행 생성 + enqueue까지만 책임진다(d4-prompt §3).
 */
import type { PoolClient } from "pg";

import type { RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { RuntimeJobEnqueuePort } from "../runtime/executor-ports";
import { runtimeJobTaskIdentifier } from "../worker/graphile-runner";
import { poolFlagFor } from "../worker/pool-forbidden-flags";
import { ApiResponseError } from "./errors";

export type RunPriority = "low" | "medium" | "high" | "critical";

export interface RunEnqueueInput {
  tenantId: string;
  runId: string;
  correlationId: string;
  priority?: RunPriority;
}

/** sink-DLQ replay enqueue 입력(release-decisions D8-A3). 잡 페이로드는 closed: schema_ref/natural_key는
 *  싣지 않는다(sink_idempotency_key는 normalized_records 행에서 산출 — FIX#7, sink-delivery.ts). */
export interface SinkDeliverEnqueueInput {
  tenantId: string;
  normalizedRecordId: string;
  sinkConfigId: string;
  correlationId: string;
}

export interface ArtifactRedactionEnqueueInput {
  tenantId: string;
  runId?: string;
  generationId?: string;
  correlationId: string;
  artifactId?: string;
}

export interface RunEnqueuer {
  /** run create 직후 run_claim 잡을 호출측 트랜잭션(client)으로 인큐(동일 tx 보장). */
  enqueueRunClaim(client: PoolClient, input: RunEnqueueInput): Promise<void>;
  /** abort state-entry 직후 run_abort 잡을 같은 트랜잭션으로 인큐한다. */
  enqueueRunAbort(client: PoolClient, input: RunEnqueueInput): Promise<void>;
  /** sink-DLQ replay: 새 sink_deliver attempt를 호출측 트랜잭션으로 인큐(D8-A3 — 상태전이 아님,
   *  worker가 attempt_no=MAX+1·동일 멱등키 산출). 실 재전달은 worker의 SinkDeliveryPort(egress) 의존. */
  enqueueSinkDeliver(client: PoolClient, input: SinkDeliverEnqueueInput): Promise<void>;
  /** Artifacts need scoped redaction before they become readable; run-less generation artifacts use generationId/artifactId scope. */
  enqueueArtifactRedaction?(client: PoolClient, input: ArtifactRedactionEnqueueInput): Promise<void>;
  /** human_task resolve(R13: suspended→resume_requested) 직후 run_resume 잡을 같은 트랜잭션으로 인큐(원자).
   *  optional: 미지원 enqueuer 가 resolve(R13)에 도달하면 호출측이 loud throw(조용한 stuck 금지). */
  enqueueRunResume?(client: PoolClient, input: RunEnqueueInput): Promise<void>;
}

type WorkerPoolStatus = "active" | "draining" | "disabled";
type WorkerPoolPriority = RunPriority;

const GRAPHILE_PRIORITY_BY_POOL_PRIORITY: Record<WorkerPoolPriority, number> = {
  low: 5,
  medium: 0,
  high: -5,
  critical: -10,
};

const GRAPHILE_PRIORITY_BY_RUN_PRIORITY: Record<RunPriority, number> = {
  low: 5,
  medium: 0,
  high: -5,
  critical: -10,
};

/** 운영: graphile_worker.add_job을 호출측 트랜잭션에서 실행(상태변경+인큐 원자화). */
export class PgGraphileRunEnqueuer implements RunEnqueuer, RuntimeJobEnqueuePort {
  async enqueueRuntimeJob(client: PoolClient, job: RuntimeWorkerJob, delayMs?: number): Promise<void> {
    // delayMs 지정 시 run_at=now()+delay(R3a INIT 재큐 백오프). 음수/비정수는 즉시(now()) — 조용한 무시 아님, 0 하한.
    if (delayMs !== undefined && Number.isFinite(delayMs) && delayMs > 0) {
      await client.query(
        `SELECT graphile_worker.add_job($1, payload := $2::json, run_at := now() + ($3::double precision * interval '1 millisecond'))`,
        [runtimeJobTaskIdentifier(job), JSON.stringify(job), delayMs],
      );
      return;
    }
    await client.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      runtimeJobTaskIdentifier(job),
      JSON.stringify(job),
    ]);
  }

  /**
   * DG-3: run 을 구동하는 job(run_claim/run_resume)을 테넌트의 워커 풀 배정에 따라 `pool:<key>` flag 와 함께
   * 인큐한다. 배정 없으면 'default'(모든 미선언 워커). worker_pool_assignments 는 RLS — 호출측 tenant tx 전제
   * (run create/resume 는 모두 withTenantTx). Graphile 워커의 forbiddenFlags 가 미서비스 풀 job 을 거른다.
   */
  private async enqueueDrivingJobWithPoolFlag(
    client: PoolClient,
    job: RuntimeWorkerJob,
    tenantId: string,
    runPriority?: RunPriority,
  ): Promise<void> {
    const assignment = await client.query<{ pool_key: string; status: WorkerPoolStatus; priority: WorkerPoolPriority }>(
      `SELECT a.pool_key, p.status, p.priority
         FROM worker_pool_assignments a
         JOIN worker_pools p ON p.pool_key = a.pool_key
        WHERE a.tenant_id = $1::uuid`,
      [tenantId],
    );
    const row = assignment.rows[0];
    const poolKey = row?.pool_key ?? "default";
    const effectiveRunPriority = runPriority ?? (await this.loadRunPriority(client, tenantId, job.runId));
    const priority =
      (row === undefined ? GRAPHILE_PRIORITY_BY_POOL_PRIORITY.medium : GRAPHILE_PRIORITY_BY_POOL_PRIORITY[row.priority]) +
      GRAPHILE_PRIORITY_BY_RUN_PRIORITY[effectiveRunPriority];
    if (row !== undefined && row.status !== "active") {
      throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", {
        reason: "worker_pool_unavailable",
        pool_key: row.pool_key,
        status: row.status,
      });
    }
    await client.query(`SELECT graphile_worker.add_job($1, payload := $2::json, flags := $3::text[], priority := $4::int)`, [
      runtimeJobTaskIdentifier(job),
      JSON.stringify(job),
      [poolFlagFor(poolKey)],
      priority,
    ]);
  }

  private async loadRunPriority(client: PoolClient, tenantId: string, runId: unknown): Promise<RunPriority> {
    if (typeof runId !== "string") return "medium";
    const result = await client.query<{ priority: RunPriority }>(
      `SELECT priority FROM runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, runId],
    );
    return result.rows[0]?.priority ?? "medium";
  }

  async enqueueRunClaim(client: PoolClient, input: RunEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "run_claim",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    };
    await this.enqueueDrivingJobWithPoolFlag(client, job, input.tenantId, input.priority);
  }

  async enqueueRunAbort(client: PoolClient, input: RunEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "run_abort",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    };
    await this.enqueueRuntimeJob(client, job);
  }

  async enqueueSinkDeliver(client: PoolClient, input: SinkDeliverEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "sink_deliver",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
      sinkDelivery: { sinkConfigId: input.sinkConfigId, normalizedRecordId: input.normalizedRecordId },
    };
    await this.enqueueRuntimeJob(client, job);
  }

  async enqueueArtifactRedaction(client: PoolClient, input: ArtifactRedactionEnqueueInput): Promise<void> {
    if (input.runId !== undefined && input.generationId !== undefined) {
      throw new Error("artifact_redaction enqueue cannot set both runId and generationId");
    }
    const job: RuntimeWorkerJob = {
      kind: "artifact_redaction",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      ...(input.runId === undefined ? {} : { runId: input.runId as RuntimeWorkerJob["runId"] }),
      ...(input.generationId === undefined ? {} : { generationId: input.generationId as RuntimeWorkerJob["generationId"] }),
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId as RuntimeWorkerJob["artifactId"] } : {}),
    };
    await this.enqueueRuntimeJob(client, job);
  }

  async enqueueRunResume(client: PoolClient, input: RunEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "run_resume",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    };
    await this.enqueueDrivingJobWithPoolFlag(client, job, input.tenantId, input.priority);
  }
}
