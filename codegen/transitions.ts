/**
 * D1 codegen — 상태 전이 함수 (state-machine.md §4 구현)
 *
 * 권위:
 *  - 타입: ../ts/state-machine-types.ts (State/Event/Guard/SideEffectCmd/IllegalTransition/transition 시그니처)
 *  - 로직: ../state-machine.md 전이표 (Run R1..R28 / Workitem W1..W11 / HumanTask H1..H8)
 *  - emitEvent.event 문자열: ../schema/event-envelope.schema.json $defs.eventType enum
 *
 * 규칙(계약 §4):
 *  - 본 함수는 순수 함수다. DB 반영(UPDATE ... WHERE status=<cur> CAS)은 호출측 책임.
 *  - 정의되지 않은 (상태, 이벤트[, guard]) 조합은 throw IllegalTransition — 절대 silent no-op 금지.
 *  - guard 분기(R3a/R3b, R18~R20, R26, H4a/H4b 등)는 사전 평가된 guard 필드로 결정한다.
 *
 * 본 파일은 계약을 코드로 변환만 한다(새 계약 신설 금지).
 */
import {
  IllegalTransition,
  type RunState,
  type RunEvent,
  type RunGuard,
  type WorkitemState,
  type WorkitemEvent,
  type WorkitemGuard,
  type HumanTaskState,
  type HumanTaskEvent,
  type HumanTaskGuard,
  type SideEffectCmd,
  type TransitionResult,
} from "../ts/state-machine-types";

