# 상태 전이 계약 (State Machines v1)

> Run / Workitem / HumanTask의 **완전한** 전이표. PRD의 발췌본을 대체하는 단일 진실원천.
> 전이 함수: `transition(current, event, guard) → { next, sideEffects[] }`. 모든 전이는 DB 조건부 UPDATE(CAS)로 race 방지.

---

## 1. Run 상태

상태: `queued, claimed, running, suspending, suspended, resume_requested, resuming, completing, completed, aborting, cancelled, failed_business, failed_system`.

IR terminal `success_empty`는 RunState를 새로 만들지 않고 `completed` + `run.completed` payload의 outcome/reason(`success_empty`)로 표현한다. 빈 결과 witness 없이 이 경로를 쓰는 IR은 승격 차단/경고 대상이다(reserved-handlers.md `@end_no_data`).

종결(terminal): `completed, cancelled, failed_business, failed_system`.

| # | 현재 | 이벤트 | 다음 | guard | sideEffects |
|---|---|---|---|---|---|
| R1 | queued | worker.claimed | claimed | lease 확보 | runs.worker_id set |
| R2 | claimed | run.started | running | INIT 성공 | run.started 이벤트 |
| R3a | claimed | init_failed | queued | 연속 실패 임계 **미만** | **재큐**(attempts+1, 백오프) |
| R3b | claimed | init_failed | failed_system | 연속 실패 임계 **이상** | 서킷 오픈, DLQ 판단, 더 이상 재큐 안 함 |
| R4 | running | step.challenge_detected | suspending | policy=human_first | human_task 생성(**kind=ChallengeSummary.type: mfa면 mfa, 그 외 captcha**), bookmark 시작 |
| R5 | running | node→@human_task | suspending | — | human_task 생성 |
| R6 | running | abort_requested | aborting | — | **SSE close + browser drain** |
| R7 | running | last_node_success | completing | 흐름 종료(terminal 도달) | 산출 확정 시작 |
| R8 | running | unrecoverable_exception | failed_system | system, 재시도 소진 | 실패 스크린샷, DLQ 판단 |
| R9 | running | business_exception | failed_business | business | human 후속 없으면 종결 |
| R10 | running | security_exception | aborting | security | **SSE close + browser drain + 알림** |
| R11 | suspending | bookmark_saved | suspended | resume_token 생성됨 | browser lease **반납**(Phase A 기본) 또는 유지(Live Assist) |
| R12 | suspending | bookmark_failed | failed_system | — | 일관성 복구 |
| R13 | suspended | human_task.resolved | resume_requested | task valid | resume 이벤트 |
| R14 | suspended | human_task.expired | failed_business | — | DLQ/알림. timeout 정책 분기(fail/escalate)는 HumanTask H4a/H4b에서 결정 — `expired` 도달 = run 실패(정책 재판정 안 함) |
| R15 | suspended | human_task.escalated | suspended | escalate | 담당자 재배정(상태 유지) |
| R16 | suspended | abort_requested | aborting | — | resume 무시 |
| R17 | resume_requested | worker.claimed | resuming | lease 확보 | session restore 시작 |
| R18 | resuming | restore_ok | running | pageState 대조 통과 | 진입 노드부터 재개, **run.resumed 이벤트** |
| R19 | resuming | restore_failed | running | 재로그인 우회 가능 | login_flow로 분기, **run.resumed 이벤트** |
| R20 | resuming | restore_failed | failed_system | 우회 불가 | 실패 마감 |
| R21 | completing | finalize_ok | completed | **artifact flush + 산출 확정 + 이벤트 발행 성공** (sink 전달 대기 안 함 — §2 decoupled) | run.completed, usage flush |
| R22 | completing | finalize_failed | failed_system | 저장/이벤트 발행 실패 | 보상 시도 후 마감, 일관성 로그 |
| R23 | aborting | drain_ok | cancelled | — | run.cancelled, lease 회수 |
| R24 | aborting | drain_timeout | cancelled | abort_timeout 초과 | 강제 lease kill |
| R25 | completing | abort_requested | completing | — | **abort 무시(거부)**: finalize가 이긴다. `rejectCommand(RUN_ALREADY_TERMINAL, 409)`, 상태 유지 |
| R26 | suspending | abort_requested | aborting | bookmark 진행 취소 가능 | bookmark 중단 후 drain. 불가 시 suspended 도달까지 대기 후 R16 |
| R27 | resuming | abort_requested | aborting | — | restore 중단 + drain, resume 무시 |
| R28 | resume_requested | abort_requested | aborting | — | **resume 무시**(트리거된 resume 폐기). Phase A는 R11에서 lease 반납 상태 → drain 즉시 완료 후 R23으로 cancelled |

**race 규칙**: R6/R16(abort) vs R13(resolve) 동시 → **abort 우선**(R16이 R13을 무효화). guard에서 현재 상태 CAS로 보장. **R25**: `completing` 진입 후 abort_requested → **finalize 우선**(abort 거부, 산출 일관성 보호). R21은 모든 산출(artifact redaction pending 제외) flush 후에만.

**abort 보편성**: abort_requested는 비종결 실행 상태 전체에서 정의된다 — running(R6)·suspending(R26)·suspended(R16)·resume_requested(R28)·resuming(R27). 어느 상태에서도 `aborting`을 경유해 `cancelled`로 마감(어휘 체인 abort→cancelled→run.cancelled 유지). 유일한 예외는 `completing`(R25, finalize 우선). (queued/claimed 단계 abort는 run.started 이전이므로 dispatcher가 큐/claim 회수로 처리 — Run 전이 아님.)

---

## 2. Workitem 상태

