/**
 * 런타임 잡 → graphile task 라우팅(순수 판정, R2-3 거처 이동).
 *
 * enqueue 측(runtime/run-queue)과 소비 측(worker/graphile-runner)이 공유하는 단방향 leaf —
 * api↔worker 양방향 의존을 끊기 위해 worker/graphile-runner 에서 분리했다(동작 무변경).
 */
import type { RuntimeWorkerJob } from "../../../ts/runtime-contract";

/** 일반 런타임 작업(task) 식별자: tenant RLS 아래에서 run/outbox/sink 계열만 처리한다. */
export const RUNTIME_CONTROL_JOB_TASK = "process_runtime_job";
/** Artifact lifecycle 전용 task 식별자: BYPASSRLS 운영 role로만 실행해야 한다. */
export const RUNTIME_LIFECYCLE_JOB_TASK = "process_artifact_lifecycle_job";
/** Backward-compatible alias for older tests/call sites. */
export const RUNTIME_JOB_TASK = RUNTIME_CONTROL_JOB_TASK;

export function isArtifactLifecycleRuntimeJob(job: Pick<RuntimeWorkerJob, "kind">): boolean {
  // artifact_integrity 도 BYPASSRLS lifecycle role 로 실행해야 한다(quarantine UPDATE 는 artifacts UPDATE RLS 정책
  // 부재로 tenant role 로는 불가). redaction/retention 과 동일 task 로 라우팅.
  // tenant_offboarding_purge 역시 artifacts 행 삭제(RLS DELETE 정책 부재) + object 삭제가 필요해 lifecycle role 전용.
  return (
    job.kind === "artifact_redaction" ||
    job.kind === "artifact_retention" ||
    job.kind === "artifact_integrity" ||
    job.kind === "artifact_orphan" ||
    job.kind === "tenant_offboarding_purge"
  );
}

export function runtimeJobTaskIdentifier(job: Pick<RuntimeWorkerJob, "kind">): string {
  return isArtifactLifecycleRuntimeJob(job) ? RUNTIME_LIFECYCLE_JOB_TASK : RUNTIME_CONTROL_JOB_TASK;
}
