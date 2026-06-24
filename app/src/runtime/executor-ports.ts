/**
 * 실행 런타임이 공유하는 포트(인터페이스) 정의.
 *
 * 과거엔 (테스트 전용으로 휴면이던) executor-completion-coordinator.ts 가 이 포트들을 함께 보유했으나,
 * 그 중복 완료엔진을 제거하면서 production(run-step-driver/worker/run-queue/challenge-suspension-port)이
 * 실제로 의존하는 포트만 여기로 분리했다. 인터페이스-only 모듈(런타임 코드 없음).
 */
import type pg from "pg";

import type { ClassifiedException } from "../../../ts/core-types";
import type { EventId, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { SideEffectCmd } from "../../../ts/state-machine-types";

export interface RuntimeJobEnqueuePort {
  /** delayMs 지정 시 graphile run_at=now()+delay 로 지연 인큐(R3a INIT 재큐 백오프). 미지정=즉시. */
  enqueueRuntimeJob(client: pg.PoolClient, job: RuntimeWorkerJob, delayMs?: number): Promise<void>;
}

export interface ExecutorChallengeSuspensionPort {
  // challenge(R4) 와 @human_task(R5) 두 suspend 트리거가 공유하는 human_task 생성 포트(human_tasks INSERT + human_task.created
  // emit + suspend bookmark). humanTaskKind 는 pendingSideEffects 의 createHumanTask 에서 온다(하드코딩 금지).
  suspendForChallenge(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      stepId: string;
      attempt: number;
      correlationId: string;
      exception: ClassifiedException;
      pendingSideEffects: readonly SideEffectCmd[];
        // @human_task(R5) suspend 시 human_tasks 라우팅/타임아웃 정책(reserved-handlers). challenge(R4)는 omit(둘 다 부재).
        assigneeRole?: string;
        onTimeout?: "fail" | "escalate";
        timeoutMs?: number;
        payload?: Record<string, unknown>;
        resultSchema?: Record<string, unknown>;
        artifactRefs?: readonly string[];
        // bookmark reason 마커("challenge"|"human_task"). 미지정 시 "challenge"(기존 동작 보존).
        reason?: string;
      },
  ): Promise<{ readonly emittedEvents: readonly EventId[]; readonly enqueuedRuntimeJobs?: readonly RuntimeWorkerJob[] }>;
}
