# Deferred 설계 결정 패킷 — 워커풀 격리 · artifact at-rest 하드닝 (2026-07-11)

> ⚠ **이 문서는 결정 요청이지 구현 승인·계약 변경이 아니다.** 두 건은 적대 감사에서
> "오너 조율 필요"로 deferred 된 **설계 이슈**다. 여기서는 현황을 file:line 으로 실측하고,
> 옵션·트레이드오프·권고·오너가 답해야 할 결정 질문만 정리한다. **코드·계약(DDL/ts/·루트 .md)은
> 바꾸지 않는다.** 오너가 아래 결정 질문을 확정한 뒤라야 후속 설계 스펙(예: `dg3-worker-pools-spec.md`
> 형식)→구현으로 진행한다.
>
> - file:line 앵커는 작성 시점 main `1d360e65` 기준 — 착수 시 재확인.
> - **확정 사실**(코드에서 직접 확인)과 **미확인/범위 밖**을 각 절에서 분리 표기한다.
> - 출처: §1 = DG 거버넌스 적대 감사 #373(deferred 워커풀 격리 클러스터), §2 = artifact-lifecycle
>   적대 감사 #270(deferred at-rest 하드닝). 두 감사 모두 "누출은 데이터 breach 아님, 인프라/at-rest
>   수준"으로 P2/P1 latent 분류했다(§1.1·§2.1 원문 인용).

---

## §1 — 워커풀 테넌트 격리

### 1.1 배경 / 감사 원 지적 (원문 인용)

