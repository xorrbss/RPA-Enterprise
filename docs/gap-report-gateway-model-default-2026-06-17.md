# 갭 리포트 — Gap2 모델 정책의 누락 표면 (gateway model default)

> 작성일: 2026-06-17
> 상태: **OPEN** (임시 DB 우회 적용 중 — 재시작 시 소멸)
> 전달 방법: **추후 결정** (Redmine 버그 등록 등은 미정)
> 발견 맥락: 삼성디스플레이 게스트 사이트 대상 dev 콘솔 로그인 자동화 테스트 중, 자동화 prod 승격 후 "실행" 시 발생.

> 현재 조치(2026-06-18): 이 리포트는 발견 당시 기록이다. 모델 기본값 UI는 `GatewayPolicyForms`/`Gateway` 경로에서 보강됐고, 사이트 등록 UI는 `loginUrl`/`authenticatedWhen`과 닫힌 page-state flag(`reviews_visible`, `no_next_page`, `blocked` 등)를 전송할 수 있게 됐다. 아래 원문은 당시 원인 분석 보존용이다.

---

## 1. 증상

브라우저 콘솔:
```
POST http://127.0.0.1:8080/api/v1/runs 422 (Unprocessable Entity)
```
응답: `IR_SCHEMA_INVALID { reason: "model_required" }`

테넌트에 `gateway_policies`가 **2개 이상**이고 `is_default`가 없으면, 실행 시 `POST /v1/runs`가 모델을 자동 해소하지 못해 422. 웹 실행 버튼은 모델을 보내지 않으므로 **항상** 걸린다.

## 2. 재현

1. dev 콘솔 기본 시드 기동 (정책 2개: `gpt-4o-mini`, `claude-haiku`, 둘 다 `is_default=false`)
2. 자동화 생성 → prod 승격 → "실행"
3. → 422 `model_required`

## 3. 근본 원인 — Gap2(README v2.19)가 백엔드/DB/API에만 반영되고 두 표면을 빠뜨림

`POST /v1/runs`의 모델 해소 로직(server.ts):
명시 model → (tenant,model) 존재확인 / 미지정 → `is_default`(부분 UNIQUE ≤1) → 없으면 단일정책 자동해소 → **정책이 2개면 `model_required` 거부**.

빠진 표면 2개:

1. **콘솔 UI에 `is_default` 토글 없음**
   - "AI 모델 정책" 편집폼(`web/src/views/Gateway.tsx`)은 capabilities/budget/fallback만 편집.
   - web 전체에 `is_default` 코드 부재(`grep` 확인) → 운영자가 화면에서 기본모델을 지정할 방법이 없음.
2. **dev 시드가 default 미지정**
   - `app/dev/serve.ts:481-486`가 정책 2개를 만들면서 `is_default`를 안 잡음 → out-of-the-box로 실행 버튼이 422.

## 4. 부수 관찰 (설계 어색함)

- `CODEX_MODEL`(env, 실제 LLM 호출 모델)과 `gateway_policies`(DB, 정책 레지스트리)가 **분리**돼 있고, `POST /v1/runs`는 env를 참조하지 않음.
- 해소된 `runs.model`은 **아직 실행기가 소비하지 않음**(README: "runs.model 소비는 PR-B0"; 실제 dev 실행은 env `CODEX_MODEL`로 함).
- 결과: env로 모델을 정해도 run 생성 게이트는 DB 정책으로 따로 막혀, 사용자에게 "왜 env 세팅이 안 먹히나" 혼란을 줌.

## 5. 현재 우회 (임시)

```sql
UPDATE rpa_dev_console.gateway_policies
   SET is_default = true, version = version + 1
 WHERE model = 'gpt-4o-mini';
```
- DB 직접 수정 → run 생성은 풀림.
- ⚠️ dev 서버 재시작 = 스키마 재시드 → **이 변경 소멸**(매 기동마다 재적용 필요).

## 6. 제안 수정

| 옵션 | 내용 | 성격 |
|---|---|---|
| **A** | dev 시드(`serve.ts`)에 한 정책 `is_default=true` | 즉효, dev out-of-the-box 동작 |
| **B** | 콘솔 Gateway UI에 `is_default` 토글 + web client 플럼빙 | Gap2 UI 갭 정식 보완(운영용) |
| (선택) | 실행 시 모델 선택 UI, 또는 env↔정책 일원화/연결 검토 | 설계 정합 |

## 7. 참고 위치

- 백엔드 해소 로직: `app/src/api/server.ts` (`POST /v1/runs`, model_required 경로)
- 시드: `app/dev/serve.ts:479-486`
- 정책 UI: `web/src/views/Gateway.tsx` (is_default 미노출)
- 계약 근거: `README.md` v2.19 패치 로그(Gap2), `api-surface.md` §6 Gateway Policy

---