상태: `new, processing, successful, retry, failed_business, failed_system, abandoned`.

종결: `successful, failed_business, abandoned`. (failed_system은 retry 경유 후 abandoned로 흡수)

| # | 현재 | 이벤트 | 다음 | guard | sideEffects |
|---|---|---|---|---|---|
| W1 | new | checkout | processing | unique_reference 미중복 | checked_out_by/at set |
| W2 | processing | run_succeeded | successful | sink 정책 만족(또는 수집 성공) | workitem.completed, cursor commit(§raw) |
| W3 | processing | business_exception | failed_business | — | human_task 또는 종결 |
| W4 | processing | system_exception | retry | attempts < max | evidence 유지, 백오프 |
| W5 | processing | system_exception | abandoned | attempts >= max | **dead_letter 생성** |
| W6 | processing | checkout_expired | retry | attempts < max | 체크아웃 회수, evidence 유지 |
| W7 | processing | checkout_expired | abandoned | attempts >= max | dead_letter 생성 |
| W8 | retry | checkout | processing | 백오프 경과 | **step/loop 카운터 리셋, cursor·raw 보존** |
| W9 | processing | run_suspended | processing | — | 상태 유지(런 suspend와 독립), **checkout timer pause**(재개는 W11) |
| W10 | abandoned | manual_replay | new | 운영자 재처리 권한 | attempts 리셋, DLQ에서 복원 |
| W11 | processing | run_resumed | processing | — | 상태 유지. **checkout timer resume(un-pause)** — pause된 잔여 TTL부터 재개. checkout_expired(W6/W7) 판정은 pause 구간을 제외해 계산(suspend 중 만료 오발 방지) |

**run ↔ workitem 관계**: 1 Workitem = 1 Run(기본). Run이 `completed`면 W2, `failed_system`이면 W4/W5, `failed_business`면 W3. **수집 성공 ≠ 전달 성공**: Run의 `completed`는 **raw 영속화 + artifact flush 완료**까지만 보장한다(R21). **sink 전달은 Run 종결과 분리(decoupled)** — sink 미완이어도 Run은 `completed`로 마감되고 W2로 가며, sink는 `sink_deliveries` DLQ가 별도 보장한다(§raw idempotency). 즉 별도의 `succeeded_collection` Run 상태는 두지 않는다(§1 enum 참조). sink 진행도는 `sink_deliveries.status`로만 추적.

---

## 3. HumanTask 상태

상태: `open, assigned, in_progress, resolved, expired, cancelled, escalated`.

종결: `resolved, expired, cancelled`.

| # | 현재 | 이벤트 | 다음 | guard | sideEffects |
|---|---|---|---|---|---|
| H1 | open | assign | assigned | — | assignee set |
| H2 | assigned | start | in_progress | — | — |
| H3 | in_progress | resolve | resolved | — | **run resume_requested 트리거**(R13) |
| H4a | open/assigned/in_progress | timeout | expired | on_timeout=fail | run R14(failed_business) |
| H4b | open/assigned/in_progress | timeout | escalated | on_timeout=escalate | 관리자 큐로 **자동 에스컬레이션**, run R15(suspended 유지) |
| H5 | open/assigned/in_progress | escalate | escalated | — | 관리자 **수동 에스컬레이션** → assigned로 복귀 가능, run R15 |
| H6 | escalated | assign | assigned | — | 새 담당자 재배정 |
| H7 | open/assigned/in_progress/escalated | cancel | cancelled | — | run abort 연동(R16). resolved/expired/cancelled에서 cancel은 IllegalTransition |
| H8 | escalated | timeout | expired | — | **에스컬레이션 후에도 미해소 → 최종 만료**(재에스컬레이션 없음 — 무한 대기 방지), run R14 |

규칙: Phase A에서는 `live_assist` 종류 없이 approval/validation/captcha/mfa/exception만. captcha/mfa는 **snapshot 기반 처리**(Phase A, lease 반납됨) — 실시간 제어는 Phase B(D12).

---

## 4. 전이 함수 시그니처 (codegen 대상)

```ts
type TransitionResult<S> = { next: S; sideEffects: SideEffectCmd[] };

function transitionRun(cur: RunState, ev: RunEvent, g: RunGuard): TransitionResult<RunState>;
function transitionWorkitem(cur: WorkitemState, ev: WorkitemEvent, g: WorkitemGuard): TransitionResult<WorkitemState>;
function transitionHumanTask(cur: HumanTaskState, ev: HumanTaskEvent, g: HumanTaskGuard): TransitionResult<HumanTaskState>;
// [FIX] transitionHumanTask는 guard 필요: HumanTaskGuard.on_timeout ∈ {fail, escalate} 가 timeout 시
//   H4a(→expired) vs H4b(→escalated) 분기를 결정한다(이전엔 guard 인자 부재로 분기 불가 → R14와 split-brain).
//   on_timeout은 reserved-handlers.md @human_task 입력 정책. escalated 상태의 재timeout(H8)은 정책 무관하게
//   expired로 종결(무한 에스컬레이션 방지). 정책 결정은 HumanTask 단계로 일원화, Run R14는 expired를 무조건 수용.

// 정의되지 않은 (상태,이벤트) 조합 → throw IllegalTransition(코드 ERROR), 절대 silent no-op 금지.
// 모든 전이의 DB 반영은: UPDATE ... WHERE id=? AND status=<cur> (CAS). 0 rows면 경합 → 재조회.
```

finalization 일관성: 종결 상태 진입 시 run_steps/workitems/events가 모두 최종값으로 commit되어야 하며, 부분 실패는 R22/W5로 흡수한다.
