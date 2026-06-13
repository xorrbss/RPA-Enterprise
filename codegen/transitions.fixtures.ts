/**
 * codegen/transitions.fixtures.ts
 *
 * transition*() 단위테스트 픽스처 (시뮬레이션 클록).
 *
 * 단일 진실원천:
 *  - 전이 로직: ../state-machine.md (R1..R28 / W1..W11 / H1..H8)
 *  - 전이 타입: ../ts/state-machine-types.ts (State/Event/Guard/SideEffectCmd/transition 시그니처/IllegalTransition)
 *  - 임계·픽스처값: ../ops-defaults.md (시뮬레이션-클록 단위테스트 픽스처)
 *  - 이벤트 어휘: ../schema/event-envelope.schema.json (event_type 32)
 *
 * 본 파일은 계약을 코드로 변환만 한다(새 계약 생성 금지).
 *
 * "조용한 false/unknown 금지":
 *  - 미정의 (state,event) 조합은 expectThrow:"IllegalTransition" 으로 명시한다(silent no-op 검증 금지).
 *  - 모든 fixture는 계약 표의 특정 행(R#/W#/H#)에 1:1 대응한다.
 *
 * 테스트 러너 비종속: plain 배열 + 파일 하단의 간단 assert 루프(runFixtures)만 사용.
 * SideEffectCmd 비교는 표가 명시적으로 고정한 emitEvent(event-envelope event_type)만 부분 검증한다
 * (표가 산출물 키만 서술하고 정확한 cmd 시퀀스를 고정하지 않는 행은 next/throw만 검증).
 */
import type {
  RunState,
  WorkitemState,
  HumanTaskState,
  RunEvent,
  WorkitemEvent,
  HumanTaskEvent,
  RunGuard,
  WorkitemGuard,
  HumanTaskGuard,
  SideEffectCmd,
  TransitionResult,
} from "../ts/state-machine-types";
// IllegalTransition은 ../ts/state-machine-types의 런타임 class (transitions.ts도 여기서 import).
import { IllegalTransition } from "../ts/state-machine-types";
// transition*() 는 ../ts/state-machine-types에서는 declare(타입만)이고, 실행 구현은
// codegen/transitions.ts 가 제공한다(state-machine.md §4 구현). 픽스처는 실제 구현을 대상으로 검증.
import {
  transitionRun,
  transitionWorkitem,
  transitionHumanTask,
} from "./transitions";

// ===== 시뮬레이션-클록 픽스처값 (ops-defaults.md) =====
// 운영 의미는 동일, 스케일만 축소. 타이머 구동 전이(R24/W6/W7/W9/W11)와
// 임계 분기(R3a/R3b · W4/W5)의 guard 사전평가에 쓰이는 정책 상수.
export const FIXTURE_CLOCK = {
  run: {
    initFailThreshold: 2, // ops-defaults §1 run.init_fail_threshold (fixture 2) — R3a/R3b
    initBackoff: { baseMs: 10, maxMs: 50 }, // run.init_backoff (fixture)
    abortTimeoutMs: 100, // run.abort_timeout (fixture) — R24 drain_timeout
  },
  workitem: {
    maxAttempts: 2, // workitem.max_attempts (fixture 2) — W4/W5/W6/W7
    retryBackoff: { baseMs: 10, maxMs: 50 }, // workitem.retry_backoff (fixture) — W8
    checkoutTimeoutMs: 300, // workitem.checkout_timeout (fixture) — W6/W7, W9 pause / W11 resume
  },
  resumeTokenTtlMs: 2000, // ops-defaults §7 resume_token.ttl (fixture 2s) — R13/R17
  humanTaskDefaultTimeoutMs: 2000, // §7 human_task.default_timeout (fixture 2s) — H4a/H4b/H8
} as const;

