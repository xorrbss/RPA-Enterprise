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
import { RUNTIME_JOB_TASK } from "../worker/graphile-runner";

export interface RunEnqueueInput {
  tenantId: string;
  runId: string;
  correlationId: string;
}

export interface RunEnqueuer {
  /** run create 직후 run_claim 잡을 호출측 트랜잭션(client)으로 인큐(동일 tx 보장). */
  enqueueRunClaim(client: PoolClient, input: RunEnqueueInput): Promise<void>;
  /** abort state-entry 직후 run_abort 잡을 같은 트랜잭션으로 인큐한다. */
  enqueueRunAbort(client: PoolClient, input: RunEnqueueInput): Promise<void>;
}

/** 운영: graphile_worker.add_job을 호출측 트랜잭션에서 실행(상태변경+인큐 원자화). */
export class PgGraphileRunEnqueuer implements RunEnqueuer {
  async enqueueRunClaim(client: PoolClient, input: RunEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "run_claim",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    };
    await client.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      RUNTIME_JOB_TASK,
      JSON.stringify(job),
    ]);
  }

  async enqueueRunAbort(client: PoolClient, input: RunEnqueueInput): Promise<void> {
    const job: RuntimeWorkerJob = {
      kind: "run_abort",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    };
    await client.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      RUNTIME_JOB_TASK,
      JSON.stringify(job),
    ]);
  }
}
