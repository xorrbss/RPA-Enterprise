/**
 * Graphile Worker 큐 런너 어댑터 (D2.5 — architecture.md §0/§5 큐=Graphile 전용).
 *
 * 큐 전송(Graphile Worker)을 RuntimeWorker.handle()에 위임한다. job 페이로드는 RuntimeWorkerJob.
 * 상태변경+job 동일 트랜잭션(README §결정2)은 enqueue측(D4 API/디스패처)이 graphile의
 * `addJob`을 같은 tx에서 호출해 보장한다 — 본 어댑터는 소비측(task) 골격.
 */
import { runOnce, type Task, type TaskList } from "graphile-worker";
import type pg from "pg";

import type { RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import {
  RUNTIME_CONTROL_JOB_TASK,
  RUNTIME_LIFECYCLE_JOB_TASK,
  runtimeJobTaskIdentifier,
} from "../runtime/runtime-job-routing";
import { PgRuntimeWorker, type PgRuntimeWorkerOptions } from "./runtime-worker";

export type RuntimeTaskScope = "control" | "artifact_lifecycle" | "all";

export function buildTaskList(
  pool: pg.Pool,
  workerOptions: PgRuntimeWorkerOptions = {},
  scope: RuntimeTaskScope = "control",
): TaskList {
  const worker = new PgRuntimeWorker(pool, workerOptions);
  const taskList: TaskList = {};
  if (scope === "control" || scope === "all") {
    taskList[RUNTIME_CONTROL_JOB_TASK] = buildTask(worker, RUNTIME_CONTROL_JOB_TASK);
  }
  if (scope === "artifact_lifecycle" || scope === "all") {
    taskList[RUNTIME_LIFECYCLE_JOB_TASK] = buildTask(worker, RUNTIME_LIFECYCLE_JOB_TASK);
  }
  return taskList;
}

function buildTask(worker: PgRuntimeWorker, taskIdentifier: string): Task {
  return async (payload) => {
    // graphile는 jsonb로 페이로드를 전달 — RuntimeWorkerJob로 신뢰 경계 검증.
    const job = payload as RuntimeWorkerJob;
    if (job === null || typeof job !== "object" || typeof job.kind !== "string") {
      throw new Error(`${taskIdentifier}: invalid job payload ${JSON.stringify(payload)}`);
    }
    const routedTask = runtimeJobTaskIdentifier(job);
    if (routedTask !== taskIdentifier) {
      throw new Error(`${taskIdentifier}: refused ${job.kind} payload routed for ${routedTask}`);
    }
    assertRuntimeJobCompleted(job, await worker.handle(job));
  };
}

export function assertRuntimeJobCompleted(job: RuntimeWorkerJob, result: RuntimeJobResult): void {
  if (result.kind === "completed") return;
  if (result.kind === "deferred") {
    throw new Error(
      `process_runtime_job: ${job.kind} deferred with ${result.code}; retryAfterMs=${result.retryAfterMs}`,
    );
  }
  throw new Error(`process_runtime_job: ${job.kind} failed with ${result.code}`);
}

/** 큐의 대기 잡을 1회 소진하고 종료(테스트/배치). 런타임 상시 소비는 graphile `run`. */
export async function runOnceRuntimeWorker(
  connectionString: string,
  pool: pg.Pool,
  workerOptions: PgRuntimeWorkerOptions = {},
  scope: RuntimeTaskScope = "control",
): Promise<void> {
  await runOnce({ connectionString, taskList: buildTaskList(pool, workerOptions, scope) });
}
