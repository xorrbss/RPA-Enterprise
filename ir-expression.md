# IR Expression Language 스펙 (IREL v1)

> 대상: IR `loop.until`, `on` 분기 조건, `verify.criteria[].when`, `empty_result_allowed.when`, `fallback_chain` 전환 조건.
> 원칙: **결정론적, 부작용 없음, JS eval 금지**. 자체 파서+evaluator로만 평가한다. 평가는 순수 함수: `eval(expr, scope) → boolean | value`.

---

## 1. 문법 (EBNF)

```ebnf
expression   = or_expr ;
or_expr      = and_expr , { "||" , and_expr } ;
and_expr     = not_expr , { "&&" , not_expr } ;
not_expr     = [ "!" ] , comparison ;
comparison   = additive , [ comp_op , additive ] ;
comp_op      = "==" | "!=" | ">" | ">=" | "<" | "<=" ;
additive     = primary , { ("+" | "-") , primary } ;     (* 숫자 산술만, 문자열 + 금지 *)
primary      = literal
             | variable
             | func_call
             | "(" , expression , ")" ;

variable     = ident , { "." , ident } ;                 (* 예: params.max_pages, node.extract_reviews.row_count *)
func_call    = ident , "(" , [ arg_list ] , ")" ;
arg_list     = expression , { "," , expression } ;

literal      = number | string | boolean | "null" ;
number       = ["-"] , digit , { digit } , [ "." , digit , { digit } ] ;
string       = '"' , { char } , '"' ;                    (* 작은따옴표 금지 — 일관성 *)
boolean      = "true" | "false" ;
ident        = (letter | "_") , { letter | digit | "_" } ;
```

