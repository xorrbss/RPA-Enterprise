# 삼성디스플레이 공지 수집 후속 수정사항

> 작성일: 2026-06-18
> 맥락: `삼성디스플레이 공지 수집2` 실행 결과가 쉬운 만들기에서 "여러 화면에서 목록 수집(페이지를 넘기며)"를 선택했음에도 현재 화면 10건만 산출한 문제.

> 현재 조치(2026-06-18): UI 관련 블록은 코드에 반영됨. `OperatorWizard`의 목록 수집은 `page_loop`/`next_page` IR을 생성하고 최대 페이지 수·다음 페이지 동작·마지막 페이지 flag를 입력받는다. `SiteCreateForm`은 `no_next_page` 등 닫힌 page-state flag를 추가 등록할 수 있다. DOM 실행기 추출 프롬프트는 지원되는 `network_json` 근거를 visible text/html보다 우선한다. `RunTrace`는 run artifact 본문을 바로 열어 `rows`/`records` 요약과 샘플을 표시한다.
>
> 남은 런타임 후속: 브라우저 CDP에서 모든 XHR 응답 body를 자동 수집하는 배관과, 페이지별 결과를 하나의 deduped merged artifact로 생성하는 파이프라인은 별도 런타임 작업이다. 이번 조치는 UI/프롬프트/표시 경로를 닫는다.

## 확인된 사실

- 시나리오: `삼성디스플레이 공지 수집2`
- 시나리오 ID: `ddd01b08-62f3-44c5-87ee-614bc58eeaf5`
- 최신 버전 ID: `2962497f-126e-43d4-af06-3fb8ccc70001`
- 최근 실행 ID: `a859b82f-fe5a-4fcf-b23a-dcd0b15e5a22`
- 아티팩트 ID: `fd3c5033-e584-47d4-8b62-267a155f42e7`
- 저장된 아티팩트 본문은 `records` 배열 10건이었다.

`records 개수: 10`은 별도 필드나 제한값이 아니라, 저장된 아티팩트 JSON의 `records.length`를 확인한 값이다.

## 원인 요약

현재 쉬운 만들기의 `list` 모드는 UI 라벨과 달리 실제 페이지 넘김 IR을 만들지 않는다.

생성된 IR 흐름:

```text
open -> check -> collect -> done
```

즉 `collect`에서 한 번 추출한 뒤 바로 종료한다. `loop`, `next_page`, `no_next_page`, 다음 페이지 클릭/이동 노드가 없다.

추가로 삼성 공지 그리드는 네트워크 응답과 DOM 렌더링 범위가 다르다.

- `getBbsList.json` 응답: `grid.data.length = 20`, `paging.size = 20`, `totalCount = 33`
- 현재 추출 입력: `document.body.innerText` / DOM 스냅샷 중심
- 실제 DOM/visible text에 노출된 행: 10건

따라서 지금 추출기는 네트워크 응답의 20건이 아니라 렌더된 DOM의 10건만 보고 결과를 만들었다.

## 수정 필요사항

### 1. 쉬운 만들기 라벨과 생성 IR 정합성 수정

현재 라벨:

```text
여러 화면에서 목록 수집 (페이지 넘기며)
```

하지만 실제 생성 IR은 단일 화면 추출이다.

수정 방향:

- 단기: 기능 구현 전까지 라벨을 `현재 화면 목록 수집` 수준으로 낮춘다.
- 권장: 실제 페이지네이션 IR을 생성하도록 고친다.

수용 기준:

- `list` 선택 시 생성 IR에 페이지 반복 구조가 포함된다.
- 구현 전이라면 UI 문구가 페이지 넘김을 약속하지 않는다.

### 2. 페이지네이션 IR 생성

쉬운 만들기에서 목록 수집을 선택하면 다음 구조를 만들 수 있어야 한다.

```text
open -> check -> loop
loop until flags.no_next_page || loop.page_count >= params.max_pages
body: collect -> next_page -> loop
done
```

필요한 입력:

