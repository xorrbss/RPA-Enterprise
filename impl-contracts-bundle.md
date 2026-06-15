# 구현 세부 계약 묶음 (리뷰 #4 #9 #12 #14 #15)

> P0/P1 잔여 항목 중 단독 파일이 과한 것들을 묶었다. 각 섹션은 독립 구현 단위.

---

## A. Connector Hook 실행 모델 (#12)

> v1 전제: 커넥터는 **1st-party(자사 제작)**. 3rd-party 마켓플레이스(D7+)에서만 강한 격리 필요 → v1은 "서명된 내장 함수 + 제한 컨텍스트"로 충분.

### 실행 런타임
- v1: **서버 내장 TypeScript 함수**, manifest 서명 검증 통과분만 로드. WASM/프로세스 격리는 **3rd-party 단계로 연기**(경계만 확보).
- hook 시그니처:
```ts
type ConnectorHook = (ctx: HookContext) => Promise<HookResult>;
type HookContext = {
  connectorId: string; version: string;
  // 제한 주입: 직접 DB/Secret/네트워크 핸들 금지. 화이트리스트 API만.
  api: {
    migrateSchema(spec: MigrationSpec): Promise<void>;   // 트랜잭션 경계 내
    registerTargets(schemaRef: string): void;
    readConfig(key: string): unknown;                    // connector 네임스페이스 한정
  };
  // ctx.api 외 전역 접근 불가(eslint + 모듈 경계로 강제)
};
type HookResult = { ok: true } | { ok: false; code: "CONNECTOR_HOOK_FAILED"; reason: string };
```

### 권한 제한
- hook은 `ctx.api`만 사용. SecretStore·외부 네트워크·임의 DB 직접 접근 **불가**(타입 + 모듈 경계). 위반은 빌드 차단.
- 네트워크 필요 작업(원격 검증 등)은 v1 미지원.

### lifecycle & rollback
| hook | 시점 | 트랜잭션 | rollback |
|---|---|---|---|
| `validate` | 등록/업로드 | 읽기 전용 | 불필요 |
| `install` | enable 전 | 단일 트랜잭션 | 실패 시 전체 롤백(생성 리소스 폐기) |
| `migrate` | 버전 업 | **schema migration + raw reprocess trigger 동일 트랜잭션** | 실패 시 스키마·트리거 함께 롤백 |
| `enable` | 활성화 | — | runtime/IR 버전 불일치 시 **차단**(CONNECTOR_INCOMPATIBLE), warning 아님 |
| `disable` | 비활성화 | — | 진행 중 run 없을 때만, 있으면 거부 |

- `runtime_compatibility` 불일치 = **enable 차단**(경고 아님). install된 채로 비활성 유지.

---

## B. Artifact Lifecycle Jobs (#9)

> 저장만큼 lifecycle이 중요. 운영이 아니라 **개발할 백그라운드 job**. 단일 스케줄러(스케줄러 모듈 재사용)로 주기 실행.

| job | 주기 | 동작 |
|---|---|---|
| `artifact_redaction_job` | 수초 폴링 | `redaction_status='pending'` → 마스킹 수행 → `redacted`. 실패 N회 → `failed` + 알림. **redacted/not_required 아니면 조회 API 차단**(C 참조) |
| `artifact_retention_sweeper` | 일배치 | `retention_until < now()` object 삭제 + row soft-delete. 법정 보존 태그는 예외 |
| `artifact_integrity_checker` | 일배치 | sha256 ↔ object 실제 해시 대조. 불일치 → 알림 + quarantine |
| `artifact_orphan_sweeper` | 일배치 | run 삭제/취소 후 참조 없는 object 정리 |
| `lease_sweeper` | 수초 폴링 | `browser_leases.expires_at < now()` → 프로세스 kill + cleanup 재실행(idempotent) + `expired`. credential_leases 만료도 동일 회수 |

Artifact lifecycle port boundary:
- `artifact_redaction_job` / `artifact_retention_sweeper` first claim an `artifacts` row by tenant-scoped claim lease, then perform object I/O outside the DB transaction, then finalize by `(tenant_id, artifact_id, lifecycle_claim_id, worker_id, correlation_id, unexpired claim)` CAS.
- Real object-store ports must declare `real_object_store` binding with a `SecretRef` credential path and emit `artifact/object-io-evidence@1` receipts before success finalize. Evidence may include `ArtifactRef`, backend alias, `SecretRef` identifier, receipt id, operation, and sha256 metadata; it must never include `ObjectRef` or `PlainSecret`.
- Local fake ports must declare `test_fake` / `artifact/object-io-local-test@1`; they are allowed only for repo tests and are not staging/product-open object-store evidence.
- Missing port binding, missing real-port `SecretRef`, unknown port result, stale claim, expired claim, legal hold, quarantine, missing retention deadline, or object-I/O evidence mismatch fails closed and must not silently mark rows `redacted`, `not_required`, or `deleted_at`.

