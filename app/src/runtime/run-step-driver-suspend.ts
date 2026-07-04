// run-step-driver.ts 에서 추출 — suspend 경로(driveSuspend/driveOperatorPause + 멱등 키 스코프 + pause 요청 조회,
// 동작 무변경). drive 코어 미호출(leaf) — run-step-driver 가 역import(타입은 type-only 역참조).
import type { Pool } from "pg";

import type { ClassifiedException, PageStateRef, RedactedString } from "../../../ts/core-types";
import type { IsoDateTime, ResumeTokenCodec, ResumeTokenEnvelope } from "../../../ts/runtime-contract";
import type { RunId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "./run-transition";
import type { ScenarioOutcome, SuspendContext } from "./ir-interpreter";
import { enqueueArtifactLifecycleJobsForOutcome } from "./run-step-driver-artifacts";
import { pauseLinkedWorkitemCheckout } from "./workitem-settlement";
import { recordChallenge } from "../observability/telemetry";
import type { ClaimedRun, DriveDeps, DriveResult, RunTerminalRef } from "./run-step-driver";

// ops-defaults.md resume_token.ttl=30m(expiresAt). 코드 상수 금지 규약 — inline 인용(RQ-017 패턴).
export const RESUME_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * suspend 경로(A.1 step2+3). 인터프리터 suspend outcome → R4(running→suspending)+human_task 포트 → resume-token 발행+R11(→suspended).
 * R4+포트는 한 tx(R4 pending=[createHumanTask,startBookmark] 를 포트에 전달). 토큰 발행은 SecretStore.resolve(tx 밖, 네트워크).
 * 토큰 save+R11 은 한 tx(원자: 토큰 없이 suspended 금지). R11 pending(issueResumeToken/releaseLease)은 driver 미소비
 * (success/fail 경로와 동일 — lease 회수는 deferred lease lifecycle; 토큰은 R11 전에 이미 발행·저장).
 */
export async function readOperatorPauseRequest(
  pool: Pool,
  run: RunTerminalRef,
): Promise<{ readonly pauseRequestId: string; readonly reason?: string } | null> {
  return withTenantTx(pool, run.tenantId, async (client) => {
    const result = await client.query<{ id: string; reason: string | null }>(
      `SELECT id::text, reason
         FROM run_pause_requests
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND status = 'requested'
        ORDER BY created_at
        LIMIT 1`,
      [run.tenantId, run.runId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      pauseRequestId: row.id,
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
  });
}

export async function driveSuspend(run: ClaimedRun, deps: DriveDeps, outcome: ScenarioOutcome): Promise<DriveResult> {
  const s: SuspendContext | undefined = outcome.suspend;
  if (s === undefined) {
    throw new Error("driveSuspend: terminal 'suspend' 인데 suspend 컨텍스트 부재(인터프리터 불변 위반)");
  }
  const codec = deps.resumeTokenCodec;
  if (codec === undefined) {
    throw new Error("driveSuspend: suspend 경로는 suspensionPort + resumeTokenCodec 주입 필요(미구성)");
  }

  // §E challenge_rate: challenge 자동 감지(인간개입 @human_task 트리거 제외) 카운트. bootstrap 전이면 no-op meter.
  if (s.kind === "challenge") {
    recordChallenge({ tenant_id: run.tenantId });
  }

  // 멱등 키 per-cycle 스코프 해소(같은 노드 재suspend 시 키 충돌 방지 — resolveSuspendKeyAttempt 참조).
  if (s.kind === "operator_pause") {
    return driveOperatorPause(run, deps, s, codec, outcome);
  }

  const port = deps.suspensionPort;
  if (port === undefined) {
    throw new Error("driveSuspend: challenge/human_task suspend path requires suspensionPort");
  }

  const keyAttempt = await resolveSuspendKeyAttempt(deps.pool, run, s);

  // 1) R4(challenge)/R5(@human_task)(running→suspending) + 포트(human_task INSERT + human_task.created + bookmark) — 한 tenant tx.
  //    두 트리거 모두 pending=[createHumanTask(kind), startBookmark] → 같은 포트가 소비. event/idem 키만 kind 로 분기.
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const event =
      s.kind === "human_task"
        ? ({ type: "human_task_required", humanTaskKind: s.humanTaskKind } as const)
        : ({ type: "step.challenge_detected", challengeKind: s.challengeKind } as const);
    const idemSuffix = s.kind === "human_task" ? "human-task-required" : "challenge-detected";
    const rule = s.kind === "human_task" ? "R5" : "R4";
    const t = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "running",
      event,
      guard: {},
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:${s.stepId}:${keyAttempt}:${idemSuffix}`,
    });
    if (!t.applied) {
      throw new Error(`driveSuspend: ${rule} not applied (${t.reason}, observed=${t.observed ?? "none"})`);
    }
    // exception 은 포트가 미사용(vestigial 필수 파라미터) — 있으면 전달, 없으면 기본.
    const exception: ClassifiedException =
      s.exception ?? { class: "challenge", code: "CHALLENGE_UNRESOLVED", message: "suspend" as RedactedString };
    await port.suspendForChallenge(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      stepId: s.stepId,
      attempt: keyAttempt,
      correlationId: run.correlationId,
      exception,
      pendingSideEffects: t.pending,
      // @human_task(R5)만 human_tasks 라우팅/타임아웃 정책 + bookmark reason 전달(challenge 는 omit → 기존 동작).
      ...(s.kind === "human_task"
        ? {
            nodeId: s.nodeId,
            assigneeRole: s.assigneeRole,
            onTimeout: s.onTimeout,
            ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
            ...(s.payload !== undefined ? { payload: s.payload } : {}),
            ...(s.resultSchema !== undefined ? { resultSchema: s.resultSchema } : {}),
            ...(s.artifactRefs !== undefined ? { artifactRefs: s.artifactRefs } : {}),
            reason: "human_task",
          }
        : {}),
    });
    // W9: suspend 시 연결 workitem 의 checkout timer pause(suspend 중 checkout 10m 만료로 회수/abandon 오발 방지).
    await pauseLinkedWorkitemCheckout(client, { tenantId: run.tenantId, runId: run.runId, correlationId: run.correlationId });
  });

  // 2) resume-token 발행(SecretStore.resolve — tx 밖). canonical bytes 로 로컬 HMAC 서명.
  const now = Date.now();
  const token: ResumeTokenEnvelope = await codec.issue({
    runId: run.runId as RunId,
    resumeNodeId: s.resumeNodeId,
    pageStateRef: s.pageStateRef as PageStateRef,
    issuedAt: new Date(now).toISOString() as IsoDateTime,
    expiresAt: new Date(now + RESUME_TOKEN_TTL_MS).toISOString() as IsoDateTime,
  });

  // 3) 토큰 save + R11(suspending→suspended) — 한 tx(원자). guard.resumeTokenIssued=true 는 실제 발행 후에만(stranding 금지).
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const saved = await client.query(
      `UPDATE runs SET resume_token = $3::jsonb, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'suspending'`,
      [run.tenantId, run.runId, JSON.stringify(token)],
    );
    if (saved.rowCount !== 1) {
      throw new Error(`driveSuspend: resume_token save affected ${saved.rowCount ?? 0} rows (run not in suspending)`);
    }
    const r11 = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "suspending",
      event: { type: "bookmark_saved" },
      guard: { resumeTokenIssued: true },
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:${s.stepId}:${keyAttempt}:bookmark_saved`,
    });
    if (!r11.applied) {
      throw new Error(`driveSuspend: R11 not applied (${r11.reason}, observed=${r11.observed ?? "none"})`);
    }
    await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
  });

  return { state: "suspended", outcome };
}