// ===========================================================================
// Run — state-machine.md §1 (R1..R28)
// ===========================================================================
export function transitionRun(
  cur: RunState,
  ev: RunEvent,
  g: RunGuard,
): TransitionResult<RunState> {
  switch (cur) {
    case "queued":
      // R1: queued + worker.claimed (lease 확보) → claimed
      if (ev.type === "worker.claimed" && g.leaseAcquired) {
        return r("claimed", [
          { kind: "setField", entity: "run", field: "worker_id" },
        ]);
      }
      break;

    case "claimed":
      // R2: claimed + run.started (INIT 성공) → running
      if (ev.type === "run.started" && g.initOk) {
        return r("running", [{ kind: "emitEvent", event: "run.started" }]);
      }
      // R3a/R3b: claimed + init_failed → 임계 분기
      if (ev.type === "init_failed") {
        if (requireBool("run", cur, ev.type, g.initFailBelowThreshold)) {
          // R3a: 연속 실패 임계 미만 → 재큐(attempts+1, 백오프)
          return r("queued", [{ kind: "requeue", backoff: true }]);
        }
        // R3b: 임계 이상 → 서킷 오픈 + DLQ 판단, 더 이상 재큐 안 함
        return r("failed_system", [
          { kind: "openCircuit" },
          { kind: "evaluateDeadLetter" },
          { kind: "emitEvent", event: "run.failed_system" },
        ]);
      }
      break;

    case "running":
      // R4: running + step.challenge_detected (policy=human_first) → suspending
      if (ev.type === "step.challenge_detected") {
        // human_task kind = challenge 분류(ChallengeSummary.type): mfa면 mfa, 그 외 captcha 폴백
        // (reserved-handlers @challenge: human_assist=captcha|mfa). ChallengeDetector가 ev.challengeKind 설정.
        return r("suspending", [
          { kind: "createHumanTask", humanTaskKind: ev.challengeKind ?? "captcha" },
          { kind: "startBookmark" },
        ]);
      }
      // R5: running + node→@human_task → suspending. kind는 @human_task input(approval|validation|exception,
      // reserved-handlers)에서 옴 — 하드코딩 금지(approval/validation을 exception으로 오라우팅하면 RBAC 권한 혼선).
      // 미지정 시 exception 기본(R4의 ev.challengeKind ?? captcha와 동일 패턴).
      if (ev.type === "human_task_required") {
        return r("suspending", [
          { kind: "createHumanTask", humanTaskKind: ev.humanTaskKind ?? "exception" },
          { kind: "startBookmark" },
        ]);
      }
      // R5b: running + operator_pause_requested → suspending.
      // Runtime consumes the durable pause intent at a safe boundary and writes a bookmark/resume token.
      if (ev.type === "operator_pause_requested") {
        return r("suspending", [{ kind: "startBookmark" }]);
      }
      // R6: running + abort_requested → aborting (SSE close + browser drain)
      if (ev.type === "abort_requested") {
        return r("aborting", [
          { kind: "sseClose" },
          { kind: "browserDrain" },
        ]);
      }
      // R7: running + last_node_success (흐름 종료=terminal 도달) → completing
      if (ev.type === "last_node_success" && g.flowTerminalReached) {
        return r("completing", [{ kind: "finalizeOutputs" }]);
      }
      // R8: running + unrecoverable_exception (system, 재시도 소진) → failed_system
      if (ev.type === "unrecoverable_exception" && g.exceptionClass === "system") {
        return r("failed_system", [
          { kind: "captureFailureScreenshot" },
          { kind: "evaluateDeadLetter" },
          { kind: "emitEvent", event: "run.failed_system" },
        ]);
      }
      // R9: running + business_exception → failed_business
      if (ev.type === "business_exception" && g.exceptionClass === "business") {
        return r("failed_business", [
          { kind: "emitEvent", event: "run.failed_business" },
        ]);
      }
      // R10: running + security_exception → aborting (즉시 중단 + 알림)
      if (ev.type === "security_exception" && g.exceptionClass === "security") {
        return r("aborting", [
          { kind: "sseClose" },
          { kind: "browserDrain" },
          { kind: "notify" },
        ]);
      }
      break;

    case "suspending":
      // R11: suspending + bookmark_saved (resume_token 생성됨) → suspended
      //   browser lease 반납(Phase A 기본)
      if (ev.type === "bookmark_saved" && g.resumeTokenIssued) {
        return r("suspended", [
          { kind: "issueResumeToken" },
          { kind: "releaseLease", lease: "browser" },
          { kind: "emitEvent", event: "run.suspended" },
        ]);
      }
      // R12: suspending + bookmark_failed → failed_system (일관성 복구)
      if (ev.type === "bookmark_failed") {
        return r("failed_system", [
          { kind: "consistencyRecovery" },
          { kind: "emitEvent", event: "run.failed_system" },
        ]);
      }
      // R26: suspending + abort_requested (bookmark 진행 취소 가능) → aborting
      //   불가(bookmarkCancelable=false) 시: suspended 도달까지 대기 후 R16 — 즉시 전이 없음.
      if (ev.type === "abort_requested") {
        if (g.bookmarkCancelable) {
          return r("aborting", [
            { kind: "sseClose" },
            { kind: "browserDrain" },
          ]);
        }
        // bookmark 취소 불가: 지금은 적용 가능한 전이가 없다(계약상 suspended 대기 후 R16).
        // silent no-op 금지 → 호출측이 suspended 도달 후 재시도하도록 throw.
        break;
      }
      break;

    case "suspended":
      // R13: suspended + human_task.resolved (task valid) → resume_requested
      if (ev.type === "human_task.resolved" && g.humanTaskValid) {
        return r("resume_requested", [
          { kind: "emitEvent", event: "run.resume_requested" },
        ]);
      }
      // R14: suspended + human_task.expired → failed_business (DLQ/알림)
      if (ev.type === "human_task.expired") {
        return r("failed_business", [
          { kind: "evaluateDeadLetter" },
          { kind: "notify" },
          { kind: "emitEvent", event: "run.failed_business" },
        ]);
      }
      // R15: suspended + human_task.escalated → suspended (담당자 재배정, 상태 유지)
      //   reassignAssignee는 호출측이 명시 routing/assignee로 소비해야 하며, 미지원이면 fail-closed.
      if (ev.type === "human_task.escalated") {
        return r("suspended", [{ kind: "reassignAssignee" }]);
      }
      // R16: suspended + abort_requested → aborting (resume 무시)
      if (ev.type === "abort_requested") {
        return r("aborting", []);
      }
      break;

    case "resume_requested":
      // R17: resume_requested + worker.claimed (lease 확보) → resuming (session restore 시작)
      if (ev.type === "worker.claimed" && g.leaseAcquired) {
        return r("resuming", [{ kind: "restoreSession" }]);
      }
      // R28: resume_requested + abort_requested → aborting (resume 무시; Phase A는 lease 반납 상태)
      if (ev.type === "abort_requested") {
        return r("aborting", []);
      }
      break;

    case "resuming":
      // R18: resuming + restore_ok (pageState 대조 통과) → running (진입 노드부터 재개)
      if (ev.type === "restore_ok" && g.restoreOk) {
        return r("running", [{ kind: "emitEvent", event: "run.resumed" }]);
      }
      // R19/R20: resuming + restore_failed → 재로그인 우회 분기
      if (ev.type === "restore_failed") {
        if (requireBool("run", cur, ev.type, g.loginBypassPossible)) {
          // R19: 우회 가능 → running (login_flow 분기)
          return r("running", [{ kind: "emitEvent", event: "run.resumed" }]);
        }
        // R20: 우회 불가 → failed_system (실패 마감)
        return r("failed_system", [
          { kind: "emitEvent", event: "run.failed_system" },
        ]);
      }
      // R27: resuming + abort_requested → aborting (restore 중단 + drain, resume 무시)
      if (ev.type === "abort_requested") {
        return r("aborting", [
          { kind: "sseClose" },
          { kind: "browserDrain" },
        ]);
      }
      break;

    case "completing":
      // R21: completing + finalize_ok → completed (artifact flush + 산출 확정 + 이벤트 발행)
      if (ev.type === "finalize_ok" && g.finalizeOk) {
        return r("completed", [
          { kind: "flushArtifacts" },
          { kind: "finalizeOutputs" },
          { kind: "usageFlush" },
          { kind: "emitEvent", event: "run.completed" },
        ]);
      }
      // R22: completing + finalize_failed → failed_system (보상 시도 후 마감, 일관성 로그)
      if (ev.type === "finalize_failed") {
        return r("failed_system", [
          { kind: "consistencyRecovery" },
          { kind: "emitEvent", event: "run.failed_system" },
        ]);
      }
      // R25: completing + abort_requested → completing (abort 무시/거부 — finalize 우선, 상태 유지)
      if (ev.type === "abort_requested") {
        return r("completing", [
          { kind: "rejectCommand", code: "RUN_ALREADY_TERMINAL", httpStatus: 409 },
        ]);
      }
      break;

    case "aborting":
      // R23: aborting + drain_ok → cancelled (run.cancelled, lease 회수)
      if (ev.type === "drain_ok") {
        return r("cancelled", [
          { kind: "releaseLease", lease: "browser" },
          { kind: "emitEvent", event: "run.cancelled" },
        ]);
      }
      // R24: aborting + drain_timeout (abort_timeout 초과) → cancelled (강제 lease kill)
      if (ev.type === "drain_timeout") {
        return r("cancelled", [
          { kind: "killLease", lease: "browser" },
          { kind: "emitEvent", event: "run.cancelled" },
        ]);
      }
      break;

    // terminal 상태(completed/cancelled/failed_business/failed_system): 정의된 전출 전이 없음.
    case "completed":
    case "cancelled":
    case "failed_business":
    case "failed_system":
      break;
  }
  throw new IllegalTransition("run", cur, ev.type);
}

