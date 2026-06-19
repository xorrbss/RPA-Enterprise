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
import { PgRuntimeWorker, type PgRuntimeWorkerOptions } from "./runtime-worker";

/** 일반 런타임 작업(task) 식별자: tenant RLS 아래에서 run/outbox/sink 계열만 처리한다. */
export const RUNTIME_CONTROL_JOB_TASK = "process_runtime_job";
/** Artifact lifecycle 전용 task 식별자: BYPASSRLS 운영 role로만 실행해야 한다. */
export const RUNTIME_LIFECYCLE_JOB_TASK = "process_artifact_lifecycle_job";
/** Backward-compatible alias for older tests/call sites. */
export const RUNTIME_JOB_TASK = RUNTIME_CONTROL_JOB_TASK;

export type RuntimeTaskScope = "control" | "artifact_lifecycle" | "all";

export function isArtifactLifecycleRuntimeJob(job: Pick<RuntimeWorkerJob, "kind">): boolean {
  return job.kind === "artifact_redaction" || job.kind === "artifact_retention";
}

export function runtimeJobTaskIdentifier(job: Pick<RuntimeWorkerJob, "kind">): string {
  return isArtifactLifecycleRuntimeJob(job) ? RUNTIME_LIFECYCLE_JOB_TASK : RUNTIME_CONTROL_JOB_TASK;
}

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
