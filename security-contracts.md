# 보안 계약 (Security Contracts v1)

> 시크릿 경계·실행 격리·redaction·접근 통제의 단일 진실원천. `core-types.ts` brand 타입과 `impl-contracts-bundle.md` §A/§C를 보강해, 참조만 되고 정의가 없던 보안 항목을 고정한다.
> 원칙: **"조용한 false/unknown 금지"** — 미분류 위험은 `security` 예외로 차단(absorb 금지), 통과는 명시 통과만.
> 구현 scaffold: RBAC/tenant binding/SecretStore/artifact/allowlist/prompt-injection/LLM Gateway 경계 타입은 `ts/security-middleware-contract.ts`가 고정한다(실행 코드 아님).

---

## 1. SecretStore (시크릿 경계 진입점)

시그니처는 `ts/core-types.ts`의 `SecretStore`가 단일 정의. 규칙:
- `resolve(ref: SecretRef): Promise<PlainSecret>` 만 평문을 반환. 결과는 `PlainSecret`(brand `__DoNotLog`)이며 taint 추적 대상(`safeSerialize` 경계, impl-bundle §C).
- Executor/커넥터는 `SecretRef`만 보유. 평문을 LLM 메시지·로그·이벤트·artifact 경로에 전달 시 build/lint 차단.
- 권한 위반(스코프 밖 ref 접근) → `SECRET_ACCESS_DENIED`(security).
- 키 자료(HMAC 서명키 등)의 보관·회전은 SecretStore/KMS 내부 책임(§5).

---

## 2. shell 실행 — signed command registry

`ir.schema.json` action `shell`은 `cmd_ref`(필수)로 **등록된 명령만** 실행한다. registry 구조:

```ts
type SignedCommand = {
  cmd_ref: string;            // IR이 참조하는 키
  argv: string[];             // 고정 실행 파일 + 인자 템플릿(${var} placeholder)
  allowed_args: Record<string, { pattern: string }>;  // placeholder별 허용 정규식(자유 인자 금지)
  signature: string;          // 명령 정의에 대한 서명(배포 키로 검증)
  kid: string;                // 서명 검증 키 식별자(§5)
  verification_key_ref: SecretRef; // 서명 검증 키 material은 SecretStore/KMS 뒤에 둔다.
  side_effect_kind: "read_only" | "create" | "update" | "delete" | "upload";
};
```

운영 소스:
- API composition root는 `SIGNED_COMMAND_REGISTRY_MODE=vault`일 때 SecretStore에서 registry JSON을 읽는다. 기본 경로는 `rpa/<env>/api/signed_command/registry`이며, 배포별 override는 `SIGNED_COMMAND_REGISTRY_REF`로만 허용한다.
- `SIGNED_COMMAND_REGISTRY_MODE=deny_all`은 명시적인 fail-closed 모드다. 등록 명령 목록을 빈 배열로 제공하므로 shell `cmd_ref`는 모두 저장/승격에서 거부된다.
- registry SecretStore read 실패 또는 JSON 구조 불일치는 `unavailable`로 취급한다. shell action이 필요한 IR은 `shell_cmd_registry_unavailable`로 거부되어야 하며, unknown registry를 통과로 해석하지 않는다.

검증 시점(2단계):
- **컴파일(저장)**: `cmd_ref`가 registry에 존재해야 한다. 미등록 → 저장 거부(`IR_SCHEMA_INVALID`, reason=`shell_cmd_unregistered`).
- **런타임**: 실행 직전 서명 재검증(변조 방지) + 인자가 `allowed_args` 패턴 충족. 위반 → `SHELL_COMMAND_NOT_ALLOWED`(security), 실행 안 함.

