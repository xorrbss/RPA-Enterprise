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
| `maintenance.tenant_discovery` | enabled when `MAINTENANCE_TENANT_IDS` empty | fixture query | maintenance-scheduler | 빈 목록 discovery는 application role cross-tenant scan 금지. dedicated non-superuser BYPASSRLS lifecycle role에서 `assertLifecycleBypassUse`를 통과한 pool만 사용한다. 명시 목록이 있으면 그 목록만 사용 |
| `maintenance.run_trigger_tenant_discovery` | enabled when `MAINTENANCE_TENANT_IDS` empty | fixture query | maintenance-scheduler | due cron `run_triggers` tenant discovery도 application role cross-tenant scan 금지. dedicated non-superuser BYPASSRLS lifecycle role에서 `assertLifecycleBypassUse(..., "maintenance.run_trigger_tenant_discovery")`를 통과한 pool만 사용한다. 명시 목록이 있으면 그 목록만 사용 |
| `maintenance.audit_verifier_interval` | 1h | unit override | `audit_verifier_runs` | 감사 로그가 있는 tenant에 tenant-scoped `audit_verifier` job을 enqueue한다. 빈 `MAINTENANCE_TENANT_IDS` discovery는 dedicated non-superuser BYPASSRLS lifecycle role에서 `assertLifecycleBypassUse(..., "maintenance.audit_verifier_tenant_discovery")`를 통과한 pool만 사용한다. 최신 증적이 75분 이상 stale이면 console-only ops alert로 표면화한다 |
| `worker.heartbeat_interval` | 30s | unit 10ms | workers.heartbeat_at | worker/lifecycle-worker가 부팅 시 `workers`에 self-register하고 heartbeat를 갱신. Bot Pool live capacity는 이 신호를 기준으로 stale을 판정 |
| `worker.stale_threshold` | 2m | unit 40ms | Bot Pool/Worker Pool read model | 마지막 `workers.heartbeat_at`이 이 임계보다 오래되면 `stale`로 집계하고 live capacity에서 제외한다. API/쿼리 하드코딩 금지 |

Worker heartbeat startup rule:
- heartbeat는 runtime dependency(Vault/SecretStore, encryption key, browser/artifact store, queue runner)가 준비된 뒤 시작하거나, 그 전에 시작했다면 이후 startup 실패 시 반드시 stop해야 한다.
- startup 실패 후 남은 heartbeat가 worker를 live capacity로 보이게 하면 `조용한 false`로 간주한다.

### 2.1 Product-open DB smoke binding

- `db/migration_smoke.sql` is the release smoke for these lease defaults: active credential slots are not stolen, released/expired slots can be reacquired by CAS, browser renewal is owner-only, expired browser leases are not revived, and the sweeper is idempotent.
- Run the smoke from `db/README.md` before product-open promotion. A run under `SUPERUSER`/`BYPASSRLS` is only a syntax/catalog check; at least one non-bypass application-role run is required to exercise RLS row visibility.

### 2.2 Versioned migration runner defaults

| 파라미터 | 기본값 | 테스트 픽스처 | 계약 참조 | 비고 |
|---|---|---|---|---|
| `migration.tool` | `repo_node_runner` | fake pg client | `db/README.md` | P0-adoption 기본 migration 도구. Flyway/Sqitch 전환 전까지 repo-local runner가 ledger와 smoke를 책임진다 |
| `migration.checksum_algorithm` | `sha256` | fixture migration text | `schema_migrations.checksum` | 같은 version의 checksum drift는 fail-closed |
| `migration.baseline_existing_db` | explicit operator action | baseline fixture | `schema_migrations.baseline` | 기존 DB는 shape 검증 후 `baseline=true`로 온보딩하며 DDL을 재실행하지 않는다 |
| `migration.smoke_required` | true | smoke stub | `db/migration_smoke.sql` | product-open evidence는 migration 후 smoke와 non-BYPASSRLS RLS 확인을 요구한다 |

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

