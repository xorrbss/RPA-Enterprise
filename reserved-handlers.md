# 예약 핸들러 계약 (Reserved Handlers v1)

> IR `target`이 복귀형 예약 핸들러 호출(`@challenge` / `@human_task`) 또는 `@end_no_data` 터미널일 때 인터프리터가 호출하는 내장 핸들러의 입출력·복귀 계약.
> 핸들러는 IR 노드가 아니라 **인터프리터 제공 함수**다. 복귀형 핸들러는 IR target의 `return_node`로 재개하고, `@end_no_data`는 return node 없이 즉시 정상 종료한다.

---

## IR target shape

```ts
type ReservedHandlerTarget =
  | { handler: "@challenge"; input: {}; return_node: IRNodeId }
  | { handler: "@human_task"; input: HumanTaskInput; return_node: IRNodeId }
  | "@end_no_data";

type HumanTaskInput = {
  kind: "approval" | "validation" | "exception";
  payload?: Record<string, unknown>;
  assignee_role: string;
  timeout?: string;
  on_timeout?: "fail" | "escalate"; // default fail
};
```

규칙:
- `@challenge`/`@human_task` string target은 금지한다. 반드시 `{ handler, input, return_node }` closed object를 사용한다.
- `return_node`는 `nodes`에 존재하는 노드 id여야 하며, 정적 검증 그래프의 간선으로 취급한다.
- `@end_no_data`는 terminal target이다. `return_node`를 갖지 않으며 `empty_result_allowed` witness 없이는 prod 승격이 차단된다.
- handler-call object의 최상위 추가 키는 금지한다. `input` 의미는 본 문서의 핸들러별 섹션이 권위다.

---

## 공통 결과 타입

```ts
type ReservedHandlerResult =
  | { status: "resolved";  next: IRNodeId; sessionGeneration?: number }   // 처리 완료 → next 노드로 복귀
  | { status: "suspended"; humanTaskId: string; resumeToken: string }     // 런 suspend (bookmark)
  | { status: "failed";    exception: ClassifiedException };              // 예외 → Worker 루프가 분류대로 처리

type HandlerContext = {
  runId: string; workitemId?: string; nodeId: string;     // 진입 노드
  pageStateRef: PageStateRef;
  siteProfileId: string; browserIdentityId: string; networkPolicyId: string;
  challengeEventId?: string;                              // @challenge 진입 시 ChallengeDetector가 생성
  returnNodeOnResolve: IRNodeId;                          // IR target.return_node
};
```

인터프리터 호출 규약: `await handler(ctx) → ReservedHandlerResult`. 결과에 따라:
- `resolved` → `result.next`(보통 `ctx.returnNodeOnResolve`) 노드부터 재개. `sessionGeneration` 있으면 세션 캐시 갱신.
- `suspended` → Run 상태 `running → suspending → suspended`(state-machine.md). `resume_token` 저장. Human Task 해소 시 `resuming`.
- `failed` → `result.exception.class`(business/system/challenge/security)대로 Worker 루프 처리.

---

## @challenge

ChallengeResolutionPolicy 상태머신(PRD §10.6)을 실행한다.

```ts
// 입력: ctx.challengeEventId 필수
// 동작: challenge_resolution_attempts를 순차 실행
//   session_refresh → retry_same_identity → network_retry → human_assist → provider → fail → open_circuit
// 각 attempt 결과로 다음 결정.
```

| 종료 | 결과 |
|---|---|
| session_refresh/retry/network로 해소 | `{ status: "resolved", next: returnNodeOnResolve, sessionGeneration: N }` |
| human_assist 필요(CAPTCHA/MFA) | `{ status: "suspended", humanTaskId, resumeToken }` (Human Task kind=captcha\|mfa) |
| 모든 attempt 소진 | `{ status: "failed", exception: { class: "challenge", code: "CHALLENGE_UNRESOLVED" } }` |
| circuit open(사이트 차단율 임계) | `{ status: "failed", exception: { class: "system", code: "SITE_CIRCUIT_OPEN" } }` |

규칙: 동일 challenge_event에 같은 action 중복 발화 금지(attempt 테이블로 보장). provider는 site risk=red면 skip.

---

## @human_task

승인/검증/예외 등 사람 개입이 필요한 노드. 항상 suspend.

```ts
// 입력: kind(approval|validation|exception), payload, assignee_role, timeout, on_timeout(fail|escalate, 기본 fail)
```

| 종료 | 결과 |
|---|---|
| 정상 생성 | `{ status: "suspended", humanTaskId, resumeToken }` |
| 해소(resolve) 후 | (인터프리터가 resume 시) `returnNodeOnResolve`부터 재개 |
| timeout 초과 (on_timeout=fail) | Human Task `expired`(H4a) → Run R14 → `{ status: "failed", exception: { class: "business", code: "HUMAN_TASK_EXPIRED" } }` |
| timeout 초과 (on_timeout=escalate) | Human Task `escalated`(H4b) → 관리자 큐, Run은 suspended 유지(R15). 재배정(H6) 없이 다시 timeout되면 `expired`(H8) → Run R14 → HUMAN_TASK_EXPIRED |

복귀 시점: `human_tasks.state = resolved` 이벤트 → Run `resume_requested`. resume_token으로 진입 노드 컨텍스트 복원.

---

## @end_no_data

데이터 없음 정상 종료(수집 실패 아님). 빈 결과 witness가 확인된 경우만 도달해야 한다.

```ts
// 입력 없음. 즉시 종료.
```

| 종료 | 결과 |
|---|---|
| 항상 | `{ status: "resolved", next: "__terminal__" }` 후 Run은 `completed`로 마감하고 `run.completed` payload outcome/reason에 `success_empty`를 기록 |

주의: verify의 `empty_result_allowed` witness 없이 `@end_no_data`로 보내는 IR은 **승격 시 경고**(수집 실패를 빈 데이터로 위장할 위험).

---

## 복귀(resume) 토큰 스키마

```ts
type ResumeToken = {
  runId: string; workitemId?: string;
  resumeNodeId: IRNodeId;          // 재개할 노드
  loopContext?: { iteration: number; page_count: number };   // loop 내부에서 suspend된 경우
  pageStateRef: PageStateRef;      // suspend 시점 상태(복원 검증용)
  issuedAt: string; expiresAt: string;
  kid: string;                     // [FIX] HMAC 키 식별자 — 키 회전 시 검증할 키 선택. 무중단 rotation 지원.
  hmac: string;                    // 위변조 방지 서명(kid가 가리키는 키로 검증)
};
```

resume 시 인터프리터는 `pageStateRef`와 현재 페이지 상태를 대조 — 불일치 시(세션 만료 등) 재로그인 플로우로 우회하거나 System 예외.