- `max_pages` 기본값 및 실행 시 수정 가능 값
- 다음 페이지 버튼/링크를 누르는 동작
- 마지막 페이지 판별 조건

수용 기준:

- 1페이지에서 끝나는 사이트는 정상 종료한다.
- 2페이지 이상 사이트는 `max_pages` 또는 `no_next_page`까지 반복한다.
- 삼성 공지 기준 기본 `max_pages = 2` 실행 시 최대 33건까지 수집 가능해야 한다.

### 3. 삼성 사이트 page_state_selectors 보강

현재 삼성 시드 사이트 설정은 `reviews_visible`만 판별한다.

필요한 추가 신호:

- `no_next_page`: 마지막 페이지 여부
- `next_page_available`: 다음 페이지 이동 가능 여부
- 선택적으로 `grid_loaded` 또는 `grid_row_count` 안정화 조건

주의:

- 삼성 그리드는 JWork grid 기반이며 서버 페이징/가상 렌더링을 사용한다.
- 단순 DOM row count만으로는 실제 응답 데이터 건수를 보장할 수 없다.

수용 기준:

- 첫 페이지에서 `no_next_page=false`
- 마지막 페이지에서 `no_next_page=true`
- 페이지 이동 직후 그리드 데이터가 갱신될 때까지 기다린 뒤 추출한다.

### 4. DOM 스냅샷 외 네트워크/그리드 데이터 추출 근거 포함

이번 문제의 핵심은 XHR에는 20건이 있으나 DOM에는 10건만 보인다는 점이다.

수정 방향:

- 브라우저 세션에서 최근 네트워크 응답 중 추출 대상과 관련된 JSON을 보존한다.
- `getBbsList.json` 같은 그리드 데이터 응답을 추출 컨텍스트에 포함한다.
- 추출 근거 우선순위를 `network JSON -> visible text -> HTML`로 둔다.

수용 기준:

- 삼성 공지 첫 페이지 추출 결과가 DOM 가상 렌더링 10건이 아니라 `grid.data` 20건 기준으로 나온다.
- 모델이 네트워크 JSON에 없는 값을 생성하지 않는다.
- 네트워크 응답에 개인정보/비밀값이 섞일 수 있으므로 기존 redaction 경계를 통과한다.

### 5. 반복 추출 결과 병합/표시

페이지를 넘기며 추출하면 페이지마다 LLM output artifact가 생길 수 있다. 현재 UI/아티팩트 모델은 run-level artifact를 보여줄 수 있지만, 여러 페이지 결과를 하나의 결과로 병합하는 UX는 명확하지 않다.

수정 방향:

- 페이지별 raw artifact를 유지한다.
- 최종 merged artifact를 추가로 만든다.
- 중복 제거 기준을 제공한다. 삼성 공지는 `SEQ` 또는 `BBSCTT_ID`가 자연키 후보다.

수용 기준:

- 실행 결과 화면에서 최종 병합 결과를 바로 확인할 수 있다.
- 페이지별 원본 artifact도 추적 가능하다.
- 중복 페이지 재시도 시 같은 공지가 중복 저장되지 않는다.

### 6. 테스트 보강

필수 테스트:

- `OperatorWizard`의 `list` 모드가 실제 loop IR을 생성하는 단위 테스트
- 삼성과 유사한 fixture: XHR 20건, DOM visible 10건인 그리드 페이지
- 추출기가 네트워크 JSON 기준으로 20건을 반환하는 단위/통합 테스트
- `max_pages=2`, `totalCount=33`일 때 33건 또는 마지막 페이지까지 수집하는 통합 테스트

외부 사이트 라이브 테스트는 네트워크 변동성이 있으므로, 기본 CI에는 fixture 기반 테스트를 두고 삼성 실사이트 검증은 수동/옵션 게이트로 둔다.

## 우선순위 제안