- SCIM signing SecretRef rotation monitoring uses `scim_providers.secret_rotation_policy` with default `periodic_90d`; closed values are `manual`, `periodic_30d`, `periodic_60d`, `periodic_90d`. `due_soon` begins 7 days before `rotation_due_at`; active non-decommissioned providers with `due_soon` or `overdue` status emit console-only `scim_secret_rotation` alerts. Decommissioned and `manual` providers do not emit rotation alerts.
- Production readiness evidence monitoring uses the latest non-deleted `production_readiness_evidence` row per evidence type. `readiness_evidence` alerts are console-only, `critical` when the latest row is `failed` or expired, and `warning` when valid evidence expires within 14 days. Missing evidence remains a readiness `deferred` gate rather than an ops alert.

- Ops notification webhook sender v1.1 is enabled as the only external send slice. `POST /v1/ops-alerts/{alert_id}/deliveries/send-webhook` creates `ops_notification_attempts(status='pending')` and enqueues `ops_notification_send`; optional `recipient_group_ref` is metadata-only routing evidence, and optional `callback_signature_secret_ref` is the only stored provider callback signing alias. Teams, Slack-specific auth, email/SMTP, provider-side recipient group resolution, and snooze remain closed.
- `ops.notification.delivery.max_attempts` defaults to 3 and `ops.notification.delivery.retry_after_ms` defaults to 5000. Attempt states are `pending|sending|sent|failed|dead_letter`; receipt states remain `sent|delivered|failed`.
- `integration.handoff.dispatch.max_attempts` defaults to 3 and `integration.handoff.dispatch.retry_after_ms` defaults to 5000. Attempt states are `pending|sending|accepted|failed|dead_letter`. Runtime dispatch maps provider HTTP 2xx to `accepted`, treats 429/5xx/network/timeout as transient until the max-attempt threshold, and never maps dispatch acceptance to `completed` without a provider receipt/callback.
- Webhook endpoints must be resolved from `endpoint_secret_ref` with SecretStore purpose `notification`, must be HTTPS, and the resolved host plus every redirect host must match request `allowed_hosts`. `recipient_group_ref` is stored as an audit-safe alias only and cannot contain endpoint URLs or secret material. `callback_signature_secret_ref` is stored on the originating attempt as a SecretRef alias only; raw signing key values are never stored. Raw endpoint URLs, Authorization headers, bearer values, tokens, SMTP passwords, webhook secrets, signing key values, path/query secrets, resolved SecretRef values, and provider response bodies are not stored.
- Webhook HTTP 2xx records a `sent` receipt only. `delivered` still requires external provider receipt/callback evidence. Public provider callbacks use `POST /v1/webhooks/ops-alerts/{tenant_id}/{attempt_id}` with JWT skipped and required `X-RPA-Ops-Notification-Event-Id`, `X-RPA-Ops-Notification-Timestamp`, and `X-RPA-Ops-Notification-Signature=sha256=<hex>` headers. `event_id` must equal `body.receipt_id`, timestamp skew is 5 minutes, and the signature payload is `{timestamp}.{receipt_id}.{canonical_json(metadata-only body)}` using the SecretStore value referenced by the originating attempt's `callback_signature_secret_ref`.
- A valid ops notification callback appends a new `ops_notification_deliveries` receipt with status `delivered` or `failed`; it never mutates a prior `sent` receipt into `delivered`. Missing sender config, denied SecretRef resolve, missing callback signing SecretRef, missing route policy/allowlist, unapproved host, network failure, invalid callback signature, or missing receipt must fail closed or stay deferred; success must not be synthesized.

