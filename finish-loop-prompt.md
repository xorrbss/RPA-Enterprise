# 자율 완성 루프 프롬프트 (RPA-Enterprise — 개발완료 + 테스트완료 + 관리자 콘솔 디자인 완료)

> 코딩 에이전트(autonomous/ultracode)에게 **컨텍스트로 주고 "완료 기준까지 무인 진행"으로 지시**하는 무인 연속 빌드 프롬프트.
> 계약/codegen(D1)·런타임(D2–D7)·운영 콘솔 1차(web/)는 이미 origin/main에 머지·CI green 상태다.
> 이 프롬프트는 **남은 빌드 가능 항목을 끝까지 구현해 3가지 완료 기준을 모두 충족**시키는 것을 목표로 한다.
> `build-prompt.md`(단계별 DoD)·`architecture.md`(청사진)·`autonomous-loop-prompt.md`(D2–D7 무인 빌드)의 후속판이며,
> **병렬 codex 공존(worktree 격리)·원격 CI 검증 규율**을 추가로 고정한다.

---

## [읽기 순서 — 진실원천]
README.md → CLAUDE.md / AGENTS.md → architecture.md(§6 빌드순서·§9 PoC·§10 IREL) →
계약 SSoT(ir-expression / ir-static-validation / state-machine / reserved-handlers / llm-gateway-adapter /
impl-contracts-bundle / security-contracts / auth-rbac / api-surface / ops-defaults / schema·db·ts) →
build-prompt.md → release-open-checklist.md / release-decisions.md → 전역 메모리 MEMORY.md.
**그 다음 반드시 ground truth(아래 [재개 — ground truth])로 실제 완료 증분을 확인**하고, 첫 미완 증분부터 시작한다.
(계약/codegen은 진실원천 — 손으로 다시 만들지 말고 재사용/확장. 충돌 시 계약이 이긴다.)

## [현재 상태 — 2026-06-15 기준, 새 세션은 ground truth로 재확인]
- D1 codegen 검증 완료. **D2–D7 + `POST /v1/sites/{id}/approve`가 origin/main에 머지, Contract Gates 10/10 green.**
- **레포 PUBLIC 전환됨 → GitHub Actions 무료**(과금 블로커 해소, CI 정상 실행). PR 머지 경로 열림.
- `web/` React 운영 콘솔: scaffold + 11뷰 shell/hash router + read 뷰 + 운영자 명령(abort/replay/human-task 전이/scenario promote) + scenario create/edit·StepBuilder·playground + 페이지네이션·필터·토큰 게이트·a11y + 실 브라우저 e2e 2종(stub + 라이브 browser→Fastify→PostgreSQL).
- 공개 전환이 드러낸 잠복 결함 2건 수정 완료: ① int 테스트 PG 비밀번호 인증(로컬 `--auth=trust`가 가림) ② main blocked:audit(autonomous-loop-prompt.md informational 미분류).
- ⚠ **병렬 codex 스트림이 동시에 같은 레포를 빌드·브랜치 전환·커밋한다**(이번 작업 중 실측). 반드시 [병렬 codex 공존] 규율을 따른다.

## [완료 기준 — 아래 3가지 모두 충족할 때까지 사람 개입 없이 수행]
1. **개발완료** — architecture §6 D-시리즈 + 스캔이 뽑은 빌드 가능 항목(미구현 제어평면 라우트·런타임 드라이버/스케줄러·관측·게이트)을 전부 **구현**하거나, 미결정 계약/외부 사실이면 **가정 금지로 BLOCK**(Required decision 명시 + release-open-checklist 추적). "조용한 false/unknown 금지" 불변 유지.
2. **테스트 완료** — **origin/main의 Contract Gates 전체 green**(`gh run view <id> --json conclusion == "success"`로 재확인). 단위 + 통합(temp-PG15, 비-BYPASSRLS 역할) + e2e(실 브라우저) + a11y(axe) + secret-scan + blocked:audit + migration smoke 포함. 신규 코드는 실패 테스트 먼저(TDD).
3. **관리자 콘솔 디자인 구현 완료** — `web/` React 운영 콘솔이 `rpa_enterprise_console.html` 디자인을 **충실히** 구현:
   - 11 뷰(scenarioStudio·playground·dashboard·openGate·workitems·humanTasks·runTrace·irValidation·llmGateway·security·idempotency) 전부 실 제어평면 API(api-surface)에 연결(read + command) 또는 백엔드 부재 시 정직한 사유.
   - 운영자 워크플로우: run create/abort · human-task assign/start/resolve/escalate · DLQ replay · scenario validate/promote · site approve 등 **계약에 라우트가 있는 명령 전부** UI 배선.
   - 디자인 토큰·레이아웃·운영자 비기술 한국어 카피 패리티, detail/drill-down 뷰, 커서 페이지네이션, 닫힌 enum 필터, 실시간 갱신(v1=outbox tail 폴링), 로딩/빈/오류 상태, 접근성(focus-visible·aria·axe 위반 0).
   - vitest(jsdom) + 실 브라우저 e2e(stub dist + 라이브 browser→Fastify→PostgreSQL) green.