# 갭 #2 — 사이트 `page_state_selectors`를 UI에서 설정 불가 + dev run-loop 마커-only 한계

> 발견: 삼성 사이트 등록 후 실행 시 `2c9e1a79 ... page_state_selectors 미설정 — 비-마커 실행 불가`로 멈춤.

## 증상
사이트 등록(`POST /v1/sites`) 후 실행하면 run-loop가:
```
site_profile <id> 에 page_state_selectors 미설정 — 비-마커 실행 불가
```
로 site-resolution 다음 단계에서 멈춘다.

## 근본 원인
1. **dev run-loop는 "마커 사이트"만 구동** — `app/dev/run-loop.ts:227` `loadSitePageStateConfig`로 사이트의 `page_state_selectors`(CSS 셀렉터→flag)를 로드해 PageState를 **결정형**으로 판정. 없으면 비-마커라 구동 거부(dev엔 LLM 기반 페이지상태 판정 없음).
2. **사이트 등록 폼이 `page_state_selectors`를 안 보냄** — `web/src/components/SiteCreateForm.tsx:33`은 `{name, url_pattern, risk}`만 전송. 백엔드 `POST /v1/sites`는 optional `page_state_selectors`를 받지만(검증까지 함) **UI에 입력칸이 없음**.

→ 결과: UI로 등록한 임의 사이트는 항상 `page_state_selectors`가 비어 dev에서 실행 불가.

## 마커 사이트 예시(시드 데모, 구동됨)
```json
{ "flags": {
    "login_required":  { "kind": "present",   "selector": ".login-form" },
    "reviews_visible": { "kind": "min_count", "selector": ".review-item", "n": 1 },
    "blocked": { "kind": "present", "selector": ".blocked-banner" },
    "not_found": { "kind": "present", "selector": ".empty-results" },
    "no_next_page": { "kind": "present", "selector": "a.next-page.disabled" } },
  "authenticatedWhen": { "selector": ".user-menu" } }
```
임의 사이트(삼성 등)를 구동하려면 그 사이트의 실제 DOM에 맞는 셀렉터를 **사이트별로 작성**해야 함(login_required / authenticatedWhen / 데이터-가시 마커 등).

## 제안 수정
| 옵션 | 내용 |
|---|---|
| A | `SiteCreateForm`에 `page_state_selectors`(JSON) 입력칸 추가 + client 플럼빙 |
| B | (장기) dev run-loop에 LLM 기반 페이지상태 판정 경로(비-마커 사이트 지원) |

---

# 종합 — 삼성디스플레이 end-to-end 실행 가능 여부 (2026-06-17 테스트 결론)

테스트가 검증한 것(정상 동작):
- ✅ run 생성 + 모델 해소(Gap2 경로) — *갭 #1 우회 후*
- ✅ 사이트 등록 + site-resolution
- ✅ run-loop 배선(실 Chrome + Codex + driver) 가동

남은 실행 차단(현 빌드에서 미구현/미설정):
- ❌ **갭 #2** — 삼성 `page_state_selectors` 미작성(설정 UI 없음, 사이트별 작성 필요)
- ❌ **OTP/MFA 자동화** — ChallengeDetector 미구현(RQ-016, `stagehand-dom-executor.ts:84`) + OTP 소스 없음 + v1 resolve는 데이터 미운반(v2 scope-out)

→ **현 빌드로 삼성디스플레이 로그인 자동화는 end-to-end 완료 불가.** 갭 #2를 메워도 OTP 벽에서 멈춤.

## 정정 (2026-06-17, 실제 테스트 시나리오 기준)

실제로 생성된 시나리오 IR은 **로그인 단계가 없다**: `open(navigate) → collect(extract "공지 사항") → done`. 공지사항은 비로그인으로 접근 가능하므로 **이 시나리오엔 로그인/OTP가 경로에 없다**(앞 "종합"의 OTP 결론은 로그인-기반 시나리오 가정이었음 — 이 케이스엔 부적용). 이 navigate+extract 시나리오의 실제 차단은:

1. **갭 #2** — site `page_state_selectors` 미설정(설정 UI 없음). 최소 `{"flags":{}}`로 파서는 통과하나 설정 경로가 API/DB뿐.
2. **추출 규칙 부재** — extract 노드에 `instruction`이 없음(`ir-translate`가 필수 요구 → `IR_SCHEMA_INVALID: extract.instruction 필요`). "쉬운 만들기"가 흐름 스켈레톤만 생성하고 추출 규칙은 미생성(마법사 저장 경고와 동일). "IR 직접 편집" 또는 단계 편집으로 instruction 추가 필요.

→ 이 케이스는 **OTP가 아니라 "추출 설정 미완성 + 사이트 마커 미설정"**이 차단. 로그인 시나리오의 OTP 갭(RQ-016)과는 별개 사안.
