# MFA / DOM-drive 설계 기록 (2026-06-17)

> "act-유발 challenge(captcha/mfa)를 production에서 감지→suspend→human_task→resolve"까지
> 도달시키는 워크스트림의 설계 기록. 각 단계는 멀티에이전트 워크플로(설계→심사→레드팀)로 도출,
> 적대 검증으로 잠복 결함·계약 갭을 표면화했다. 모든 근거는 `file:line`. 실제 감지 휴리스틱과
> deploy-time 값은 `TODO:[BLOCKED]`로 격리(발명 금지).

## 작업 체인 한눈에

| 단계 | 내용 | 상태 |
|---|---|---|
| ②③ | MFA 신호 배관 — `StepResult.challenge` 운반 + 인터프리터 매핑 | ✅ 구현·커밋 (`7ef31a2`, 브랜치 `fl/mfa-challenge-signal`) |
| ① | `ChallengeDetector` seam | 📐 설계 확정 (감지 휴리스틱 RQ-016/codex BLOCKED) |
| 배선0 (PR-B0) | `StagehandDomExecutor`를 production drive에 합류 | 📐 설계 확정 |
| Gap1 | `promptTemplateVersion` 출처 | ✅ 코드 상수 확정 (계약 무변경) |
| Gap2 | run의 model 선택 출처 | ✅ B+C 확정 (오너 결정 2026-06-17) |
| 선존 결함 | `driveClaimedRun` 죽은 abortSignal | 🔍 식별 (별도 PR) |

**구현 의존 순서**: Gap2 계약변경(`runs.model`+`is_default`) → PR-B0(dom drive 합류) → ①(detect seam) / deploy-PR(gateway 조립).

---

## Part 1 — ②③ MFA 신호 배관 (구현 완료)

**문제**: 인터프리터가 `status==='suspended'`를 무조건 `challengeKind:"captcha"`로 하드코딩 → 실제 mfa도 `resolve.captcha` RBAC로 오라우팅되던 잠복 결함. 또한 executor의 감지 종류를 인터프리터로 운반할 통로 부재.

**변경** (commit `7ef31a2`):
- `ts/core-types.ts`: `StepResult.challenge?: ChallengeSummary` 추가. 인터프리터는 `pageStateAfter`(ref)만 쥐어 `PageState.challenge`를 못 읽으므로, 감지한 executor가 step 출력에 echo. 이것이 `challengeKind(captcha|mfa)→human_task kind→resolve.<kind>` RBAC의 유일한 상류 신호.
- `ir-interpreter.ts:201`: `res.challenge.type`에서 `challengeKind` 유도. captcha|mfa 아니면 `EXECUTOR_STATUS_UNSUPPORTED` throw(조용한 captcha 폴백 제거).
- `stagehand-dom-executor.ts:72`: `classify()` 위에 `TODO:[BLOCKED]`(① 표면화).
- `interpreter-suspend.unit.ts`: captcha/mfa + 무효 challenge throw 케이스.

**하류 무수정 확인**: `transitions.ts:75 humanTaskKind: ev.challengeKind` → `PgChallengeSuspensionPort` INSERT → `human-tasks.ts:127 resolve.mfa`. 전 구간 `"captcha"|"mfa"` 허용.

---

## Part 2 — ① ChallengeDetector seam (설계 확정, 감지 본체 BLOCKED)

**채택**: executor 경계 1점 — `StagehandDomExecutor`에 옵셔널 주입 함수 + 모듈 헬퍼. 신규 파일·포트·타입 0.

```ts
type ChallengeDetect = (session: CdpSession, ctx: RunContext) => Promise<ChallengeSummary | undefined>;
// 생성자 5번째 옵셔널 인자 detect? (기존 cache? 선례 확장). 미주입 → detect 미호출(회귀0).
// 호출점: executeAct applyPlan 직후 / executeReadOnly gateway 응답 직후 — 같은 step 라이브 세션.
function dispositionOf(type: ChallengeSummary["type"]): "suspend" | "failed_challenge" {
  return type === "captcha" || type === "mfa" ? "suspend" : "failed_challenge";  // 그 외 6종 → failed_challenge
}
```

**resolver-채움 기각**: resolver는 노드 진입 1회만 호출 → act-유발 challenge를 같은 step에 못 담음(1-step 지연으로 엉뚱한 step suspend). `PageState.challenge?` 필드는 선언만 보존.

**8종 → disposition**: captcha/mfa → suspend(human_task), 나머지(block_page/rate_limit/login_loop/access_denied/session_expired/unknown) → failed_challenge(자동복구/circuit은 @challenge 소관).