// ===========================================================================
// Workitem — state-machine.md §2 (W1..W11)
// ===========================================================================
export function transitionWorkitem(
  cur: WorkitemState,
  ev: WorkitemEvent,
  g: WorkitemGuard,
): TransitionResult<WorkitemState> {
  switch (cur) {
    case "new":
      // W1: new + checkout (unique_reference 미중복) → processing
      if (ev.type === "checkout" && g.uniqueReferenceFree) {
        return r("processing", [
          { kind: "setField", entity: "workitem", field: "checked_out_by" },
          { kind: "setField", entity: "workitem", field: "checked_out_at" },
        ]);
      }
      break;

    case "processing":
      // W2: processing + run_succeeded (sink 정책 만족/수집 성공) → successful
      if (ev.type === "run_succeeded" && g.sinkPolicyMet) {
        return r("successful", [
          { kind: "emitEvent", event: "workitem.completed" },
        ]);
      }
      // W3: processing + business_exception → failed_business (human_task 또는 종결)
      if (ev.type === "business_exception") {
        return r("failed_business", []);
      }
      // W4/W5: processing + system_exception → attempts 분기
      if (ev.type === "system_exception") {
        if (requireBool("workitem", cur, ev.type, g.attemptsBelowMax)) {
          // W4: attempts < max → retry (evidence 유지, 백오프)
          return r("retry", []);
        }
        // W5: attempts >= max → abandoned (dead_letter 생성)
        return r("abandoned", [
          { kind: "createDeadLetter" },
          { kind: "emitEvent", event: "workitem.dead_lettered" },
        ]);
      }
      // W6/W7: processing + checkout_expired → attempts 분기
      if (ev.type === "checkout_expired") {
        if (requireBool("workitem", cur, ev.type, g.attemptsBelowMax)) {
          // W6: attempts < max → retry (체크아웃 회수, evidence 유지)
          return r("retry", []);
        }
        // W7: attempts >= max → abandoned (dead_letter 생성)
        return r("abandoned", [
          { kind: "createDeadLetter" },
          { kind: "emitEvent", event: "workitem.dead_lettered" },
        ]);
      }
      // W9: processing + run_suspended → processing (상태 유지, checkout timer pause)
      if (ev.type === "run_suspended") {
        return r("processing", [{ kind: "pauseCheckoutTimer" }]);
      }
      // W11: processing + run_resumed → processing (상태 유지, checkout timer resume)
      if (ev.type === "run_resumed") {
        return r("processing", [{ kind: "resumeCheckoutTimer" }]);
      }
      break;

    case "retry":
      // W8: retry + checkout (백오프 경과) → processing (step/loop 카운터 리셋, cursor·raw 보존)
      if (ev.type === "checkout" && g.backoffElapsed) {
        return r("processing", [
          { kind: "resetStepLoopCounters" },
          { kind: "setField", entity: "workitem", field: "checked_out_by" },
          { kind: "setField", entity: "workitem", field: "checked_out_at" },
        ]);
      }
      break;

    case "abandoned":
      // W10: abandoned + manual_replay (운영자 재처리 권한) → new (attempts 리셋, DLQ 복원)
      if (ev.type === "manual_replay" && g.operatorAuthorized) {
        return r("new", [
          { kind: "setField", entity: "workitem", field: "attempts" },
        ]);
      }
      break;

    // terminal 상태(successful/failed_business): 정의된 전출 전이 없음.
    case "successful":
    case "failed_business":
      break;
  }
  throw new IllegalTransition("workitem", cur, ev.type);
}

