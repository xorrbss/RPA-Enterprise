# DG-3 설계 스펙 — 전용 워커 풀 (Worker Pool Affinity)

> Status: **PROPOSED** (설계 제안). `release-decisions.md` DG-3 의 "재고 조건(net-new spec 필요)"을
> 구체화한다. **이 문서는 설계 제안이며 코드·계약을 바꾸지 않는다.** 구현 착수 전 오너가 §8
> "결정 필요"를 확정해야 한다. file:line 앵커는 작성 시점(main `3e6fc88f`) 기준 — 구현 시 재확인.

## 1. 목적 / 비목적

**목적**: 특정 테넌트(선택적으로 시나리오)의 run 을 **전용 워커**에서만 실행해 격리한다 — 예:
민감 테넌트를 공용 워커에서 분리, 특수 자원(전용 네트워크·고사양) 시나리오를 지정 워커로 라우팅.
현재는 모든 워커가 공유 Graphile 큐에서 무차별 claim 한다(공유 풀 = `release-decisions.md` DG-3
의 의도된 기본 설계).

**비목적**:
- 동시성 *상한*은 이미 자원 단위(credential slot·browser-lease·circuit)로 건다(D5 가 가시화).
  풀은 *격리*이지 *상한*이 아니다 — 둘을 섞지 않는다.
- 워커 오토스케일링·부하분산 = 배포 인프라(범위 밖, DG-2).
- cross-env 라우팅(DG-2)·테넌트 물리 격리(DG-5)와 무관 — 풀은 단일 스택 안의 논리 격리다.

## 2. 현재 구조 (앵커 — 구현 시 재확인)

- **적재**: `app/src/api/run-queue.ts` `PgGraphileRunEnqueuer.enqueueRunClaim()` →
  `graphile_worker.add_job('process_runtime_job', payload := {kind:'run_claim', tenantId, runId, correlationId})`.
  현재 **`queueName`/`flags` 미사용** — 모든 job 이 기본 큐로 간다.
- **claim**: Graphile job → `app/src/worker/runtime-worker-run-drive.ts` `WorkerRunDrive.handleRunClaim()` →
  CAS `UPDATE runs SET status='claimed', worker_id=$w WHERE id=$r AND tenant_id=$t AND status='queued'`
  (`app/src/runtime/run-transition.ts`, event `worker.claimed`).
- **`workers` 테이블** (`db/migration_core_entities.sql`): `id, kind, status, heartbeat_at, circuit_state,
  circuit_until, consecutive_init_failures, half_open_successes, created_at`. **tenant_id·pool 컬럼 없음**,
  BYPASSRLS 인프라 도메인(`auth-rbac.md §4:141`). `runs→workers` FK 없음(논리 참조).
- **워커 부트**: `app/src/main-worker.ts` `run({ taskList, concurrency: GRAPHILE_CONCURRENCY, pollInterval })`,
  단일 task `process_runtime_job`. 워커는 동질적 — 전원이 공유 `graphile_worker.jobs` 큐를 소비.

→ 현재 풀/친화 로직은 **전무**하다. 아래는 기존 메커니즘을 확장하는 비파괴 설계다.

## 3. 설계 (KISS — Graphile 네이티브 flags)

핵심: Graphile Worker 의 **job `flags` + 워커 `forbiddenFlags`** 로 풀 친화를 건다. Graphile 이
**디스패치 단계에서** 워커가 금지한 flag 의 job 을 그 워커에 주지 않는다 → claim CAS·drive·transition
경로 **무변경**, 풀 내부 **병렬성 보존**.

> ⚠ Graphile 의 `queueName` 은 **큐당 직렬 실행**(한 번에 1개)이라 풀 병렬성을 깬다 → **쓰지 않는다.**
> 친화는 `flags`/`forbiddenFlags` 가 정답(병렬 유지 + 라우팅).

### 3.1 풀 키 해석 (enqueue 시점)

run 적재 시 `pool_key` 를 결정해 job flag `pool:<key>` 로 부착한다. 해석 우선순위(상위 없으면 하위):

1. *(선택 확장)* `scenarios.pool_key` — 시나리오 지정.
2. `worker_pool_assignments(tenant_id) → pool_key` — **테넌트 지정(MVP 핵심)**.
3. `'default'` — 미지정.

`createRunInTx` 와 **같은 tx** 에서 해석(추가 round-trip 0). `default` → flag 미부착(= 모든 워커 서비스).

### 3.2 워커 풀 선언 (startup)

워커는 env `WORKER_POOL_KEYS="default,sensitive"` 로 서비스할 풀을 선언하고, Graphile runner 에
**`forbiddenFlags`** 를 주입한다:

- 워커가 선언한 풀 **밖**의 모든 `pool:*` flag 를 forbid → Graphile 이 해당 job 을 그 워커에 디스패치 안 함.
- `forbiddenFlags` 는 함수로 동적 평가 가능(`() => computeForbidden(registry)`) → 풀 레지스트리 변경 대응.
- env 미설정(기본) 워커 = `default` 만 서비스 → **기존 배포 무변경**(모든 기존 run = default).

### 3.3 백워드 호환 (비파괴)

