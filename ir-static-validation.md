# IR 정적 검증 계약 (IR Static Validation v1)

> IR 시나리오 저장/승격 시 수행하는 **그래프 수준 정적 검증**. `ir.schema.json`(구조)·`ir-expression.md`(IREL 표현식)을 통과한 뒤 추가로 적용하는 규칙의 단일 진실원천.
> 원칙: **컴파일 타임 검증, 런타임 추정 금지, "조용한 false/unknown 금지"**. 위반은 코드와 함께 거부(error) 또는 prod 승격 차단(warning)으로 분류한다.

---

## 0. 검증 파이프라인 순서

시나리오 저장/승격 요청 → 아래 순서로 검증, 첫 단계 실패 시 중단:

1. **schema**: `ir.schema.json`(ajv) — 노드 구조·흐름키 oneOf. 실패 → `IR_SCHEMA_INVALID`.
2. **IREL compile**: 모든 expression 파싱+타입체크(`ir-expression.md`). 실패 → `IR_EXPRESSION_COMPILE_ERROR`.
3. **graph static validation**: 본 문서 §1 규칙(V1..V12). 구조 위반 → `IR_SCHEMA_INVALID`(reason 태그), 표현식 위반 → `IR_EXPRESSION_COMPILE_ERROR`.

검증 결과는 `ValidationReport`(§3). `errors`가 하나라도 있으면 **저장 거부**. `warnings`는 draft 저장은 허용하되 **prod 승격은 차단**(§3).

---

## 1. 정적 검증 규칙

심각도: **error**=저장 거부 / **promote-block**=draft 저장 허용·prod 승격 차단.

| # | 규칙 | 위반 시 | 심각도 | reason 태그 |
|---|---|---|---|---|
| V1 | **target 참조 무결성** — 모든 노드 target(`next`, `on[].target`의 노드 id, 복귀형 예약 핸들러 `return_node`, `fallback_chain[].entry_node`, `loop.body_target`, `loop.exit_target`)은 `nodes`에 존재해야 한다. `@challenge`/`@human_task`는 string target 금지, closed handler-call object만 허용한다. `@end_no_data`는 return node 없는 terminal target이다. | `IR_SCHEMA_INVALID` | error | `target_not_found`, `reserved_handler_call_shape_invalid` |
| V2 | **start 존재** — `start`가 `nodes`에 존재해야 한다. | `IR_SCHEMA_INVALID` | error | `start_not_found` |
| V3 | **종료 도달성** — `start`에서 흐름 그래프를 따라 적어도 하나의 종료(`terminal` 노드 또는 `@end_no_data`)에 도달 가능해야 한다. | `IR_SCHEMA_INVALID` | error | `no_reachable_terminal` |
| V4 | **loop/사이클 제약** — `loop`는 closed `{ body_target, exit_target, until, max_iterations }` shape를 사용한다. 두 target은 V1을 통과해야 하고, `exit_target`은 loop 노드에서 도달 가능해야 하며, `max_iterations`는 `ops-defaults.md` 상한(10000) 이하여야 한다. 흐름 그래프의 back-edge(사이클)는 **해당 사이클 안에 `loop` 노드가 있을 때만** 허용한다. | `IR_SCHEMA_INVALID` | error | `illegal_cycle`, `loop_target_invalid`, `loop_exit_unreachable`, `loop_max_iterations_unbounded` |
| V5 | **고아 노드** — `start`에서 도달 불가한 노드. 실행되지 않으므로 무해하나 작성 실수 신호. | (저장 허용) | promote-block | `unreachable_node` |
| V6 | **on priority 동률 금지** — 한 노드 `on[]` 내 동일 `priority` 둘 이상 금지(비결정 분기 방지). | `IR_SCHEMA_INVALID` | error | `duplicate_priority` |
| V7 | **@end_no_data witness 필수** — `@end_no_data` target 또는 `terminal: success_empty`로 가는 진입 노드의 `verify.criteria`에 `empty_result_allowed` witness가 있어야 한다. 없으면 수집 실패를 빈 데이터로 위장할 위험. | (저장 허용) | promote-block | `empty_result_without_witness` |
| V8 | **flags 레지스트리 준수** — 모든 `flags.*` 참조는 §2 권위 레지스트리에 등록된 키여야 한다(닫힌 집합). | `IR_EXPRESSION_COMPILE_ERROR`(IREL_UNKNOWN_VARIABLE) | error | `unknown_flag` |
| V9 | **node 출력 필드 한정** — `node.<id>.*`는 표준 출력 필드(`row_count`/`status`/`extracted_ref`/`tier`/`http_status`/`http_ok`)만 참조 가능. **단 `decision`(scalar)·`correction.<key>`(sub-namespace)는 `<id>`가 `@human_task`를 선언한 소유 노드일 때만 허용**(ir-expression §2; 일반 노드에서 참조 시 위반). | `IR_EXPRESSION_COMPILE_ERROR` | error | `unknown_node_field` |
| V10 | **value_match.path 문법** — §3 path 문법(dot-path, 인덱싱 금지)을 위반하거나 평가 대상이 부재. | `IR_SCHEMA_INVALID` | error | `invalid_value_path` |
| V11 | **fallback_chain 정합** — `tier`는 `T0..T3` 중 **중복 없이** 단조 사용. `entry_node`는 V1 적용. `advance_when` 생략·마지막 티어 실패 시 의미는 §4. | `IR_SCHEMA_INVALID` | error | `fallback_chain_invalid` |
| V12 | **fallback_chain 멱등성** — 체인 내 어느 티어든 `entry_node`가 **비-read_only** `side_effect`를 선언하면(=체인이 비-read_only), fallback이 티어를 재실행하므로 **모든 티어 `entry_node`**가 `side_effect.idempotency_key`(비어있지 않음)를 명시해야 한다(§4). `entry_node`가 `side_effect` 미선언이거나 `read_only`(키 없음)면 위반 — 스키마(`ir.schema.json`)는 *선언된* 비-read_only side_effect에만 키를 강제하므로 못 잡는 **무방비 재실행 진입점**이다. | `IR_SCHEMA_INVALID` | error | `fallback_side_effect_idempotency_missing` |
| V13 | **decision 분기 완전성** — 한 노드의 `on[]`이 `node.<htId>.decision`(@human_task 출력, **닫힌 enum** `approve`/`reject`/`correct`/`retry`)을 분기 키로 참조하면, 그 enum 도메인을 **전부** 커버해야 한다(catch-all when 또는 각 값 대응 branch). 부분 커버(일부 decision 값에 대응 branch 없음)면 그 값으로 해소된 task의 재개가 매칭 branch 없음 → `IR_NO_BRANCH_MATCHED`(System 예외→노드 재시도). decision은 사람 판정으로 고정이라 재시도해도 불변 → run 영구 stuck. "조용한 false/dead-end 금지"의 prod 적용. (값-의존 무매칭 일반은 정적 미검출이나, decision은 **닫힌 enum**이라 커버리지를 정적 판정 가능.) | (저장 허용) | promote-block | `decision_branch_incomplete` |

