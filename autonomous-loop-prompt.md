# 자율 빌드 루프 프롬프트 (RPA-Enterprise, D2–D7)

> 코딩 에이전트(autonomous/ultracode)에게 컨텍스트로 주고 "D2부터 시작"으로 지시하는 **무인 연속 빌드** 프롬프트.
> 계약/codegen(D1)은 검증 완료. 이 프롬프트는 런타임(D2–D7) 구현을 끝까지 진행한다.
> `build-prompt.md`(상세 DoD)·`architecture.md`(청사진)의 보강판이며, 무인 루프의 안전장치(루프 종료·커밋 안전·재개 절차)를 추가로 고정한다.

---

[읽기 순서 — 진실원천]
README.md → CLAUDE.md / AGENTS.md → architecture.md(§6 빌드순서·§9 PoC·§10 IREL) →
계약 SSoT(ir-expression / ir-static-validation / state-machine / reserved-handlers / llm-gateway-adapter /
impl-contracts-bundle / security-contracts / auth-rbac / api-surface / ops-defaults / schema·db·ts) →
build-prompt.md → 전역 메모리 MEMORY.md 를 이 순서로 읽고,
architecture.md §6 의 빌드 순서(D2)부터 자율 빌드를 시작한다.
(D1 codegen은 이미 검증 완료 — irel-compile 파서/타입체커/evaluator·static-validation V1–V11·transitions·
validators·error-middleware·event-payload-registry 포함. 손으로 다시 만들지 말고 재사용/확장. 충돌 시 계약이 이긴다.
build-prompt.md의 고정 수치(전이/validator/ErrorCode 개수)는 stale일 수 있으니, 회귀 기준은 README v2.x와
`npm --prefix codegen run fixtures`/`run validators` 실측 출력을 따른다.)

[빌드 루프]
각 단계(D2~D7)는 단계별 TDD로 돈다:
  1) 해당 단계 DoD/게이트를 architecture.md·build-prompt.md에서 확인(수치는 실측 우선)
  2) 실패 테스트 먼저(단위→통합) 작성  3) 최소 구현  4) 리팩터(KISS/YAGNI, 파일 500라인)
  5) 단계 검증: `npm --prefix app run typecheck` · `test:unit`, 통합은 temp-PG 게이트로
       `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`     ← testcontainers 아님(Docker 미사용)
  6) 집계 게이트: `node scripts/run-local-gates.mjs` (contract-lint·blocked:audit·codegen test·secret-scan·DB smoke·app 단위/통합)
  7) 게이트 통과 후에만 커밋. codegen fixtures 회귀와 "조용한 false/unknown 금지" 불변을 매 단계 유지.

[커밋 안전 — 하드 게이트]
이 워킹트리는 병렬 codex 스트림이 계약 파일을 편집하고 브랜치를 전환한다(과거 main 직접 커밋 직전까지 간 사례 있음).
모든 커밋 전:
  - `git branch --show-current` 와 `git status` 확인. 현재 브랜치가 main이거나 의도한 feature 브랜치가 아니면 STOP —
    feature 브랜치를 만들/체크아웃한 뒤 커밋.
  - 자기 파일만 명시 경로로 스테이징. `git add -A` / `git add .` 금지(병렬 에이전트의 미커밋 변경을 쓸어담는다).
  - 커밋 메시지: 무엇/왜/영향범위/검증결과.

[루프 종료·에스컬레이션 — 무한루프 방지]
'막힘'을 정의한다:
  - 같은 단계 게이트가 동일 근본원인으로 3회 연속 실패하거나, 그린이던 게이트가 의도된 변경 없이 다시 red로 깜빡이면 → 재시도 중단(STOP).
  - 원격 CI는 `gh run watch --exit-status`의 exit 0을 성공으로 믿지 않는다. 머지 전 `gh run view <id> --json conclusion` == "success"로 재확인.

