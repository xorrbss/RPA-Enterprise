# RPA Enterprise — 테스트 발견 정리 (현재 버전 기준)

> **버전**: `6acc4be` (full `6acc4be6c80a3bc90ab6b13f0499f29cbe4f94cd`), 2026-06-17
> **포함 PR**: #133(run_steps 조회) · #134(run artifacts 조회) · #135(운영자-보조 세션 캡처) · #136(idempotency 뷰) · #137(사이트 이름/세션등록 노출)
> **테스트 맥락**: 삼성디스플레이 게스트(`https://guest.samsungdisplay.com/argos/main.do`) 공지사항 자동화를 dev 콘솔로 end-to-end 시도
> **결론 한 줄**: 백엔드/배선은 살아있으나, **사이트를 실제로 쓸 수 있게 완성하는 제품 UI 표면이 없어** 운영자가 콘솔만으로 임의 사이트 자동화를 완료할 수 없음. 데모는 시드 하드코딩 픽스처로만 성립.

---

## 1. 핵심 갭 (제품 UI로 도달 불가)

### 갭 #1 — 모델 기본값을 UI로 지정 불가 → 실행 422
- **증상**: 자동화 실행 시 `POST /v1/runs` → `422 IR_SCHEMA_INVALID {reason: model_required}`
- **원인**: 시드가 게이트웨이 정책 2개(`gpt-4o-mini`/`claude-haiku`)를 만들면서 `is_default` 미지정. 모델 미지정 run은 다정책 상황에서 해소 불가.
- **연결 단절**: `CODEX_MODEL`(env, 실제 호출 모델)과 `gateway_policies`(DB, 정책)가 분리됨. `POST /v1/runs`는 env를 참조 안 함. 해소된 `runs.model`은 아직 실행기가 소비도 안 함(PR-B0).
- **UI 부재**: "AI 모델 정책" 화면(`web/src/views/Gateway.tsx`)에 `is_default` 토글 없음(Gap2가 API/DB에만 추가). 실행 버튼도 모델 선택 없음.
- **현재 우회**: DB `UPDATE gateway_policies SET is_default=true WHERE model='gpt-4o-mini'` — **재시작(재시드) 시 소멸**.
- **제안**: (A) 시드에 default 지정 / (B) 콘솔에 is_default 토글 추가.

### 갭 #2 — 사이트 `page_state_selectors`를 UI로 설정 불가 (최대 관문)
- **증상**: 사이트 등록 후 실행 → `page_state_selectors 미설정 — 비-마커 실행 불가`
- **원인**:
  - dev run-loop는 "마커 사이트"만 구동(`loadSitePageStateConfig` — 셀렉터로 PageState 결정형 판정). 미설정 → `PAGE_STATE_UNRESOLVED`.
  - 사이트 등록 폼(`web/src/components/SiteCreateForm.tsx`)은 `{name, url_pattern, risk}`만 전송 — `page_state_selectors`(loginUrl·authenticatedWhen·flags) 입력칸 없음. `browser_identity`도 UI가 생성 안 함.
- **파급 (한 갭이 다 막음)**:
  - 추출 사이트 실행 불가(마커 없음).
  - **'세션 등록' 버튼 미노출** — `login_capable = (page_state_selectors->>'loginUrl') IS NOT NULL`(reads.ts). loginUrl을 UI로 못 넣으니 UI 등록 사이트는 항상 버튼 없음.
- **제안**: SiteCreateForm에 page_state_selectors(JSON) 입력 + client 플럼빙 / (장기) LLM 기반 페이지상태 판정으로 비-마커 지원.