async function driveOperatorPause(
  run: ClaimedRun,
  deps: DriveDeps,
  s: Extract<SuspendContext, { readonly kind: "operator_pause" }>,
  codec: ResumeTokenCodec,
  outcome: ScenarioOutcome,
): Promise<DriveResult> {
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const transition = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "running",
      event: { type: "operator_pause_requested" },
      guard: {},
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:${s.pauseRequestId}:operator_pause_requested`,
    });
    if (!transition.applied) {
      throw new Error(`driveOperatorPause: operator_pause_requested not applied (${transition.reason}, observed=${transition.observed ?? "none"})`);
    }
    if (transition.pending.length !== 1 || transition.pending[0]?.kind !== "startBookmark") {
      throw new Error("driveOperatorPause: operator pause transition produced unsupported pending side effects");
    }
    const accepted = await client.query(
      `UPDATE run_pause_requests
          SET status = 'accepted',
              accepted_by_worker_id = $4::uuid,
              updated_at = now()
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND id = $3::uuid
          AND status = 'requested'`,
      [run.tenantId, run.runId, s.pauseRequestId, deps.workerId],
    );
    if (accepted.rowCount !== 1) {
      throw new Error(`driveOperatorPause: pause request '${s.pauseRequestId}' was not claimable`);
    }
    const saved = await client.query(
      `UPDATE runs
          SET bookmark = $3::jsonb,
              updated_at = now()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'suspending'`,
      [
        run.tenantId,
        run.runId,
        JSON.stringify({
          stepId: s.stepId,
          attempt: s.attempt,
          reason: "operator_pause",
          pauseRequestId: s.pauseRequestId,
        }),
      ],
    );
    if (saved.rowCount !== 1) {
      throw new Error(`driveOperatorPause: bookmark save affected ${saved.rowCount ?? 0} rows`);
    }
    await pauseLinkedWorkitemCheckout(client, { tenantId: run.tenantId, runId: run.runId, correlationId: run.correlationId });
  });

  const now = Date.now();
  const token: ResumeTokenEnvelope = await codec.issue({
    runId: run.runId as RunId,
    resumeNodeId: s.resumeNodeId,
    pageStateRef: s.pageStateRef as PageStateRef,
    issuedAt: new Date(now).toISOString() as IsoDateTime,
    expiresAt: new Date(now + RESUME_TOKEN_TTL_MS).toISOString() as IsoDateTime,
  });

  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const saved = await client.query(
      `UPDATE runs SET resume_token = $3::jsonb, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'suspending'`,
      [run.tenantId, run.runId, JSON.stringify(token)],
    );
    if (saved.rowCount !== 1) {
      throw new Error(`driveOperatorPause: resume_token save affected ${saved.rowCount ?? 0} rows`);
    }
    const r11 = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "suspending",
      event: { type: "bookmark_saved" },
      guard: { resumeTokenIssued: true },
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:${s.pauseRequestId}:bookmark_saved`,
    });
    if (!r11.applied) {
      throw new Error(`driveOperatorPause: R11 not applied (${r11.reason}, observed=${r11.observed ?? "none"})`);
    }
    await client.query(
      `UPDATE run_pause_requests
          SET status = 'completed',
              completed_at = now(),
              updated_at = now()
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND id = $3::uuid
          AND status = 'accepted'`,
      [run.tenantId, run.runId, s.pauseRequestId],
    );
    await enqueueArtifactLifecycleJobsForOutcome(client, run, deps, outcome);
  });

  return { state: "suspended", outcome };
}

