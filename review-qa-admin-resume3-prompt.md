# 검토·QA·어드민 미션 — resume3 continuation 프롬프트 (RPA-Enterprise)

> `review-qa-admin-prompt.md`(원본 미션 규율 = 그대로 유효, 먼저 읽어라)의 **이어가기 프롬프트**.
> 코딩 에이전트(autonomous/ultracode)에게 컨텍스트로 주고 "남은 BLOCK을 Required decision/외부 소유자로
> 1:1 추적된 [확정]까지, 가능한 것만 무인 진행"으로 지시한다. **이슈를 숨기지 않는다.**

---

## [진실원천 — 먼저]
- **레지스터 = `C:\project\rpa\open-issues.md`(main, SSoT)**. 카운트·상태는 항상 여기서 최신 재확인(이 프롬프트의 스냅샷은 작성 시점이며 codex가 계속 진행해 **이미 변했을 수 있다**).
- 읽기 순서: `review-qa-admin-prompt.md` → README.md → CLAUDE.md → 레지스터 → `release-decisions.md`(D7/D8) → 전역 메모리 `MEMORY.md`(특히 `open-issues-mission.md`).

## [재개 — ground truth (인메모리 가정 금지)]
1. `git fetch origin && git log origin/main --oneline -12` / `gh pr list` / `gh run list --branch main --workflow=contract-gates.yml --limit 3`.
2. `open-issues.md` 상태 요약 + 각 BLOCK 행 재독. **BLOCK이 풀렸는지 먼저 확인**: 외부 결정(object-store egress 인프라)·codex 증분(loop/fallback·suspend 경로)이 들어왔으면 해당 이슈 재평가.
3. CI는 `gh run view <id> --json conclusion` == `"success"`로 재확인(watch exit 0 불신). 머지 후 최신 main run의 commit이 내 머지≥이고 success인지 확인.

---

