# UI 검증 발견 — 시나리오 스튜디오 (자동화 생성·편집·실행)

> **버전**: `705f2fd` (UI/UX 고도화 Phase 0~3 + R1~R4 반영분), 2026-06-18
> **방법**: dev 콘솔(127.0.0.1:8080) Playwright 실구동 + `dev:serve` 로그 + Postgres 실측. **모든 항목 실제 실행으로 확인**(추측 없음).
> **이전 버전**: 시간순 작성본은 `docs/archive/ui-findings-scenario-studio-2026-06-18.chronological-v1.md`

> **현재 조치 메모(2026-06-18)**: 이 문서는 당시 실측 리포트다. 이후 UI 관련 블록 중 저-코드 추출 지시문/loop 생성, 단계 편집 loop·act/observe instruction, 사이트 `page_state_selectors` 입력, 실행 상세 artifact 결과 미리보기, 추출 프롬프트의 `network_json` 근거 지원이 반영됐다. 아래 본문은 발견 당시 맥락 보존용이며 최신 상태는 코드와 테스트(`scenario-params`, `smoke`, `run-trace`, `stagehand-dom-executor`)를 기준으로 본다.

---

## TL;DR

현재 빌드 기준, **UI에서 만든 자동화는**:
1. **실행되지 않는다** — 생성 3모드(쉬운/단계/IR직접) 모두 저장은 되지만, 만든 시나리오는 **전부 실행 실패**.
2. **실패해도 안 보인다** — 실패한 run이 UI엔 "실행 중/점유"로 표시. **"실패"로 잡히는 건 0건.**
3. **완료돼도 데이터가 없다** — 유일하게 완료되는 IR도 실제 추출 데이터는 0(추출 "플랜"만 나옴).
4. **고치려면 개발자여야 하고, 그나마 시드 사이트에서만** — 작동하는 추출 시나리오는 **IR(JSON) 구조를 직접 수정**해야만 가능(저-코드 2모드 불가). 게다가 **시드로 등록된 사이트(삼성·데모)에서만** 작동 — *새* 사이트는 사이트 마커(page_state_selectors) 등록 UI가 없어 불가(gap #2).
5. **만들면 되돌릴 수 없다** — 시나리오 **삭제·prod 취소(un-promote)·버전 롤백이 모두 없어**, 한 번 만든 자동화를 콘솔에서 회수·중단할 수 없다. (B3·B4)

> **핵심 구분**: "폼에 데이터를 입력하는 것"과 "IR 구조를 고치는 것"은 다르다. **작동에는 구조 수정이 필요한데, 저-코드 모드(쉬운/단계)에는 구조를 고칠 수단이 없다.**

---

## A. 자동화 생성 — 3가지 모드 (쉬운 / 단계 / IR 직접)

### A1. 세 모드는 서로 다른 IR을 생성한다 (같은 템플릿이 아님)
| 모드 | 생성 IR 구조 | extract instruction | params_schema |
|---|---|---|---|
| 쉬운 만들기 | navigate→observe→extract→done | ❌ 없음(`schema_ref`만) | entry_url **default = 입력 URL** |
| 단계 편집(기본) | **observe→end 뿐** (navigate·extract **둘 다 없음**) | ❌ | 없음 |
| IR 직접 편집(기본 템플릿) | navigate→observe→extract→done | ❌ 없음 | entry_url (default 없음) |

- 같은 템플릿 아님. 단계편집 기본값은 **아무 동작도 없는** observe→end.
- 셋 다 **저장은 성공**(ajv 스키마 통과, 콘솔 에러 0). 단 **저장 성공 ≠ 실행 가능**(→ A2).
- **URL prefill은 모드마다 다르다** (실행 대화상자는 `params_schema.entry_url.default`를 prefill):
  | 모드 | `entry_url.default` 생성 | 실행 시 URL prefill |
  |---|---|---|
  | 쉬운 만들기 | ✅ 입력 URL을 default로 저장 | ✅ 자동 채움 |
  | 단계 편집 | ❌ `params_schema` 자체를 안 만듦(`StepBuilder.tsx`엔 params_schema 생성 코드 없음) | ❌ 빈칸 |
  | IR 직접 편집 | ⚠️ **기본 템플릿은 default 없음** → 템플릿을 직접 고쳐 `"default"`를 추가해야 prefill | ⚠️ 수정 시만 |
  - URL은 IR에 박히지 않는 런타임 파라미터(`url_ref`)라 실행 시 입력/수정 — 그래서 **URL이 "생성"과 "실행" 양쪽에 등장**한다(중복 아님). 단 **단계편집·IR직접(기본)은 생성 때 URL을 넣을 수단이 없거나(단계편집), 넣어도 실행 prefill로 안 이어진다(IR직접 기본 템플릿).**

### A2. 세 모드로 만든 시나리오는 전부 "실행" 실패 — 그리고 **데이터 입력으론 못 고친다**
| 만든 시나리오 | run | 실행 실패 사유 |
|---|---|---|
| IR직접편집 테스트 | `922e5a4c` | `compiledScenarioFrom: extract.instruction 필요` |
| 쉬운만들기 테스트 | `02156c17` | `origin https://example.com 매칭 site_profile 없음` (+ instruction도 없음) |
| 단계편집 테스트 | `baa59d75` | `start에서 도달 가능한 navigate 없음 — entry URL 판정 불가` |

**왜 폼 입력으로는 안 되나 (이 문서의 핵심):**
- 위 실패는 모두 **구조적 결함**이다 — extract에 `instruction` 없음 / `navigate` 노드 없음 / 미등록 사이트.
- 폼에 **URL·데이터 라벨을 채워 넣는 것**으로는 안 고쳐진다. 예: 쉬운 만들기에 URL/라벨을 아무리 정확히 입력해도, 생성되는 IR의 extract엔 `instruction`이 안 들어간다(템플릿 흐름이 고정). 단계 편집도 extract 단계에 `instruction` 입력칸이 없다.
- 즉 작동하려면 **IR의 "구조"를 수정**해야 하는데(extract에 instruction 추가 등), 그 수단이 있는 건 **IR 직접 편집뿐**이다(→ A3·A4).

### A3. 저-코드 2모드(쉬운·단계)로는 "작동 추출 IR"을 만들 수 없다
| 모드 | extract instruction 입력 수단 | 작동(추출) IR |
|---|---|---|
| 쉬운 만들기 | ❌ 폼에 필드 자체가 없음(이름/주소/라벨/방식뿐) | **불가** |
| 단계 편집 | ❌ extract 단계에 '출력 스키마(schema_ref)'만 (UI 실측) | **불가** |
| IR 직접 편집 | ✅ IR을 직접 작성 | **가능** |

- 코드 근거: `OperatorWizard.tsx:50`(extract `schema_ref`만), `StepBuilder.tsx:43-44`(extract `schema_ref`만 + "추가 필드는 IR 직접 편집에서" 주석).
- → **비개발자용 두 모드로는 데이터를 추출하는 작동 자동화를 만들 수 없다.** 작동 추출 시나리오는 개발자 모드(IR 직접 편집)에서 IR 구조를 직접 써야만 가능. (+ 사이트가 `page_state_selectors`와 함께 등록돼 있어야 함 — gap #2)

### A4. 작동하는 IR 만드는 법 — IR 직접 편집에서 **템플릿 구조 2곳 수정** (실측)
기본 IR 템플릿(navigate→observe→extract→done) 대비, **데이터가 아니라 구조를 수정**한다:
1. **extract 노드에 `"instruction": "…추출하라"` 추가** — 없으면 런타임 `IR_SCHEMA_INVALID(extract.instruction 필요)`.
2. **entry_url을 등록된 사이트로** — `params_schema.entry_url.default`를 `page_state_selectors`와 함께 **등록된 site origin**(예: `https://guest.samsungdisplay.com/bbs/bbsHPNO.do`)으로. 미등록 origin이면 site-resolution 실패.
- 검증: 수정한 IR(`bad2f033`) 실행 → **`1183668b → completed (open→check→collect→done)`** ✅

**단, 이 "작동 IR"에도 3가지 한계가 있다:**
- ⚠️ **"완료" ≠ "데이터 추출"**: 실제 출력은 추출 "플랜"(`{"extractor":"table","fields":["title","author","date","views"],"rowSelector":".grid-row"}`)뿐 — 실데이터 0. (→ C2)
- ⚠️ **등록된 사이트에 의존하는데, 그런 사이트를 UI로 등록할 수 없다**: entry_url 사이트가 `page_state_selectors`(observe 마커)와 함께 등록돼 있어야 하는데, **사이트 등록 폼은 page_state_selectors를 못 넣는다(gap #2)** — **보안/개인정보 탭 "사이트 등록" 폼 실측: 이름·URL 패턴·위험도 3필드뿐, page_state_selectors 입력칸 없음.** → 실제로는 **시드로 등록된 사이트(삼성·데모)에서만** 작동하고, 운영자가 콘솔에서 *새 사이트용* 작동 자동화를 만드는 건 **IR 직접 편집으로도 불가**.
- ⚠️ **간헐 실패(타이밍)**: observe 게이트가 그리드 렌더를 ≤10s 폴링하는데, 미렌더 시 `IR_NO_BRANCH_MATCHED`로 실패(시드 삼성 auto-run에서 관측). 같은 IR이라도 타이밍에 따라 완료/실패가 갈리며, 그 실패도 UI엔 "실행 중"으로 숨겨짐(→ C1).

### A5. "prod 승격" 없이도 실행된다 (draft 실행) — 계약상 허용
- 위에서 실행한 시나리오는 전부 `promotion_status='draft'`(미승격)인데도 **"실행"이 동작**했다(DB 실측: 생성한 4개 전부 draft).
- **계약상 허용**: `POST /v1/runs`(`api-surface.md §1`)는 `scenario_version_id`만 받고 **prod 여부를 검사하지 않는다**(server.ts에 promotion 게이트 없음). 런타임이 IR을 재컴파일하므로 draft도 실행됨.
- **"prod 승격"의 실제 역할** = 그 버전을 prod(canonical)로 표시 + AST 캐시 빌드(`api-surface.md §2`, `scenarios.ts /promote`). **실행의 전제가 아니다.**
- **UX 관찰**: "prod 승격" 버튼이 "실행"과 나란히 눈에 띄게 있지만 실행엔 불필요 → "승격해야 실행되나?"라는 오해 소지. (버그 아님 — 의도된 계약. 단, 버튼 위계/설명 정리 여지)

---

## B. 시나리오 편집 / 삭제

### B1. [BUG] 편집 전환 시 IR 내용이 갱신되지 않음 (덮어쓰기 위험)
- **증상**: A의 "편집"을 연 뒤 B의 "편집"을 누르면 **제목(헤더)은 B인데 IR 본문은 A 그대로**. 그대로 저장하면 A의 IR이 **B의 새 버전으로 덮어써질 위험**.
- **재현**: "IR직접편집 테스트" 편집(열림) → "삼성디스플레이 공지 수집" 편집 → 제목="삼성…"인데 본문은 "IR직접편집 테스트" IR.
- **원인**(`web/src/components/ScenarioForm.tsx:96-100`): 편집 패널이 scenarioId마다 remount되지 않고 재사용되는데, IR 주입 effect가 `text !== null` 가드로 재초기화를 막음.
- **수정**: `<ScenarioForm key={scenarioId} … />`(강제 remount) 또는 scenarioId 변경 시 `text` 리셋.

### B2. [설계] 편집은 "IR 직접 편집" 전용
- "편집"은 항상 IR 문서 폼으로만 열림(`ScenarioForm.tsx:81` `editor = isEdit ? "ir" : "easy"`). 쉬운/단계 편집 탭은 **"새로 만들기"에만** 존재.
- **함의**: 쉬운 만들기로 만든 자동화를 나중에 쉬운/단계 방식으로 **수정 불가** → 저-코드 사용자 동선 단절.

### B3. [기능 부재] 시나리오 삭제 불가
- 행 작업 버튼 = **편집 / prod 승격 / 실행** 뿐. **삭제 버튼 없음.** web 전체·`app/src/api/scenarios.ts`에 시나리오 삭제(UI/API)가 **존재하지 않음**(StepBuilder의 "삭제"는 *단계* 삭제).
- **함의**: 잘못 만든/테스트 시나리오를 콘솔에서 못 지움 → 목록 오염, 재시드로만 정리.

### B4. [중대] 버전·승격·식별 거버넌스가 단방향·일회성
- **시나리오 식별 = 이름** (IR엔 id 없음): `scenarios` 테이블 `UNIQUE(tenant_id, name)`로 **이름이 정체성**이고 DB가 `scenarios.id`(UUID)를 부여. 편집 시 **이름 변경 불가**(`scenario_name_immutable`, `scenarios.ts:50`). → 이름은 한 번 쓰면 영구 점유.
- **버전 관리 = "편집"으로만**: "새 자동화 만들기"는 같은 이름을 차단(`scenario_name_in_use`) → 새 버전은 기존 시나리오의 **"편집"** 버튼으로 생성(`vN+1`, version은 직전+1 단조 증가).
- **버전 히스토리 조회·롤백 UI 없음**: 목록·상세 모두 **latest 버전만** 노출(`api-surface §2`에 "버전 목록" 엔드포인트 없음). v3을 만들면 v1·v2를 콘솔에서 다시 볼/되돌릴 수 없음.
- **prod 승격은 단방향 — 취소(un-promote) 없음**: `/promote`는 `target='prod'`만 허용(다른 값 거부, `scenarios.ts:222`). **prod→draft로 되돌리는 API·UI가 둘 다 없음.** prod→draft는 *같은 시나리오의 다른 버전을 promote*할 때 이전 prod가 auto-demote되는 경우뿐(시나리오당 prod 1개 보장, `scenarios.ts:285`). → 한 번 prod가 되면 **"운영 중단(unpublish)" 불가**.
- **"prod 승격" 버튼이 현재 상태를 반영 안 함**: 이미 prod인 시드 시나리오에도 그냥 "prod 승격"만 표시(승격 여부 표시·강등 버튼 없음).
- **종합**: 삭제 없음(B3) + un-promote 없음 + 버전 히스토리/롤백 없음 → **만들면 쌓이기만 하고 회수·정리·중단 수단이 전혀 없음.**

---

## C. 실행 / 관찰 (실행 가시성)

### C1. [중대 BUG] UI가 실행 실패를 전혀 표면화하지 않음 (DB↔UI 실측 대조)
| run | 실제 결과 | DB 상태 | **UI 표시** |
|---|---|---|---|
| `922e5a4c` | ❌ 실패(extract.instruction) | `running` | **"실행 중"** |
| `02156c17` | ❌ 실패(site 없음) | `claimed` | **"점유"** |
| `baa59d75` | ❌ 실패(navigate 없음) | `claimed` | **"점유"** |
| `1183668b` | ⚠ 완료지만 **데이터 0** | `completed` | **"완료"** |

- **실패 3건 모두 "실행 중"/"점유"로 표시** — 진행 중처럼 보이고 "취소" 버튼까지 달림. **"실패"로 잡히는 건 0건.**
- **근본 원인**: run-loop가 loud-fail해도 **run 상태를 `failed_*`로 전이시키지 않고** `claimed`/`running`에 그대로 둠 → 상태 필터('실패' 옵션은 있음)에도 안 잡힘. 운영자는 실패를 알 길이 없음.
- → **"조용한 false 금지" 원칙으로 만든 콘솔이 정작 실행 실패를 가장 조용히 숨김.**

### C2. "완료"도 실제 데이터가 없음 (extract content 갭)
- 완료 run(`1183668b`)도 extract 출력은 "플랜"뿐, 실데이터 0. 상세의 단계 트레이스·산출물도 비어 **"완료 = 성공"으로 오해**하게 됨.
- **원인**: extract가 페이지 DOM을 LLM에 미전달(`stagehand-dom-executor.ts:138`, read-only 게이트웨이 전용) → LLM이 실데이터 대신 구조 플랜만 반환. **IR로는 못 고치는 런타임 코드 갭.**

### C3. RunTrace "단계 트레이스"가 dev에서 비어있음
- dev run-loop가 `run_steps`/artifact를 DB에 **영속하지 않음**(프로덕션 워커 기능). Phase 0/1 "라이브 트레이스" UI는 구조는 완성됐으나 **dev 실행은 보여줄 단계 데이터가 없음**.

---

## D. 계약 ↔ 런타임 불일치

### D1. `extract.instruction` — 계약은 "선택", 런타임은 "필수"
- **계약**(`schema/ir.schema.json:140-141`): extract는 `schema_ref`만 required. **instruction은 선택**(정의만 존재).
- **런타임**(`app/src/runtime/ir-translate.ts`): extract에 instruction도 **required** — 없으면 `IR_SCHEMA_INVALID` throw.
- → **저장(ajv)은 통과하고 실행(ir-translate)만 실패** = extract 시나리오에서 "저장됨 ≠ 실행됨"의 근본 원인.
- **instruction의 역할**: extract는 LLM 기반 프리미티브 → instruction은 "무엇을 추출하라"는 **자연어 작업 지시**. `schema_ref`는 출력 구조의 이름표(검증용)일 뿐이며, dev엔 스키마 레지스트리가 없어 의미 정보 0 → instruction이 사실상 유일한 작업 정보원.
- **제안(통일)**: ① 계약 스키마도 instruction을 required로(저장에서 즉시 차단) **또는** ② 런타임 선택 + schema에서 작업 추론. 현 상태(계약=선택 / 런타임=필수)는 최악.

### D2. "검사"(검증) 버튼이 **실행 불가 IR을 "검증 통과"로 표시** (D1의 UI 증거)
- **검증 버튼 = 저장 안 하는 dry-run 정적 검사**(`POST /v1/scenarios/{id}/validate`, api-surface §2 "부작용 없는 dry-run"). 3개 층을 본다 — 전부 **정적**(IR 문서만 검사, 실행 안 함):

  | 층 | 보는 것 (well-formed) | 안 보는 것 (runnable) |
  |---|---|---|
  | ① **ajv 스키마**(`ir.schema.json`) | 문서 구조·타입, `on`이 `{when,target,priority}` 배열, flow 키 1개(oneOf) | `extract.instruction`(선택이라 **없어도 통과**) |
  | ② **IREL 타입체크**(`ir-expression.md`) | 조건식 파싱(EBNF)+타입, `flags.*`가 닫힌 레지스트리의 boolean인가 | 실제 페이지 상태 |
  | ③ **그래프 검증 V1~V11**(`ir-static-validation.md`) | target 참조 무결성·도달성·terminal·loop·우선순위 동률 | 사이트 등록·셀렉터 실재·추출 가능성 |

- → 검증은 **"IR이 잘 빚어졌나(well-formed)"** 만 보고 **"실제로 돌아가나(runnable)"** 는 안 본다.
- **실측**: extract에 instruction이 없어 실행은 실패(run `922e5a4c`)했던 **"IR직접편집 테스트"** 가 검증에선 **"검증 통과"** 로 표시됨 → **"검증 통과" ≠ "실행 가능"**. 운영자에게 **거짓 안심**을 준다.
- (사소) 버튼 라벨은 **"검사"**인데 결과 텍스트는 **"검증 통과"** — 용어 혼용.

---

## E. 고급 설정 — "AI 모델 설정"(AI 모델 정책 / `gateway_policies`) 화면
> `llmGateway` 뷰(`GatewayView`). 테넌트별 LLM 게이트웨이 정책(모델별 capabilities·budget·fallback) 관리. **`POST /v1/runs`의 model 해소원**(gap #1)이자, 실제 접속정보 `.env CODEX_*`(provider 연결)와는 **별개의 제어평면 정책**.

- **조회·편집은 동작**(실측): 모델명 입력 → "조회" → 그 정책의 `capabilities`·`budget`·`fallback` 표시 + 편집 폼("정책 저장"). 예: `gpt-4o-mini` → `{vision:false,jsonMode:true}` / `{maxInputTokens:1000}`.
- ⚠️ **모델 "목록"을 안 보여줌**: 정확한 모델명을 미리 알아야 조회 가능(시드: `gpt-4o-mini`·`claude-haiku`). 백엔드가 다정책 시 `GET /v1/gateway/policy`(무지정)를 **422(`model_required`)로 막고 목록을 안 줌** → 방문 시 콘솔 422가 찍힘(뷰는 "모델명 입력"으로 graceful 처리). 모델명을 모르면 이 화면에서 찾을 방법이 없음.
- ⚠️ **`is_default`(기본 모델) 토글 없음**: 정책 편집은 되나 "기본으로 지정"이 없음 → `model_required`를 콘솔에서 못 푼다(**gap #1의 UI측 원인**).
- ⚠️ **새 정책 생성·삭제 없음**: 기존(시드) 정책의 JSON 편집만 가능.

---

## 우선순위 (UI/UX 리팩토링)
1. **저-코드 모드(쉬운/단계)에 extract 추출규칙(instruction) 입력 추가** — 없으면 두 모드는 추출 용도로 사실상 무용. (A3·D1, 최우선)
2. **실행 실패를 UI에 표면화** — run 상태를 `failed_*`로 전이 + "실행 중/점유"로 숨기지 말 것. (C1)
3. **`extract.instruction` 계약↔런타임 일치화** — "저장됨 ≠ 실행됨" 제거 + **검증 버튼이 실행불가 IR을 "통과"로 표시하는 거짓 안심 제거**. (D1·D2)
4. **시나리오 회수 수단** — 삭제(B3) + prod 취소(un-promote)(B4). 현재 만든 자동화를 제거·중단할 방법이 전혀 없음.
5. **편집 전환 버그** `key={scenarioId}`(B1) · **버전 히스토리/롤백 UI**(B4).
6. **AI 모델 설정** — 모델 목록 노출 + `is_default` 토글(gap #1) + 정책 생성/삭제. (E)
7. (런타임 측 후속) **extract content 갭**(실데이터 추출) · RunTrace dev 단계트레이스 가시화. (C2·C3)
