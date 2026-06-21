/**
 * ExecutorChallengeSuspensionPort 구현 (RQ-016). challenge 에서 driver(run-step-driver driveSuspend)가
 * R4(running→suspending)를 적용한 직후 호출 — 공급된 tenant tx 안에서 human_tasks row 생성 + human_task.created
 * 발행 + suspend bookmark 영속. run 을 재전이하지 않는다(R4 는 호출 전 적용됨). R11(suspending→suspended)·
 * resume-token 발행은 driveSuspend 의 후속 단계가 수행한다(이 포트 책임 밖).
 *
 * 도달성: production run-drive(driveClaimedRun/driveResumedRun → driveSuspend)가 이 포트를 거친다(테스트 전용
 * 휴면 경로였던 PgExecutorCompletionCoordinator 는 제거됨). RQ-016 의 "suspendForChallenge 미구현 포트 gap" 은 닫혀
 * production 도달한다.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { ClassifiedException } from "../../../ts/core-types";
import type { EventId } from "../../../ts/runtime-contract";
import type { SideEffectCmd } from "../../../ts/state-machine-types";
import type { ExecutorChallengeSuspensionPort } from "./executor-ports";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "./outbox";

export class PgChallengeSuspensionPort implements ExecutorChallengeSuspensionPort {
  async suspendForChallenge(
    client: PoolClient,
    input: {
      tenantId: string;
      runId: string;
      stepId: string;
      attempt: number;
      correlationId: string;
      exception: ClassifiedException;
      pendingSideEffects: readonly SideEffectCmd[];
      assigneeRole?: string;
      onTimeout?: "fail" | "escalate";
      reason?: string;
    },
  ): Promise<{ readonly emittedEvents: readonly EventId[] }> {
    // R4 pending = [createHumanTask{humanTaskKind}, startBookmark] (coordinator 가 정확히 이 둘을 assert).
    // humanTaskKind 는 createHumanTask 에서 가져온다(하드코딩 금지 — challenge 는 captcha|mfa).
    const createCmd = input.pendingSideEffects.find(
      (c): c is Extract<SideEffectCmd, { kind: "createHumanTask" }> => c.kind === "createHumanTask",
    );
    if (createCmd === undefined) {
      throw new Error("PgChallengeSuspensionPort: pendingSideEffects 에 createHumanTask 부재(조용한 false 금지)");
    }
    if (!input.pendingSideEffects.some((c) => c.kind === "startBookmark")) {
      throw new Error("PgChallengeSuspensionPort: pendingSideEffects 에 startBookmark 부재(조용한 false 금지)");
    }

    // 1) human_tasks row 생성. kind 는 createHumanTask 에서; assignee_role/on_timeout 은 @human_task(R5) input 에서(challenge 는
    //    미지정 → NULL/DDL 기본 'fail'). state='open' 은 DDL 기본. on_timeout NOT NULL 이라 COALESCE 로 기본 'fail' 보장.
    const humanTaskId = randomUUID();
    await client.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, assignee_role, on_timeout)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, COALESCE($6, 'fail'))`,
      [humanTaskId, input.tenantId, input.runId, createCmd.humanTaskKind, input.assigneeRole ?? null, input.onTimeout ?? null],
    );

    // 2) suspend bookmark 영속(전용 runs.bookmark — resume_token 과 분리). 재개 지점 마커(서명 봉투 아님; pageStateRef/kid/hmac 은 R11 후속).
    const bookmarkUpdate = await client.query(
      `UPDATE runs SET bookmark = $3::jsonb, updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [
        input.tenantId,
        input.runId,
        JSON.stringify({ stepId: input.stepId, attempt: input.attempt, reason: input.reason ?? "challenge", humanTaskId }),
      ],
    );
    if (bookmarkUpdate.rowCount !== 1) {
      throw new Error(
        `PgChallengeSuspensionPort: bookmark UPDATE affected ${bookmarkUpdate.rowCount ?? 0} rows (run 부재/테넌트 불일치)`,
      );
    }

    // 3) human_task.created 발행(닫힌 빈 payload). idempotencyKey 는 (run,step,attempt) 고유.
    const emitted = await emitOutboxEvent(client, {
      tenantId: input.tenantId,
      eventType: "human_task.created",
      correlationId: input.correlationId,
      runId: input.runId,
      idempotencyKey: `${input.runId}:${input.stepId}:${input.attempt}:human_task.created`,
      retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
    });

    return { emittedEvents: [emitted.eventId as EventId] };
  }
}
