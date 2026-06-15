/**
 * State Machine Types v1 (codegen 대상)
 * state-machine.md §4가 참조하는 State/Event/Guard/SideEffectCmd의 기계가독 정의.
 * 전이표(R1..R28 / W1..W11 / H1..H8)의 단일 진실원천은 state-machine.md이며, 본 파일은
 * 그 전이 함수 시그니처가 쓰는 타입을 고정한다(전이표 자체는 codegen이 .md에서 파싱).
 */
import type { ExceptionClass } from "./core-types";

// ===== States (state-machine.md §1·§2·§3) =====
export type RunState =
  | "queued" | "claimed" | "running" | "suspending" | "suspended"
  | "resume_requested" | "resuming" | "completing" | "completed"
  | "aborting" | "cancelled" | "failed_business" | "failed_system";
export const RUN_TERMINAL: RunState[] = ["completed", "cancelled", "failed_business", "failed_system"];

export type WorkitemState =
  | "new" | "processing" | "successful" | "retry"
  | "failed_business" | "failed_system" | "abandoned";
export const WORKITEM_TERMINAL: WorkitemState[] = ["successful", "failed_business", "abandoned"];

export type HumanTaskState =
  | "open" | "assigned" | "in_progress" | "resolved" | "expired" | "cancelled" | "escalated";
export const HUMANTASK_TERMINAL: HumanTaskState[] = ["resolved", "expired", "cancelled"];

export type HumanTaskKind = "approval" | "validation" | "exception" | "captcha" | "mfa";

// ===== Events (전이표 '이벤트' 열) =====
export type RunEvent =
  | { type: "worker.claimed" }
  | { type: "run.started" }
  | { type: "init_failed" }
  | { type: "step.challenge_detected"; challengeKind?: "captcha" | "mfa" }   // ChallengeSummary.type → human-assist kind(R4)
  | { type: "human_task_required" }              // R5: node→@human_task
  | { type: "abort_requested" }
  | { type: "last_node_success" }
  | { type: "unrecoverable_exception" }
  | { type: "business_exception" }
  | { type: "security_exception" }
  | { type: "bookmark_saved" }
  | { type: "bookmark_failed" }
  | { type: "human_task.resolved" }
  | { type: "human_task.expired" }
  | { type: "human_task.escalated" }
  | { type: "restore_ok" }
  | { type: "restore_failed" }
  | { type: "finalize_ok" }
  | { type: "finalize_failed" }
  | { type: "drain_ok" }
  | { type: "drain_timeout" };

export type WorkitemEvent =
  | { type: "checkout" }
  | { type: "run_succeeded" }
  | { type: "business_exception" }
  | { type: "system_exception" }
  | { type: "checkout_expired" }
  | { type: "run_suspended" }
  | { type: "run_resumed" }                       // W11
  | { type: "manual_replay" };

export type HumanTaskEvent =
  | { type: "assign" }
  | { type: "start" }
  | { type: "resolve" }
  | { type: "timeout" }                           // H4a/H4b/H8 (guard.onTimeout 분기)
  | { type: "escalate" }
  | { type: "cancel" };

// ===== Guards (전이표 'guard' 열의 사전 평가 결과) =====
export interface RunGuard {
  leaseAcquired?: boolean;          // R1/R17
  initOk?: boolean;                 // R2
  initFailBelowThreshold?: boolean; // R3a(true) / R3b(false)
  flowTerminalReached?: boolean;    // R7
  exceptionClass?: ExceptionClass;  // R8/R9/R10
  resumeTokenIssued?: boolean;      // R11
  humanTaskValid?: boolean;         // R13
  restoreOk?: boolean;              // R18
  loginBypassPossible?: boolean;    // R19(true) / R20(false)
  finalizeOk?: boolean;             // R21(true) / R22(false)
  drainTimedOut?: boolean;          // R24
  bookmarkCancelable?: boolean;     // R26
}

