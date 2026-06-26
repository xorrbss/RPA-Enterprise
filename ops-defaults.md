# 운영 기본값 · 수치 임계 (Operational Defaults v1)

> 전이 guard·정책·job에 쓰이지만 계약 본문이 값을 비워둔 수치의 **기본값 단일 진실원천**. 모든 값은 **환경별 설정으로 오버라이드 가능**한 운영 정책이며, 본 문서는 (a) 코드 기본값과 (b) 시뮬레이션-클록 단위테스트 픽스처값을 함께 고정한다(README §"D1에서 함께 산출할 것"의 픽스처 근거).
> 원칙: 임계는 결정론적으로 평가(IREL `now()` 금지와 별개 — 인프라 타이머). "조용한 false 금지" — 임계 도달은 명시적 전이/예외로만 표면화.

---

## 1. Run / Workitem 전이 임계 (state-machine.md)

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `run.init_fail_threshold` | 3 | 2 | R3a/R3b | 연속 INIT 실패 < 임계 → 재큐(R3a), ≥ 임계 → `failed_system`+서킷(R3b). 카운터 = `runs.consecutive_init_failures`(R3a 시 +1, R2 INIT 성공 시 reset; 누적 `attempts`와 분리 — state-machine §1 INIT 규칙) |
| `run.init_backoff` | base 2s · factor 2 · max 60s · jitter ±20% | base 10ms · max 50ms | R3a "백오프" | 지수 백오프 |
| `workitem.max_attempts` | 3 | 2 | W4/W5/W6/W7 | attempts < max → retry, ≥ max → abandoned(dead_letter) |
| `workitem.retry_backoff` | base 5s · factor 2 · max 5m | base 10ms · max 50ms | W4 "백오프" | W8 재checkout 시 step/loop 카운터 리셋·cursor 보존 |
| `run.abort_timeout` | 30s | 100ms | R24 `drain_timeout` | drain 초과 시 강제 lease kill → cancelled |
| `workitem.checkout_timeout` | 10m | 300ms | W6/W7 `checkout_expired` | W9 suspend 중 pause, W11 resume 시 잔여 TTL 재개(pause 구간 제외) |

---

## 2. Lease TTL · sweeper 주기 (migration SQL · impl-bundle §B)

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `browser_lease.ttl` | 5m | 500ms | browser_leases.expires_at | heartbeat 갱신 시 연장 |
| `browser_lease.heartbeat_interval` | 30s | 100ms | renewal 주석 | 만료 전 갱신 |
| `credential_lease.locked_until_ttl` | 15m | 500ms | credential_leases.locked_until | 만료 시 sweeper 회수 |
| `credential.default_max_concurrency` | **1** | 1 | §19 결정·credential_concurrency_policies | 사이트별 정책으로 상향 |
| `lease_sweeper.poll_interval` | 5s | 20ms | §B "수초 폴링" | browser+credential 만료 회수(idempotent) |

### 2.1 Product-open DB smoke binding

- `db/migration_smoke.sql` is the release smoke for these lease defaults: active credential slots are not stolen, released/expired slots can be reacquired by CAS, browser renewal is owner-only, expired browser leases are not revived, and the sweeper is idempotent.
- Run the smoke from `db/README.md` before product-open promotion. A run under `SUPERUSER`/`BYPASSRLS` is only a syntax/catalog check; at least one non-bypass application-role run is required to exercise RLS row visibility.

---