DG 거버넌스 감사(#373, 12/12 confirmed)의 headline P1(redaction legal_hold 가드)은 이미 머지됐고,
**워커풀 격리 클러스터**(C2/C4/C6/C7/C9/C10/C11/C12)는 "설계 이슈"로 deferred 됐다. PR #373 본문 원문:

> 워커풀 격리 클러스터(C2/C4/C6/C7/C9/C10/C11/C12): worker_pools 전역/무소유 → tenant admin이 타
> 테넌트 전용 풀 라우팅/삭제/열거. **설계 이슈**(ownership 모델 or platform-admin 제한 필요)로 최근
> 병렬세션 신규 feature → 단독 재설계 대신 owner 조율 필요.

`release-decisions.md:1093-1104`(DG-3)는 공유 풀을 by-design 으로 확정하되 재고 조건을 남겼다:

> 재고 조건(별도 spec 필요): 전용 워커 풀이 실제 요구가 되면(민감 테넌트 격리·특수 시나리오 라우팅)
> `worker_pools`+claim-time 필터+RBAC+web 의 versioned 기능으로 설계하되, 오너가 친화 차원
> (테넌트/사이트/시나리오)·예약 모델을 먼저 결정. Owner = project owner.

그 후 전용 풀 기능이 **실제로 빌드**됐다(`df2a8ec1` DG-3 backend, `9a75e8b1` web, `f9f0976f` stuck
가시화 #374). 감사가 지적한 격리 갭은 이 구현체에 대한 것이다.

### 1.2 확정 사실 — 현재 구조 (file:line)

**데이터 모델** — `db/migration_core_entities.sql`

| 테이블 | 라인 | tenant_id | RLS |
|---|---|---|---|
| `worker_pools` (풀 레지스트리) | L298-310 | **없음** | **제외** (L294 주석 "인프라 도메인(tenant_id 없음, workers 처럼 RLS 제외)") |
| `worker_pool_assignments` (테넌트→풀) | L314-318 | PK | **적용** (RLS 루프 배열 L2580, 정책 L2584-2588) |
| `worker_pool_memberships` (워커→풀) | L322-328 | 없음 | **제외** |

- `worker_pools` PK=`pool_key`(L299), 상태 `active/draining/disabled`(L302-303). 소유 테넌트 컬럼 없음.
- `worker_pool_assignments.pool_key → worker_pools(pool_key)` FK 는 **ON DELETE RESTRICT**(L316, 절 생략).
- `runs.pool_key` 컬럼은 **존재하지 않는다** — 라우팅은 Graphile job flag `pool:<key>` 로만 하고 runs 행에
  영속하지 않는다(스펙 `docs/dg3-worker-pools-spec.md:78` 의 `runs.pool_key` 제안은 미채택).

**API** — `app/src/api/worker-pools.ts` (전 엔드포인트 단일 게이트 `worker_pool.manage`)

| 엔드포인트 | 라인 | 테넌트 스코프 |
|---|---|---|
| GET `/v1/worker-pools` | L66 | 풀 목록 `FROM worker_pools`(L70-72) **필터 없음** = 전 테넌트 공통. 배정/pending 만 tenant tx |
| POST `/v1/worker-pools` | L98 | `INSERT … ON CONFLICT (pool_key) DO UPDATE`(L111-121) = 전역 생성/**덮어쓰기** |
| PATCH `/v1/worker-pools/:poolKey` | L136 | `UPDATE … WHERE pool_key=$1`(L362-367) = pool_key 만으로 수정 |
| DELETE `/v1/worker-pools/:poolKey` | L162 | `DELETE … WHERE pool_key=$1`(L169), 배정 참조 시 FK 로만 차단(L172-173) |
| PUT `/v1/worker-pool` (self-assign) | L184 | tenant_id=인증 컨텍스트, body=`pool_key` 만(L193-195) |

- **RBAC**: `worker_pool.manage` 는 `ts/rbac-policy.ts:196`(admin 전용) + `ALL_RBAC_ACTIONS`(L297) 정의.
  role 은 tenant 내부 5종뿐(`ts/security-middleware-contract.ts:37`) — **platform-admin/시스템 테넌트 개념
  부재**. `api-surface.md:232-238` 은 문서화하나 `auth-rbac.md §2 권한 매트릭스에는 미등재`(감사 C5 doc-sync).
- **런타임 배선**: 배정 해석 `run-queue.ts:113-145`(`enqueueDrivingJobWithPoolFlag`, 미배정→`default` L127),
  워커 선언 `WORKER_POOL_KEYS`(`config/env-worker.ts:75-78`)→`buildPoolForbiddenFlags`(`main-worker.ts:323`).
- **stuck 가시화(#374)**: GET 응답 `pending{queued_runs,oldest_queued_at}`(`worker-pools.ts:79-92`, 호출
  테넌트 스코프) + web `WorkerPoolPanel.tsx` amber 힌트(STUCK 임계 5분).

### 1.3 확정 사실 — 격리 미결 지점 (감사 지적의 실체, 코드 재확인)

1. **전역 열거(C6)**: GET 의 `worker_pools` SELECT 에 tenant 필터·RLS 없음(`worker-pools.ts:70-72`) →
   모든 admin 이 전 테넌트 풀 목록을 본다.
2. **self-assign into 타 테넌트 풀(C2)**: PUT `/v1/worker-pool` 은 존재하는 풀이면(FK 통과) 어떤 풀에든
   자기 테넌트를 배정. **int 테스트가 실증**: `app/test/api-worker-pools.int.ts:263-265` — TENANT_A 가
   만든 풀 `pb` 에 TENANT_B admin 이 배정 → `200`("tenant B assign → 200").
3. **cross-tenant 덮어쓰기(C10)**: POST 의 `ON CONFLICT DO UPDATE`(`worker-pools.ts:111-121`) 로 타
   테넌트가 만든 풀의 status/max_concurrency/priority/description 을 덮어쓴다.
4. **cross-tenant 상태변경 → 피해 테넌트 run 정지(C7 계열, 교차 DoS)**: 타 테넌트 admin 이 PATCH 로 풀을
   `disabled/draining` 전환하면, 그 풀에 배정된 피해 테넌트의 enqueue 가 실패 —
   `run-queue.ts:132-138` `if (row.status !== "active") throw WORKITEM_CHECKOUT_CONFLICT{reason:"worker_pool_unavailable"}`.
5. **임의 풀 삭제(C4)**: DELETE 는 배정이 없으면(FK 미참조) 임의 admin 이 삭제. 배정 참조 시에만 409 차단.
6. **queued job 의 pool flag 고아(C4 계열)**: 풀 삭제/unassign 시 **이미 enqueue 된** run_claim/run_resume
   job 의 `pool:<key>` flag 를 정리하는 로직 없음(`worker-pools.ts` DELETE L162-182 어디에도 없음, runs 에
   pool_key 컬럼도 없어 갱신 대상 부재). 완화는 fail-open(레지스트리에서 사라진 풀은 forbidden 집합에서
   빠져 default 워커가 집음 — 영구 stuck 은 아니나 격리 상실).
7. **낙관적 락 부재(C11/C12 lost-update)**: PATCH 에 If-Match/version 없음 → 동시 수정 last-writer-wins.
   유일한 제어는 `Idempotency-Key` + DB upsert(`worker-pools.ts` 전반, `api/command.ts`).

### 1.4 미확인 / 범위 밖 (확정 아님)

- **데이터 breach 아님(중요)**: 위는 전부 **라우팅 제어면** 이슈다. run 페이로드·artifact 등 실 데이터는
  여전히 RLS 스코프이며 워커풀 조작으로 타 테넌트 데이터가 노출되지 않는다(감사도 "P2 인프라격리, 데이터
  breach 아님"으로 분류). 영향은 (a) 격리 무력화, (b) 교차 DoS, (c) 거버넌스 가시성 오염.
- **실배포의 admin 분포는 미확인**: `worker_pool.manage` 는 admin 전용이다. 실 운영에서 admin 이 곧
  단일 플랫폼 운영자(단일 조직)라면 위 표면은 사실상 무해하고, 각 고객사가 자기 admin 을 갖는
  멀티테넌트 SaaS 라면 실질 위험이다. **이 구분이 옵션 선택을 좌우** → 오너 결정 질문 Q1.
- physical 워커 오토스케일링·부하분산은 배포 인프라(DG-2/DG-5) 범위 밖.

### 1.5 옵션

**옵션 1A — 현상 유지 + 보상 통제 (RBAC/write 경계 하드닝)**
풀 write(POST/PATCH/DELETE/멤버십)를 tenant admin 이 아니라 **플랫폼 운영 경계**로 제한한다. 구현 형태
후보: (i) 신규 `platform_admin` 성격 role/claim 도입 후 풀 write 를 거기에만 부여, 또는 (ii) 풀 write 를
유지보수 경계(`MAINTENANCE_TENANT_IDS` 류, 이미 존재하는 cross-tenant 인프라 경로)로만 허용, self-assign
(PUT `/v1/worker-pool`)만 tenant admin 유지.
- 비용: **낮음~중간**. 데이터 모델 무변경. RBAC/미들웨어 + 라우트 가드 + web `useCan` 조정.
- 보안 이득: cross-tenant 덮어쓰기·삭제·상태변경(DoS) 표면 제거. 열거는 여전히 전역이나 write 불가라 무해화.
- 마이그레이션 영향: 없음(role/claim 레이어만). 기존 배정/멤버십 보존.
- 한계: "각 테넌트가 자기 전용 풀을 셀프서비스로 생성"하는 모델은 포기(플랫폼이 대행).

**옵션 1B — 논리 격리 강화 (풀 소유권 모델)**
`worker_pools` 에 `owner_tenant_id uuid NULL`(NULL=공용 인프라 풀) 추가. GET 은 `owner_tenant_id IS NULL
OR owner_tenant_id = current tenant` 로 필터, POST/PATCH/DELETE/PUT(assign)은 소유 검사. 멤버십도 소유 풀
한정.
- 비용: **중간**. DDL 1컬럼+백필(기존 풀=공용 NULL) + 5개 핸들러 소유 가드 + int/web 테스트 + api-surface/
  스펙 동기. `worker_pools` 는 여전히 RLS 비대상(전역 조회를 owner 필터로 대신 — workers 인프라 도메인 일관성 유지).
- 보안 이득: 테넌트 전용 풀의 **진짜 논리 격리**. 셀프서비스 유지(각 테넌트가 자기 풀 CRUD).
- 마이그레이션 영향: `worker_pools` ALTER + 백필, FK/매니페스트 2중 동기(`db-static-smoke`+`migration_smoke`).
  공용 풀(NULL) 개념으로 하위호환.
- 한계: 여전히 단일 스택 논리 격리(물리 분리 아님). owner NULL 공용 풀 write 권한은 별도 결정 필요.

**옵션 1C — 물리 풀 분리 (배포 인프라)**
테넌트(등급)별 별도 워커 배포 + 전용 큐. 최고 수준 격리(민감 테넌트 물리 분리).
- 비용: **높음**. 배포 파이프라인·인프라 영역(레포 밖, DG-5 물리 테넌시와 연결). 앱은 `WORKER_POOL_KEYS`
  선언으로 이미 부분 지원하나, 큐 분리·프로비저닝은 운영.
- 보안 이득: 최고(프로세스/네트워크 경계까지). 규제·계약상 물리 격리 요구에 부합.
- 마이그레이션 영향: 운영 모델 전환. 코드 변경 최소, 배포 복잡도 최대.

### 1.6 권고

**1A(보상 통제)를 기본선으로 즉시 검토, 셀프서비스 요구가 확인되면 1B로 승격.** 근거:
- 감사가 데이터 breach 가 아니라 인프라 격리로 분류했고 run 데이터는 RLS 로 보호된다 → P0 긴급성 아님.
- 실질 위험도는 "멀티테넌트 admin 분포"(Q1)에 전적으로 의존하며, 이는 코드가 아니라 운영 모델 결정이다.
  단일 조직 운영이면 1A 로 write 경계만 조이면 충분(YAGNI). 고객사별 admin 이면 1B 소유권 모델이 정답.
- 1C 는 물리 격리라는 별도 요구가 확정될 때만(DG-5 트랙) 검토 — 현 클러스터 해소에는 과대.

### 1.7 오너 결정 질문 (§1)

- **Q1-1 (선결)**: 실배포에서 `admin`(=`worker_pool.manage` 보유)은 **단일 플랫폼 운영자**인가, **각
  테넌트/고객사별 admin**인가? (이 답이 1A vs 1B 를 가른다.)
- **Q1-2**: 전용 풀은 **플랫폼이 대행 생성**(1A)인가 **테넌트 셀프서비스**(1B 소유권 모델)인가?
- **Q1-3**: 공용(owner NULL) 인프라 풀에 대한 write 권한은 누구에게? (1B 채택 시)
- **Q1-4**: 물리 격리(1C)를 요구하는 민감 테넌트/규제 요건이 지금 존재하는가, 아니면 논리 격리로 충분한가?
- **Q1-5**: 부수 doc-sync — `auth-rbac.md §2` 에 `worker_pool.manage` 등재(감사 C5)를 이 트랙에 포함할까,
  별도 문서 PR 로 분리할까? (구현 아닌 문서 정합)

---

## §2 — artifact at-rest 하드닝

### 2.1 배경 / 감사 원 지적 (원문 인용)

artifact-lifecycle 감사(#270, 17→8 confirmed)에서 redaction 출력 정확성 2건은 머지됐고, **at-rest 하드닝
클러스터**는 deferred 후 대부분 후속 처리됐다. `release-decisions.md` 원문:

> AUD-9. Redacted-at-rest violation … **Not API-reachable** — the read route (`reads-artifacts.ts`) serves
> the swapped redacted `object_ref` behind RLS; leak surface is object-store at-rest / backup / forensic.
> (`release-decisions.md:816,829`)

deferred 클러스터 3건은 **모두 후속 머지**됐다(AUD-9 원본삭제 #272, AUD-10 integrity #276·orphan #278,
AUD-11 legal_hold TOCTOU #275 — `release-decisions.md:816,837,863` 전부 "✅ RESOLVED"). **그러나 이들은
전부 "누출면=object-store at-rest 수준"을 전제로 라이프사이클 위생(원본 GC·무결성·고아)만 다뤘고, at-rest
자체의 기밀성(=object 바이트 평문 저장)은 손대지 않았다.** 즉 감사가 반복 지적한 "leak surface is
object-store at-rest / backup / forensic" 의 **근본(평문 저장)은 미해결**로 남아 이 결정 패킷의 대상이다.

### 2.2 확정 사실 — 현재 구조 (file:line)

**object 바이트는 Fs/S3 양쪽 평문 저장 (암호화·SSE 없음)**
- FsObjectStore: `app/src/gateway/pg-gateway-artifact-sink.ts:64` `writeFileSync(path, content)`(putBytes,
  raw 그대로), L58 utf8. crypto 사용은 sha256 메타 1건뿐(L133).
- S3ObjectStore: `app/src/artifacts/s3-object-store.ts:139-140` 바이트 그대로 PUT. 서명 헤더는 SigV4 4종
  (`signRequest` L311-316)뿐 — **`x-amz-server-side-encryption` 부재**(app/src 전역 grep 0건). crypto 는
  SigV4 전용(L19,387-399).
- artifacts DDL(`db/migration_core_entities.sql:1475-1530`)에 암호화 컬럼(`enc_kid`/`ciphertext`) **없음**.
  대조적으로 `browser_sessions` 만 ciphertext/enc_kid 보유.

**세션 캡처 봉투암호화 선례 (재사용 후보의 근거)** — `app/src/runtime/browser-session-store.ts`
- `KmsEnvelopeSessionEncryptor` L123-207: per-message DEK(L146) → KEK 로 wrap(L147) → 본문 DEK 암호화
  (L148), 저장 포맷 `[version | wrappedDek | body]`(L150). AES-256-GCM(L93,188).
- `AesGcmSessionEncryptor` L77-112(단일키) — **프로덕션 wiring 은 이쪽**(`main-worker.ts:139,221`).
  `KmsEnvelopeSessionEncryptor`/`buildKmsSessionEncryptor` 는 정의·export 만 되고 배선 미등장(선례 구현체).
- KEK 원천 = `SecretStore.resolve(kekRef)`(L243,257) — 라이브 KMS 호출이 아닌 Vault ref 해소.
- AAD 는 `setAAD()` API 가 아니라 **ctx 평문 삽입 + GCM 태그 인증**(`sessionContextTag` L42-44:
  `bsession:v1|tenantId|siteProfileId|browserIdentityId|identityKey`, save L322 / load L311 대조).
- fail-closed: prod 에서 평문 세션 암호화기는 `allowDevPlaintext` 없이 throw(L287-291).

**라이프사이클 (전부 구현 완료 — 위치 확인)**
- redaction 원본 삭제: `app/src/worker/artifact-redaction-processor.ts:133-150`(finalize 커밋 후 `delete`).
- retention 단일 tx FOR UPDATE: `app/src/worker/artifact-retention-processor.ts:241-259`(`legal_hold=false`
  재검사 L251 + `FOR UPDATE` L255).
- integrity→quarantine: `app/src/worker/artifact-integrity-processor.ts:111-143`(sha256 대조→`quarantine=true`).
- orphan 전역 차집합: `app/src/worker/artifact-orphan-processor.ts:106-133`(BYPASSRLS 자기검증 L115).
- **`artifacts.legal_hold=true` in-product 라이터 없음**: app/src 의 `UPDATE artifacts` 전수(quarantine·
  redaction claim/finalize·retention·offboarding-purge)가 어느 것도 `legal_hold` 를 SET 하지 않는다.
  offboarding(`tenant-offboarding-purge.ts:158`)은 `legal_hold=false` 를 **읽어 제외**만 한다 → 운영자 직접
  DB 쓰기 전제(AUD-11 latent 근거 유지).

**read 경계 (누출면 판정 근거)** — `app/src/api/reads-artifacts.ts`
- RLS `artifacts_visible_isolation` 가 redacted/not_required·미삭제·비격리만 노출, 나머지는 404(L61-63).
- disclosure 직전 `securityAudit.recordDecision(artifact.read, allow, failClosed:true)`(L105-129 등).
- → **read API 는 redacted 서빙**이므로 평문 누출면은 API 가 아니라 **object-store 매체/백업/포렌식**.

### 2.3 확정 사실 — at-rest 갭

- **핵심 갭**: artifact object 바이트(병합 추출·gateway LLM 출력·스크린샷/비디오·DOM 추출·시나리오 생성)가
  Fs/S3 에 **평문**으로 놓인다. redaction 이 PII/자격증명을 마스킹하지만, (a) redaction **전** pending 원본,
  (b) redaction 대상이 아닌 not_required 산출물, (c) redacted 산출물 자체도 매체·백업 레벨에서는 평문 바이트다.
- **세션 대비 비대칭**: 세션 쿠키는 prod 평문 저장이 코드로 금지(fail-closed)인데, artifact 는 동급 민감도
  (자격증명 임베드 가능)임에도 매체 평문 저장이 허용된다.

### 2.4 미확인 / 범위 밖 (확정 아님)

- **계약은 침묵**: `security-contracts.md`(키 커스터디만 L15,30,85), `impl-contracts-bundle.md`(encrypt/aes/kms
  매치 0), `ops-defaults.md`(L37 "encryption key" 는 heartbeat 의존성 목록일 뿐) — 세 계약 어디도 artifact
  object at-rest 암호화를 **요구하지 않는다**. 따라서 이건 계약 위반 수정이 아니라 **신규 보안 강화 결정**이다.
- **API 비도달**: read 는 redacted 서빙(§2.2) → 이 갭은 P1 이더라도 API 노출이 아니라 매체/백업/포렌식 수준.
- 배포 매체의 디스크/버킷 암호화(LUKS·S3 버킷 기본 SSE)가 인프라에서 이미 켜져 있는지는 **레포 밖·미확인** —
  옵션 2A 의 실효성은 여기에 의존.

### 2.5 옵션

**옵션 2A — 현상 유지 + 인프라 계층 암호화 (계약 침묵 존중)**
앱 코드·계약 무변경. at-rest 기밀성을 **배포 매체**로 확보: 디스크 암호화(LUKS/dm-crypt) + S3 버킷 기본
암호화(SSE-S3 또는 SSE-KMS) + 백업 암호화. 운영 런북에 명문화.
- 비용: **낮음(운영)**. 코드 0. 인프라 설정·검증만.
- 보안 이득: 매체 도난/폐기/백업 유출 방어. 앱은 평문 취급하나 저장 매체가 암호화 → 감사가 지목한
  "backup / forensic" 표면 상당 부분 커버.
- 트레이드오프: 앱 프로세스·메모리·정당 접근 경로에는 평문 그대로(애플리케이션 레벨 기밀성 아님).
  kid 회전·테넌트별 키 분리 불가(버킷 단일 정책). read 경로 성능 영향 없음.

**옵션 2B — 애플리케이션 봉투암호화 (세션 KMS 선례 재사용) ★ 필수 검토**
`browser-session-store.ts` 의 `KmsEnvelopeSessionEncryptor` 패턴(이미 구현·export 됨)을 ObjectStore 경계에
적용: put 시 `[version|wrappedDek|body]` 로 암호화, get/getBytes 시 복호화. `artifacts` 에 `enc_kid` 추가.
AAD 등가로 `tenant_id|artifact_id` 바인딩(세션의 `sessionContextTag` 대응).
- 비용: **중간~높음**. ObjectStore 래핑(Fs/S3 공통 데코레이터) + DDL(`enc_kid`) + 라이프사이클 전 경로 영향:
  - **integrity checker 재정의 필수**: sha256 대조 대상이 평문인지 암호문인지 결정해야 함
    (`artifact-integrity-processor.ts:111-128` 은 현재 저장 바이트=평문 기준). 암호문 저장 시 sha256 을
    암호문 기준으로 바꾸거나 복호화 후 대조로 변경.
  - **redaction 재작성**: 복호화→변환→재암호화 파이프라인 필요(`fs-artifact-lifecycle-store.ts:93`,
    `s3-artifact-redactor.ts:147` putBytes 전).
  - orphan/retention 은 object_ref 메타만 다뤄 영향 적음.
- 보안 이득: **애플리케이션 레벨 기밀성** + kid 회전(세션과 동일 KMS 경계 재사용) + 테넌트 AAD 바인딩.
  선례가 있어 암호 설계 리스크 낮음(검증된 AES-256-GCM 봉투 패턴).
- 트레이드오프: read 경로에 복호화 추가(지연·CPU). integrity/redaction 재설계가 클러스터를 키움. 계약이
  요구하지 않으므로 신규 보안 결정으로서 명시 승인 필요. 키 없으면 백업 복구 불가(운영 부담↑).

**옵션 2C — S3 SSE 헤더만 (S3 경로 한정, 최소)**
S3 put 요청에 `x-amz-server-side-encryption: aws:kms|AES256` 헤더 추가(`s3-object-store.ts:311-316` 서명에
포함). Fs 경로는 미해결.
- 비용: **낮음**. S3 어댑터 한정 소변경 + 서명 헤더 포함 테스트.
- 보안 이득: S3 배포에서 버킷 정책 없이도 객체별 SSE. 2A 의 코드 내 최소판.
- 트레이드오프: **부분적** — Fs(로컬/온프렘) 경로는 평문 유지. 실질적으로 2A(버킷 기본 SSE)와 중복이며
  버킷 정책이 더 단순. 단독으로는 갭 미봉합.

### 2.6 권고

**옵션 2A(인프라 계층)를 기본선으로 확정하고, 규제·고객 계약상 "애플리케이션 레벨 암호화"가 요구될 때만
2B(세션 선례 재사용)로 승격.** 근거:
- read API 는 redacted 서빙이라 누출면이 매체/백업 수준(§2.2·2.4) → 매체 암호화(2A)가 위험 대부분을 비용
  최소로 커버. 계약이 침묵하므로 앱 레벨 암호화는 YAGNI 리스크(2B 는 integrity/redaction 재설계로 클러스터를
  키움).
- 2B 는 선례(`KmsEnvelopeSessionEncryptor`)가 이미 있어 **채택 시 재발명이 아님** — 오너가 애플리케이션 레벨
  기밀성·kid 회전·테넌트 키 분리를 요구하면 즉시 이 패턴으로 설계 가능(그래서 필수 검토 옵션으로 포함).
- 2C 는 2A(버킷 SSE)에 흡수되므로 단독 채택 비권장.
- **선결 확인**: 배포 매체 암호화(디스크/버킷)가 이미 켜져 있으면 2A 는 "런북 명문화 + 검증"으로 종결될 수
  있다(신규 구현 0). 이 사실 확인이 최우선.

### 2.7 오너 결정 질문 (§2)

- **Q2-1 (선결)**: 현 배포 매체(디스크·S3 버킷·백업)에 at-rest 암호화가 **이미 적용**돼 있는가? (적용돼
  있으면 2A 는 런북 명문화로 종결.)
- **Q2-2**: 요구 수준은 **매체 암호화(2A)**로 충분한가, **애플리케이션 레벨 기밀성(2B)**이 필요한가?
  (규제/고객 계약/위협모델 기준.)
- **Q2-3**: 2B 채택 시 **테넌트별 키 분리 + kid 회전**이 요건인가, 단일 KEK 로 충분한가? (세션은 현재
  단일키 wiring, 봉투 구현체는 준비됨.)
- **Q2-4**: 2B 채택 시 integrity checker 의 sha256 대조는 **평문 기준(복호화 후 대조)**인가 **암호문
  기준**인가? (라이프사이클 재설계 범위를 가른다.)
- **Q2-5**: at-rest 암호화 요구를 **계약(security-contracts.md)에 명문화**할 것인가, 배포 운영 결정으로만
  남길 것인가? (계약 침묵 상태를 유지할지 결정.)

---

## 부록 — 실측 앵커 요약 (main `1d360e65`)

| 주제 | 핵심 앵커 |
|---|---|
| worker_pools 무소유·RLS 제외 | `db/migration_core_entities.sql:294,298-310`; RLS 배열 L2580(assignments 만) |
| self-assign 실증 | `app/test/api-worker-pools.int.ts:263-265` (tenant B → A 풀 200) |
| 교차 DoS | `app/src/api/run-queue.ts:132-138` |
| worker_pool.manage 등재 갭 | `ts/rbac-policy.ts:196` vs `auth-rbac.md §2`(부재) |
| object 바이트 평문 | `app/src/gateway/pg-gateway-artifact-sink.ts:64`; `app/src/artifacts/s3-object-store.ts:139-140` |
| 봉투암호화 선례 | `app/src/runtime/browser-session-store.ts:123-207`(KmsEnvelope), `77-112`(AesGcm, prod wiring) |
| 계약 침묵 | `security-contracts.md`·`impl-contracts-bundle.md`·`ops-defaults.md` (artifact at-rest 암호화 요구 0) |
| read=redacted 서빙 | `app/src/api/reads-artifacts.ts:61-63` |
