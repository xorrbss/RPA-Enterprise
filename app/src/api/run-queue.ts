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
import type { RuntimeJobEnqueuePort } from "../runtime/executor-completion-coordinator";
import { runtimeJobTaskIdentifier } from "../worker/graphile-runner";

export interface RunEnqueueInput {
  tenantId: string;
  runId: string;
  correlationId: string;
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
  correlationId: string;
}

export interface RunEnqueuer {
  /** run create 직후 run_claim 잡을 호출측 트랜잭션(client)으로 인큐(동일 tx 보장). */
  enqueueRunClaim(client: PoolClient, input: RunEnqueueInput): Promise<void>;
  /** abort state-entry 직후 run_abort 잡을 같은 트랜잭션으로 인큐한다. */
  enqueueRunAbort(client: PoolClient, input: RunEnqueueInput): Promise<void>;
  /** sink-DLQ replay: 새 sink_deliver attempt를 호출측 트랜잭션으로 인큐(D8-A3 — 상태전이 아님,
   *  worker가 attempt_no=MAX+1·동일 멱등키 산출). 실 재전달은 worker의 SinkDeliveryPort(egress) 의존. */
  enqueueSinkDeliver(client: PoolClient, input: SinkDeliverEnqueueInput): Promise<void>;
  /** Run-less generation artifacts need a tenant-scoped redaction pass before they become readable. */
  enqueueArtifactRedaction?(client: PoolClient, input: ArtifactRedactionEnqueueInput): Promise<void>;
  /** human_task resolve(R13: suspended→resume_requested) 직후 run_resume 잡을 같은 트랜잭션으로 인큐(원자).
   *  optional: 미지원 enqueuer 가 resolve(R13)에 도달하면 호출측이 loud throw(조용한 stuck 금지). */
  enqueueRunResume?(client: PoolClient, input: RunEnqueueInput): Promise<void>;
}

/** 운영: graphile_worker.add_job을 호출측 트랜잭션에서 실행(상태변경+인큐 원자화). */
export class PgGraphileRunEnqueuer implements RunEnqueuer, RuntimeJobEnqueuePort {
  async enqueueRuntimeJob(client: PoolClient, job: RuntimeWorkerJob): Promise<void> {
    await client.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      runtimeJobTaskIdentifier(job),
      JSON.stringify(job),
    ]);
  }

  async enqueueRunClaim(client: PoolClient, input: RunEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "run_claim",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    };
    await this.enqueueRuntimeJob(client, job);
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
    const job: RuntimeWorkerJob = {
      kind: "artifact_redaction",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
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
    await this.enqueueRuntimeJob(client, job);
  }
}