## 3. 서킷 임계 (error-catalog · reserved-handlers)

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `site.circuit.block_rate_threshold` | 30% | 50% | `SITE_CIRCUIT_OPEN` | rolling window 내 차단율(blocks/total). 표본=`site_block_samples`(drive 1회=1행). blocked=challenge 자동감지(driveSuspend kind<>human_task = 사이트가 봇을 차단; SITE_PROFILE_BLOCKED 승인게이트는 제외). 평가·전이=`recordSiteCircuitOutcome`(drive 후 best-effort tenant tx) |
| `site.circuit.window` | 5m · min_samples 20 | 1s · 4 | site.circuit_opened | 표본 부족(window 내 total<min_samples) 시 미발동. 삽입 시 window 밖 표본 lazy prune. closed→open CAS 시 `events_outbox` 에 site.circuit_opened(closed-empty, correlation=트리거 run) |
| `site.circuit.open_duration` | 15m | 1s | site.circuit_closed | open cooldown(`circuit_until`). **경과 후 다음 drive=프로브**(게이트 `acquireBrowserLease`=read-only: open+cooldown 이면 `SITE_CIRCUIT_OPEN` deferred=cooldown 만큼 재큐, run 은 queued 유지). **회복=lazy auto-close**(신규 컬럼 없음): 프로브 비차단→open→closed+site.circuit_closed, 프로브 차단→재open+새 cooldown. 전이는 전부 record* 에서(게이트 미전이→프로브 없는 경로 limbo 회피). 사이트 서킷=tenant-scoped → worker 와 달리 events_outbox 발행 |
| `challenge.block_rate_threshold` | 30% | 50% | reserved-handlers SITE_CIRCUIT_OPEN | provider는 risk=red면 skip |
| `worker.circuit.consecutive_failures` | 5 | 3 | worker.circuit_opened | 워커 격리. 카운터 = `workers.consecutive_init_failures`(per-worker 연속 INIT 실패; R3b openCircuit 트리거 — state-machine §1). INIT 성공 시 0 reset |
| `worker.circuit.open_duration` | 1m | 200ms | worker.circuit_opened→half_open | cooldown. **`circuit_until` 경과 후 claim 은 프로브로 허용**(게이트 `checkWorkerCircuit`=read-only). 프로브 성공이 `open`→`half_open`→`closed`, 프로브 실패가 `open` 재진입을 **`recordWorkerInit*`에서 원자적으로** 처리(게이트 미전이 → SESSION_LOCKED/resume 조기반환이 limbo 안 만듦). cooldown 중·`circuit_until` 미설정(레거시/수동 open)은 fail-closed. worker 서킷은 infra → tenant `events_outbox` 미발행 |
| `worker.circuit.half_open_close_threshold` | 2 | 2 | worker.circuit_closed | **half_open 회복**: 연속 INIT 프로브 성공 N회(=`workers.half_open_successes`) → `closed`(회복 확정). half_open 프로브 **1회 실패 → 즉시 `open` 재진입**+cooldown(closed 의 누적 임계보다 민감). N=1 이면 단일 프로브 성공으로 close |
| `worker.lease_expiry_isolation.open_duration` | = `worker.circuit.open_duration` | 200ms | `lease_sweeper` → `workers.circuit_state` | `lease_sweeper`가 `browser_leases.state IN ('reserved','active') AND expires_at < now()` 행을 `expired`로 전환하면, 반환된 `owner_worker_id`의 browser worker를 즉시 `circuit_state='open'`으로 격리하고 동일 cooldown을 설정한다. 두 번째 sweep은 이미 만료된 lease를 반환하지 않아 멱등이다. worker는 infra이므로 tenant `events_outbox`는 발행하지 않고, tenant 영향은 `bot_pool` ops alert로 노출한다 |

### 3.1 Ops alert console delivery / ack

