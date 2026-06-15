# 검토·QA·어드민·충실도 완성 루프 프롬프트 (RPA-Enterprise)

> 코딩 에이전트(autonomous/ultracode)에게 **컨텍스트로 주고 "OPEN ISSUES 0[확정]까지 무인 진행"으로 지시**하는
> 연속 검토·QA·개발 프롬프트. 미션: **전체 코드리뷰 + 역할별 QA + 어드민 기능 개발 + 충실도(fidelity) 통과**.
> `finish-loop-prompt.md`(D2–D7 + 게이트·OTel·계약결정 A1–A6까지 완성)의 후속판 — 빌드 가능 백로그가
> 대부분 소진된 시점에서 **품질·정합·완성도**를 [확정] 수준으로 끌어올린다.
> 이후 사람 개입 없이 진행된다. 사용량 한도로 멈추면 새 세션에서 `/resume` 로 이어간다.

---

## [핵심 규율 — OPEN ISSUES (이 프롬프트의 심장)]

- **이슈를 숨기지 않는다.** "OPEN ISSUES 0"을 만들기 위해 이슈를 누락·축소·임의 종결하지 않는다.
- 모든 발견은 **OPEN ISSUES 레지스터**(아래 [레지스터])에 ID로 등록한다. 미해결 항목은 **닫지 말고 명시적으로** 남긴다.
- 각 이슈는 다음 분류 중 하나로만 표기한다:
  - **[확정]** — 로그/테스트출력/코드/CI로 증명되어 **해결**(또는 근거 있는 명시적 **수용**)된 상태.
  - **[추정]** — 1개 가설로 설명되나 증명되지 않음. **미해결**.
  - **[모름]** — 원인/해법 불명. **미해결**.
  - **BLOCK([확정 불가])** — 외부 사실/미결정 계약/재현 불가에 의존. `Required decision:` 또는 외부 소유자를 명시해 추적(닫지 않음).
- **"완료" = OPEN ISSUES가 전부 [확정]** + origin/main Contract Gates green(conclusion=success 재확인) + 모든 BLOCK이 Required decision/외부 소유자로 1:1 추적된 상태.
- **[모름]/[추정]/BLOCK이 하나라도 남으면 완료가 아니라 "사람 검토 대기(NEEDS HUMAN REVIEW)"** 로 표시하고, 각 항목에 무엇이 막는지(외부 사실/미결정 계약/재현 불가)와 다음 행동을 명시한다.
- 레지스터는 **추가만(append)**; 분류 강등([확정]→[추정] 등)도 기록한다(은폐 금지).

---

## [읽기 순서 — 진실원천]

README.md → CLAUDE.md / AGENTS.md → architecture.md →
계약 SSoT(ir-expression / ir-static-validation / state-machine / reserved-handlers / llm-gateway-adapter /
impl-contracts-bundle / security-contracts / auth-rbac / api-surface / ops-defaults / schema·db·ts) →
build-prompt.md / finish-loop-prompt.md → release-decisions.md(D1–D8) / release-open-checklist.md → 전역 메모리 MEMORY.md(특히 finish-loop-plan.md).
계약/codegen은 진실원천 — 손으로 다시 만들지 말고 재사용/확장. **충돌 시 계약이 이긴다.**

## [재개 — ground truth (인메모리 가정 금지)]

(a) README/CLAUDE/AGENTS/architecture + MEMORY.md 재독.
(b) `git fetch && git log origin/main --oneline -15` / `gh pr list` / `gh run list --branch main --workflow=contract-gates.yml --limit 3`로 실제 완료·CI 상태 확인.
(c) `api-surface.md` ↔ `app/src/api`, `state-machine.md` ↔ 런타임 드라이버, `web/src/views` ↔ `rpa_enterprise_console.html` 11뷰, `auth-rbac.md §2` ↔ RBAC 구현·UI 게이팅을 직접 대조해 갭 도출.
(d) OPEN ISSUES 레지스터를 이어받거나(있으면) 새로 만든다. **첫 미확정 이슈부터** 시작.

---

## [미션 — 4대 작업 스트림]