> V3/V4의 도달성·사이클 판정은 흐름 그래프를 노드=정점, (`next`/`on[].target` 노드 id/복귀형 예약 핸들러 `return_node`/`fallback entry_node`/`loop.body_target`/`loop.exit_target`)=간선으로 구성해 수행한다. `@end_no_data`/`terminal`은 종료 정점이다.
>
> **결정 #3 적용**: 복귀형 예약 핸들러 target은 closed object `{ handler, input, return_node }`다. `handler`는 `@challenge` 또는 `@human_task`, `input`은 명시 객체, `return_node`는 existing node id여야 한다. `@challenge`/`@human_task` string target은 저장 거부한다. `@end_no_data`는 데이터 없음 terminal이며 `return_node`를 갖지 않는다.
>
> **결정 #4 적용**: `loop`는 closed `{ body_target, exit_target, until, max_iterations }` shape다. validator는 두 target 존재, exit target 도달성, `until` IREL boolean compile, 그리고 bounded `max_iterations`를 검증한다. `loop` 없는 cycle은 무한 비종료 위험으로 거부한다.
>
> **정적 한계**: V3는 *구조* 도달성만 보장한다. `on[]`의 모든 `when`이 런타임에 false가 되는 **값-의존 무매칭**은 정적으로 잡을 수 없으며, 인터프리터가 `IR_NO_BRANCH_MATCHED`(System 예외 → 노드 재시도)로 표면화한다(ir-expression §5·§7, error-catalog). "조용한 dead-end" 금지.

---

## 2. flags 권위 레지스트리 (닫힌 집합)

> **[결정] `flags.*`는 닫힌 레지스트리다.** 이전엔 `ir-expression.md` §2가 "미정의 flag 참조=컴파일 에러"(닫힘)라 했으나 권위 목록이 없어 `flags.reviews_visible`(예시)가 미등록 상태였다. 본 표가 그 권위 목록이며, 시나리오가 참조할 수 있는 flag는 아래로 제한된다(V8).