- 연산자 우선순위(낮음→높음): `||` < `&&` < `!` < 비교 < `+`/`-` < 함수호출/괄호.
- **금지**: 임의 함수 정의, 람다, 인덱싱(`a[0]`), 비트연산, 삼항, 할당. 화이트리스트 함수만(§4).
- **[FIX #9] 모호성 가드(괄호 강제)**: `!`는 비교보다 우선순위가 **낮으므로** `!a == b`는 `!(a == b)`로 해석된다(다수 언어와 반대 → footgun). 혼동 방지를 위해 컴파일러는 다음을 **`IREL_PARSE_ERROR`로 거부**하고 괄호를 요구한다:
  - `!` 뒤에 비교식이 직접 오는 경우 → `!(a == b)` 또는 `(!a) == b`로 명시.
  - `&&`와 `||`를 괄호 없이 혼합 → `a || b && c` 금지, `a || (b && c)`로 명시.
  결합 순서를 작성자가 눈으로 확인하도록 강제(§6 예시도 이 규칙에 맞춰 괄호 표기).

---

## 2. 변수 스코프

평가 시 주입되는 `scope`는 다음 4개 네임스페이스로만 구성. 그 외 식별자는 **컴파일 타임 에러**(`IREL_UNKNOWN_VARIABLE`).

| 네임스페이스 | 내용 | 예 |
|---|---|---|
| `params.*` | 시나리오 실행 파라미터(params_schema로 타입 확정) | `params.max_pages` (int) |
| `node.<nodeId>.*` | 이미 실행 완료된 노드의 표준 출력 필드 | `node.extract_reviews.row_count` (int) |
| `cursor.*` | 현재 수집 커서 | `cursor.last_review_id` (string\|null) |
| `flags.*` | 런타임 불린 플래그(인터프리터가 set) | `flags.no_next_page`, `flags.cursor_reached`, `flags.login_required`, `flags.blocked`, `flags.not_found`, `flags.no_review_message_visible` |
| `loop.*` | 현재 loop 컨텍스트(loop 노드 내부에서만) | `loop.iteration` (int, 0-base), `loop.page_count` (int) |

규칙:
- `node.<id>`는 **DAG 상 선행(이미 완료)된 노드만** 참조 가능. 미실행/미래 노드 참조는 컴파일 에러(`IREL_FORWARD_REF`).
- `flags.*`는 인터프리터가 매 노드 평가 직전 PageState/observe 결과로부터 채운다. 정의되지 않은 flag 참조는 컴파일 에러. **허용 flag 집합(닫힌 레지스트리)의 권위 목록은 `ir-static-validation.md` §2** — 여기 위 표는 예시이며, 검증·추가 절차는 그 레지스트리를 따른다.
- `loop.*`는 loop 노드 밖에서 참조 시 컴파일 에러(`IREL_SCOPE_VIOLATION`).

표준 노드 출력 필드(참조 가능): `row_count`(int), `status`(string), `extracted_ref`(string), `tier`(string, fallback 시).

---

## 3. 타입 시스템 & 타입체커

타입: `int`, `number`(float), `string`, `boolean`, `null`. (날짜는 `string` ISO-8601로 다루되 비교는 §4 `date_*` 함수로만.)

타입 규칙(컴파일 타임 검증, 위반 시 `IREL_TYPE_ERROR`):

| 연산 | 허용 | 비고 |
|---|---|---|
| `==` `!=` | 동일 타입 간. `x == null`은 모든 타입 허용 | string==int 금지 |
| `> >= < <=` | int/number 간, 또는 date 함수 결과 | string 직접 대소비교 금지 |
| `+ -` | int/number 간만 | **문자열 결합 금지** (의도 모호 방지) |
| `&& \|\| !` | boolean 간만 | truthy 강제변환 없음 — `loop.page_count`는 boolean 아님 |
| `until` / `when` / `on` 조건 전체 | **최상위 결과가 boolean이어야** | int 단독을 조건으로 쓰면 에러 |

- params 타입은 `params_schema`(JSON Schema)에서 추론. `node.*`/`cursor.*`/`flags.*`/`loop.*` 타입은 본 문서가 고정.
- **null 처리**: null 동등성은 `== null` / `!= null`로만 명시한다. **순서/수치 비교(`> >= < <=`)·산술(`+ -`)의 피연산자가 런타임에 null/부재이면 `false`로 조용히 단락하지 않고 `IREL_RUNTIME_MISSING`(System 예외 → 노드 재시도)으로 표면화한다** — §5 "평가 실패 처리" 및 "조용한 false 금지" 불변과 일치(false success 위험 차단). 타입체커가 정상 경로의 null 수치 피연산자를 차단하므로 이 경로는 런타임 데이터 불일치(컴파일 타입 위반) 시에만 도달한다. 값 위치의 null은 `== null`/`!= null` 명시 비교로만 다룬다. 암묵 NPE 금지.

---

## 4. 화이트리스트 함수

| 함수 | 시그니처 | 용도 |
|---|---|---|
| `len(s)` | string → int | 문자열 길이 |
| `is_null(x)` | any → boolean | null 검사(= `x == null`의 가독형) |
| `coalesce(a, b)` | (T\|null, T) → T | null 대체 |
| `date_before(a, b)` | (string, string) → boolean | ISO 날짜 비교 a<b |
| `date_after(a, b)` | (string, string) → boolean | a>b |
| `starts_with(s, p)` | (string, string) → boolean | 접두 |
| `contains(s, p)` | (string, string) → boolean | 부분문자열 |

함수 외 호출은 `IREL_UNKNOWN_FUNCTION`. 인자 타입 불일치는 `IREL_TYPE_ERROR`.

---

## 5. Evaluator 동작 규약

```ts
// 순수 함수. 부작용/네트워크/시간 의존 금지(now()는 제공하지 않음 — 결정론 보장)
function evalExpression(ast: IRELNode, scope: IRELScope): IRELValue;
```

- **결정론**: 같은 (expr, scope) → 항상 같은 결과. 현재시각·랜덤·외부조회 함수 없음.
- **[FIX #12] 상대 날짜 패턴**: `now()`를 제공하지 않으므로(결정론 보장) "오늘 기준 N일 이내" 같은 식은 IREL 내부에서 표현 불가. 기준 시각이 필요하면 **실행 파라미터 `params.as_of`(ISO-8601 string)로 주입**하고 `date_after(x, params.as_of)` 형태로 비교한다. as_of는 Run 생성 시 1회 고정되어 재시도·replay에도 결정론이 유지된다(런타임 now() 금지).
- **평가 실패 처리**(런타임): 정의된 변수인데 scope에 값이 없으면(예: 선행 노드가 skipped여서 `node.x.row_count` 부재) → 평가 결과 `null`/`false` 단락이 아니라 **`IREL_RUNTIME_MISSING` 예외 → System 예외로 분류 → 해당 노드 재시도**. "조용한 false"는 금지(false success 위험).
- **`on[]` 무매칭 처리**(런타임): priority 내림차순으로 모든 `when`을 평가했는데 **어느 것도 true가 아니면** → 분기 없음을 조용히 흘리지 않고 **`IR_NO_BRANCH_MATCHED` 예외 → System 분류 → 해당 노드 재시도**(IREL_RUNTIME_MISSING과 동일 원칙, "조용한 dead-end" 금지). 정적검증(ir-static-validation V3 도달가능성)은 *구조*만 보장하며 값 의존 무매칭은 못 잡으므로, 런타임은 반드시 이 예외로 표면화한다.
- **컴파일 시점**: 시나리오 저장/승격 시 모든 expression을 파싱+타입체크. 하나라도 실패하면 **저장 거부**(prod 승격 차단). 런타임에 파싱하지 않는다(AST 캐시).

---

## 6. 예시 (쿠팡 리뷰)

```jsonc
// loop.until — 페이지네이션 종료
"until": "flags.no_next_page || flags.cursor_reached || loop.page_count >= params.max_pages"

// on 분기 — [FIX] 명시적 priority 배열(키 순서 의존 제거, 결정론 보장)
"on": [
  { "when": "flags.blocked",         "target": "@challenge",      "priority": 100 },
  { "when": "flags.login_required",  "target": "login_flow",      "priority": 90 },
  { "when": "flags.reviews_visible", "target": "extract_reviews", "priority": 80 },
  { "when": "flags.not_found",       "target": "@end_no_data",    "priority": 10 }
]
// 인터프리터는 priority 내림차순으로 when을 평가 → 첫 true 채택. 동률 priority는 컴파일 거부.

// empty_result_allowed witness
"when": "flags.no_review_message_visible"

// fallback 전환 (T1 → T2) — [FIX #9] 혼합 &&/|| 괄호 명시
"advance_when": "node.t1_fetch.status == \"failed_system\" || (node.t1_fetch.row_count == 0 && flags.no_review_message_visible == false)"
```

---

## 7. 에러 코드 (컴파일/런타임)

| 코드 | 시점 | 의미 |
|---|---|---|
| `IREL_PARSE_ERROR` | compile | 문법 위반 |
| `IREL_UNKNOWN_VARIABLE` | compile | 미정의 식별자 |
| `IREL_UNKNOWN_FUNCTION` | compile | 화이트리스트 외 함수 |
| `IREL_TYPE_ERROR` | compile | 타입 불일치 |
| `IREL_FORWARD_REF` | compile | 미실행 노드 참조 |
| `IREL_SCOPE_VIOLATION` | compile | loop 밖 loop.* 참조 등 |
| `IREL_RUNTIME_MISSING` | runtime | scope에 기대 값 부재 → System 예외 |
| `IR_NO_BRANCH_MATCHED` | runtime | on[] 전 분기 false(무매칭) → System 예외(error-catalog 동명 코드) |

컴파일 에러는 전부 시나리오 저장 거부 사유. 런타임 에러는 `error-catalog`의 `IR_EXPRESSION_RUNTIME`으로 매핑.