규칙: 모든 sweeper는 **idempotent**(중복 실행 안전). cleanup 중 워커 크래시 → 다음 틱이 재청소.

---

## C. 런타임 Redaction Boundary (#14)

> TS 브랜드 타입은 런타임에 사라진다 → DB/JSON 경계 보호 필수.

### serialization guard
```ts
// JSON.stringify 직렬화 전 검사. PlainSecret 인스턴스가 그래프에 있으면 throw.
function safeSerialize(obj: unknown): string;   // 내부에서 taint 검사
// Logger/EventPublisher/ArtifactSink는 safeSerialize만 사용. raw JSON.stringify 금지(eslint 룰).
```

### runtime schema validation (경계)
- **들어오는 모든 payload**(API body / DB row / queue job)는 경계에서 JSON Schema(ajv) 검증. 타입 단언만으로 신뢰 금지.
- `SecretStore.resolve()` 결과(PlainSecret)는 taint helper로 추적 — 로그/이벤트/artifact 경로 진입 시 build/lint 에러.

### artifact access middleware
```ts
// 조회 API 진입 시 강제
if (artifact.redaction_status !== 'redacted' && artifact.redaction_status !== 'not_required')
  throw ApiError('ARTIFACT_NOT_REDACTED');   // 누락 방지를 미들웨어 1지점에 고정
```

### redaction test fixture (계약상 필요 케이스 — 수행은 타팀)
password 필드, OTP, iframe 내 입력, shadow DOM 입력, 스크린샷 내 텍스트(주민/계좌/전화), hidden-instruction 텍스트. 픽스처 데이터는 개발팀이 산출, 테스트 실행은 QA.

---

## D. ActionPlanCache Family Classifier (#4)

> loop 페이지 캐시 family 묶기의 판정 주체·임계·충돌 처리.

- **classifier source**: **deterministic rule 우선**. landmark 구조(role/name path) + url_pattern 정규화(page/offset placeholder)로 family 키 산출. LLM/VLM 미사용(비용·비결정성 회피).
- **family 키**: `(url_pattern_normalized, dom_structural_hash)` — visible_text는 제외(loop 가변). 같은 family = 1회 해석 후 재생.
- **confidence threshold**: deterministic이므로 confidence 개념 대신 **구조 해시 정확 일치**가 family 조건. 일치 안 하면 별도 시그니처(miss).
- **collision 처리**: 서로 다른 페이지가 같은 structural_hash로 잘못 묶여 verify 실패가 누적되면 → 해당 family `suspect → stale`(§7.2). stale은 재생 차단 → 재해석.
- **loop-specific 강화**: 1회차 plan을 2회차+에 재사용할 때 **verify를 매 iteration 수행**(재생이라도 검증은 생략 안 함). false success 방지.
- **insert race**: migration_concurrency_idempotency.sql의 ON CONFLICT 규약 — "먼저 검증된 active가 이긴다", 늦은 해석 폐기.
- **failed plan 저장**: verify 실패 해석은 active로 저장 금지, `suspect`로 1회 기록(추적용).

---

## E. Observability — Trace Span 계약 (#15)

> instrumentation은 개발 코드 계약. RPA는 실패 재현이 어려워 trace 없으면 디버깅 비용 폭증. (백엔드 수집은 타팀, **span 이름·부모관계·필수 속성은 개발 계약**.)

### 필수 span (이름 고정)
```
run.claim
  browser.lease.acquire
  session.restore
  page_state.resolve
  executor.execute              (attr: node_id, action, executor)
    action_plan_cache.lookup    (attr: cache.mode)
    llm_gateway.call            (attr: primitive, model, transport, stream_status, ttfb_ms)
    verify.run                  (attr: status, recommendation)
  artifact.capture              (attr: type, redaction_status)
  pipeline.raw_persist
  sink.deliver                  (attr: sink, attempt_no, status)
```

### 공통 속성(전 span)
`tenant_id, run_id, workitem_id?, correlation_id`. 이벤트 envelope의 correlation_id와 동일 값으로 트레이스↔이벤트↔로그 상호 연결.

### 필수 메트릭(이름 고정, 수집 백엔드 무관)
`run_success_rate, cache_hit_rate, self_heal_rate, vlm_fallback_rate, challenge_rate, site_block_rate, workitem_sla_violation, queue_depth, llm_ttfb_ms, llm_cost`.