- Product Open v1 delivery channel은 콘솔 alert center뿐이다. 모든 `OpsAlert.delivery`는 `{ channel:"console", status:"delivered", external_delivery:false }`이며 Teams/Slack/email/webhook 전송 성공으로 위장하지 않는다.
- `POST /v1/ops-alerts/{alert_id}/ack`는 `ops_alert.ack` + `Idempotency-Key`를 요구한다. 현재 계산 가능한 alert가 아니면 `RESOURCE_NOT_FOUND(reason=ops_alert_not_current)`로 실패한다.
- ack 원장은 `ops_alert_acknowledgements(tenant_id, alert_id, detected_at)` generation 키로 저장한다. 장애가 해소 후 재발해 `detected_at`이 바뀌면 이전 ack가 새 open alert를 숨기지 않는다. `GET /v1/ops-alerts` 기본은 `status=open`이며 `status=acknowledged|all`로 원장 반영 상태를 조회한다.
- v1.1 external delivery supports webhook sender attempts only. Candidate external channels remain `teams`·`slack`·`email`·`webhook`, but the active sender implementation is `webhook`; HTTP 2xx is recorded as `sent`, never as synthesized `delivered`.
- External delivery remains a separate leg from ack. The ack ledger does not indicate external send success/failure, and external send failure does not block `POST /ack`.
- `ops_notification_deliveries` receipt ledger는 metadata-only로 열려 있다. `POST /v1/ops-alerts/{alert_id}/deliveries`는 provider receipt를 기록하지만 네트워크 전송을 수행하지 않는다. `endpoint_secret_ref`/`credential_secret_ref`는 `secret://` 참조만 허용하고 raw URL/token/password/webhook secret/bearer 값은 summary/metadata/ref에 저장하지 않는다.
- readiness external-alert gate는 최신 provider receipt가 `delivered`이고 freshness window 안에 있을 때 pass할 수 있다. Signed provider callbacks that append `ops_notification_deliveries.status='delivered'` are valid delivery-ledger evidence for this gate. owner evidence로 대체할 때도 `channel`, `provider_alias`, `receipt_id`, `receipt_at`, `delivery_status=delivered` metadata가 필요하다. 최신 receipt가 `failed`면 blocked이고, `sent`/expired/missing이면 fresh valid owner evidence가 없는 한 deferred다. ack 원장은 이 gate의 증거가 아니다.
- 외부 전송 전제조건은 all-or-nothing이다: channel connector 활성화, endpoint/credential의 `SecretRef` 보관, 수신자/route policy, real send receipt가 모두 있어야 한다. 하나라도 없거나 unknown이면 외부 leg는 `deferred` 또는 미인큐 상태로 남기고, console alert만 노출한다. `sent`/`delivered`를 합성하지 않는다.
- v1.1 이후 남은 owner input: 비-webhook 채택 채널, SecretRef namespace/backend, provider-side 수신자 그룹 해석 owner, retry/DLQ 정책, 허용 endpoint domain/provider account ownership. 이는 Product Open v1 blocker가 아니다.

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
| `artifact.redaction_fail_threshold` | 5 | 2 | §B "실패 N회 → failed+알림" | 초과 시 `failed`+알림, 조회 차단(ARTIFACT_NOT_REDACTED). 코드 SSoT는 `ARTIFACT_REDACTION_FAIL_THRESHOLD` |
| `artifact_retention_sweeper` | daily 02:00 KST | tick | §B "일배치" | retention_until < now() 삭제+soft-delete |
| `artifact_integrity_checker` | daily | tick | §B | sha256 불일치 → quarantine+알림 |
| `artifact_orphan_sweeper` | daily | tick | §B | 참조 없는 object 정리(전역 BYPASSRLS 스캔) |
| `artifact.orphan_grace_default` | 24h | — | §B orphan_sweeper | 최근 생성 object 보호 유예(artifacts INSERT in-flight 오판 방지). now-mtime < grace 면 삭제 제외 |

### 6.1 Daily lifecycle sweeper non-dormancy

- `artifact_integrity_checker`와 `artifact_orphan_sweeper`는 `MAINTENANCE_TENANT_IDS`가 비어 있다는 이유만으로 휴면하면 안 된다.
- `artifact_orphan_sweeper`는 전역 object-store 작업이므로 tenant fanout 뒤에 숨기지 않고 daily cadence마다 1회 enqueue한다. BYPASSRLS 사용 시 `bypassrls.use` audit와 전용 infra role이 필수다.
- `artifact_integrity_checker`와 retention sweeper는 명시 tenant 목록이 있으면 그 목록을 사용하고, 목록이 비어 있으면 lifecycle 대상 row에서 tenant를 discovery해야 한다. discovery가 불가능하거나 BYPASSRLS/audit 경계가 준비되지 않았으면 `deferred`/ops alert로 표면화하고 성공으로 합성하지 않는다.
- tenant discovery 실패는 tenant-scoped retention/integrity fanout만 막는다. `artifact_orphan_sweeper`는 discovery 실패와 분리해 daily cadence마다 전역 1건을 enqueue해야 한다.
- default local/pilot 배포에서 daily sweeper가 비활성인 경우 release packet에 `BLOCKED(reason=lifecycle_daily_sweeper_owner)`로 남긴다.