1. 쉬운 만들기 라벨/IR 불일치 수정
2. 네트워크 JSON을 추출 컨텍스트에 포함
3. 삼성 page_state_selectors에 마지막 페이지/다음 페이지 신호 추가
4. 쉬운 만들기에서 `max_pages` 포함한 페이지네이션 IR 생성
5. 반복 추출 결과 병합 artifact와 UI 표시 추가

## 완료 정의

다음이 모두 충족되면 이 이슈를 닫을 수 있다.

- `삼성디스플레이 공지 수집2`와 같은 쉬운 만들기 목록 시나리오가 사용자가 기대하는 페이지 수만큼 이동한다.
- 삼성 공지 첫 페이지에서 최소 20건이 수집된다.
- 전체 2페이지 수집 시 `totalCount=33` 기준 누락 없이 수집된다.
- 결과 화면에서 최종 병합 records 수와 본문을 확인할 수 있다.
- UI 문구가 실제 동작과 일치한다.

## 2026-06-19 Runtime Update

- `StagehandDomExecutor` now installs a page-side fetch/XHR JSON capture hook before DOM `act` and `extract` steps. Captured JSON is exposed through the existing `[network_json]` snapshot path and remains best-effort so blocked injection does not fake success or fail unrelated DOM execution.
- Repeated extract results now surface in interpreter outcomes as page-level `extractPages` plus a deduped `mergedExtract`. The merge helper reads common result shapes such as `rows`, `records`, `items`, `data`, and nested `grid.data`, preserving order while deduping by natural keys such as `SEQ` or `BBSCTT_ID`.
- Fixture coverage was added for Samsung-like 20+13 notice collection with one repeated boundary row, nested `grid.data`, network JSON prompt inclusion, automatic capture hook installation, and interpreter-level merged extract output.
- The remaining deploy-time provisioning row is intentionally not closed by code. It requires owner-provided staging platform/deploy target, GitHub Environment approval/protection, rollback confirmation, and SecretRef/SecretStore provisioning evidence.

## 2026-06-19 Natural Prompt Update

- `POST /v1/scenario-generations` now recognizes natural-language pagination intent such as "모든/다음/더보기 페이지", "all/every/next page", and "load more" in the deterministic MVP planner.
- Matching prompts generate bounded loop IR: `open_start_url -> paginate_pages -> extract_current_page -> advance_page -> paginate_pages -> done`.
- `max_pages` is inferred from the prompt when possible, defaults to 3, and is persisted into `runs.params`; automatic execution is capped at 10 pages.
- Requests above the cap are saved as blocked scenario generations with `pagination_page_limit_exceeded` and do not enqueue a run.
- Integration coverage now proves natural prompt generation can save the scenario, enqueue the run, persist `max_pages`, preserve the loop IR in `scenario_versions`, and keep the over-limit path fail-closed.

## LLM Planner Follow-up

- The deterministic MVP planner now sits behind a `ScenarioPlanner` port and persists `plan.planner` through the existing generation ledger/response path. A future LLM planner should be added as a second implementation of that port so it shares the same compile, persistence, RBAC, target inference, evidence, and run enqueue boundary.
- `planner="llm_v1"` is now accepted only when a matching `ScenarioPlanner` implementation is injected into the API server; otherwise it fails closed with `RESOURCE_NOT_FOUND`. Control-plane idempotency reservation happens before planner execution, so replay does not call an expensive or side-effecting planner again.
- Planner implementations may provide one bounded `repair` pass after `compileScenario` rejects generated IR. The repair input includes the failed plan and compile error; if the repaired IR still fails, the request returns the original compile error class and no scenario/run is saved.
- Keep prompt text out of the generation ledger. LLM planner inputs/outputs should go through the existing gateway artifact sink and redaction boundary rather than adding a second prompt storage path.
- Keep any future planner-internal gateway calls behind the same pre-planner control-plane idempotency boundary, and add generation-scoped artifact/call storage rather than reusing run-step `stagehand_calls`.
- Next implementation step: add generation-scoped LLM prompt/output artifacts and a real `llm_v1` planner implementation that emits contract-valid IR through this port.