## [현재 스냅샷 — 작성 시점 origin/main `54dc28a5` (레지스터로 재확인)]
- resolution: **[확정] 14 · OPEN 0 · BLOCK 3 · 부분 1(RQ-002)** → **NEEDS HUMAN REVIEW**.
- resume2서 8건 [확정](RQ-005·006·007·012·013·014·015·017, PR#49–59) + codex가 RQ-002 부분(PR#57/#60: params·node.status·row_count·extracted_ref 투영, `{rows}` 봉투 규약 운영자 결정).

## [남은 작업 — 4건 (전부 외부 인프라 또는 codex 미구현·기능 의존)]

| 이슈 | 막는 것 | 종류 | 소유자 | in-repo 가능 액션 |
|---|---|---|---|---|
| **RQ-002** 잔여 | `tier`(=fallback_chain 기능)·`cursor.*`/`loop.until`(=loop 기능) 미구현 | feature-gated(계약 결정 끝남) | codex D3 (loop/fallback 증분) | 없음 — 해당 feature 구현 시 동일 투영 패턴(`projectNodeOutput`) 확장 |
| **RQ-010** GET artifacts | 외부 object-store egress(B3) 바인딩(200 body/signed URL) | 외부 인프라 | 배포/인프라 | 없음 — 계약 D8-A1 결정 완료(pending⇒404). egress 생기면 라우트+§5 amend |
| **RQ-011** sink replay | 실 재전달 egress(B3/D6-2) 바인딩 | 외부 인프라 | 배포/인프라 | **△ 라우트 partial-build 가능**(D8-A3): `?kind=sink` 분기 + `sink_dlq.replay` RBAC + `deliverNormalizedRecord` enqueue. egress 전까지 `SINK_DELIVERY_FAILED`(502, loud) — **가짜 202 금지**. 라우트는 [확정] 가능, 실 재전달은 egress BLOCK 잔존 |
| **RQ-016** human_task.created | `ExecutorChallengeSuspensionPort`(suspend/challenge 경로) 미구현 | codex 미구현 코드 | codex executor | 없음 — producer는 human_tasks INSERT와 분리 불가(더미 발행 금지). suspend 경로 구현 시 같은 tenant tx에서 emitOutboxEvent 배선 |

### 우선순위
1. **재확인 우선**: 위 4건 중 BLOCK 해소 신호(외부 egress 인프라 도입 / codex의 loop·fallback·suspend 증분 머지)가 있으면 그 이슈부터 재평가·진행.
2. **선택적 in-repo 진척**: RQ-011 라우트 partial-build(운영자 capability 도달 + fail-honest egress). 진행 시: `ts/control-plane-contract.ts`에 `replaySinkDeadLetter` OperationId, `app/src/api/dlq.ts` `?kind` 분기(default workitem 회귀 보존), int test(operator 202 with test_fake port / viewer 403 / cross-tenant 404 / real-port-unbound→SINK_DELIVERY_FAILED 502 / kind=workitem 회귀). **egress는 BLOCK 유지** → RQ-011 전체는 "라우트 [확정] + egress BLOCK"으로 추적.
3. 그 외 3건은 **외부 인프라 결정/codex 증분 선행** — in-repo로 닫을 수 없음. NEEDS HUMAN REVIEW로 추적.

---

## [하드 규율 — 실측 함정 (원본 프롬프트 + 이번 미션 학습)]
1. **모든 빌드는 git worktree `C:\project\rpa-fl`에서.** 메인 워킹트리 `C:\project\RPA`는 병렬 codex 소유 — **무접촉**(브랜치 전환·커밋 금지). worktree 재사용, 증분마다 `git checkout -B <branch> origin/main`(최신), **path-scoped 스테이징**(`git add <자기파일>`만; `git add -A`/`.` 금지), 머지 전 rebase.
2. **codex 활성 도메인 무접촉/조율.** `app/src/runtime/ir-interpreter.ts`·executor·`app/test/interpreter-*`·`feat/d3-*` 브랜치는 codex가 빠르게 머지. 그 영역 수정은 충돌·중복 위험 → 운영자 권위 결정이 없으면 손대지 말 것. (RQ-002는 운영자가 투영 규약을 결정해 진행됐다 — 계약 권위는 운영자.)
3. **계약(SSoT) 변경 규율**: 검증된 내부 모순일 때만 README 패치로그로. **미정 *기본값·데이터 가시성·UX*는 `release-decisions.md`에 결정·근거·영향범위 기재 후 진행 가능**(예: RQ-017 = ops-defaults에 graph_max_steps 행 추가 + D8-A7, **값 비발명**=기존 가드 추적가능화). 역할 권한·데이터 경계는 `auth-rbac.md §2` 권위, 없으면 최소권한. **값을 발명하지 말 것**(가정 금지) — 모르면 BLOCK + Required decision.
4. **프론트 badge/문구 변경 함정**: web vitest엔 안 잡혀도 `app/test/console-browser.e2e.ts`·`console-live.e2e.ts`(raw status 텍스트 단언)를 깬다. 푸시 전 로컬 e2e로 검증: web 빌드 후 `CHROME_PATH=... npm --prefix app run test:console-e2e` + `PSQL_BIN=... node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:console-live-e2e`.
5. **CDP 플레이키**: app-runtime의 브라우저 단계(test:executor·full-stack pipeline)가 간헐 ECONNREFUSED/timeout으로 깰 수 있음(코드 무관, RQ-001 하든이 런타임 재시도는 추가). main run 실패 시 로그에 그 패턴 있으면 `gh run rerun <id> --failed` 후 green 재확인.
6. 로컬 게이트: `node scripts/run-local-gates.mjs`; DB+Chrome 동반 시 `PSQL_BIN="C:\Program Files\PostgreSQL\15\bin\psql.exe" node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`. 단일 게이트 소스=run-local-gates.mjs(test:ci는 RQ-015로 제거됨).

## [증분 루프]
실패테스트 먼저 → 최소구현(KISS/YAGNI) → 로컬게이트 → path-scoped 커밋 → PR → **CI green 재확인**(`--json conclusion`) → 머지 → **main run success 재확인** → 레지스터 행 [확정] 갱신(추가만, 분류 강등도 기록). 세션 종료 전 레지스터·release-decisions·`MEMORY.md`(`open-issues-mission.md`) 갱신.

## [완료 / 보고]
- **완료 = 전 항목 [확정] + origin/main Contract Gates success**.
- BLOCK/부분/[추정]/[모름]이 하나라도 남으면 **NEEDS HUMAN REVIEW** — 각 항목에 막는 사유(외부 사실/미결정 계약/미구현/재현 불가)와 다음 행동·외부 소유자를 명시.
- 같은 게이트가 동일 근본원인으로 3회 연속 실패하면 STOP + 보고. 외부 사실/미결정 계약 의존은 BLOCK + Required decision로 추적(닫지 않음).