### 6.2 DB payload retention 계약

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

Web Attended uses the same human-task defaults. `web_attended_run_requests.human_task_policy` and `run_resume_requests.human_task_policy` are snapshots of `human_task.default_timeout=30m`, `on_timeout=fail`, and the existing allowed human task kinds (`approval`, `validation`, `exception`, `captcha`, `mfa`). There is no separate Web Attended timeout or escalation default in Product Open v1.

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
- 실 외부 전달(네트워크 전송)은 더 이상 전부 future/deferred가 아니다. repo-local runtime은 `SinkDeliveryPort`
  `real_sink` 바인딩을 통해 HTTPS endpoint SecretRef를 해석하고, resolved host와 redirect host를
  `allowed_hosts`에 대해 검증한 뒤 `sink_idempotency_key`를 downstream `Idempotency-Key`로 보낸다.
  다만 customer/provider endpoint ownership, allowed-host approval, and SecretRef provisioning은 owner evidence로 남는다.
  `test_fake` 바인딩은 계속 local test evidence 전용이며 staging/product-open delivery evidence가 아니다.
- sink egress logging/evidence는 SecretRef 식별자, backend alias, allowed host, attempt_no/status, receipt/error alias만
  남길 수 있다. Authorization header, raw payload, resolved endpoint URL, resolved SecretRef material은 로그·감사·release evidence에 남기지 않는다.
  `sink.delivery.max_attempts`와 retry/dead-letter behavior는 기존 표와 동일하다.

---

## 9. 적용 규약

- **오버라이드 계층**: 시스템 기본(본 문서) < 테넌트 설정 < 사이트 프로파일 < 시나리오 노드 정책(`nodePolicy`). 좁은 범위가 우선.
- **테스트 픽스처값**은 시뮬레이션 클록(가상 시간)에서 전이/타임아웃 경로를 빠르게 검증하기 위한 값이며, 운영 의미는 동일(스케일만 축소). state-machine 전이 테스트·sweeper 멱등 테스트가 사용.
- **미확정(외부 사실)**: LLM 모델별 정확한 `maxContextTokens`·실제 Codex structured-output 스트리밍 지원범위는 구현 시 라이브 capabilities로 확정(README v1.4 §19). 본 문서 값은 안전 기본값.
- 모든 임계는 메트릭으로 노출(impl-bundle §E `*_rate`/`queue_depth` 등)되어 운영자가 조정 근거를 본다.
- Observability exporter default remains explicit: `OTEL_EXPORTER=none|console|prometheus|otlp` only. Unknown values fail closed at startup. `prometheus` exposes the existing low-cardinality runtime metrics on the health server `/metrics`; `otlp` requires `OTEL_EXPORTER_OTLP_ENDPOINT` or both trace/metric endpoint env vars. OTLP URLs must be absolute HTTP(S) and must not contain credentials, query strings, or fragments. Collector/dashboard/alert approval remains controlled-prod owner evidence, not an automatic green state.

---

## 10. Enterprise adoption profile defaults (90점+ 설계)

`docs/rpa-adoption-90plus-design-2026-06-29.md`의 도입 평가 기준을 운영 기본값으로 고정한다. 이 절은 구현 완료 증거가 아니라 pilot → controlled-prod 승격 시 필요한 운영 입력값의 단일 기준이다.

| Profile | 목적 | 기본 운영 기준 | 필수 증거 |
|---|---|---|---|
| `local-review` | 개발/리뷰 | Docker/Compose, local artifact store, console telemetry 허용 | static smoke, secret scan, package별 typecheck |
| `pilot` | 제한 업무 파일럿 | Compose 또는 단일 namespace, external DB backup, console 또는 webhook alert | migration fresh/baseline/re-run smoke, backup restore runbook, pilot charter |
| `controlled-prod` | 제한 운영 | managed PostgreSQL, object storage, OTLP/Prometheus, on-call/RACI | PITR 또는 backup restore drill, SLO dashboard, support/training completion, observability telemetry wiring evidence, incident rehearsal |
| `enterprise-scale` | 전사 확장 | CoE 운영, connector catalog, SSO/SCIM, WORM audit option 검토 | quarterly ROI report, DR decision, support/training refresh |