/**
 * suspend-side outbox 멱등 키(R4/R5·human_task.created·R11)의 per-suspend-cycle 스코프. 인터프리터 ctx.attempt 은 매
 * 드라이브 0 에서 시작해 같은 노드 재suspend(resume 후 재진입) 시 키가 충돌(events_outbox UNIQUE)한다. 기록 executor 가
 * run_steps 에 (run,step)별 단조 증가 attempt(MAX+1)를 영속하므로 그 최댓값을 키 스코프로 쓴다 — per-cycle 고유 +
 * 재시도 안정(영속). 기록 미사용(ad-hoc) run 은 run_steps 부재 → fallback(s.attempt, 단일 사이클).
 */
async function resolveSuspendKeyAttempt(pool: Pool, run: RunTerminalRef, s: SuspendContext): Promise<number> {
  return withTenantTx(pool, run.tenantId, async (client) => {
    if (s.kind === "human_task") {
      // @human_task 는 reserved_handler flow 라 executor 미경유 → run_steps 행 부재로 위 방식이 fallback(=ctx.attempt=0)에 고정돼
      //   loop/재진입 2회차 키가 충돌(events_outbox UNIQUE 23505→run stuck)했다. 대신 그 노드(node_id)의 기존 human_tasks 행 수로
      //   스코프 — 사이클당 1행 생성이라 단조 증가·per-cycle 고유(키 계산 시점엔 이번 사이클 행 미생성 → prior count).
      const r = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM human_tasks WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND node_id=$3`,
        [run.tenantId, run.runId, s.nodeId],
      );
      return Number(r.rows[0]?.n ?? "0");
    }
    // challenge: 기록 executor 가 run_steps 에 (run,step)별 MAX+1 attempt 영속 → per-cycle 고유.
    const r = await client.query<{ attempt: number }>(
      `SELECT COALESCE(MAX(attempt), $3::int) AS attempt FROM run_steps WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$4`,
      [run.tenantId, run.runId, s.attempt, s.stepId],
    );
    return r.rows[0]?.attempt ?? s.attempt;
  });
}