### 1. 전체 코드리뷰
- 범위: `app/`(런타임·API·executor·gateway·pipeline·worker·observability) · `web/`(콘솔) · `codegen/`(D1 산출) · 계약(`schema/`·`db/`·`ts/`·루트 `.md`).
- 축: ① 정확성(버그·경합·CAS·멱등) ② 보안(RLS·RBAC·redaction·secret taint·shell signed registry·prompt-injection) ③ 계약 정합(코드 ↔ SSoT) ④ 불변식 **"조용한 false/unknown 금지"** ⑤ 어휘 체인(abort→cancelled→run.cancelled→"취소됨") ⑥ 단순성/중복/효율(KISS/YAGNI, 500라인) ⑦ 테스트 충분성(단위·통합·e2e·a11y).
- ultracode면 워크플로우로 차원별 병렬 리뷰 → 발견을 **적대적 검증**(독립 다수결 refute)으로 거른 뒤 확정분만 등록.
- 발견은 전부 레지스터에 등록(숨김 금지). 결정적·국소 수정 가능분은 고치고 [확정], 외부/미결정 의존은 BLOCK.

### 2. 역할별 QA
- auth-rbac §2의 5역할(viewer/operator/reviewer/approver/admin) **각 관점**에서:
  - 허용 액션이 실제 동작하는가(read + command).
  - 미허용 액션이 fail-closed(`AUTHZ_FORBIDDEN`/자원특정 코드 `SECRET_ACCESS_DENIED`·`SITE_PROFILE_BLOCKED` 등)로 거부되는가.
  - tenant 경계(RLS)가 cross-tenant 행을 숨기는가(존재 비노출).
- 운영자 여정 QA: 콘솔 뷰의 read + 명령 워크플로우(run create/abort · human-task assign/start/resolve/escalate · DLQ replay(workitem/sink) · scenario validate/promote · site approve · gateway policy edit)를 끝까지 통과.
- 검증은 가능한 한 실행으로: app 통합(temp-PG15 게이트) + web vitest/axe + 실 브라우저 e2e. 재현 불가/외부 스택 의존은 [추정]/BLOCK으로 명시(가짜 통과 금지).

### 3. 어드민 기능 개발
- 어드민 전용 표면을 계약(api-surface·auth-rbac §2 admin 행)에 맞춰 완성. 후보:
  - **gateway policy 편집 UI** — `PUT /v1/gateway/policy` 배선(백엔드는 이미 존재, release-decisions D8-A2).
  - **openGate(Product-open 점검) 뷰** — 정적 contract-doc 뷰(D8-A5).
  - **idempotency 뷰** — read 엔드포인트 결정 후 배선; 미결정이면 BLOCK + Required decision(D8-A5).
  - 그 외 계약에 admin 권한이 있는 명령(site approve·network policy 등)의 UI 배선.
- 새 기능은 **계약에 근거**해야 한다. 계약에 없는 기능은 만들지 않는다(YAGNI). 필요하나 계약 미정이면 BLOCK + Required decision.

### 4. 충실도(fidelity) 통과
- **콘솔 디자인 충실도**: `web/` React 콘솔이 `rpa_enterprise_console.html`을 디자인 토큰·레이아웃·운영자 비기술 한국어 카피·detail/drill-down·상태(로딩/빈/오류)·접근성(focus-visible·aria·포커스트랩·axe 위반 0)·실시간(v1=outbox tail 폴링)까지 충실히 구현했는지 11뷰 대조.
- **계약 충실도**: 구현이 SSoT(상태기계·api-surface·schema·auth-rbac·ops-defaults)를 정확히 반영하는지. 드리프트는 OPEN ISSUE.
- 충실도 갭은 전부 레지스터 등록. 외부/프론트-스트림 의존이면 BLOCK.

---

## [OPEN ISSUES 레지스터 — 형식]
`open-issues.md`(신규) 또는 `release-open-checklist.md`에 표로 유지. 컬럼:
`ID | 영역 | 설명 | 분류([확정]/[추정]/[모름]/BLOCK) | 증거(파일:라인 / 테스트 / CI run URL) | 해결 또는 Required decision·외부 소유자`.
세션 종료 시 레지스터를 반드시 커밋한다(미커밋 손실 방지). 닫힌 이슈도 [확정] 증거와 함께 남긴다(이력).