[추측 통제]
[확정] 로그/테스트출력/코드로 증명 → 바로 해결.
[추정] 유력하나 미증명 → 가설 1개만 시도, 실패 시 [모름]으로 강등.
[모름] 원인 불명 → 임의 수정 금지. `TODO: [BLOCKED]`를 남기되 바로 다음 줄에 `Required decision:` 줄을 반드시 포함하고
       (없으면 blocked:audit 게이트가 build를 fail시킨다), release-open-checklist.md의 active blocker 행으로 추적한 뒤 다음 단계로.
[확정] 교훈만 전역 메모리(feedback)에 기록. [추정]/[모름]은 release-open-checklist.md에만 남긴다.
이는 CLAUDE.md "가정 금지" 및 미정의 전이→throw IllegalTransition / 미분류 예외→system 흡수 / IREL scope missing→System 규율과 동일선상이다.

[BLOCK vs 계속]
순수 app/ 내부에서 국소화·수정 가능한 결정적 코드/테스트 오류만 계속 시도한다.
미결정 계약 필드·외부 사실(라이브 provider 동작·배포 타깃·SecretStore 백엔드)·모호한 명세·3회 초과 실패는 BLOCK한다.
BLOCK한 단계에 의존하지 않는 후속 단계만 진행 가능; 의존하면 STOP.

[임의결정 로그]
계약(SSoT)에 명시 없는 모든 결정(권한 경계·데이터 가시성·기본값·멱등키 구성·UX)은 release-decisions.md에
결정/근거/틀렸을 때 영향범위로 기재. 계약 결함(검증된 내부 모순)일 때만 README 패치로그 규율로 계약을 고친 뒤 진행.
역할 권한·데이터 경계는 auth-rbac.md §2 매트릭스가 권위다 — 역할 포함/상속을 권위로 보지 않는다("조용한 상속 금지").
§2에도 없으면 release-decisions.md에 올린 뒤 가장 보수적인(최소권한) 쪽으로 구현.

[완료 기준]
D2~D7 게이트 + CI 그린(eslint+secret taint·tsc --strict·전체 테스트·마이그레이션 적용/롤백·OpenAPI/AsyncAPI lint)
+ 멱등·RLS(cross-tenant 차단)·관측(OTel 이름 고정)·보안(redaction/signed-shell/prompt-injection) 게이트
+ RBAC 역할별 QA + 운영 콘솔(rpa_enterprise_console.html) 디자인 충실도 통과.
외부 사실(Stagehand v3 결정형 page API 커버리지·Codex structured-output 스트리밍 범위·모델 maxContextTokens)은
PoC로 확정하거나 `TODO: [BLOCKED]`로 명시한다.
"완료" = `node scripts/blocked-decisions-audit.mjs`(blocked:audit) 통과 — 모든 `TODO: [BLOCKED]`가
release-open-checklist.md와 1:1로 묶이고 미해결 항목이 모두 [확정] 처리된 상태. [모름]/[추정]이 남으면 "사람 검토 대기".

[세션 핸드오프 & 재개]
이후 사람 개입 없이 진행된다. 사용량 한도로 멈추면 새 세션에서 `/resume` 로 이어간다.
`/resume`(직전 세션 복원)이 불가능한 새 대화라면 인메모리 상태를 가정하지 말고 ground truth에서 재개한다:
  (a) README/CLAUDE/AGENTS/architecture + 전역 메모리 MEMORY.md 재독,
  (b) `git status` / `git branch --show-current` / `git log --oneline -8` 로 실제 완료 증분 확인,
  (c) `npm --prefix app run typecheck`·`test:unit` + temp-PG 게이트 `test:int` 로 어디까지 그린인지 확인,
  (d) 게이트가 그린이 아닌 첫 증분부터 재개.
세션 종료 전 항상 전역 메모리 MEMORY.md·release-decisions.md(임의결정)·release-open-checklist.md(미해결)를 갱신하고,
미커밋 작업이 있으면 정확한 `git status` 경로를 메모리/블록보고에 남긴다(병렬 codex의 `git add -A`·브랜치 전환에 쓸려갈 수 있음).
