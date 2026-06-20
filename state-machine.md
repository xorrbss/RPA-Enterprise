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
| R5 | running | node→@human_task | suspending | — | human_task 생성(**kind=@human_task input kind**: approval\|validation\|exception(reserved-handlers), 미지정 시 exception 기본). RunEvent `human_task_required.humanTaskKind`로 전파 — 하드코딩 금지(approval/validation을 exception으로 오라우팅하면 RBAC resolve 권한 혼선, auth-rbac §2) |
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

**R26 fail-closed 규칙**: `suspending`은 bookmark 저장 중인 전이 상태라 API가 `bookmarkCancelable=true`를 추정하면 안 된다. bookmark-cancel port 또는 durable abort intent가 연결된 런타임만 R26을 즉시 적용할 수 있다. Product Open v1 제어평면은 그 소유권이 없으므로 `suspending` abort를 멱등 예약 전에 `WORKITEM_CHECKOUT_CONFLICT`(`run_bookmark_in_progress`)로 거부하고, R11로 `suspended`에 도달한 뒤 R16으로 재시도하게 한다. 이는 성공 응답으로 알 수 없는 bookmark side effect를 숨기는 것을 금지하기 위한 계약이다.

**INIT 규칙(R2/R3a/R3b — `init_failed` 발생 경계)**: **INIT = `claimed`→`running` 셋업 구간**이다. 워커는 claim(R1, `queued`→`claimed`) 직후 run을 구동하기 위한 셋업을 수행한다 — drive-input 적재 + 브라우저 세션 bind + site page-state config 적재 + executor/resolver 구성(런타임 Phase B). 이 셋업이 성공하면 R2(`run.started`, `initOk`)로 `running`에 진입하고, **실패하면 `status='claimed'`에서 `init_failed` 이벤트를 발생**시켜 R3a/R3b로 분기한다. 셋업 실패가 현재 `claimed`에 영구 잔류(좀비)하지 않도록 하는 것이 본 전이의 목적이다.
  - **적격/부적격**: 브라우저 lease 확보(Phase A)는 claim **CAS 이전**에 일어나 그 시점 run 상태는 여전히 `queued`이므로 lease 실패는 `init_failed` 대상이 **아니다**(`queued`+`init_failed`는 정의되지 않은 전이=`IllegalTransition`). lease 실패는 큐/claim 재시도(dispatcher)로 처리한다. `init_failed`는 `claimed` 이후 Phase B 셋업 실패에만 한정한다.
  - **연속 실패 카운터**: R3a/R3b 분기의 '연속 실패'는 누적 `runs.attempts`가 아니라 **`runs.consecutive_init_failures`**다(누적과 의미 분리 — 계약 단어가 '연속(consecutive)'). **R3a 재큐 시 +1, R2(=INIT 성공, `running` 진입) 시 0으로 reset**. guard `연속 실패 임계 미만` = 이번 실패 포함 연속 실패 수 < `run.init_fail_threshold`(ops-defaults §1, 기본 3) → R3a, 그 이상 → R3b. 즉 임계 3이면 2회 재큐 후 3회째에 R3b로 종결한다.
  - **R3b `서킷 오픈` = worker 서킷(결정됨, versioned)**: R3b의 `openCircuit`이 여는 서킷의 **대상 엔티티 = worker**다. 근거: 실제 lease 게이팅 READ는 worker 서킷 단 한 곳(`acquireBrowserLease`가 `workers.circuit_state='open'`이면 거부)이고, site 서킷은 표시 전용(차단 없음)이며, INIT 실패는 사이트-접근-차단이 아니라(red 사이트는 bind 이전에 `SITE_PROFILE_BLOCKED`로 선차단) worker-인프라/세션 bind 문제이므로 '워커 격리'가 정합하다. **단 트리거는 R3b의 per-run 카운터(`runs.consecutive_init_failures`, 임계 3)를 회로에 직결하지 않는다** — 한 run의 실패로 워커 전체(모든 테넌트/사이트 run)를 차단하는 과잉격리를 피하기 위해, **워커가 모든 INIT 실패(R3a/R3b 공통)를 per-worker로 누적**(`workers.consecutive_init_failures`)해 **`worker.circuit.consecutive_failures`(기본 5)** 도달 시 회로를 연다(`workers.circuit_state='open'` + `circuit_until=now()+worker.circuit.open_duration`). 즉 `openCircuit` side effect는 run 계층에서 직접 실행하지 않고(run 핸들러는 `failed_system`+DLQ 종결만), **worker 계층의 per-worker 누적이 그 의도를 실현**한다(조용한 false 아님 — 설계상 계층 분리). **회복(half-open 프로브 + close 임계, versioned)**: 게이트(`checkWorkerCircuit`)는 **read-only 판정**이다 — `open`+cooldown(`circuit_until` 미설정 OR 미래)이면 거부(격리), 그 외(`closed`·`half_open`·`open`+cooldown 경과)면 허용. **상태 전이는 전부 프로브 INIT 결과(`recordWorkerInitSuccess/Failure`)에서 원자적으로** 일어난다(게이트가 전이를 미리 하지 않으므로, 프로브가 실제로 안 일어나는 경로 — `SESSION_LOCKED` 등 lease 조기반환·resume lease 재사용 — 는 회로를 `half_open` limbo 로 남기지 않는다). `open`+cooldown 경과 claim 이 곧 프로브다: **프로브 성공 N회 연속**(`workers.half_open_successes` ≥ `worker.circuit.half_open_close_threshold`, 기본 2) → `closed`(회복 확정·카운터 reset); 첫 프로브 성공(임계 미달)은 `open`→`half_open` 진입; **프로브 1회 실패 → `open` 유지/재진입**+새 cooldown(`closed`의 누적 임계 5보다 민감 — 시험 중 한 번만 실패해도 재격리). `closed`에서의 INIT 성공은 `consecutive_init_failures`만 0 reset(streak 종료, 상태 유지). cooldown 중·`circuit_until` 미설정(레거시/수동 open)은 fail-closed 유지. `half_open` 프로브 동시성은 잠그지 않는다(행잠금이 성공 누적을 직렬화·실패는 즉시 재open으로 수렴 — single-probe lock 미도입 v2). **best-effort 한계**(versioned): record\*는 게이트(claim tx)와 다른 autocommit connection이라, 임계만큼의 동시 프로브 성공이 `closed`한 '직후' 도착한 stale 프로브 실패는 `closed` 누적(+1)으로 흡수될 수 있다(희귀·과소격리 방향, 누적이 결국 재open — trial epoch 토큰은 후속). worker 서킷은 infra라 tenant `events_outbox` 이벤트를 내지 않는다(asyncapi infra 배제 불변식 유지).

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

**assignment/routing 규칙**: `reassignAssignee`는 자동 DB 반영이 아니라 호출측이 반드시 소비해야 하는 pending side effect다. H6 `assign`은 요청 body의 명시 `assignee`로 이 side effect를 소비한다. H5 수동 escalate와 Run R15는 durable routing port/assignee policy가 없으면 어떤 assignee/assignee_role/admin queue로도 추정 매핑하지 않는다. 현재 API 구현은 이 pending side effect를 미지원으로 보고 동일 트랜잭션 rollback + `CONTROL_PLANE_INTERNAL_ERROR`로 fail-closed한다.

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

> Repo-controlled fail-closed v1: H5/R15 `reassignAssignee` success requires an explicit routing/assignment owner; absent that owner, API rolls back and returns `CONTROL_PLANE_INTERNAL_ERROR` instead of reporting `escalated`.

> Repo-controlled fail-closed v1: `suspending` abort success requires a runtime-owned bookmark-cancel port or durable abort intent; absent that owner, API rejects before idempotency reservation and allows retry after `suspended`.