// ===========================================================================
// HumanTask — state-machine.md §3 (H1..H8)
// ===========================================================================
export function transitionHumanTask(
  cur: HumanTaskState,
  ev: HumanTaskEvent,
  g: HumanTaskGuard,
): TransitionResult<HumanTaskState> {
  // H7: * + cancel → cancelled (run abort 연동, R16). 모든 비종결 상태에서 정의.
  if (ev.type === "cancel") {
    if (
      cur === "open" ||
      cur === "assigned" ||
      cur === "in_progress" ||
      cur === "escalated"
    ) {
      return r("cancelled", []);
    }
    // 종결 상태(resolved/expired/cancelled)에서의 cancel은 정의 안 됨 → throw.
    throw new IllegalTransition("human_task", cur, ev.type);
  }

  switch (cur) {
    case "open":
      // H1: open + assign → assigned
      if (ev.type === "assign") {
        return r("assigned", [
          { kind: "setField", entity: "human_task", field: "assignee" },
        ]);
      }
      // H4a/H4b: open + timeout → on_timeout 분기
      if (ev.type === "timeout") return timeoutBranch(cur, g);
      // H5: open + escalate → escalated (관리자 수동 에스컬레이션)
      //   reassignAssignee는 자동 admin queue 추정 금지; 호출측 미지원이면 rollback + fail-closed.
      if (ev.type === "escalate") {
        return r("escalated", [{ kind: "emitEvent", event: "human_task.escalated" }, { kind: "reassignAssignee" }]);
      }
      break;

    case "assigned":
      // H2: assigned + start → in_progress
      if (ev.type === "start") {
        return r("in_progress", []);
      }
      // H4a/H4b: assigned + timeout → on_timeout 분기
      if (ev.type === "timeout") return timeoutBranch(cur, g);
      // H5: assigned + escalate → escalated
      //   reassignAssignee는 자동 admin queue 추정 금지; 호출측 미지원이면 rollback + fail-closed.
      if (ev.type === "escalate") {
        return r("escalated", [{ kind: "emitEvent", event: "human_task.escalated" }, { kind: "reassignAssignee" }]);
      }
      break;

    case "in_progress":
      // H3: in_progress + resolve → resolved (run resume_requested 트리거, R13)
      if (ev.type === "resolve") {
        return r("resolved", [
          { kind: "emitEvent", event: "human_task.resolved" },
        ]);
      }
      // H4a/H4b: in_progress + timeout → on_timeout 분기
      if (ev.type === "timeout") return timeoutBranch(cur, g);
      // H5: in_progress + escalate → escalated
      //   reassignAssignee는 자동 admin queue 추정 금지; 호출측 미지원이면 rollback + fail-closed.
      if (ev.type === "escalate") {
        return r("escalated", [{ kind: "emitEvent", event: "human_task.escalated" }, { kind: "reassignAssignee" }]);
      }
      break;

    case "escalated":
      // H6: escalated + assign → assigned (새 담당자 재배정)
      if (ev.type === "assign") {
        return r("assigned", [
          { kind: "reassignAssignee" },
          { kind: "setField", entity: "human_task", field: "assignee" },
        ]);
      }
      // H8: escalated + timeout → expired (재에스컬레이션 없음, 정책 무관 최종 만료, run R14)
      if (ev.type === "timeout") {
        return r("expired", [
          { kind: "emitEvent", event: "human_task.expired" },
        ]);
      }
      break;

    // terminal 상태(resolved/expired/cancelled): 정의된 전출 전이 없음.
    case "resolved":
    case "expired":
    case "cancelled":
      break;
  }
  throw new IllegalTransition("human_task", cur, ev.type);
}

/**
 * H4a/H4b: timeout 시 on_timeout 정책 분기.
 *   fail → expired (run R14 failed_business),  escalate → escalated (자동 에스컬레이션, run R15)
 * on_timeout 미지정은 정의되지 않은 분기 → throw(조용한 기본값 금지).
 */
function timeoutBranch(
  cur: HumanTaskState,
  g: HumanTaskGuard,
): TransitionResult<HumanTaskState> {
  if (g.onTimeout === "fail") {
    // H4a
    return r("expired", [{ kind: "emitEvent", event: "human_task.expired" }]);
  }
  if (g.onTimeout === "escalate") {
    // H4b
    return r("escalated", [
      { kind: "emitEvent", event: "human_task.escalated" },
    ]);
  }
  throw new IllegalTransition("human_task", cur, "timeout");
}

// ===== helper =====
function requireBool(
  entity: "run" | "workitem" | "human_task",
  state: string,
  event: string,
  value: boolean | undefined,
): boolean {
  if (value === true || value === false) return value;
  throw new IllegalTransition(entity, state, event);
}

function r<S>(next: S, sideEffects: SideEffectCmd[]): TransitionResult<S> {
  return { next, sideEffects };
}
