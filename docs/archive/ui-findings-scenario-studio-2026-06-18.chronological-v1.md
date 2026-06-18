# UI 검증 발견 — 자동화 만들기/편집/실행 (시나리오 스튜디오)

> **버전**: `705f2fd` (UI/UX 고도화 Phase 0~3 + R1~R4 반영분), 2026-06-18
> **맥락**: "소스 새로 받고 자동화 만들기 3가지 모드 + 실행" 검증 (Playwright 실구동)
> **증빙**: `automation-create-3modes-result.png`, `samsung-run-completed-runtrace.png`

---

## ✅ 정상 동작 확인

### 자동화 "새로 만들기" 3가지 모드 — 전부 저장 성공
| 모드 | 결과 |
|---|---|
| 쉬운 만들기 | ✅ 저장(`0d25711d`) |
| 단계 편집(고급) | ✅ 저장(`0afb5308`) |
| IR 직접 편집(개발자) | ✅ 저장(`06011cf2`) |
- 브라우저 콘솔 에러 0건. 이전 옛 빌드의 `invalid_name` 자동등록 버그는 현재 main에서 미발생.
- ⚠️ **저장만 성공 — 셋 다 "실행"은 실패함** (아래 "[중대] 심화 검증" 참조). **"저장됨 ≠ 실행됨".**