격리: v1은 서버 내장 실행이며 **네트워크/SecretStore 직접 접근 금지**(impl-bundle §A 커넥터 hook과 동일 제한). 강한 프로세스/WASM 격리는 3rd-party 단계로 연기(README #12).

---

## 3. Prompt Injection 탐지

목적: 페이지 텍스트에 숨은 "지시문"이 LLM을 조종(allowed action 이탈·시크릿 유출 유도)하는 것을 차단. `PROMPT_INJECTION_DETECTED`(security)로 surfacing.

| 항목 | 규약 |
|---|---|
| 탐지 지점 | Gateway redaction 단계(§4 step2) — **adapter 진입 전**. observe/extract/act 모든 페이지 텍스트 입력 대상. |
| 신호 | (a) 가시성 0 텍스트(hidden/invisible/오프스크린)에 명령형 문구, (b) "ignore previous / system / 너는 이제~" 류 지시 패턴, (c) 시크릿/자격증명 요청 문구, (d) allowed domains 밖 URL 유도. |
| 판정 | 신호 ≥1 → **차단(기본)**. 단일 약신호는 `uncertain`로 두지 않고(조용한 unknown 금지) 보수적으로 차단 후 Human Task(kind=exception) 에스컬레이션 옵션. |
| 결과 | 해당 step `security` 예외 → Run R10(aborting) 또는 노드 verify `abort_security`. evidence(마스킹된 발췌)만 artifact 저장. |

탐지 픽스처는 impl-bundle §C 목록(hidden-instruction 텍스트)과 공유. 구현 시 신호 (b)의 패턴 사전은 운영 정책으로 갱신(Phase 3 기본값 문서).

---

## 4. Redaction 경계 & 알고리즘 (Gateway 소유)

> [FIX] `llm-gateway-adapter.md`가 "redaction은 Gateway §5.1 step2"라 참조했으나 §5.1 문서가 패키지에 없었다(댕글링). 본 절이 그 정의이며, adapter md의 §5.1 참조는 **본 문서 §4**를 가리킨다.

Gateway 호출 파이프라인:
1. **step1 — 입력 조립**: system/user 메시지 분리. 페이지 텍스트·추출물은 항상 `user`.
2. **step2 — redaction(차단 지점)**: 아래 대상 마스킹 + §3 injection 탐지. 통과분만 `RedactedString`/`RedactedContentBlock`로 brand.
3. **step3 — adapter 전달**: adapter는 redaction 책임 없음(이미 마스킹된 참조만 수신, adapter md §2).

redaction 대상(필드/패턴):
- 자격증명: password/secret/token 필드, OTP, Authorization 헤더값.
- PII: 주민/여권/카드/계좌/전화/이메일(사이트 프로파일별 정책으로 확장 가능).
- 이미지: VLM 입력은 민감 영역 마스킹 후 `vlm_input` artifact 참조만(adapter md §6).
- hidden-instruction(§3) 텍스트: 마스킹 + 탐지.

규약: redaction 실패/미수행 입력은 adapter로 보낼 수 없다(brand 미부여 → 타입/lint 차단). 산출 artifact는 `redaction_status` 게이트(impl-bundle §C) 통과 전 조회 불가(`ARTIFACT_NOT_REDACTED`).

---

## 5. resume_token HMAC 키 & 회전

`reserved-handlers.md` ResumeToken의 `kid`/`hmac` 경계:
- 키 자료는 **SecretStore/KMS 도메인**(DB 테이블 아님). `kid`는 활성 서명키 식별자.
- 회전: 새 키 발급 시 `kid` 증가, 신규 토큰은 신 키로 서명. 검증은 토큰의 `kid`가 가리키는 키로 수행 → **무중단 rotation**. 폐기 키는 검증 목록에서 제거(유예 기간 후).
- 검증 실패(kid 미존재/서명 불일치/만료) → resume 거부, 재로그인 우회 또는 `system` 예외(reserved-handlers §복원). 만료값 기본은 Phase 3 운영 기본값 문서.

---

## 6. Network Policy & 도메인 allowlist

`RunContext.networkPolicyId`가 가리키는 정책 구조:
```ts
type NetworkPolicy = {
  id: string;
  allowed_domains: string[];     // 정확/와일드카드(*.vendor.com) 허용 목록
  block_on_violation: true;      // Product Open: monitor-only false is not contracted
};
```
- Implementation status (2026-06-29): worker run-drive/resume now pass `network_policies.allowed_domains` into `BrowserSessionProvider.bind`, which requires a CDP `Fetch`/`Network` browser guard before a lease session is registered. `UtilityExecutor.navigate` and `api_call` still perform preflight allowlist checks, while the browser guard blocks off-allowlist navigation, subresource/fetch/XHR-style requests, iframe/document loads, WebSocket handshakes, and downloads with `DOMAIN_POLICY_VIOLATION`.
- Audit evidence (2026-06-29): production worker composition injects `PgDurableSecurityAuditDecisionWriter` into the browser guard. Guard decisions append durable `network.request` audit rows before `Fetch.continueRequest` or `Fetch.failRequest`; audit append failure blocks the request fail-closed.
- **enforce 지점**: 브라우저 navigation + 모든 outbound request 가로채기. allowed_domains 밖 이동/요청 → 차단 + `DOMAIN_POLICY_VIOLATION`(security, 침해 의심 알림).
- `@challenge`/login 우회 중에도 정책 유지. 정책은 site profile과 독립적으로 run에 바인딩(Phase 2 site_profiles와 FK 연계).

---

## 7. Connector manifest permissions

`impl-contracts-bundle.md` §A 커넥터의 권한 선언:
```ts
type ConnectorManifestPermissions = {
  api: ("migrateSchema" | "registerTargets" | "readConfig")[];   // 화이트리스트 ctx.api만
  network: false;                                                // v1 항상 false(원격 작업 미지원)
  secret_refs: string[];                                         // 접근 가능한 SecretRef 네임스페이스
};
```
- **검사 지점**: `validate`(등록) 시 manifest 서명 + 선언 권한이 화이트리스트 부분집합인지. enable 전 `install`에서 재확인.
- 선언 외 API/네트워크/시크릿 접근 시도 → `CONNECTOR_PERMISSION_DENIED`(security), 빌드/런타임 차단.

---

## 8. Artifact 접근 통제 (redaction 게이트 + RBAC)

impl-bundle §C access middleware는 `redaction_status` 게이트만 강제했다. **RBAC 게이트 추가**:
- artifact 조회 = `redaction_status ∈ {redacted, not_required}` **AND** 호출자 역할이 해당 tenant/run의 artifact 조회 권한 보유(Phase 2 RBAC 역할 레지스트리).
- 권한 부족 → `SECRET_ACCESS_DENIED`(security). 두 게이트는 미들웨어 1지점에서 순서대로(redaction → RBAC) 검사.

### 8.1 Artifact object at-rest 기밀성 (매체 계층)

객체 at-rest 기밀성은 **배포 저장·매체 계층**(디스크 암호화·S3 버킷 SSE·백업 암호화)이 제공하며, 이 매체 암호화가 실제 적용돼 있음은 오너가 증빙으로 확인한다(deferred 결정 Q2-1 = 적용됨). 애플리케이션은 v1에서 **객체 레벨(봉투) 암호화를 추가하지 않는다**.
- **누출면 한정**: artifact read API는 redacted 서빙이다(`app/src/api/reads-artifacts.ts` 부근 — RLS가 `redaction_status ∈ {redacted, not_required}`·미삭제·비격리 row만 노출, 나머지는 404). 따라서 앱-계층 누출면은 없고, 잔여 at-rest 노출면은 **매체/백업/포렌식**으로 한정된다 — 그 표면을 매체 계층 암호화가 담당한다.
- **승격 경로(현재 미적용)**: 규제·고객 계약이 애플리케이션 레벨 기밀성(kid 회전·테넌트별 키 분리·`tenant_id|artifact_id` AAD 바인딩)을 요구하면, 세션 봉투암호화 선례(`app/src/runtime/browser-session-store.ts`의 `KmsEnvelopeSessionEncryptor` — AES-256-GCM `[version|wrappedDek|body]`, 현재 정의만 되고 배선되지 않음)를 ObjectStore 경계에 재사용해 승격한다. v1은 이 경로를 배선하지 않는다(계약이 요구하지 않는 신규 보안 강화 결정이므로 명시 승인·별도 계약 필요). 승격 시 integrity checker의 sha256 대조 기준(평문 vs 암호문)을 함께 재정의해야 한다. 근거·옵션은 `docs/deferred-design-decision-packets-2026-07-11.md` §2.

---

## 9. action.sensitive & recording 동작

`ir.schema.json` action `sensitive`(기본 false)·nodePolicy `recording`(기본 `masked_on_failure`)의 런타임 의미:

| recording | 동작 |
|---|---|
| `always` | 매 step 화면 기록(증빙). `sensitive=true` 입력 영역은 항상 마스킹 후 저장. |
| `masked_on_failure` (기본) | 성공 step은 기록 안 함; **실패 시에만** 마스킹된 화면 저장(디버깅). |
| `never` | 화면 기록 없음(증빙 불가 — side_effect 노드엔 부적합). |

규칙: `sensitive=true` action의 입력값은 recording 모드와 무관하게 **항상 마스킹**(평문 화면 저장 금지). 어떤 모드든 저장 artifact는 §4/§8 게이트를 통과해야 조회 가능.

---

## 10. Immutable audit log append 계약

보안 경계 판정(SecretStore resolve, artifact 조회, connector enable/install, domain policy 위반, prompt injection 차단, BYPASSRLS 사용)은 append-only audit log에 남긴다.

규약:
- audit writer 인터페이스는 `append(input): Promise<record>`만 노출한다. update/delete/upsert는 계약에 없다.
- record는 `tenant_id`, actor, action, outcome, reason, `correlation_id`, `idempotency_key`, `occurred_at`, `previous_hash`, `hash`를 포함한다.
- payload는 `safeSerialize` 경계를 먼저 통과해야 한다. `PlainSecret`이 payload 그래프에 있으면 append 실패(`SECRET_ACCESS_DENIED`)이며 hash 계산으로 넘어가지 않는다.
- hash는 canonical payload와 `previous_hash`로 결정적으로 산출한다. 저장소 구현은 hash-chain 검증을 운영 점검에 노출해야 한다.
- v1 durable authority is PostgreSQL `audit_log`. The table is tenant-scoped, append-only, and hash-chained by `(tenant_id, previous_hash) -> (tenant_id, hash)`; external WORM storage may mirror it later but is not the v1 authority.
- D4.4 repo-owned writer boundary is `DurableSecurityAuditDecisionWriter` (`ts/security-middleware-contract.ts`); the app-runtime PostgreSQL implementation is `PgDurableSecurityAuditDecisionWriter` (`app/src/api/security-audit.ts`). Control-plane/runtime paths that make `artifact.read`, `secret.resolve`, `connector.enable`, `connector.install`, `network.request`, `prompt.inspect`, or `bypassrls.use` decisions must append through this boundary before returning allow/deny/blocked results.
- Boundary rows use `payload_schema_ref = audit/security-boundary-decision@1`, explicit `retentionUntil`, and `failClosed = true`. If safe serialization, payload schema selection, retention timestamp validation, or durable append fails, the caller must fail closed and must not return protected artifacts, PlainSecret material, connector activation, network/prompt continuation, or BYPASSRLS work.
- Broader API routes that are not implemented in the repo-owned app runtime remain scoped out of executable staging evidence until they are wired to this boundary or explicitly excluded in the staging packet.
- `audit_log.payload` is a payload-bearing column and therefore carries inline `retention_until`, `deleted_at`, and `legal_hold`. Audit retention/deletion evidence is appended; audit rows are not updated or deleted in place.
- `audit_verifier_runs` is the tenant-scoped operational evidence table for hash-chain checks. Manual API verification requires `audit.verify`; listing evidence requires `audit.read`. The maintenance scheduler enqueues tenant-scoped `audit_verifier` jobs hourly for tenants with audit rows; runtime exceptions are recorded as `status=failed` evidence rather than reported as unknown healthy. Results are retained for 90 days by default, expose metadata-only violations (`sequenceNo`, `id`, `kind`, `detail`), and never return raw audit payload bodies. Tampering is recorded as `status=invalid`, not reported as unknown healthy.

TS 코드 계약: `ts/security-middleware-contract.ts` `ImmutableAuditLogAppendOnly`, fixture scaffold: `security/compliance-scaffold.ts` `InMemoryImmutableAuditLog`, app integration evidence: `app/test/security-audit.int.ts`.

---

## 11. Minimum BYPASSRLS policy 코드 계약

`auth-rbac.md` §4의 "BYPASSRLS 도메인"은 애플리케이션 롤이 아니다. 최소 정책은 코드 상수로도 고정한다(`MINIMUM_BYPASS_RLS_POLICY`).

최소 조건:
- application role은 `BYPASSRLS` 권한을 가질 수 없다.
- `BYPASSRLS` 전용 DB role은 user HTTP/API traffic을 처리할 수 없다.
- 전용 DB role, reason code, immutable audit append가 모두 필수다.
- 허용 use case는 schema migration, artifact redaction/retention/integrity/orphan jobs, lease sweeper, scheduler/worker registry infra 작업으로 제한한다.
- maintenance tenant discovery가 tenant 경계를 넘는 catalog/data scan을 수행하려면 전용 BYPASSRLS operational role과 `bypassrls.use` audit가 필수다. 대안은 tenant별 non-bypass transaction에서 `SET LOCAL app.tenant_id`를 바인딩해 실행하는 것이다.
- app-role에서 `SET LOCAL app.tenant_id` 없이 cross-tenant discovery 쿼리를 실행하는 설계는 금지한다. superuser에서만 동작하는 discovery는 product-open evidence가 아니다.
- artifact integrity/orphan sweeper는 `MAINTENANCE_TENANT_IDS` 공백 때문에 조용히 휴면하면 안 된다. orphan sweeper는 전역 object-store 작업으로 매 cadence 1회 실행하고, BYPASSRLS 사용 시 audit evidence를 남긴다.
- artifact redaction/retention object I/O는 `real_object_store` 포트 바인딩 + `SecretRef` credential path + `artifact/object-io-evidence@1` 성공 receipt가 있어야 finalize CAS가 가능하다. `test_fake` / `artifact/object-io-local-test@1` 포트는 repo-local 테스트 전용이며 staging/product-open object-store evidence로 인용 금지.
- object I/O evidence는 `ArtifactRef`, backend alias, `SecretRef` 식별자, receipt id, operation, sha256 메타데이터만 기록할 수 있다. `ObjectRef`, `PlainSecret`, resolved secret material은 audit/log/event/release evidence에 남기지 않는다.
- 그 외 운영 편의성 작업은 `TODO: [BLOCKED]` 결정 없이 확장 금지. Required decision: 신규 BYPASSRLS use case, operational DB role, reason code, immutable audit append contract.

TS 코드 계약: `ts/security-middleware-contract.ts` `BypassRlsPolicyContract` 및 `MINIMUM_BYPASS_RLS_POLICY`.
- Release/staging evidence may record only `SecretRef` identifiers, SecretStore backend aliases/paths, namespace conventions, runtime identity aliases, and `secret.resolve` audit outcome metadata such as row IDs, hashes, counts, and allow/deny results. It must never include `PlainSecret`/resolved material, value-derived hashes or fingerprints, raw credential payloads, or sensitive backend paths designated non-evidence by the staging owner.

---

## 12. SCIM inbound signature boundary

SCIM sync is not a free-form admin upsert. It is a two-gate boundary:
- Gate 1: normal control-plane authentication and RBAC. The caller must authenticate as a tenant principal with `scim.sync` (admin) permission.
- Gate 2: registered provider signed request. `scim_providers` is tenant-scoped and stores only provider metadata plus `signature_secret_ref`; HMAC material stays behind `SecretStoreBoundary.resolveAuthorized(purpose='connector', connectorId='scim:<provider_key>')`.

Request headers:
- `X-RPA-SCIM-Timestamp`: epoch seconds. The provider row controls maximum clock skew; stale or malformed timestamps are `UNAUTHENTICATED`.
- `X-RPA-SCIM-Signature`: `sha256=<hex>`.

Signing payload:

```text
{timestamp}.POST./v1/scim/principals.{provider_key}.{schema_version}.{canonical_json(body)}
```

Rules:
- Provider row missing/disabled is `AUTHZ_FORBIDDEN`, not implicit bootstrap.
- Only `schema_version='scim-principal@1'` is contracted. Unknown or mismatched schemas are `IR_SCHEMA_INVALID`; no best-effort field interpretation.
- Provider external identity `(tenant_id, idp_provider, external_id)` is immutable for a `sub`. Moving it to another `sub`, or relinking an already externally linked `sub`, is `IR_SCHEMA_INVALID`.
- SCIM role sync may create/revive/revoke only `source='scim'` role assignments. Token roles and `source='manual'` assignments remain outside the SCIM lifecycle.
- SCIM group-to-role mapping is repo-owned, not inferred from IdP semantics. `scim_group_role_mappings` is the tenant-scoped source of truth for opaque external group strings; only `status='active'` rows map to closed RPA roles.
- A SCIM principal body must contain exactly one role source: direct `roles` or `external_groups`. Mixing both, omitting both, or sending any unmapped/disabled external group is `IR_SCHEMA_INVALID`; no principal or role upsert may be committed.
- `signature_secret_ref` may be logged or audited only as a SecretRef identifier. The resolved HMAC key, value-derived hash, or fingerprint must not appear in logs, audit payloads, events, screenshots, or release evidence.
- `secret_rotation_policy` is metadata-only and closed to `manual`, `periodic_30d`, `periodic_60d`, `periodic_90d` (default `periodic_90d`). Rotation monitoring computes `rotation_due_at` from `COALESCE(last_secret_rotated_at, created_at)` and never resolves or stores signing secret material. Decommissioned providers surface `rotation_status='decommissioned'` and do not raise SCIM rotation ops alerts.

---

## 13. Ops alert external notification SecretRef boundary

Product Open v1 uses the console alert center as the in-product delivery channel. v1.1 opens one external network send path: SecretRef-backed webhook notification attempts. The same security boundary applies to the current webhook sender and any future Teams/Slack/email expansion:
- Channel enum candidates are `teams`, `slack`, `email`, and `webhook`; only `webhook` has an active runtime sender in v1.1. `console` remains the in-product delivery channel and does not require external SecretRef material.
- Endpoint URLs, webhook path/query, bearer tokens, SMTP credentials, provider signing secrets, and channel-specific credentials are `SecretRef` material. API/config/audit surfaces may store only SecretRef identifiers, backend aliases, runtime identity aliases, route policy ids, provider/channel aliases, and non-secret display labels.
- Required runtime namespace shape for the active sender is `rpa/<env>/notification-sender/notification/<channel>/<name>`, resolved by the dedicated `notification-sender` runtime identity with SecretStore purpose `notification`. Reusing executor/site credentials for notification delivery is not allowed without a versioned contract change.
- Endpoint allowlist is metadata, not a substitute for SecretRef. The resolved endpoint host must match the approved provider/domain policy; redirects to unapproved domains, missing allowlist, unresolved SecretRef, denied resolve, disabled connector, or missing provider receipt all fail closed.
- Delivery evidence may record channel, provider alias, SecretRef identifier, receipt id, status class, attempt count, and redacted error code. It must not record PlainSecret, resolved endpoint URL, Authorization headers, webhook body containing secret material, recipient secrets, or value-derived hashes/fingerprints.
- `ops_notification_deliveries` is a receipt ledger, not a sender. `ops_notification_attempts` owns sender state (`pending|sending|sent|failed|dead_letter`) and retry/DLQ for webhook. `sent`/`delivered` requires a provider receipt id and `failed` requires a redacted error code. HTTP 2xx webhook sends record `sent`, not synthesized `delivered`. `test_fake` sender receipts are repo-local test evidence only and cannot satisfy staging/product-open external delivery evidence.
- Ack remains a separate authorization and ledger boundary. `ops_alert_acknowledgements` proves only operator acknowledgement; it must not be used as proof that Teams/Slack/email/webhook delivery happened, and external delivery failures must not weaken `ops_alert.ack` RBAC.
- Remaining owner input after webhook v1.1: Teams/Slack/email channel contracts, recipient/group routing policy owner, provider-specific authentication policy, rotation cadence, and break-glass owner for non-webhook channels.

### 13.1 Sink delivery egress SecretRef boundary

Sink delivery egress is a repo-local runtime capability when the injected `SinkDeliveryPort` is bound as `real_sink`; it is not a blanket claim that production/customer external delivery evidence is complete.
- `real_sink` must resolve an HTTPS endpoint from SecretRef material and must validate the resolved endpoint host, plus redirect hosts, against the configured `allowed_hosts`. Raw endpoint URLs, path/query secrets, bearer values, passwords, Authorization headers, provider credentials, and resolved SecretRef material must not appear in request bodies, responses, audit payloads, logs, release evidence, or UI state.
- The downstream idempotency value is `sink_idempotency_key = tenant_id:sink_config_id:schema_ref:natural_key`; the runtime sends it as the external `Idempotency-Key`, and all retry attempts for the same normalized record/sink config reuse that value.
- Sink egress evidence may record only SecretRef identifiers, backend aliases, allowed host names, sink config id, normalized record id, attempt number, status class, receipt alias, and redacted error code. Raw payload bodies and Authorization header values are never evidence fields.
- Customer/provider endpoint ownership, allowed-host approval, and SecretRef provisioning remain owner evidence. A repo-local `real_sink` implementation, or a passing local test, cannot close those owner-evidence gates by itself.
- Retry and dead-letter behavior remains governed by `ops-defaults.md#sink.delivery`: transient failures retry under the injected `SinkDeliveryPolicy`; max-attempt exhaustion becomes `dead_letter`/`SINK_DELIVERY_FAILED`. `test_fake` sink ports are local test evidence only.

---

## 14. Enterprise adoption AI/IDP/federation security boundary

90점+ 도입 설계는 기능 폭을 과장하지 않고 외부 시스템 연계 경계를 명시한다. 이 절은 `docs/rpa-adoption-90plus-design-2026-06-29.md`의 market-federation 전략을 보안 계약에 고정한다.

### 14.1 AI governance evidence

LLM/AI 기능은 다음 evidence 없이는 enterprise-scale 기능으로 표시할 수 없다.

| Evidence | 보안 경계 |
|---|---|
| model registry | provider/model/version, tenant allowlist, data retention policy만 저장. provider credential은 `SecretRef` |
| prompt registry | template id, owner, version, eval set id, rollback target만 저장. 민감 payload 원문 저장 금지 |
| eval result | prompt injection, data leakage, hallucination, policy block 결과를 redacted evidence로만 저장 |
| cost control | tenant/scenario budget, per-run cap, anomaly alert. billing credential은 `SecretRef` |
| human override | override actor/action/reason/correlation id를 audit append. override가 AI 원판정을 삭제하지 않음 |

AI 판단을 감사 가능한 결정으로 쓰려면 policy decision id와 audit correlation id를 연결해야 한다. 연결이 없으면 "AI approved" 같은 성공 상태로 표시하지 않는다.

Implementation contract:
- `ai_governance_evidence` is the tenant-scoped metadata-only ledger for these five evidence classes.
- `GET /v1/ai-governance/evidence` uses `ai_governance.read`; `POST /v1/ai-governance/evidence` uses `ai_governance.manage` plus `Idempotency-Key`.
- `status=valid` evidence must include `evidence_ref`, `policy_decision_ref`, and an existing `audit_log.correlation_id`. Model/prompt/eval/cost-control evidence also needs future `expires_at`; human override evidence is event-scoped and may omit expiry.
- Evidence fields may store opaque aliases, policy refs, artifact refs, audit refs, pass/fail metrics, and non-secret summary metadata only. Raw prompts, model outputs, prompt/output bodies, endpoint URLs, provider credentials, bearer values, tokens, passwords, webhook secrets, resolved SecretRef material, payloads, and document bodies are forbidden in `summary`, `subject_ref`, `evidence_ref`, `policy_decision_ref`, and `metadata`.

- Runtime AI enforcement is a separate policy decision, not an inference from the evidence table alone. Required decision: tenant/customer AI policy must define enforcement mode (`observe`, `warn`, `block`), subject mapping, grace period, emergency override owner, and `policy_decision_ref` before missing or expired AI governance evidence may block `/v1/runs`, model selection, or prompt template rollout.
- `ai_runtime_policies` is the tenant-scoped runtime enforcement contract. `GET /v1/ai-governance/runtime-policy` uses `ai_governance.read`; `PUT /v1/ai-governance/runtime-policy` uses `ai_governance.manage` plus `Idempotency-Key`. Policy refs are opaque metadata; raw prompts, model outputs, endpoint URLs, provider credentials, bearer values, tokens, passwords, webhook secrets, resolved SecretRef material, payloads, and bodies are forbidden.
- In `block` mode without active grace, run creation and the LLM Gateway fail closed with `AI_GOVERNANCE_POLICY_BLOCKED` when required model registry, prompt registry, eval result, or cost-control evidence is missing, expired, deferred, or failed. Production readiness must evaluate deployment-configured model/prompt template versions together with observed LLM call versions, so a fresh deployment cannot pass AI governance readiness merely because no call has occurred yet. The LLM Gateway must append a fail-closed `ai_governance.enforce` audit decision before returning the block.

### 14.2 External IDP/OCR boundary

Product Open v1은 OCR/IDP 완성 제품을 주장하지 않는다. 외부 IDP/OCR 연계를 여는 경우:
- 열린 제품 표면은 외부 IDP/OCR 공급자가 이미 산출한 **metadata-only normalized result intake**다. 본 시스템이 이미지/PDF OCR 엔진, provider-side classification/extraction/validation 엔진, 또는 장문 OCR 전문 저장소를 제공한다고 주장하지 않는다.
- OCR/IDP provider credential, raw endpoint URL, webhook/callback URL, webhook secret, storage credential, bearer/API token, Authorization header, signed URL은 모두 `SecretRef`/SecretStore 경계 뒤의 material이다. API/config/audit/event/release evidence/UI state에는 SecretRef 식별자와 provider alias 같은 비밀 아닌 별칭만 남길 수 있고 resolved material은 남길 수 없다.
- API/audit/event에는 provider alias, document job id, normalized extraction schema id, field key/value, field confidence, validation task id, provider receipt id/receipt_at, opaque evidence_ref, redacted error code, non-secret metadata만 기록한다. `evidence_ref`는 외부 증거 별칭이지 raw URL 또는 signed object path가 아니다.
- 원본 문서 bytes, 원문 OCR 전문, 장문 OCR text block, provider response body, provider token/secret, raw endpoint URL, signed URL, callback secret은 DB payload, 로그, 감사, event, LLM payload, release evidence, UI state에 남길 수 없다.
- `POST /v1/document-jobs/{job_id}/external-extractions`는 `document_job.manage` RBAC, tenant-scoped `job_id`, `Idempotency-Key`, provider receipt replay key를 강제한다. cross-tenant job 참조, receipt mismatch replay, idempotency hash mismatch는 fail-closed다.
- confidence threshold 미달, schema mismatch, provider receipt 부재, media type 미지원은 human validation 또는 fail-closed로 처리한다.
- 외부 IDP 결과가 없는데 extraction success를 합성하지 않는다.

### 14.3 Existing RPA handoff boundary

Implementation boundary:
- `integration_handoffs` is a control-plane handoff request ledger, `integration_handoff_dispatch_attempts` is the durable outbound provider attempt ledger, and `integration_handoff_receipts` is the provider receipt ledger. They record metadata and status evidence only.
- `POST /v1/integration-handoffs` does not perform external provider dispatch. Dispatch is explicit through `POST /v1/integration-handoffs/{handoff_id}/dispatch`, which creates an idempotent attempt and enqueues `integration_handoff_dispatch`.
- Callback/webhook and dispatch endpoint material is SecretRef-only. `callback_url_secret_ref` may store a callback endpoint SecretRef identifier, `callback_signature_secret_ref` may store a provider callback HMAC verification SecretRef identifier, and dispatch attempts store only `endpoint_secret_ref`, but raw callback URLs, webhook URLs, provider endpoint URLs, path/query secrets, bearer tokens, passwords, Authorization headers, provider credentials, signing keys, and resolved SecretRef material must not appear in request bodies, responses, audit payloads, logs, release evidence, or UI state.
- Runtime dispatch resolves `endpoint_secret_ref` through `SecretStoreBoundary` with `purpose="connector"`, `connectorId=provider_alias`, and runtime identity `integration-handoff-dispatcher`; it requires HTTPS, public-host `allowed_hosts`, redirect host revalidation, timeout handling, retry/backoff, and `dead_letter` final failure. A provider 2xx response may mark the handoff `accepted`; `completed` still requires a provider receipt/callback.
- `POST /v1/integration-handoffs/{handoff_id}/callback` is a JWT/RBAC-protected control-plane receipt recording endpoint guarded by `integration.handoff`. It is not public provider ingress.
- `POST /v1/webhooks/integration-handoffs/{tenant_id}/{handoff_id}` is the public provider callback ingress. It skips JWT, verifies `X-RPA-Integration-Signature=sha256=<hex>` over `{timestamp}.{receipt_id}.{canonical_json(body)}`, resolves only `callback_signature_secret_ref` through `SecretStoreBoundary` with `purpose="connector"` and runtime identity `api`, enforces a five-minute timestamp window, and uses `(tenant_id,handoff_id,receipt_id)` as the replay key.
- Handoff request/dispatch/receipt payloads may record provider alias, handoff id, external job id, receipt id, status class, idempotency key, redacted error code, allowed host names, SecretRef identifiers, and non-secret metadata only.

Desktop/SAP/Citrix/Office 자동화는 Product Open/P0 범위가 아니다. 기존 RPA 제품에 handoff하는 경우:
- handoff credential과 endpoint는 `SecretRef`로만 저장한다.
- handoff request/receipt에는 external system alias, job id, status class, idempotency key, redacted error code만 저장한다.
- 외부 RPA job의 `accepted`와 실제 업무 `completed`를 분리한다. provider callback/receipt 없이 completed로 표시하지 않는다.
- 외부 RPA가 처리하는 화면/파일/자격증명은 본 시스템의 redaction/RBAC/audit 경계 밖 외부 사실로 표시한다.

### 14.4 CAPTCHA/MFA rule

CAPTCHA/MFA 자동 해결은 enterprise adoption score를 올리기 위한 기능으로 주장하지 않는다. 기본 동작은 human-first suspend이며, 자동 우회/해결은 법무·보안·사이트 정책 owner 승인과 별도 계약 없이는 금지한다.