export interface WorkitemGuard {
  uniqueReferenceFree?: boolean;    // W1
  sinkPolicyMet?: boolean;          // W2
  attemptsBelowMax?: boolean;       // W4/W5/W6/W7
  backoffElapsed?: boolean;         // W8
  operatorAuthorized?: boolean;     // W10
}

export interface HumanTaskGuard {
  onTimeout?: "fail" | "escalate";  // H4a(fail→expired) / H4b(escalate→escalated)
}

// ===== Side effects (전이표 'sideEffects' 열) =====
export type EventEnvelopeType =
  | "run.created" | "run.started" | "run.suspended" | "run.resume_requested" | "run.resumed"
  | "run.cancelled" | "run.completed" | "run.failed_business" | "run.failed_system"
  | "step.started" | "step.completed" | "step.verify.failed"
  | "llm.stream.started" | "llm.stream.completed" | "llm.stream.aborted"
  | "challenge.detected" | "challenge.resolved"
  | "human_task.created" | "human_task.resolved" | "human_task.expired" | "human_task.escalated"
  | "workitem.completed" | "workitem.dead_lettered"
  | "pipeline.stage.completed" | "sink.delivered" | "sink.dead_lettered"
  | "site.circuit_opened" | "site.circuit_closed";

export type SideEffectCmd =
  | { kind: "emitEvent"; event: EventEnvelopeType }                   // event-envelope event_type
  | { kind: "setField"; entity: "run" | "workitem" | "human_task"; field: string }
  | { kind: "requeue"; backoff: true }                                // R3a
  | { kind: "openCircuit" }                                           // R3b
  | { kind: "evaluateDeadLetter" }                                    // R8 DLQ 판단
  | { kind: "createDeadLetter" }                                      // W5/W7
  | { kind: "createHumanTask"; humanTaskKind: HumanTaskKind }         // R4/R5
  | { kind: "startBookmark" }                                         // R4/R5
  | { kind: "issueResumeToken" }                                      // R11
  | { kind: "sseClose" }                                              // R6
  | { kind: "browserDrain" }                                          // R6
  | { kind: "releaseLease"; lease: "browser" | "credential" }         // R11/R23
  | { kind: "killLease"; lease: "browser" | "credential" }            // R24
  | { kind: "restoreSession" }                                        // R17
  | { kind: "flushArtifacts" }                                        // R21
  | { kind: "finalizeOutputs" }                                       // R7/R21
  | { kind: "usageFlush" }                                            // R21
  | { kind: "resetStepLoopCounters" }                                 // W8
  | { kind: "pauseCheckoutTimer" }                                    // W9
  | { kind: "resumeCheckoutTimer" }                                   // W11
  | { kind: "reassignAssignee" }                                      // H5/H6/R15: 호출측이 명시 routing/assignee로 소비
  | { kind: "captureFailureScreenshot" }                              // R8
  | { kind: "consistencyRecovery" }                                   // R12/R22
  | { kind: "rejectCommand"; code: string; httpStatus: number }        // R25 등 명시적 명령 거부
  | { kind: "notify"; channel?: string };                             // R10/R14 알림

// ===== Transition functions (state-machine.md §4) =====
export type TransitionResult<S> = { next: S; sideEffects: SideEffectCmd[] };

export declare function transitionRun(cur: RunState, ev: RunEvent, g: RunGuard): TransitionResult<RunState>;
export declare function transitionWorkitem(cur: WorkitemState, ev: WorkitemEvent, g: WorkitemGuard): TransitionResult<WorkitemState>;
export declare function transitionHumanTask(cur: HumanTaskState, ev: HumanTaskEvent, g: HumanTaskGuard): TransitionResult<HumanTaskState>;

/** 정의되지 않은 (상태,이벤트) 조합 → throw. 절대 silent no-op 금지(state-machine.md §4). */
export class IllegalTransition extends Error {
  constructor(public entity: "run" | "workitem" | "human_task", public state: string, public event: string) {
    super(`IllegalTransition: ${entity} has no transition for (${state}, ${event})`);
    this.name = "IllegalTransition";
  }
}