## [빌드 루프 — 증분별 TDD]
각 증분은 다음을 돈다:
1. DoD/게이트를 architecture·build-prompt·api-surface에서 확인(수치는 실측 우선: `npm --prefix codegen run fixtures`/`run validators`).
2. **실패 테스트 먼저**(단위→통합→필요 시 e2e) 작성.
3. 최소 구현(KISS/YAGNI, 파일 500라인, 기존 구조 우선 — 새 추상화 전 확장 가능성 검토).
4. 리팩터.
5. 단계 검증: `npm --prefix app run typecheck`·`test:unit`; 통합은 `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`(Docker 미사용=testcontainers 불가, temp PG15 게이트); web은 `npm --prefix web run typecheck`·`test`·`build`; 브라우저 e2e는 Chrome 필요.
6. 집계 게이트: `node scripts/run-local-gates.mjs`(contract-lint·blocked:audit·codegen test·secret-scan·DB smoke·app/web 단위/통합/e2e). DB+Chrome 동반 시 `node scripts/db-temp-postgres-gate.mjs --local-gates`.
7. 게이트 통과 후에만 커밋 → push → PR → **원격 CI green 확인** → 머지. codegen fixtures 회귀와 "조용한 false/unknown 금지" 불변을 매 증분 유지.

## [병렬 codex 공존 — 하드 게이트]
메인 워킹트리는 병렬 codex가 **브랜치를 전환하며** 빌드·커밋한다. 충돌·작업 손실을 막기 위해:
- **모든 빌드는 git worktree에서** 한다: `git fetch origin && git worktree add <경로> -b <feature> origin/main`. 메인 워킹트리를 건드리지 않는다(브랜치 전환 금지).
- worktree는 `node_modules`가 없다 → 필요한 `npm ci --prefix {app,codegen,web}`. **하나의 worktree를 재사용**해 설치 비용을 아낀다(증분마다 그 안에서 새 브랜치).
- 커밋 전 `git -C <wt> status`로 **자기 파일만 path-scoped 스테이징**. `git add -A`/`git add .` 금지(병렬 미커밋 변경을 쓸어담는다).
- 작업 끝나면 `git worktree remove`(또는 재사용). 메인 워킹트리의 미커밋 변경은 병렬 codex 것이므로 절대 건드리지/커밋하지 않는다.
- 머지 전 `git fetch && git log origin/main`으로 최신 확인. 머지 후 통합 main CI가 green인지 재확인(중복 fix 커밋 auto-merge 검증).

## [원격 CI 검증 — 신뢰 규율]
- `gh run watch --exit-status`의 exit 0을 성공으로 **믿지 않는다**. 항상 `gh run view <id> --json conclusion` == `"success"`로 재확인(이번 세션에서 watch exit0이 실제 failure였던 사례 있음).
- push 직후 `gh run list --limit 1`이 **이전(stale) run**을 줄 수 있다 — `headSha`를 방금 커밋과 대조한다. 필요 시 `gh workflow run contract-gates.yml --ref <branch>`로 명시 트리거.
- 머지 후 push가 main에서 새 Contract Gates를 띄운다(concurrency cancel-in-progress 주의) — **최종 main run의 conclusion=success**를 확인하고서야 그 증분을 "완료"로 본다.