- 마이그레이션 후에도 `pool_key` 미지정 run = `default`, 모든 기존 워커 = default 서비스 → **행동 무변경**.
- 전용 풀은 **opt-in**: `worker_pool_assignments` 행 추가 + 해당 워커에 `WORKER_POOL_KEYS` 설정 시에만 활성.
- 안전장치: 어떤 풀에 배정됐는데 그 풀을 서비스하는 활성 워커가 0이면 run 이 영구 대기 → §7 의 가시화
  (풀별 활성 워커 수)와 적재 시 경고로 **조용한 stuck 방지**("조용한 false 금지").

## 4. 계약 변경 (제안)

- **DDL** (`db/migration_core_entities.sql`):
  - `worker_pools(pool_key text PK, tenant_id uuid NULL, description text, created_at)` — 풀 레지스트리
    (거버넌스 가시화·검증). 인프라 공용 풀이면 `tenant_id` NULL, 테넌트 전용이면 부여.
  - `worker_pool_assignments(tenant_id uuid PK, pool_key text, created_at)` — 테넌트→풀 (MVP). RLS 적용.
  - `runs.pool_key text NULL` — **해석된 값 기록(감사/조회용)**; 라우팅은 flag 가, 이 컬럼은 가시성.
  - *(선택 확장)* `scenarios.pool_key text NULL` — 시나리오 오버라이드.
  - 절차: 매니페스트 2중 동기(`db-static-smoke.mjs` expectedTables + `migration_smoke.sql` 2배열) +
    RLS 루프 + 복합 FK(`worker_pool_assignments.pool_key → worker_pools.pool_key`).
- **ts/**: 워커 job/option 타입에 `poolKeys`(worker 선언), enqueue 의 flags 부착. **state enum 무변경.**
- **RBAC** (`ts/rbac-policy.ts` + `ts/security-middleware-contract.ts`): 신규 `worker_pool.manage`(admin) —
  풀/배정 CRUD. 읽기는 `ops_alert.read` 재사용(D5 동형). web 권한은 `ts/rbac-policy` 직접 import(미러 없음).
- **api-surface.md** + `codegen` openapi: `GET/POST/DELETE /v1/worker-pools`,
  `PUT/DELETE /v1/tenants/{id}/worker-pool`. consistency 게이트 동기.

## 5. 런타임 변경

- `run-queue.ts`: enqueue 전 `resolvePoolKey(tx, tenantId, scenarioId)` →
  `add_job('process_runtime_job', payload := …, flags := array['pool:'||key])` (Graphile `add_job` 의 `flags` 인자).
- `main-worker.ts`: `loadWorkerConfig` 에 `WORKER_POOL_KEYS` →
  `run({ …, forbiddenFlags: computeForbiddenFlags(poolKeys, registry) })`.
- **claim / drive / transition: 무변경**(Graphile 디스패치가 거른다).

## 6. web (콘솔)

- Security(또는 신규 "워커" 운영) 뷰: 풀 목록 + 테넌트 배정 관리(`worker_pool.manage`, ActionButton 재사용) +
  **풀별 활성 워커 수·대기 run 수 가시화**(§3.3 stuck 방지). 무권한 vs 무데이터 구분(Dashboard 패턴).

## 7. 검증

- **실 PG int** (`db-temp-postgres-gate`): 테넌트 A→pool 'sensitive' 배정 후 run 적재 →
  job flag `pool:sensitive` 부착 확인; `forbiddenFlags=['pool:sensitive']` 워커는 claim **안 함**,
  sensitive 워커는 claim; default run 은 양쪽 claim; 풀에 워커 0이면 가시화가 표면화. RLS 격리.
- Graphile flags 디스패치 동작 = `graphile-worker.int` 패턴 확장. **신규 `*.int.ts` 는 `test:int` 배선 필수**
  (`test-wiring-audit`).
- web vitest + console-e2e 목(apiFixture 에 worker-pools 목 추가 — 미스 시 화이트스크린).

## 8. 결정 필요 (DECISION REQUIRED — 오너 확인)

- **DG3-D1 풀 배정 차원**: ✅ **결정 = 테넌트-레벨**(`worker_pool_assignments`, MVP). 시나리오
  오버라이드(`scenarios.pool_key`)는 후속 확장으로 남긴다. [오너 확정 2026-06-26]
- **DG3-D2 기본 풀 의미**: ▶ 권장 미지정=`default`=모든 미선언 워커 서비스(무변경 호환). 확정?
- **DG3-D3 워커 풀 선언 소스**: ▶ 권장 env `WORKER_POOL_KEYS`(배포 설정 — DG-2 env-agnostic 와 일관).
  대안: DB 워커 등록 행. 확정?
- **DG3-D4 stuck 정책**: 풀에 활성 워커 0인 채 적재된 run — ▶ 권장 적재는 허용하되 콘솔에서 loud 가시화 +
  대기 임계 초과 시 ops_alert. 대안: 적재 거부(fail-loud). 확정?

## 9. 추정 규모 / 리스크

- 중간 규모: DDL 3~4 테이블/컬럼 + enqueue/부트 2곳 + RBAC 1액션 + api 2~3엔드포인트 + web 1뷰.
- 리스크 낮음(Graphile 네이티브 메커니즘, claim 경로 무변경). 최대 함정 = §3.3 stuck(가시화로 완화) +
  flags 문자열 컨벤션 일관성. 계약 경계 위반 없음(순수 라우팅 격리).