- Product Open v1 delivery channel은 콘솔 alert center뿐이다. 모든 `OpsAlert.delivery`는 `{ channel:"console", status:"delivered", external_delivery:false }`이며 Teams/Slack/email/webhook 전송 성공으로 위장하지 않는다.
- `POST /v1/ops-alerts/{alert_id}/ack`는 `ops_alert.ack` + `Idempotency-Key`를 요구한다. 현재 계산 가능한 alert가 아니면 `RESOURCE_NOT_FOUND(reason=ops_alert_not_current)`로 실패한다.
- ack 원장은 `ops_alert_acknowledgements(tenant_id, alert_id, detected_at)` generation 키로 저장한다. 장애가 해소 후 재발해 `detected_at`이 바뀌면 이전 ack가 새 open alert를 숨기지 않는다. `GET /v1/ops-alerts` 기본은 `status=open`이며 `status=acknowledged|all`로 원장 반영 상태를 조회한다.
- v1.1 external delivery 준비 계약은 future-only이며 기본값은 disabled다. 후보 외부 채널은 `teams`·`slack`·`email`·`webhook`이고, Product Open v1에서 `delivered`로 인정되는 채널은 계속 `console`뿐이다.
- future external delivery는 ack와 별도 leg다. ack 원장은 외부 전송 성공/실패를 표시하지 않고, 외부 전송 실패도 `POST /ack` 성공을 막지 않는다.
- 외부 전송 전제조건은 all-or-nothing이다: channel connector 활성화, endpoint/credential의 `SecretRef` 보관, 수신자/route policy, real send receipt가 모두 있어야 한다. 하나라도 없거나 unknown이면 외부 leg는 `deferred` 또는 미인큐 상태로 남기고, console alert만 노출한다. `sent`/`delivered`를 합성하지 않는다.
- v1.1 구현 전 owner input: 채택 채널, SecretRef namespace/backend, 수신자 라우팅 owner, retry/DLQ 정책, 허용 endpoint domain/provider account ownership. 이는 Product Open v1 blocker가 아니다.

---

## 4. LLM Gateway (llm-gateway-adapter.md)

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `llm.retry_max` | 2 | 1 | §4 "최대 N" | RATE_LIMIT/BACKEND_ERROR 재시도, 소진 시 terminal(LLM_RATE_LIMITED 등) |
| `llm.stream_idle_timeout` | 20s | 100ms | `STREAM_IDLE_TIMEOUT` | 토큰 무수신 → 1회 재시도 → fallback |
| `llm.stream_wall_timeout` | 120s | 300ms | `STREAM_TIMEOUT` | wall-clock 초과 → System(비재시도) |
| `llm.fallback_attempts` | 1 | 1 | §4 fallback model | secondary adapter 1회 |
| `llm.repair_attempts` | 1 | 1 | §5 | MALFORMED_OUTPUT repair 최대 1회 |
| `llm.budget.max_output_tokens` | 4096 | 256 | LLMRequest.budget | per-call. 초과 시 스트림 중 즉시 close(BUDGET_EXCEEDED) |
| `llm.budget.max_cost_per_run` | $0.85 | $0.01 | budget.maxCost | run 단위 누계 상한 |
| `llm.budget.max_input_tokens` | model `maxContextTokens`의 90% | 1024 | capabilities | 모델별 상한 비례 |

---

## 5. 캐시 · 검증 · self-heal (ir.schema · verify.schema · impl-bundle §D)

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `node.max_self_heal` | 2 | 1 | ir.schema nodePolicy(기본 2) | 스키마 기본값 유지 |
| `loop.max_iterations` (상한) | 10000 | 10 | ir.schema(max 10000) | **loop body 전용** 반복 상한(loop 노드 1회 실행 내) |
| `interpreter.graph_max_steps` | 200 | deps.maxSteps 주입 | ir-interpreter `runScenario` / RQ-017 | **그래프 전체 노드 순회** 상한(비종료 방어). `loop.max_iterations`(loop body 전용)와 **구분** — 이건 시작→terminal까지 방문 노드 step 총수. 초과 시 `InterpreterError("IR_LOOP_LIMIT")`(조용한 무한루프 금지). 시나리오는 graph 크기에 맞게 더 작게 오버라이드 권장 |
| `node.timeout_ms` 기본 | 30000 | 200 | nodePolicy.timeout_ms(min 1000) | 미지정 시 적용 |
| `node.timeout_ms` 상한 | 300000 | — | — | 초과 지정 거부(저장 검증) |
| `verify.element_visible.timeout_ms` 기본 | 10000 | 100 | verify.schema | 미지정 시 적용 |
| `action_plan_cache` family 재해석 | suspect 1회 기록 후 재히트 시 재해석 | 동일 | §D / §7.2 | active만 재생, 늦은 해석 폐기 |

---