### 레드팀이 표면화한 추가 결함 (BLOCKED 격리)
- **P1-A** act-suspend의 `sideEffect.kind`를 `read_only`로 박으면 거짓(applyPlan이 이미 mutation) → `update`로 정직화.
- **P1-B** resume 구조적 깨짐: `SuspendContext.pageStateRef = pageStateAfter = before`(challenge 이전 snapshot) → resume 검증 항상 불일치. post-act PageState 캡처 인프라 부재 → BLOCKED.
- **P1-C** @challenge 자동복구 래더 우회: production driveSuspend가 `session_refresh→retry→network_retry` 3 자동복구를 생략하고 바로 suspend → `reserved-handlers.md:64` 순차성 **계약 미준수가 production**(은폐 금지로 정직 기술).
- **P2** `challenge.detected` 이벤트 producer 부재 + block_page→failed_challenge 강등 시 차단율 미집계 → `SITE_CIRCUIT_OPEN` 무력화.

### BLOCKED 경계 (codex/RQ-016)
실제 판정 휴리스틱(어느 dom/network/screenshot/vlm 신호로 captcha vs mfa) 미정. 가용 신호=dom 단일(network/screenshot/vlm 수집 인프라 0). confidence 임계값 ops-defaults §7 부재. → `detect?` 미주입(회귀0), codex가 RQ-016 해소 후 구현체 주입.

---

## Part 3 — 배선0 (PR-B0): StagehandDomExecutor를 production drive에 합류

**문제**: production drive(`run-claim-runner.ts:126`)가 `new UtilityExecutor(...)` 단독 → dom(act) step이 `EXECUTOR_CAPABILITY_MISMATCH` throw. dom은 production에서 영원히 실행 불가 = ① detect seam의 도달성 선결.

**핵심**: 라우팅은 이미 `CompositeExecutor`(`composite-executor.ts:14-31`, act/observe/extract→dom·그 외→utility)가 해결. 배선0의 실제 과제는 **StagehandDomExecutor 생성의 의존 캐스케이드 + gateway 부재 시 fail-closed**.

```ts
// run-claim-runner.ts Phase B (:125-141 교체)
const gatewayCaller = gateLlmGatewayProvider(this.options.llmGatewayProvider, this.options.allowTestLlmGatewayProvider === true);
let executor: ExecutorPlugin = utility;                       // 미주입 → utility 단독(현행 바이트 동일, 회귀0)
if (gatewayCaller !== undefined) {
  const domCfg = await this.loadDomExecutorConfig(tenantId, d);  // §4
  const dom = new StagehandDomExecutor(gatewayCaller, bound.provider, domCfg, new PgActionPlanCache(this.pool));
  executor = new CompositeExecutor(dom, utility);             // detect(①)는 5번째 인자 — B0 미주입
}
```

- **주입 포트**: `PgRuntimeWorkerOptions.llmGatewayProvider` + `allowTestLlmGatewayProvider` (신규 `app/src/executor/llm-gateway-provider.ts`) — `browserSessionProvider` 게이트 동형. `binding.kind`로 test_fake 차단(`instanceof` 금지 — 래핑 caller 오분류로 게이트 자신이 조용한 false 유발).
- **fail-closed**: gateway 미주입 × dom 노드 → utility의 `EXECUTOR_CAPABILITY_MISMATCH` loud throw. dom stub 주입안은 편법·더미 금지 + 거짓 capability 보고로 기각.
- `driveClaimedRun`/`DriveDeps` 무변경(executor 1개) → 저결합 유지.

### BLOCKED / 선존 결함
- **deploy-time**: production `LlmGateway` 조립 부재(`app/src`에 `new LlmGateway` 0건, validator/redaction app-side 0건). `CODEX_BASE_URL`(checklist line50)·API키(line48) = owner 배포. 코드는 주입점만.
- **선존 결함**: `driveClaimedRun`이 죽은 `new AbortController().signal`(`run-step-driver.ts:98`) 하드와이어 → `run_abort`가 in-flight LLM 호출을 못 끊음. dom 합류로 노출면 증가 → 별도 abort-배선 PR.

---

## Part 4 — Gap1: promptTemplateVersion = executor 코드 상수 (계약 무변경)

`buildRequest`(`stagehand-dom-executor.ts:295-298`)가 프롬프트 메시지를 **코드 인라인**으로 빌드 → `promptTemplateVersion`은 그 코드의 버전(캐시 무효화용 `action_plan_cache` 키 컬럼).

```ts
// stagehand-dom-executor.ts — buildRequest 옆
export const DOM_PROMPT_TEMPLATE_VERSION = "dom@1";
```
- `StagehandDomExecutorConfig.promptTemplateVersion: string` 필드 **유지**(테스트/PoC가 자체 문자열로 캐시 키 격리). run-claim-runner가 이 상수를 주입.
- **ts/·md/·sql 무변경, README 등재 불필요** — 계약 결함이 아니라 구현 선택. (이전 워크플로의 "gateway_policies 컬럼 필요"는 tenant 정책과 혼동한 과판정으로 철회.)

---

## Part 5 — Gap2: run의 model 선택 출처 = B+C (오너 결정 2026-06-17)

**갭**: 테넌트가 `gateway_policies` 다수 행을 가질 때 자동 run이 어느 model로 시작하는지 계약 부재(`runs`/`scenario_versions`/`ir.meta` 모두 model 출처 없음, `gateway_policies` primary/default 플래그 없음). "조용한 임의선택 금지" 규율상 silent 임의선택만이 유일 비차단 경로였던 모순.

