/**
 * Graphile Worker 큐 런너 어댑터 (D2.5 — architecture.md §0/§5 큐=Graphile 전용).
 *
 * 큐 전송(Graphile Worker)을 RuntimeWorker.handle()에 위임한다. job 페이로드는 RuntimeWorkerJob.
 * 상태변경+job 동일 트랜잭션(README §결정2)은 enqueue측(D4 API/디스패처)이 graphile의
 * `addJob`을 같은 tx에서 호출해 보장한다 — 본 어댑터는 소비측(task) 골격.
 */
import { runOnce, type Task, type TaskList } from "graphile-worker";
import type pg from "pg";

import type { RuntimeWorkerJob } from "../../../ts/runtime-contract";
import { PgRuntimeWorker } from "./runtime-worker";

/** 모든 RuntimeWorkerJob을 처리하는 단일 task 식별자. */
export const RUNTIME_JOB_TASK = "process_runtime_job";

export function buildTaskList(pool: pg.Pool): TaskList {
  const worker = new PgRuntimeWorker(pool);
  const task: Task = async (payload) => {
    // graphile는 jsonb로 페이로드를 전달 — RuntimeWorkerJob로 신뢰 경계 검증.
    const job = payload as RuntimeWorkerJob;
    if (job === null || typeof job !== "object" || typeof job.kind !== "string") {
      throw new Error(`process_runtime_job: invalid job payload ${JSON.stringify(payload)}`);
    }
    await worker.handle(job);
  };
  return { [RUNTIME_JOB_TASK]: task };
}

/** 큐의 대기 잡을 1회 소진하고 종료(테스트/배치). 런타임 상시 소비는 graphile `run`. */
export async function runOnceRuntimeWorker(connectionString: string, pool: pg.Pool): Promise<void> {
  await runOnce({ connectionString, taskList: buildTaskList(pool) });
}