| flag | 의미 | 원천 |
|---|---|---|
| `flags.no_next_page` | 다음 페이지 없음(페이지네이션 종료) | observe/PageState |
| `flags.cursor_reached` | 수집 커서 도달(이전 수집 경계) | interpreter |
| `flags.login_required` | 로그인 필요 화면 감지 | observe/PageState |
| `flags.blocked` | 차단/봇 감지 화면 | ChallengeDetector |
| `flags.not_found` | 대상 없음(404/빈 화면) | observe/PageState |
| `flags.no_review_message_visible` | "리뷰 없음" 류 빈 결과 witness | observe/PageState |
| `flags.reviews_visible` | 대상 데이터(리뷰 등) 목록 가시 | observe/PageState |

규칙:
- `PageState.flags`(`core-types.ts`, `Record<string, boolean>`)는 **런타임 표현**이다. PageStateResolver/observe는 위 등록 키만 set한다. 미등록 키를 런타임에 채워도 IREL은 참조 불가(V8가 컴파일에서 차단).
- **flag 추가 절차**: 본 표 + (해당 flag를 산출하는) PageState 생산자(`PageStateResolver`)를 **동시 갱신**해야 한다. 한쪽만 추가 금지.
- 도메인 특화 flag(예: `reviews_visible`)는 명시적으로 등록한다. 일반화가 필요하면 별도 결정.

---

## 3. value_match.path 문법 & ValidationReport

### value_match.path
- 문법: `ident ( "." ident )*` — dot-path만. **인덱싱(`a[0]`) 금지**(IREL §1 일관).
- 평가 대상: 직전 노드의 `extracted`(extract 결과) 또는 `node.<id>.*` 표준 출력. path 첫 식별자가 가리키는 루트가 부재하면 V10 위반.
- 비교값 `equals`는 `int`/`number`/`string`/`boolean`/`null` 리터럴.

### ValidationReport (검증 산출 — codegen 대상)
```ts
type ValidationIssue = {
  rule: "V1"|"V2"|"V3"|"V4"|"V5"|"V6"|"V7"|"V8"|"V9"|"V10"|"V11"|"V12"|"V13";
  reason: string;            // 위 표 reason 태그
  code: "IR_SCHEMA_INVALID" | "IR_EXPRESSION_COMPILE_ERROR";
  nodeId?: string;           // 위반 위치
  detail: string;            // 사람이 읽는 설명(민감정보 없음)
};
type ValidationReport = { errors: ValidationIssue[]; warnings: ValidationIssue[] };
```
- `errors` 비어있지 않으면 저장 거부(HTTP 422, `code`별).
- `warnings`(promote-block 규칙 V5/V7/V13): draft 저장은 허용, **prod 승격 API는 거부**(승격 차단). 운영자에게 목록 표시.

---

## 4. fallback_chain 의미론

- `tier`는 `T0→T1→T2→T3` 순서로만 정의(중복·역순 금지, V11).
- 각 티어를 `entry_node`부터 실행. `advance_when`(IREL 불린식) **true**면 다음 티어로 전환.
- `advance_when` **생략 시 기본**: 해당 티어가 실패(StepResult.status=`failed_*`)하면 자동으로 다음 티어 시도.
- **마지막 티어 실패 시**: 더 전환할 티어 없음 → 노드는 마지막 티어의 `StepResult`를 그대로 채택(분류대로 business/system/challenge/security 처리). 빈 결과로 위장하지 않는다("조용한 false 금지").
- **멱등성(V12 강제)**: 체인이 비-read_only면(= 어느 티어든 `entry_node`가 비-read_only `side_effect`를 선언) **모든 티어 `entry_node`**가 `side_effect.idempotency_key`를 명시해야 한다(재시도 안전). fallback은 `advance_when`/실패 시 티어를 재실행하므로, 키 없는 진입점은 부작용을 조용히 중복시킨다. 검사 범위는 **티어 `entry_node` 자체**다(다운스트림 경로 노드는 스키마가 노드별로 비-read_only side_effect에 키를 이미 강제 → 전역 보장). 인터프리터는 멱등 적용을 executor/DB 레이어에 위임한다(런타임 추가검사 없음).

---

## 5. 에러 코드 매핑 (요약)

| 위반 부류 | ErrorCode | exceptionClass | 시점 |
|---|---|---|---|
| 구조/그래프(V1·V2·V3·V4·V6·V10·V11·V12) | `IR_SCHEMA_INVALID` | business | 저장 |
| 표현식/스코프(V8 flag·V9 node 필드) | `IR_EXPRESSION_COMPILE_ERROR` | business | 저장 |
| 승격 차단(V5·V7·V13) | (warning, 코드 없음) | — | 승격 |

전부 `ir-expression.md` §7·`error-catalog.ts`와 정합. 본 문서는 **그래프 수준 규칙**을 고정하고, 표현식 수준은 `ir-expression.md`가 담당한다.