## [추측 통제 — BLOCK vs 계속]
- **[확정]** 로그/테스트출력/코드로 증명 → 바로 해결. **[추정]** 1개 가설만 시도, 실패 시 [모름]으로 강등. **[모름]** 임의 수정 금지.
- 순수 app/web 내부에서 국소화·수정 가능한 **결정적 코드/테스트 오류만** 계속 시도. 같은 게이트가 동일 근본원인으로 **3회 연속 실패**하면 STOP.
- **BLOCK**: 미결정 계약 필드(예: `PUT /v1/gateway/policy`의 `LLM_CAPABILITY_MISMATCH` coherence — ModelCapabilities가 독립 boolean 3개라 정책-정의 시점 모순 규칙이 미정의)·외부 사실(라이브 LLM·실 sink/object-store·SecretStore·배포 타깃)·모호 명세는 `TODO: [BLOCKED]` + 바로 다음 줄 `Required decision:` + release-open-checklist active blocker로 추적. **BLOCK한 항목에 의존하지 않는 후속만 진행**; 의존하면 STOP.
- 계약(SSoT) 미명시 결정(권한 경계·데이터 가시성·기본값·멱등키 구성·UX)은 release-decisions.md에 결정/근거/틀렸을 때 영향범위 기재. 검증된 내부 모순일 때만 README 패치로그 규율로 계약을 고친 뒤 진행. 역할 권한·데이터 경계는 auth-rbac §2 매트릭스가 권위("조용한 상속 금지"); §2에도 없으면 가장 보수적(최소권한).

## [남은 작업 — 스캔 기준, ground truth로 재확인]
빌드 가능(가정 금지 통과): GET /v1/artifacts/{id}(redaction→RBAC 2-게이트, 메타/게이트 절반 — 객체 본문 egress만 외부) · OTel §E span 실제 call-site 계측 + bootstrapTracing 프로덕션 배선 + 메트릭 · 체크아웃 만료 sweeper(W6/W7, CAS 골격 buildable; W9/W11 pause-TTL 공식만 BLOCKED) · W8 retry 재-checkout 드라이버 · 재귀 스케줄러(outbox relay + lease/artifact sweeper) · sink-DLQ replay 재-enqueue + sink 전달 sweeper · secret-taint ESLint 룰(빌드 차단, 최대 게이트 갭) · Spectral OpenAPI/AsyncAPI lint · migration 멱등/rollback 검증 · 관리자 콘솔 잔여 뷰/detail/명령/디자인 패리티 · 라이브 e2e 명령 커버리지 확장.
BLOCKED(외부 사실/미결정): PUT gateway/policy capability coherence · 실 sink/object-store egress · SecretStore 프로비저닝 · 배포 타깃 · D5 라이브 모델 증거.
※ 이 목록은 스냅샷이다. 새 세션은 `api-surface.md` 라우트 인벤토리 ↔ `app/src/api` 실구현, `state-machine` 전이 ↔ 런타임 드라이버, `web/src/views` ↔ `rpa_enterprise_console.html` 11뷰를 직접 대조해 최신 갭을 도출한다(ultracode면 워크플로우로 병렬 스캔 후 우선순위 합성).

## [재개 — ground truth (새 대화/`/resume` 불가 시)]
인메모리 상태를 가정하지 않는다:
(a) README/CLAUDE/AGENTS/architecture + 전역 메모리 MEMORY.md 재독,
(b) `git fetch && git log origin/main --oneline -10` / `gh pr list` / `gh run list --branch main --workflow=contract-gates.yml --limit 3`으로 실제 완료·CI 상태 확인,
(c) `api-surface` ↔ `app/src/api`, `web/src/views` ↔ `rpa_enterprise_console.html` 대조로 미구현 갭 도출,
(d) **첫 미완 증분부터** worktree에서 재개.

## [세션 핸드오프]
이후 사람 개입 없이 진행된다. 사용량 한도로 멈추면 새 세션에서 `/resume` 또는 위 ground truth로 이어간다.
세션 종료 전 항상 전역 메모리 MEMORY.md · release-decisions.md(임의결정) · release-open-checklist.md(미해결)를 갱신하고, 미커밋 작업이 있으면 정확한 `git status` 경로를 메모리/블록보고에 남긴다(병렬 codex의 add-A·브랜치 전환에 쓸려갈 수 있음).

## [완료 선언]
**3가지 완료 기준(개발·테스트·관리자 콘솔 디자인) 모두 충족 + origin/main Contract Gates green(conclusion=success 재확인)** + 모든 `TODO: [BLOCKED]`가 release-open-checklist와 1:1로 묶이고 미해결은 Required decision으로 추적된 상태. [모름]/[추정]이 남으면 "사람 검토 대기"로 보고. 그 전까지 멈추지 않는다(단 BLOCK·3회 실패·외부 사실 의존은 STOP+보고 규율을 따른다).