### OTP/MFA 자동화 미구현 (RQ-016)
- dom executor가 challenge를 항상 `failed_challenge`로 분류, suspend 신호 미발신(`stagehand-dom-executor.ts:84`). suspend 배관은 완비, **감지기(ChallengeDetector)만 부재**.
- OTP 값 자동 입력 경로 없음(이메일/SMS/TOTP 소스 없음). v1 resolve는 "계속" 신호일 뿐 데이터 미운반(v2 scope-out).
- **대안(PR #135)**: 운영자-보조 세션 캡처 — 사람이 OTP 포함 직접 로그인 → 쿠키 캡처·재사용. **단 갭 #2 때문에 시드 사이트에서만 도달 가능**.

### "쉬운 만들기"가 실행 불가 시나리오 생성
- navigate→extract 스켈레톤만 생성. extract 노드에 `instruction`(추출 규칙) 없이 라벨(`schema_ref`)만 넣음.
- 런타임 `ir-translate`는 `extract.instruction` 필수 → `IR_SCHEMA_INVALID`. 마법사도 저장 시 "실제 추출 규칙은 별도"라 경고.

---

## 2. 메타 관찰 — "데모는 시드 픽스처, 제품 UI는 미완성"
- 하이웍스 세션 캡처 데모는 `app/dev/serve.ts:385-404`에 **page_state_selectors·browser_identity를 하드코딩**해 성립. UI로는 그런 사이트를 못 만듦.
- 백엔드/계약 기능(Gap2 모델, 세션 캡처)이 **대응 콘솔 UI 없이** 머지됨. → PR의 "검증됨"은 **시드 픽스처 기준 검증**으로 읽어야 함.
- 같은 패턴이 이번 세션에 2회(갭 #1 DB 우회, 갭 #2 시드 하드코딩).

---

## 3. 정상 동작 확인 (배선은 살아있음)
- 제어평면: run 생성 + 모델 해소(Gap2 경로), 사이트 등록 + site-resolution, run-loop(실 Chrome + Codex + driver) 가동.
- 세션 캡처: 시드 하이웍스 픽스처 기준 동작. capture-loop 폴러 활성.
- 신규 조회면: run_steps(#133)·run artifacts(#134) RunTrace 노출, idempotency 뷰(#136).
- 인프라: Postgres(127.0.0.1:55432 / `rpa_contract_gate`), dev 콘솔(8080), CODEX 게이트웨이 활성.

---

## 4. 정정 (테스트 중 바로잡은 점)
- **OTP 과대 예측 정정**: 실제 시나리오(공개 공지 navigate+extract)는 로그인 단계가 없어 **OTP가 경로에 없음**. 그 케이스의 차단은 갭 #2 + extract instruction. (OTP는 로그인-기반 시나리오에만 해당.)
- **수동 로그인 무용**: run-loop는 별도 headless Chrome라 사용자 브라우저 세션과 쿠키 비공유. 캡처 경로(자체 Chrome)로만 재사용 가능.
- **스테일 빌드 주의**: `web/dist`는 git 미추적 로컬 산출물. 풀 후 재빌드 안 하면 옛 프런트가 새 백엔드와 불일치(예: 옛 자동등록 → `invalid_name` 422). 풀 → `npm --prefix web run build` → dev:serve 재시작 필요.

---

## 5. 삼성 테스트 진행 경로 (벽 순서)
1. run 생성 → **갭 #1(model_required)** → DB 우회로 통과
2. site-resolution → 사이트 미등록 → UI 등록으로 통과
3. **갭 #2(page_state_selectors 미설정)에서 멈춤** ← 현재 지점
4. (넘어가도) extract `instruction` 부재로 실패
5. OTP는 이 시나리오엔 무관(로그인 없음)

→ **현 버전으로 삼성 공지 추출 자동화는 콘솔만으로 완료 불가** (갭 #2 + 추출규칙 필요). 로그인-기반 시나리오는 추가로 OTP/세션캡처 경로 필요(역시 갭 #2 선행).

---

## 6. 우선순위 제안
1. **갭 #2 (page_state_selectors UI)** — 최우선. 이게 풀려야 임의 사이트가 제품 UI로 "완성" 가능(추출·세션캡처 둘 다 해금).
2. **갭 #1 (is_default UI 또는 시드 default)** — 실행 진입 자체를 막음. 즉효는 시드 수정.
3. **extract 규칙 입력 경로** — 쉬운 만들기에 추출 규칙(instruction) 입력 또는 IR 편집 안내.
4. **OTP/ChallengeDetector(RQ-016)** — 장기. 단기 대안은 세션 캡처(갭 #2 해소 전제).