## 6. Artifact lifecycle (impl-bundle §B · security-contracts)

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `artifact.retention_default` | 90d | 1s | retention_until | legal_hold 태그는 예외(보존) |
| `artifact_redaction_job.poll` | 5s | 20ms | §B "수초 폴링" | pending→redacted |
| `artifact.redaction_fail_threshold` | 5 | 2 | §B "실패 N회 → failed+알림" | 초과 시 `failed`+알림, 조회 차단(ARTIFACT_NOT_REDACTED) |
| `artifact_retention_sweeper` | daily 02:00 KST | tick | §B "일배치" | retention_until < now() 삭제+soft-delete |
| `artifact_integrity_checker` | daily | tick | §B | sha256 불일치 → quarantine+알림 |
| `artifact_orphan_sweeper` | daily | tick | §B | 참조 없는 object 정리(전역 BYPASSRLS 스캔) |
| `artifact.orphan_grace_default` | 24h | — | §B orphan_sweeper | 최근 생성 object 보호 유예(artifacts INSERT in-flight 오판 방지). now-mtime < grace 면 삭제 제외 |

### 6.1 DB payload retention 계약

- Decision v1: payload-bearing PostgreSQL tables carry inline `retention_until`, `deleted_at`, and `legal_hold` columns. This applies to `control_plane_idempotency_keys.response_body`, `raw_items.raw_payload`, `normalized_records.record`, `events_outbox.payload`, `artifacts.object_ref` metadata rows, and `audit_log.payload`.
- `legal_hold = true` blocks retention deletion. `deleted_at` records soft-delete/tombstone state; physical purge/archive workers may be added later, but the table-level columns are the authoritative v1 retention contract.
- `events_outbox.retention_default` is the repo-owned v1 source for app/runtime outbox producers: uniform 90d for every tenant-scoped event type. `emitOutboxEvent` calculates `retention_until` from the PostgreSQL transaction timestamp (`now()`) plus this duration; supplied `occurredAt` only sets the envelope `occurred_at` and does not backdate retention. Missing, unsupported, non-finite, or non-positive policy input is a fail-closed producer error, and `events_outbox.retention_until` is `NOT NULL` so direct SQL producers cannot persist unknown retention.
- artifact는 위 표의 `artifact.retention_default`와 sweeper 규칙을 따른다. 다른 payload-bearing 테이블은 각 row의 `retention_until`을 기준으로 하며, 값이 없으면 해당 producer 계약이 보존 기간을 아직 산출하지 못한 오류로 취급한다(조용한 unknown 금지).
- **Per-producer retention duration/source (release-decisions D8-A11):** `events_outbox`(90d, NOT NULL)·`artifacts`(`artifact.retention_default` 90d, DB CHECK) 외 나머지 payload-bearing 테이블의 v1 보존기간/출처:

| Table | retention | source | 비고 |
|---|---|---|---|
| `raw_items.raw_payload` | 30d | `raw_items.retention_default` | 원시 수집·재처리 창(최단). 실 collector(D6 범위 밖)가 이 source로 산출 |
| `normalized_records.record` | 90d | `normalized_records.retention_default` | events_outbox 90d 정합. 실 normalizer가 산출 |
| `control_plane_idempotency_keys.response_body` | = `expires_at` | D4.3 app idempotency writer | 단일 source 유지(별도 값 없음, 이미 배선) |
| `audit_log.payload` | **2555d (7년) — v1 기본값, override 가능 (D8-A14)** | 규제/감사 보존 (redacted 저-PII payload) | 과소보존 회피 우선. 특정 규제 상이 시 오너 조정. writer는 `retentionUntil` 미공급 시 fail-closed |

---

## 7. Challenge / Resume / 기타

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `challenge.network_retry_max` | 2 | 1 | reserved-handlers @challenge | network_retry attempt 횟수 |
| `challenge.attempt_backoff` | 5s | 20ms | attempt 순차 실행 | session_refresh→retry→network→human_assist→provider→fail 순 |
| `resume_token.ttl` (expiresAt) | 30m | 2s | reserved-handlers ResumeToken | 만료 시 resume 거부→재로그인/System |
| `resume_token.key_rotation_grace` | 7d | — | security-contracts §5 | 폐기 키 검증 유예 |
| `human_task.default_timeout` | 30m | 2s | @human_task `timeout` | kind별 시나리오 오버라이드 |