// ===== Fixture 형태 =====
// {name, entity, cur, event, guard?, expectNext | expectThrow}
// expectEmits: 표가 명시적으로 고정한 emitEvent(event_type)만 부분검증(옵션).
export interface RunFixture {
  name: string;
  entity: "run";
  cur: RunState;
  event: RunEvent;
  guard?: RunGuard;
  expectNext?: RunState;
  expectThrow?: "IllegalTransition";
  expectEmits?: string[];
}
export interface WorkitemFixture {
  name: string;
  entity: "workitem";
  cur: WorkitemState;
  event: WorkitemEvent;
  guard?: WorkitemGuard;
  expectNext?: WorkitemState;
  expectThrow?: "IllegalTransition";
  expectEmits?: string[];
}
export interface HumanTaskFixture {
  name: string;
  entity: "human_task";
  cur: HumanTaskState;
  event: HumanTaskEvent;
  guard?: HumanTaskGuard;
  expectNext?: HumanTaskState;
  expectThrow?: "IllegalTransition";
  expectEmits?: string[];
}
export type TransitionFixture = RunFixture | WorkitemFixture | HumanTaskFixture;

// ===== Run 전이 픽스처 (state-machine.md §1) =====
export const RUN_FIXTURES: RunFixture[] = [
  // --- happy path 대표 행 ---
  {
    name: "R1 queued + worker.claimed (lease 확보) → claimed",
    entity: "run",
    cur: "queued",
    event: { type: "worker.claimed" },
    guard: { leaseAcquired: true },
    expectNext: "claimed",
  },
  {
    name: "R2 claimed + run.started (INIT ok) → running",
    entity: "run",
    cur: "claimed",
    event: { type: "run.started" },
    guard: { initOk: true },
    expectNext: "running",
    expectEmits: ["run.started"],
  },
  // --- R3a/R3b: init_fail_threshold 분기 (ops-defaults fixture=2) ---
  {
    name: "R3a claimed + init_failed (연속실패 < 임계, 1<2) → queued 재큐",
    entity: "run",
    cur: "claimed",
    event: { type: "init_failed" },
    guard: { initFailBelowThreshold: true },
    expectNext: "queued",
  },
  {
    name: "R3b claimed + init_failed (연속실패 >= 임계, 2>=2) → failed_system 서킷오픈",
    entity: "run",
    cur: "claimed",
    event: { type: "init_failed" },
    guard: { initFailBelowThreshold: false },
    expectNext: "failed_system",
  },
  // --- R4/R5: challenge / human_task → suspending ---
  {
    name: "R4 running + step.challenge_detected (policy=human_first) → suspending",
    entity: "run",
    cur: "running",
    event: { type: "step.challenge_detected" },
    expectNext: "suspending",
  },
  {
    name: "R5 running + human_task_required → suspending",
    entity: "run",
    cur: "running",
    event: { type: "human_task_required" },
    expectNext: "suspending",
  },
  // --- R6: abort_requested (running) → aborting (SSE close + drain) ---
  {
    name: "R6 running + abort_requested → aborting (SSE close + browser drain)",
    entity: "run",
    cur: "running",
    event: { type: "abort_requested" },
    expectNext: "aborting",
  },
  // --- R7/R8/R9/R10: 흐름 종료 / 예외 분기 ---
  {
    name: "R7 running + last_node_success (terminal 도달) → completing",
    entity: "run",
    cur: "running",
    event: { type: "last_node_success" },
    guard: { flowTerminalReached: true },
    expectNext: "completing",
  },
  {
    name: "R8 running + unrecoverable_exception (system) → failed_system",
    entity: "run",
    cur: "running",
    event: { type: "unrecoverable_exception" },
    guard: { exceptionClass: "system" },
    expectNext: "failed_system",
  },
  {
    name: "R9 running + business_exception → failed_business",
    entity: "run",
    cur: "running",
    event: { type: "business_exception" },
    guard: { exceptionClass: "business" },
    expectNext: "failed_business",
  },
  {
    name: "R10 running + security_exception → aborting (즉시 중단 + 알림)",
    entity: "run",
    cur: "running",
    event: { type: "security_exception" },
    guard: { exceptionClass: "security" },
    expectNext: "aborting",
  },
  // --- R11/R12: suspending 종결 ---
  {
    name: "R11 suspending + bookmark_saved (resume_token 발급) → suspended",
    entity: "run",
    cur: "suspending",
    event: { type: "bookmark_saved" },
    guard: { resumeTokenIssued: true },
    expectNext: "suspended",
  },
  {
    name: "R12 suspending + bookmark_failed → failed_system (일관성 복구)",
    entity: "run",
    cur: "suspending",
    event: { type: "bookmark_failed" },
    expectNext: "failed_system",
  },
  // --- R13/R14/R15: suspended human_task 후속 ---
  {
    name: "R13 suspended + human_task.resolved (task valid) → resume_requested",
    entity: "run",
    cur: "suspended",
    event: { type: "human_task.resolved" },
    guard: { humanTaskValid: true },
    expectNext: "resume_requested",
    expectEmits: ["run.resume_requested"],
  },
  {
    name: "R14 suspended + human_task.expired → failed_business (정책 재판정 안 함)",
    entity: "run",
    cur: "suspended",
    event: { type: "human_task.expired" },
    expectNext: "failed_business",
  },
  {
    name: "R15 suspended + human_task.escalated (escalate) → suspended (상태 유지, 재배정)",
    entity: "run",
    cur: "suspended",
    event: { type: "human_task.escalated" },
    expectNext: "suspended",
  },
  // --- R16: abort vs resolve race — abort 우선 ---
  {
    name: "R16 suspended + abort_requested → aborting (resume 무시, abort 우선)",
    entity: "run",
    cur: "suspended",
    event: { type: "abort_requested" },
    expectNext: "aborting",
  },
  // --- R17/R18/R19/R20: resume_requested / resuming restore ---
  {
    name: "R17 resume_requested + worker.claimed (lease 확보) → resuming (session restore)",
    entity: "run",
    cur: "resume_requested",
    event: { type: "worker.claimed" },
    guard: { leaseAcquired: true },
    expectNext: "resuming",
  },
  {
    name: "R18 resuming + restore_ok (pageState 대조 통과) → running",
    entity: "run",
    cur: "resuming",
    event: { type: "restore_ok" },
    guard: { restoreOk: true },
    expectNext: "running",
  },
  {
    name: "R19 resuming + restore_failed (재로그인 우회 가능) → running (login_flow 분기)",
    entity: "run",
    cur: "resuming",
    event: { type: "restore_failed" },
    guard: { loginBypassPossible: true },
    expectNext: "running",
  },
  {
    name: "R20 resuming + restore_failed (우회 불가) → failed_system",
    entity: "run",
    cur: "resuming",
    event: { type: "restore_failed" },
    guard: { loginBypassPossible: false },
    expectNext: "failed_system",
  },
  // --- R21/R22: completing finalize ---
  {
    name: "R21 completing + finalize_ok (artifact flush + 산출 확정 + 이벤트 성공) → completed",
    entity: "run",
    cur: "completing",
    event: { type: "finalize_ok" },
    guard: { finalizeOk: true },
    expectNext: "completed",
    expectEmits: ["run.completed"],
  },
  {
    name: "R22 completing + finalize_failed → failed_system (보상 후 마감, 일관성 로그)",
    entity: "run",
    cur: "completing",
    event: { type: "finalize_failed" },
    guard: { finalizeOk: false },
    expectNext: "failed_system",
  },
  // --- R23/R24: aborting drain → cancelled (어휘 체인 abort→cancelled→run.cancelled) ---
  {
    name: "R23 aborting + drain_ok → cancelled (run.cancelled, lease 회수)",
    entity: "run",
    cur: "aborting",
    event: { type: "drain_ok" },
    expectNext: "cancelled",
    expectEmits: ["run.cancelled"],
  },
  {
    name: "R24 aborting + drain_timeout (abort_timeout 초과, fixture 100ms) → cancelled (강제 lease kill)",
    entity: "run",
    cur: "aborting",
    event: { type: "drain_timeout" },
    guard: { drainTimedOut: true },
    expectNext: "cancelled",
    expectEmits: ["run.cancelled"],
  },
  // --- R25 race: completing 진입 후 abort_requested → finalize 우선(abort 거부, 상태 유지) ---
  {
    name: "R25 race: completing + abort_requested → completing (finalize 우선, abort 거부 / RUN_ALREADY_TERMINAL)",
    entity: "run",
    cur: "completing",
    event: { type: "abort_requested" },
    expectNext: "completing",
  },
  // --- R26/R27: abort 보편성 (suspending / resuming) ---
  {
    name: "R26 suspending + abort_requested (bookmark 취소 가능) → aborting (bookmark 중단 후 drain)",
    entity: "run",
    cur: "suspending",
    event: { type: "abort_requested" },
    guard: { bookmarkCancelable: true },
    expectNext: "aborting",
  },
  {
    name: "R27 resuming + abort_requested → aborting (restore 중단 + drain, resume 무시)",
    entity: "run",
    cur: "resuming",
    event: { type: "abort_requested" },
    expectNext: "aborting",
  },
  // --- R28 race: resume_requested + abort_requested → aborting (트리거된 resume 폐기) ---
  {
    name: "R28 race: resume_requested + abort_requested → aborting (resume 무시 / Phase A lease 반납 → drain 즉시)",
    entity: "run",
    cur: "resume_requested",
    event: { type: "abort_requested" },
    expectNext: "aborting",
  },
  // --- IllegalTransition: 정의되지 않은 (state,event) (silent no-op 금지) ---
  {
    name: "IllegalTransition: queued + run.started (claim 전 start 불가)",
    entity: "run",
    cur: "queued",
    event: { type: "run.started" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: terminal completed + abort_requested (종결 run abort 불가)",
    entity: "run",
    cur: "completed",
    event: { type: "abort_requested" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: cancelled + worker.claimed (종결 run 재claim 불가)",
    entity: "run",
    cur: "cancelled",
    event: { type: "worker.claimed" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: running + finalize_ok (completing 경유 없이 finalize 불가)",
    entity: "run",
    cur: "running",
    event: { type: "finalize_ok" },
    expectThrow: "IllegalTransition",
  },
];

// ===== Workitem 전이 픽스처 (state-machine.md §2) =====
export const WORKITEM_FIXTURES: WorkitemFixture[] = [
  {
    name: "W1 new + checkout (unique_reference 미중복) → processing",
    entity: "workitem",
    cur: "new",
    event: { type: "checkout" },
    guard: { uniqueReferenceFree: true },
    expectNext: "processing",
  },
  {
    name: "W2 processing + run_succeeded (sink 정책 만족) → successful",
    entity: "workitem",
    cur: "processing",
    event: { type: "run_succeeded" },
    guard: { sinkPolicyMet: true },
    expectNext: "successful",
    expectEmits: ["workitem.completed"],
  },
  {
    name: "W3 processing + business_exception → failed_business",
    entity: "workitem",
    cur: "processing",
    event: { type: "business_exception" },
    expectNext: "failed_business",
  },
  // --- W4/W5: system_exception + max_attempts 분기 (fixture=2) ---
  {
    name: "W4 processing + system_exception (attempts < max, 1<2) → retry (evidence 유지, 백오프)",
    entity: "workitem",
    cur: "processing",
    event: { type: "system_exception" },
    guard: { attemptsBelowMax: true },
    expectNext: "retry",
  },
  {
    name: "W5 processing + system_exception (attempts >= max, 2>=2) → abandoned (dead_letter 생성)",
    entity: "workitem",
    cur: "processing",
    event: { type: "system_exception" },
    guard: { attemptsBelowMax: false },
    expectNext: "abandoned",
    expectEmits: ["workitem.dead_lettered"],
  },
  // --- W6/W7: checkout_expired + max_attempts 분기 (fixture timeout 300ms) ---
  {
    name: "W6 processing + checkout_expired (attempts < max) → retry (체크아웃 회수, evidence 유지)",
    entity: "workitem",
    cur: "processing",
    event: { type: "checkout_expired" },
    guard: { attemptsBelowMax: true },
    expectNext: "retry",
  },
  {
    name: "W7 processing + checkout_expired (attempts >= max) → abandoned (dead_letter 생성)",
    entity: "workitem",
    cur: "processing",
    event: { type: "checkout_expired" },
    guard: { attemptsBelowMax: false },
    expectNext: "abandoned",
    expectEmits: ["workitem.dead_lettered"],
  },
  // --- W8: retry 재checkout (백오프 경과) → processing (카운터 리셋) ---
  {
    name: "W8 retry + checkout (백오프 경과, fixture base 10ms) → processing (step/loop 카운터 리셋, cursor·raw 보존)",
    entity: "workitem",
    cur: "retry",
    event: { type: "checkout" },
    guard: { backoffElapsed: true },
    expectNext: "processing",
  },
  // --- W9/W11: 타이머 race — checkout timer pause/resume (상태 유지) ---
  {
    name: "W9 timer: processing + run_suspended → processing (상태 유지, checkout timer pause)",
    entity: "workitem",
    cur: "processing",
    event: { type: "run_suspended" },
    expectNext: "processing",
  },
  {
    name: "W11 timer: processing + run_resumed → processing (상태 유지, checkout timer resume — 잔여 TTL부터)",
    entity: "workitem",
    cur: "processing",
    event: { type: "run_resumed" },
    expectNext: "processing",
  },
  // --- W10: abandoned 재처리 ---
  {
    name: "W10 abandoned + manual_replay (운영자 권한) → new (attempts 리셋, DLQ 복원)",
    entity: "workitem",
    cur: "abandoned",
    event: { type: "manual_replay" },
    guard: { operatorAuthorized: true },
    expectNext: "new",
  },
  // --- IllegalTransition ---
  {
    name: "IllegalTransition: new + run_succeeded (checkout 전 성공 불가)",
    entity: "workitem",
    cur: "new",
    event: { type: "run_succeeded" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: successful + checkout (종결 workitem 재checkout 불가)",
    entity: "workitem",
    cur: "successful",
    event: { type: "checkout" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: failed_business + manual_replay (manual_replay은 abandoned에서만)",
    entity: "workitem",
    cur: "failed_business",
    event: { type: "manual_replay" },
    expectThrow: "IllegalTransition",
  },
];

// ===== HumanTask 전이 픽스처 (state-machine.md §3) =====
export const HUMANTASK_FIXTURES: HumanTaskFixture[] = [
  {
    name: "H1 open + assign → assigned",
    entity: "human_task",
    cur: "open",
    event: { type: "assign" },
    expectNext: "assigned",
  },
  {
    name: "H2 assigned + start → in_progress",
    entity: "human_task",
    cur: "assigned",
    event: { type: "start" },
    expectNext: "in_progress",
  },
  {
    name: "H3 in_progress + resolve → resolved (run resume_requested 트리거 R13)",
    entity: "human_task",
    cur: "in_progress",
    event: { type: "resolve" },
    expectNext: "resolved",
    expectEmits: ["human_task.resolved"],
  },
  // --- H4a/H4b: timeout 정책 분기 (guard.onTimeout) — split-brain 방지 ---
  {
    name: "H4a in_progress + timeout (on_timeout=fail) → expired (run R14 failed_business)",
    entity: "human_task",
    cur: "in_progress",
    event: { type: "timeout" },
    guard: { onTimeout: "fail" },
    expectNext: "expired",
    expectEmits: ["human_task.expired"],
  },
  {
    name: "H4a open + timeout (on_timeout=fail) → expired",
    entity: "human_task",
    cur: "open",
    event: { type: "timeout" },
    guard: { onTimeout: "fail" },
    expectNext: "expired",
  },
  {
    name: "H4b assigned + timeout (on_timeout=escalate) → escalated (자동 에스컬레이션, run R15 suspended 유지)",
    entity: "human_task",
    cur: "assigned",
    event: { type: "timeout" },
    guard: { onTimeout: "escalate" },
    expectNext: "escalated",
    expectEmits: ["human_task.escalated"],
  },
  {
    name: "H4b in_progress + timeout (on_timeout=escalate) → escalated",
    entity: "human_task",
    cur: "in_progress",
    event: { type: "timeout" },
    guard: { onTimeout: "escalate" },
    expectNext: "escalated",
  },
  // --- H5: 수동 에스컬레이션 ---
  {
    name: "H5 in_progress + escalate → escalated (관리자 수동 에스컬레이션, run R15)",
    entity: "human_task",
    cur: "in_progress",
    event: { type: "escalate" },
    expectNext: "escalated",
  },
  // --- H6: escalated 재배정 ---
  {
    name: "H6 escalated + assign → assigned (새 담당자 재배정)",
    entity: "human_task",
    cur: "escalated",
    event: { type: "assign" },
    expectNext: "assigned",
  },
  // --- H7: cancel (* → cancelled), run abort 연동(R16) ---
  {
    name: "H7 open + cancel → cancelled (run abort 연동 R16)",
    entity: "human_task",
    cur: "open",
    event: { type: "cancel" },
    expectNext: "cancelled",
  },
  {
    name: "H7 in_progress + cancel → cancelled",
    entity: "human_task",
    cur: "in_progress",
    event: { type: "cancel" },
    expectNext: "cancelled",
  },
  {
    name: "H7 escalated + cancel → cancelled",
    entity: "human_task",
    cur: "escalated",
    event: { type: "cancel" },
    expectNext: "cancelled",
  },
  // --- H8: escalated 재timeout → expired (무한 에스컬레이션 방지, 정책 무관) ---
  {
    name: "H8 escalated + timeout (정책 무관) → expired (재에스컬레이션 없음, run R14)",
    entity: "human_task",
    cur: "escalated",
    event: { type: "timeout" },
    guard: { onTimeout: "escalate" }, // 정책 무관 — escalate여도 expired로 종결
    expectNext: "expired",
    expectEmits: ["human_task.expired"],
  },
  // --- IllegalTransition ---
  {
    name: "IllegalTransition: open + start (assign 전 start 불가)",
    entity: "human_task",
    cur: "open",
    event: { type: "start" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: resolved + assign (종결 task 재배정 불가)",
    entity: "human_task",
    cur: "resolved",
    event: { type: "assign" },
    expectThrow: "IllegalTransition",
  },
  {
    name: "IllegalTransition: expired + timeout (종결 task 재timeout 불가)",
    entity: "human_task",
    cur: "expired",
    event: { type: "timeout" },
    expectThrow: "IllegalTransition",
  },
];

export const ALL_FIXTURES: TransitionFixture[] = [
  ...RUN_FIXTURES,
  ...WORKITEM_FIXTURES,
  ...HUMANTASK_FIXTURES,
];

// ===== 간단 assert 루프 (테스트 러너 비종속) =====
// transition*()는 codegen이 .md 전이표에서 생성하는 구현(state-machine-types.ts는 declare만).
// 이 루프는 그 구현(codegen/transitions.ts)을 대상으로 fixture를 검증한다.

function dispatch(f: TransitionFixture): TransitionResult<string> {
  switch (f.entity) {
    case "run":
      return transitionRun(f.cur, f.event, f.guard ?? {});
    case "workitem":
      return transitionWorkitem(f.cur, f.event, f.guard ?? {});
    case "human_task":
      return transitionHumanTask(f.cur, f.event, f.guard ?? {});
  }
}

function emittedEvents(sideEffects: SideEffectCmd[]): string[] {
  return sideEffects
    .filter((c): c is Extract<SideEffectCmd, { kind: "emitEvent" }> => c.kind === "emitEvent")
    .map((c) => c.event);
}

export interface FixtureFailure {
  name: string;
  reason: string;
}

/** ALL_FIXTURES(또는 주어진 배열)를 검증하고 실패 목록을 반환. 0건이면 통과. */
export function runFixtures(fixtures: TransitionFixture[] = ALL_FIXTURES): FixtureFailure[] {
  const failures: FixtureFailure[] = [];

  for (const f of fixtures) {
    if (f.expectThrow === "IllegalTransition") {
      let threw = false;
      try {
        dispatch(f);
      } catch (e) {
        threw = e instanceof IllegalTransition;
        if (!threw) {
          failures.push({
            name: f.name,
            reason: `expected IllegalTransition, got ${e instanceof Error ? e.name : String(e)}`,
          });
        }
      }
      if (!threw && !failures.some((x) => x.name === f.name)) {
        failures.push({ name: f.name, reason: "expected IllegalTransition, but no throw" });
      }
      continue;
    }

    // expectNext 경로
    let result: TransitionResult<string>;
    try {
      result = dispatch(f);
    } catch (e) {
      failures.push({
        name: f.name,
        reason: `unexpected throw: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (f.expectNext !== undefined && result.next !== f.expectNext) {
      failures.push({ name: f.name, reason: `next: expected ${f.expectNext}, got ${result.next}` });
    }

    if (f.expectEmits && f.expectEmits.length > 0) {
      const emitted = emittedEvents(result.sideEffects);
      const missing = f.expectEmits.filter((ev) => !emitted.includes(ev));
      if (missing.length > 0) {
        failures.push({
          name: f.name,
          reason: `emits: missing [${missing.join(", ")}], got [${emitted.join(", ")}]`,
        });
      }
    }
  }

  return failures;
}