### 실행 (삼성 공지 수집)
- 실행 버튼 → URL 입력 → 실행 시작 → **run 생성 + RunTrace 자동 직행**(Phase 0) → **완료**(`open→ready→collect→done`).
- `model_required` 422 미발생(시드 기본모델 자동해소). observe 게이트(#143) 동작.

---

## 🐞 발견 이슈

### [BUG] 시나리오 편집 전환 시 IR 내용이 갱신되지 않음
- **증상**: 시나리오 A의 "편집"을 연 뒤, 시나리오 B의 "편집"을 누르면 **제목(헤더)은 B로 바뀌지만 IR 문서 textarea 내용은 여전히 A의 IR**. 잘못 저장하면 A의 IR이 B의 새 버전으로 덮어써질 위험.
- **재현**: 자동화 만들기 → "IR직접편집 테스트" 편집(열림) → "삼성디스플레이 공지 수집" 편집 클릭 → 제목="삼성…"인데 본문은 "IR직접편집 테스트" IR.
- **원인** (`web/src/components/ScenarioForm.tsx:96-100`):
  ```js
  const [text, setText] = useState(() => (isEdit ? null : ...));   // L77
  useEffect(() => {
    if (mode.kind !== "edit" || text !== null || ...) return;       // text!==null → early-return
    setText(...해당 시나리오 IR...);
  }, [mode, text, detail.data]);
  ```
  편집 패널이 **scenarioId마다 remount되지 않고 재사용**되는데, IR 주입 effect가 `text !== null` 가드로 **재초기화를 막음**. 첫 시나리오 IR이 채워진 뒤엔 다른 시나리오로 바꿔도 text 고정.
- **수정안**:
  1. 부모(Scenarios 뷰)에서 `<ScenarioForm key={scenarioId} ... />` — scenarioId 변경 시 강제 remount, 또는
  2. `mode.scenarioId` 변경을 감지해 `text=null`(+report/error 리셋)로 되돌리는 effect 추가.

### [설계/UX] 편집은 "IR 직접 편집" 전용
- "편집"은 항상 IR 문서 폼으로만 열림(`ScenarioForm.tsx:81` `editor = isEdit ? "ir" : "easy"`). 쉬운 만들기/단계 편집 탭은 **"새로 만들기"에만** 존재.
- **함의**: 비개발자(운영자)가 쉬운 만들기로 만든 자동화를 **나중에 쉬운/단계 방식으로 수정 불가** — 편집하려면 IR(JSON)을 직접 다뤄야 함. 저-코드 사용자 동선 단절.
- **개선안**: 편집에서도 3-탭(쉬운/단계/IR) 제공, 또는 최소한 단계 편집 모드 제공.

### [기능 부재] 시나리오 삭제 불가
- 시나리오 행 작업 버튼 = **편집 / prod 승격 / 실행** 뿐. **삭제 버튼 없음.**
- web 전체·`app/src/api/scenarios.ts`에 **시나리오 삭제(UI/API)가 존재하지 않음**. (StepBuilder의 "삭제"는 *단계* 삭제)
- **함의**: 잘못 만든/테스트용 시나리오를 콘솔에서 못 지움 → 목록 오염, 재시드로만 정리.
- **개선안**: 시나리오 삭제(또는 보관/archive) 액션 + 백엔드 DELETE 라우트.

---

## 🔭 관련 실행 발견 (배경)

- **RunTrace "단계 트레이스"가 dev에서 비어있음** — dev run-loop가 `run_steps`/artifact를 DB에 영속하지 않음(프로덕션 워커 기능). Phase 0/1의 "라이브 트레이스" UI는 구조는 완성됐으나 **dev 실행은 보여줄 단계 데이터가 없음**.
- **extract content 갭** — 실행은 완료되나 extract가 실제 행 데이터가 아니라 **추출 플랜(셀렉터)** 까지만 산출(LLM에 DOM 본문 미전달, `stagehand-dom-executor.ts:138`). observe 게이트로 about:blank 경합은 해소됨.
- **observe 게이트 loud-fail** — 그리드 미렌더(타이밍) 시 `IR_NO_BRANCH_MATCHED`로 표면화(무음 빈추출 금지, #143 의도대로).

---

## 우선순위 제안 (UI/UX 리팩토링)
1. **편집 전환 버그** (데이터 덮어쓰기 위험) — 최우선, `key={scenarioId}` 한 줄로 해결 가능.
2. **시나리오 삭제** — 운영 필수 액션.
3. **편집 모드 다양화**(쉬운/단계 편집도 편집에서) — 저-코드 동선.
4. RunTrace 단계 트레이스 dev 가시화 / extract content — 런타임 측 후속.

---

# [중대] 심화 검증 — "저장됨 ≠ 실행됨", 작동 IR은 IR직접편집에서만 가능

> 1차 테스트는 "3모드 저장 성공"만 보고 실행은 삼성 시드만 돌린 **불완전 검증**이었음. 이번엔 **3모드로 만든 것을 전부 실제 실행**하고, "작동하는 IR" 제작법을 실측 확정. (run id는 dev:serve 로그 기준)

## 1. 3모드가 만드는 IR은 서로 다름 (실측 IR 비교)
| 모드 | 생성 IR 구조 | extract instruction | params_schema |
|---|---|---|---|
| 쉬운 만들기 | navigate→observe→extract→done | ❌ 없음(`schema_ref`만) | entry_url **default=입력URL** |
| 단계 편집(기본) | **observe→end 뿐** (navigate·extract 둘 다 없음) | ❌ 없음 | 없음 |
| IR 직접 편집(기본 템플릿) | navigate→observe→extract→done | ❌ 없음 | entry_url (default 없음) |

→ **같은 템플릿 아님.** 단계편집 기본값은 아무 동작도 없는 observe→end.

## 2. 3모드로 만든 시나리오 — 전부 실행 실패 (실측)
| 시나리오 | run | 실행 결과 |
|---|---|---|
| IR직접편집 테스트 | `922e5a4c` | ❌ `compiledScenarioFrom: node 'collect' extract.instruction 필요` |
| 쉬운만들기 테스트 | `02156c17` | ❌ `origin https://example.com 매칭 site_profile 없음` (+ extract instruction도 없음) |
| 단계편집 테스트 | `baa59d75` | ❌ `start에서 도달 가능한 navigate 없음 — entry URL 판정 불가` |

→ **저장 가능 ≠ 실행 가능.** 기본 산출물은 셋 다 실행 불가.

## 3. [BUG/중대] UI가 실행 실패를 전혀 표면화하지 않음 (DB↔UI 실측 대조)
| run | 실제 결과 | DB 상태 | **UI 표시** |
|---|---|---|---|
| `922e5a4c` | ❌ 실패(extract.instruction) | `running` | **"실행 중"** |
| `02156c17` | ❌ 실패(site 없음) | `claimed` | **"점유"** |
| `baa59d75` | ❌ 실패(navigate 없음) | `claimed` | **"점유"** |
| `1183668b` | ⚠ 완료지만 **데이터 0** | `completed` | **"완료"** |

- **실패 3건 모두 "실행 중"/"점유"로 표시** — 진행 중처럼 보이고 "취소" 버튼까지 달림. **"실패"로 잡히는 건 0건.**
- **근본 원인**: run-loop가 loud-fail해도 **run 상태를 `failed_*`로 전이시키지 않고** `claimed`/`running`에 그대로 둠 → 상태 필터('실패' 옵션 있음)에도 안 잡힘. 운영자는 실패를 알 길이 없음.
- **"완료"도 비정직**: `1183668b`는 "완료"지만 실제 추출 데이터 0(extract content 갭), 상세의 단계 트레이스·산출물도 비어 "완료=성공"으로 오해.
- → **"조용한 false 금지" 원칙으로 만든 콘솔이 정작 실행 실패를 가장 조용히 숨김.** (실패→"실행중/점유", 빈완료→"완료")
- 증빙: `template-scenario-run-fails-but-shows-running.png`, `runs-failed-but-shown-as-running-or-claimed.png`

## 4. "작동하는 IR" 제작법 — IR직접편집 기본 템플릿에서 2가지만 수정 (실측 완료)
기본 IR 템플릿 대비:
1. **extract 노드에 `"instruction": "…추출하라"` 추가** — 없으면 런타임 `IR_SCHEMA_INVALID(extract.instruction 필요)`.
2. **entry_url을 등록된 사이트로** — `params_schema.entry_url.default`를 **page_state_selectors와 함께 등록된 site origin**(예: `https://guest.samsungdisplay.com/...`)으로. 미등록 origin이면 site-resolution 실패.
- 검증: 작동확인 IR(`bad2f033`) 실행 → **`1183668b → completed (open→check→collect→done)`** ✅. (extract 출력: `{"extractor":"table","fields":["title","author","date","views"],"rowSelector":".grid-row"}`)

## 5. [중대] 쉬운/단계 모드로는 "작동 IR"을 만들 수 없음
| 모드 | extract instruction 입력 | 작동(추출) IR 생성 |
|---|---|---|
| 쉬운 만들기 | ❌ 폼에 필드 자체가 없음(이름/주소/라벨/방식뿐) | **불가** |
| 단계 편집 | ❌ extract 단계에 '출력 스키마(schema_ref)'만, instruction 필드 없음(UI 실측) | **불가** |
| IR 직접 편집 | ✅ IR에 직접 입력 가능 | 가능 |

코드 근거: `OperatorWizard.tsx:50`(extract `schema_ref`만), `StepBuilder.tsx:43-44`(extract `schema_ref`만 + "추가 필드는 IR 직접 편집에서" 주석 — 그러나 instruction 없는 extract는 런타임 무효라 "무효 IR 미생성" 원칙과 모순).

→ **결론: 비개발자용 두 모드(쉬운·단계)로는 "데이터를 추출하는 작동 자동화"를 만들 수 없다.** extract instruction을 못 넣기 때문. **오직 개발자 모드(IR 직접 편집)** 에서만 작동 추출 시나리오 생성 가능. (+ 사이트가 page_state_selectors와 함께 등록돼 있어야 함 — gap #2)

## 6. [근본] `extract.instruction` — 계약은 "선택", 런타임은 "필수" (불일치)
- **계약(`schema/ir.schema.json:140-141`)**: extract는 `schema_ref`만 required. **instruction은 선택**(있으면 string으로 정의만).
- **런타임(`app/src/runtime/ir-translate.ts`)**: extract에 instruction도 **required** — 없으면 `IR_SCHEMA_INVALID(extract.instruction 필요)` throw.
- → 저장(ajv 스키마 검증)은 통과하고 **실행(ir-translate 컴파일)만 실패** = extract 시나리오에서 **"저장됨 ≠ 실행됨"의 근본 원인**.
- **instruction의 역할**: extract는 LLM 기반 프리미티브 → instruction은 LLM에게 "무엇을 추출하라"는 **자연어 작업 지시**. `schema_ref`는 출력 구조의 이름표(검증용)일 뿐이며, dev엔 스키마 레지스트리가 없어 의미 정보가 0 → instruction이 LLM의 사실상 유일한 작업 정보원.
- **제안(통일)**: ① 계약 스키마도 instruction을 required로(저장 단계에서 즉시·명확히 차단) **또는** ② 런타임을 선택으로 + schema에서 작업 추론. 현 상태(계약=선택 / 런타임=필수)는 최악 — 저장 통과 → 실행 시 늦게 실패 → 저-코드 UI엔 입력칸도 없음.

## 우선순위 (갱신)
1. **쉬운/단계 모드에 extract 추출규칙(instruction) 입력 추가** — 없으면 저-코드 모드는 추출 용도로 사실상 무용. (최우선)
2. **`extract.instruction` 계약↔런타임 일치화** (위 §6) — "저장됨 ≠ 실행됨" 제거.
3. **실행 실패를 UI에 표면화** — "실행 중"으로 숨기지 말 것.
4. **편집 전환 버그**(`key={scenarioId}`) · **시나리오 삭제 기능** — 1차 문서대로.