**확정안 (B+C 하이브리드)**: model은 run-create 시 `runs.model`로 **1회 동결**(`as_of` 동형). 명시 run은 param, 무인 run은 테넌트 default로 해소.

### 계약 변경 체크리스트
**DDL** (`db/migration_core_entities.sql`, core):
- `runs.model text` (nullable) — `as_of` 인접. NULL=utility-only 또는 미해소(LLM 노드 도달 시 fail-closed).
- `gateway_policies.is_default boolean NOT NULL DEFAULT false` + 부분 UNIQUE `ON gateway_policies(tenant_id) WHERE is_default` (테넌트당 ≤1, `uq_scenario_versions_prod` 선례 동형).
- FK 금지(자연키 복합 `(tenant_id,model)` + 정책 삭제 시 재현성 파괴) → 느슨한 text 스냅샷, 부재는 run-time loud.

**API**:
- `POST /v1/runs`(`server.ts:264`): body 화이트리스트에 optional `model`. tx 내 해소 — 명시→`(tenant,model)` 존재확인 / 미지정→`is_default` 또는 단일정책 1행 / 다정책+미지정+default없음→loud 거부.
- `PUT /v1/gateway/policy`(`gateway.ts`): `is_default` 토글 + 기존 default 해제를 같은 CAS tx 선행. RBAC `gateway_policy.edit`(admin) 그대로 — 신규 권한 불필요.
- `ir.schema.json` **무변경**(model은 IR 밖 런타임 링크 — v2.10 결정 정합).

**코드**: `loadRunDriveInputs` SELECT에 `model` → `driveClaimedRun` → `StagehandDomExecutorConfig.model = inputs.model`. capability 정적대조(IR primitive→required caps)를 createRun tx + run-time `SafeCapabilityGate`(무변경)의 2층 방어.

### 소결정 (KISS 기본값)
- 단일정책 테넌트: 1행 자동해소. 다정책만 명시/default 강제.
- ErrorCode: 신규 `MODEL_UNRESOLVED` 도입 안 함 → 기존 `LLM_CAPABILITY_MISMATCH`/`RESOURCE_NOT_FOUND` 재사용(closed registry).
- backfill: 과거 run `model` NULL(무영향). 다정책 테넌트 무인 run은 admin이 `is_default` 지정 전까지 loud 거부.

### 레드팀 정정
jsonMode=false는 deny가 아니라 prompt-schema 폴백(`capability-gate.ts:46`)이라 save-time 사전검증 실효는 vision/domReasoning 2개뿐. run-time 게이트는 어댑터 실제 caps로 평가하므로 어느 안이든 제거 불가.

---

## Part 6 — 구현 PR 분해 & 의존 순서

```
[contract] Gap2 (runs.model + gateway_policies.is_default + POST/PUT API + capability 대조)   ← dom 실구성 선결
     ↓
PR-B0 (gateway 주입점·게이트·CompositeExecutor 합류·browserIdentityVersion 적재·fail-closed
        + DOM_PROMPT_TEMPLATE_VERSION 상수 + runs.model→cfg.model 주입)                        ← detect 도달성 선결
     ├─► ① detect seam (StagehandDomExecutor 5번째 인자 detect? + ChallengeDetector) — RQ-016/codex 해소 후
     ├─► PR-deploy: owner가 CODEX_BASE_URL/API키 + validator/redaction으로 LlmGateway 조립 주입
     └─► PR-abort: driveClaimedRun 죽은 abortSignal 배선 (선존 결함, 분리)
```

- **즉시 닫을 수 있음**: Gap1 상수, PR-B0의 옵션필드+게이트+fail-closed+회귀0 테스트(T2/T3/T4/T7).
- **종속**: dom executor 실구성(Gap2 계약변경 머지 후), ①(RQ-016), deploy-PR(owner).

---

## Part 7 — 식별된 잔여 결함 / BLOCKED 요약

| 항목 | 종류 | 위치 |
|---|---|---|
| ① 감지 휴리스틱(captcha vs mfa 신호) | BLOCKED/codex | `stagehand-dom-executor.ts:72` TODO |
| network/screenshot/vlm 신호 인프라 부재 | BLOCKED | 가용=dom 단일 |
| resume pageStateRef 불일치(captcha 해소 후 복귀 깨짐) | BLOCKED | `ir-interpreter.ts:217` / post-act PageState 인프라 |
| @challenge 자동복구 래더 우회(계약 미준수가 production) | 계약 drift | `run-step-driver.ts:137` vs `reserved-handlers.md:64` |
| challenge.detected producer 부재 + circuit 무력화 | 배선 | driveSuspend / circuit 집계 주체 |
| production LlmGateway 조립 + CODEX_BASE_URL/API키 | deploy-time | checklist line48/50 |
| driveClaimedRun 죽은 abortSignal | 선존 결함 | `run-step-driver.ts:98` |
| RunResumeRunner codec.verify 미사용(HMAC 미검증) | 갭 | `run-resume-runner.ts:70` |