기본 RPO/RTO 제안:

| Profile | RPO | RTO | 비고 |
|---|---:|---:|---|
| `pilot` | 24h 이하 | 8h 이하 | 운영팀 승인값이 없으면 `BLOCKED(reason=rpo_rto_owner_decision)`로 남긴다 |
| `controlled-prod` | 15m 이하 | 2h 이하 | PITR/restore drill evidence 없이는 승격 금지 |
| `enterprise-scale` | 조직 SLA | 조직 SLA | multi-region/DR architecture decision 필요 |

Pilot adoption readiness evidence:

| Evidence type | Required signal | Freshness default | 비고 |
|---|---|---:|---|
| `pilot_charter_signoff` | 업무 범위, 성공/실패 기준, business owner 승인 | 파일럿 기간 내 | charter 원문은 외부 ticket/artifact에 두고 `evidence_ref`만 저장 |
| `raci_signoff` | business/platform/security/support owner와 escalation 책임 승인 | 90d | RACI 문서 원문/URL은 저장 금지 |
| `training_completion` | admin/developer/reviewer/approver 교육 완료 집계 | 90d | 긴 training roster 원문은 저장 금지, 집계 metadata만 허용 |
| `support_model_signoff` | L1/L2/L3, support hours, severity/escalation path 승인 | 90d | support model 문서 원문/URL은 저장 금지 |

`AutomationAdoptionEvidence.status`는 `valid|failed|deferred`로 닫는다. `evidence_ref`는 opaque ticket/artifact ref이며 raw URLs, tokens, passwords, webhook secrets, resolved SecretRef material, long raw documents, and raw training rosters are forbidden in `summary`, `evidence_ref`, and `metadata`.

운영 owner 입력값:
- `adoption.business_owner`: 업무 범위와 성공 기준 owner.
- `adoption.platform_owner`: runtime, DB, deployment, migration owner.
- `adoption.security_owner`: SecretRef, RBAC, audit, egress, retention owner.
- `adoption.support_model`: L1/L2/L3, support hours, escalation path.
- `adoption.roi_owner`: baseline/actual ROI 입력과 월간 리포트 owner.

값이 미정인 owner/SLA/RPO/RTO를 성공, healthy, delivered로 합성하지 않는다. 미정은 release packet과 readiness report에 `BLOCKED(reason=missing_owner_or_sla)`로 노출한다.

Controlled-prod observability evidence is tracked separately from SLO/on-call sign-off. `observability_telemetry_wiring` valid evidence requires metadata-only `exporter=prometheus|otlp`, `collector_ref`, `dashboard_ref`, `alert_route_ref`, and `sampled_at`; raw collector endpoints, dashboard URLs, alert webhook URLs, tokens, and resolved SecretRef material remain forbidden.

Controlled-prod support/training evidence is tracked separately from SLO/on-call sign-off and from pilot `AutomationAdoptionEvidence.training_completion`. `support_training_completion` valid evidence requires metadata-only `support_model_ref`, `training_completion_ref`, `trained_role_count`, `trained_user_count`, `coverage_percent`, and `completed_at`. Raw rosters, user lists, training documents, raw URLs, tokens/passwords/secrets, and resolved SecretRef values remain forbidden. Missing or expired evidence is a readiness `deferred` gate; failed evidence is `blocked`.

### 10.1 Deployment DB role split

| Runtime | DB role requirement | Evidence |
|---|---|---|
| API | non-`SUPERUSER`, non-`BYPASSRLS` application role | RLS row visibility smoke |
| Browser worker | non-`SUPERUSER`, non-`BYPASSRLS` application role for user traffic | lease/run visibility smoke |
| Lifecycle/maintenance worker | dedicated operational role only for approved BYPASSRLS work | `bypassrls.use` audit receipt |
| Migration runner | migration role; may own DDL but must not be reused for API traffic | migration ledger + smoke |
| Local compose | must provision the same split or clearly label superuser smoke as catalog-only evidence | release packet note |

`postgres` superuser로 API/worker/migrate를 모두 실행하는 compose는 review convenience일 수 있으나 product-open evidence가 아니다.