> **resume_token.ttl 보강(상태머신 감사 클러스터 C)**: TTL 은 **resume 개시→restore** 구간을 경계한다. `resume_requested` 도달은 R13(`human_task.resolved`, RBAC 인증 resolve)로만 가능하므로, 워커는 resume 시작 시 진본(hmac/kid 일치)·만료 토큰을 fresh TTL 로 **재발행** 후 restore 한다(tamper=hmac/kid 불일치는 재발행하지 않아 R20 으로 거부 — 보안 경계 유지). 인간 승인 대기의 경계는 토큰 TTL 이 아니라 **human_task 생명주기**(R13 resolve / R14 timeout)다. `human_task.default_timeout`과 명시 `@human_task.timeout`은 `expires_at`으로 저장되고 `human_task_timeout_sweeper`가 H4/H8을 처리한다. "만료 시 resume 거부"는 재발행 후의 restore-verify(=resume 개시 후 짧은 창)에 적용된다.

---

## 8. Sink delivery (D6 — db sink_deliveries, 데이터평면 외부 전달)

> sink_deliveries 테이블은 존재하나 v1.6 시점엔 전달 상한이 미정의였다. D6 빌드가 failed→dead_letter
> 전이를 결정하려면 attempt 상한이 필요하다. **결정(release-decisions.md D6-1)**: sink 전달은 구조적으로
> 재시도형 system 작업이므로 `workitem` retry family를 그대로 정렬해 v1 기본값으로 둔다(별도 운영정책이
> 이를 대체할 때까지). 값은 코드 상수가 아니라 `SinkDeliveryPolicy`(runtime-contract)로 **주입**한다 —
> 조용한 하드코딩 금지.

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `sink.delivery.max_attempts` | 3 | 2 | sink_deliveries.status | attempt_no < max → `failed`(재전달), ≥ max 실패 → `dead_letter`(SINK_DELIVERY_FAILED 소진) |
| `sink.delivery.retry_backoff` | base 5s · factor 2 · max 5m | base 10ms · max 50ms | `failed` 재전달 | `workitem.retry_backoff`와 정렬. 같은 sink_idempotency_key로 재전달(외부 1건 흡수) |
| `sink.delivery.sweeper.poll` | 5s | 20ms | impl-bundle §B "수초 폴링" | `failed`(상한 미달) 행 재전달 스케줄(idempotent) |

- 멱등키 `sink_idempotency_key = tenant_id:sink_config_id:schema_ref:natural_key`(attempt_no 제외)는 모든
  재시도가 동일 키를 보내 외부 다운스트림이 1건으로 흡수하게 한다(migration SQL FIX#7). 제어평면
  `Idempotency-Key`와 다른 계층(api-surface §0.4).
- 실 외부 전달(네트워크 전송)은 외부 사실 경계다 — `SinkDeliveryPort`의 `real_sink` 바인딩(SecretRef-backed)
  으로 분리하고, 로컬은 `test_fake` 바인딩(staging 증거 아님)으로 검증한다(artifact object-I/O 포트와 동형).

---

## 9. 적용 규약

- **오버라이드 계층**: 시스템 기본(본 문서) < 테넌트 설정 < 사이트 프로파일 < 시나리오 노드 정책(`nodePolicy`). 좁은 범위가 우선.
- **테스트 픽스처값**은 시뮬레이션 클록(가상 시간)에서 전이/타임아웃 경로를 빠르게 검증하기 위한 값이며, 운영 의미는 동일(스케일만 축소). state-machine 전이 테스트·sweeper 멱등 테스트가 사용.
- **미확정(외부 사실)**: LLM 모델별 정확한 `maxContextTokens`·실제 Codex structured-output 스트리밍 지원범위는 구현 시 라이브 capabilities로 확정(README v1.4 §19). 본 문서 값은 안전 기본값.
- 모든 임계는 메트릭으로 노출(impl-bundle §E `*_rate`/`queue_depth` 등)되어 운영자가 조정 근거를 본다.