## [작업 루프 — 이슈별]
1. ground truth로 갭/이슈 도출 → 레지스터 등록(숨김 금지).
2. 결정적·국소 수정 가능분: **실패 테스트 먼저** → 최소 구현(KISS/YAGNI, 기존 구조 우선) → 리팩터 → 로컬 게이트(`node scripts/run-local-gates.mjs`; DB+Chrome 동반 시 `node scripts/db-temp-postgres-gate.mjs --local-gates`; DB 통합은 `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`).
3. 게이트 통과 후에만 커밋 → push → PR → **원격 CI green 재확인** → 머지 → main CI green 재확인 → 이슈 **[확정]**.
4. 외부/미결정 의존: BLOCK + Required decision; 그 BLOCK에 의존하는 후속만 STOP, 비의존 후속은 계속.

## [병렬 codex 공존 — 하드 게이트]
메인 워킹트리는 병렬 codex가 브랜치를 전환하며 빌드·커밋한다. 충돌·손실 방지:
- **모든 빌드는 git worktree에서**: `git fetch origin && git worktree add <경로> -b <branch> origin/main`. 메인 워킹트리 무접촉(브랜치 전환 금지).
- worktree 재사용(증분마다 그 안에서 새 브랜치). 필요한 `npm ci --prefix {app,codegen,web}` 1회.
- 커밋 전 `git -C <wt> status`로 **자기 파일만 path-scoped 스테이징**. `git add -A`/`git add .` 금지.
- 머지 전 `git fetch && git log origin/main`로 최신 확인 + rebase. 머지 후 통합 main CI green 재확인. 메인 워킹트리의 미커밋 변경은 병렬 codex 것이므로 절대 건드리지/커밋하지 않는다.

## [원격 CI 검증 — 신뢰 규율]
- `gh run watch --exit-status`의 exit 0을 믿지 않는다. 항상 `gh run view <id> --json conclusion` == `"success"`로 재확인. push 직후 `gh run list`가 stale run을 줄 수 있으니 `headSha`를 방금 커밋과 대조.
- 머지 후 main run conclusion=success를 확인하고서야 [확정]. **PR green이어도 main run이 flaky failure일 수 있다**(실측: `test:executor` 브라우저 dry-run의 Chrome CDP `ECONNREFUSED`). flaky로 판단되면 `gh run rerun <id> --failed` 후 green 재확인하고 [확정]; 원인 불명이면 OPEN ISSUE([추정])로 남긴다.

## [추측 통제 — 확정/추정/모름]
- **[확정]** 증거(로그/테스트/코드/CI)로 증명 → 해결/수용. **[추정]** 1개 가설만 시도, 실패 시 [모름]으로 강등. **[모름]** 임의 수정 금지.
- 순수 app/web 내부에서 국소화·수정 가능한 결정적 결함만 계속 시도. 같은 게이트가 동일 근본원인으로 **3회 연속 실패**하면 STOP + 보고.
- 계약(SSoT) 미명시 결정(권한 경계·데이터 가시성·기본값·멱등키 구성·UX)은 `release-decisions.md`에 결정/근거/틀렸을 때 영향범위 기재. **검증된 내부 모순일 때만** README 패치로그 규율로 계약을 고친다. 역할 권한·데이터 경계는 `auth-rbac.md §2`가 권위, 없으면 가장 보수적(최소권한).

## [세션 핸드오프]
이후 사람 개입 없이 진행된다. 사용량 한도로 멈추면 새 세션에서 `/resume` 또는 위 [재개 — ground truth]로 이어간다.
세션 종료 전 항상 전역 메모리 MEMORY.md · OPEN ISSUES 레지스터 · release-decisions.md(임의결정) · release-open-checklist.md(미해결)를 갱신하고, 미커밋 작업이 있으면 정확한 `git status` 경로를 메모리/보고에 남긴다(병렬 codex의 add-A·브랜치 전환에 쓸려갈 수 있음).

## [완료 선언]
**OPEN ISSUES가 전부 [확정]** + origin/main Contract Gates green(conclusion=success 재확인) + 모든 BLOCK이 Required decision/외부 소유자로 1:1 추적된 상태 == **"완료"**.
[모름]/[추정]/BLOCK이 하나라도 남으면 완료가 아니라 **"사람 검토 대기(NEEDS HUMAN REVIEW)"** 로 보고하고, 남은 항목·막는 사유·다음 행동을 명시한다. 그 전까지 멈추지 않는다(단 BLOCK·3회 연속 실패·외부 사실 의존은 STOP+보고 규율을 따른다).
