# Staging Decision Proposals (DRAFT — not release evidence)

> 목적: `release-open-checklist.md`의 **Deploy-Time Provisioning Blockers 11건 전부**를 배포 시 오너가 닫기 쉽도록,
> **레포가 정당하게 결정할 수 있는 항목은 미리 작성**하고, **현실에 존재해야만 하는 외부 사실은 입력란으로**
> 남긴 초안.
>
> ⚠️ 이 문서는 **릴리즈 증거가 아니다.** 체크리스트 박스를 닫지 않으며 `blocked:audit` 게이트 상태를
> 바꾸지 않는다. `[PROPOSED]` 항목은 배포 시 오너 확정 시 release-decisions.md로 승격, `[EXTERNAL-FACT]`
> 항목은 실제 인프라 사실이 제공되어야 닫힌다(가정 금지 — 지어내지 않음).
>
> 근거: SecretRef 실사용은 `ts/security-middleware-contract.ts`(`SecretAccessRequest.purpose`,
> `SignedCommandRegistryEntry.verificationKeyRef`), `ts/core-types.ts`(`SecretStore`,
> `ConnectorManifestPermissions.secret_refs`), `security-contracts.md` §1·§5·§7에서 도출.

## 왜 일부는 레포가 못 닫는가

`blocked:audit`는 양방향 강제다 — 체크리스트의 미해결 블로커와 `product-open-candidate-report.md`의
blocked-decision 마커가 1:1로 묶인다. 이는 "외부 시스템에 실제로 존재하는 증거"가 있어야만 블로커가 닫히도록
한 의도된 안전장치다. 물리적 외부 사실(실제 배포 타깃·실제 Vault/KMS·실제 CI 로그)을 지어내 박스를 닫으면
**조용한 거짓 릴리즈 준비 상태**가 되어 "조용한 false 금지" 원칙과 레포 게이트를 동시에 위반한다.

---

## [DECIDED D8-A12] 3. SecretRef 네임스페이스 컨벤션 (체크리스트 row 45)

레포 결정 가능 — 네이밍은 시크릿 값이 아니라 규칙이다.

- 컨벤션: `rpa/<env>/<runtime>/<purpose>/<name>`
  - `<env>`: `staging` | `prod`
  - `<runtime>`: `api` | `runtime-worker` | `browser-worker` | `llm-gateway`
  - `<purpose>`: `SecretAccessRequest.purpose` 값(`executor` | `connector` | `resume_token_hmac` | `gateway_policy` | `object_store`) + signed-command registry 전용 namespace(`signed_command`, `SignedCommandRegistryEntry.verificationKeyRef`)
  - `<name>`: 자유 식별자(시크릿 값 아님)
- 런타임 ID ↔ 네임스페이스 resolve 권한 맵 (최소권한):

| 런타임 identity | resolve 허용 purpose | 비고 |
|---|---|---|
| `api` | `signed_command`, `resume_token_hmac`(검증), `object_store` | 컴파일/승격 시 서명 검증, challenge 토큰 검증, artifact reader/scenario-generation artifact producer |
| `runtime-worker` | `resume_token_hmac`, `executor`, `object_store` | R17 resume 복원, run_claim 자격, runtime artifact producer |
| `browser-worker` | `executor` | credential lease 로그인 자격 |
| `llm-gateway` | `gateway_policy` | LLM provider API 키 |
| `artifact-lifecycle` (redaction/retention 운영 role) | `object_store` | 아티팩트 lifecycle 객체 I/O 자격 (D8-A10, BYPASSRLS 운영 role, executor와 격리) |
| `connector-runtime` | `connector` | D7+ 격리(현재 연기) |

> resume_token_hmac 키 자료(kid 회전)는 DB 아님 — KMS/SecretStore 내부 책임(security-contracts §5).

## [DECIDED D8-A12] 4. 초기 SecretRef 인벤토리 (체크리스트 row 46, 식별자만)

코드 사용처에서 도출. **식별자/소유자/용도만 — 평문 없음.**

| SecretRef 식별자(예) | 소유 런타임 | 용도(코드 근거) |
|---|---|---|
| `rpa/staging/llm-gateway/gateway_policy/codex-primary` | llm-gateway | Codex SSE provider 키 (`gateway_policy`) |
| `rpa/staging/runtime-worker/resume_token_hmac/active` | runtime-worker | resume token HMAC (kid, KMS) |
| `rpa/staging/runtime-worker/object_store/s3-producer` | runtime-worker | runtime/gateway artifact producer object-store 자격 (`object_store`, S3 producer mode) |
| `rpa/staging/browser-worker/executor/<site>` | browser-worker | site 로그인 credential lease (`executor`) |
| `rpa/staging/api/signed_command/registry-verify` | api | shell `cmd_ref` 서명 검증 키(`verificationKeyRef`) |
| `rpa/staging/artifact-lifecycle/object_store/primary` | artifact-lifecycle | artifact redaction/retention object-store 자격 (`object_store`, D8-A10) |
| `rpa/staging/connector-runtime/connector/<connector_id>` | connector-runtime | connector manifest `secret_refs` (D7+ 연기) |

> 실제 인스턴스 수/사이트별 자격은 운영 시점 인벤토리 — 위는 코드가 요구하는 **네임스페이스 골격**.

## [DECIDED D8-A13] 5. 로테이션/브레이크글래스 정책 (체크리스트 row 47)

정책/주기는 레포 결정. **로테이션 오너 = 단일 프로젝트 오너**(release-decisions #13 — 별도 release/oncall 팀 없음; deploy 승인/롤백과 동일 주체). 실 핸들=배포 시 오너 본인.

- 로테이션 주기(제안 기본값): `gateway_policy` 90d, `resume_token_hmac` kid 180d(중첩 kid 회전, 무중단),
  `executor` credential 사이트 정책 우선·기본 90d, `signed_command` 검증 키 365d.
- 브레이크글래스: 침해 의심 시 즉시 회전 + 영향 SecretRef 무효화 + audit_log append(`secret.resolve` deny 기록)
  + 사후 24h 내 정상 키 재발급. 모든 break-glass 사용은 immutable audit 1건 필수.

## [PROPOSED→DECIDED D8-A11] 7. Producer retention 기간/근거 (체크리스트 row 40)

release-decisions #5(inline `retention_until`/`deleted_at`/`legal_hold`) + ops-defaults `events_outbox` 90d
패턴에 정합한 **제안 기본값**. ⚠️ `audit_log`는 규제 영향 — 컴플라이언스 오너 확정 필수.

> ✅ **승격됨 (release-decisions D8-A11 / ops-defaults §6.1)**: 운영 테이블(raw_items 30d·normalized 90d·idempotency=`expires_at`·artifacts 90d)은 ops-defaults SSoT로 결정. **`audit_log` 보존기간 값만** 컴플라이언스 오너 입력 대기([EXTERNAL-FACT]).

| Producer | 제안 retention | 근거 |
|---|---|---|
| `raw_items.raw_payload` | 30d | 원시 수집·재처리 창만 필요, 최단 |
| `normalized_records.record` | 90d | events_outbox 90d 정합 |
| `artifacts.object_ref` | 타입별, 기본 90d | artifacts 기존 retention 패턴 재사용 |
| `audit_log.payload` | **컴플라이언스 확정**(제안 365d+) | 규제/감사 보존 — 임의 단축 금지 |
| `control_plane_idempotency_keys.response_body` (비-D4.3) | D4.3 `expires_at`와 동일 source | 단일 retention source 유지 |

> 공통 fail-closed: 모든 payload-bearing writer는 `retention_until`을 명시하거나 insert 전 throw
> (이미 events_outbox에 적용된 패턴). 비-app writer도 동일 강제.

## [PROPOSED] B3. Artifact object-store redaction/retention 증거 형태 (체크리스트 rows 48-49)

증거의 **형태**는 `ts/runtime-contract.ts` 포트 계약에서 도출 — 레포가 정한다. 실 객체 I/O **값/영수증**은 외부 사실([EXTERNAL-FACT] 8).

- real 포트 바인딩: `ArtifactRealObjectStorePortBinding { kind:"real_object_store", backendAlias, credentialRef: SecretRef, evidenceSchemaRef:"artifact/object-io-evidence@1" }`.
  `test_fake` 바인딩은 `mayBeUsedAsStagingEvidence:false` — **계약상** staging 증거가 될 수 없다(편법 차단이 타입에 박혀 있음).
- 영수증 필수 필드(`ArtifactObjectIoEvidence` real 변형): `portKind:"real_object_store"`, `backendAlias`, `credentialRef`(SecretRef 식별자만), `operation:"redact"|"delete"`, `artifactRef`(public), `correlationId`, `receiptId`, `sha256?`. `objectRefInternalOnly:true` — `ObjectRef`는 로그/이벤트/감사에 절대 노출 금지(`publicEvidenceUsesArtifactRefOnly`).
- redaction 결과: `redacted`/`not_required`/`retryable_failed`/`terminal_failed`. finalize는 미만료 claim lease + `bypassrls.use` audit(useCase `artifact_redaction_job`, failClosed) 이후 CAS로만.
- retention 결과: `deleted`/`not_found`(멱등 성공)/`transient_failed`(→ `deleted_at` 설정 금지). useCase `artifact_retention_sweeper`.
- 제안 기본값(레포 결정 가능): redaction `maxAttempts`는 `ops-defaults.md` redaction/self-heal 상한에 정합(하드코딩 금지), retention 기간은 [PROPOSED] 7 표를 따른다.

> ✅ object-store 자격증명 SecretRef **purpose 결정됨 (release-decisions D8-A10)**: `SecretAccessRequest.purpose`에 전용 `object_store` 추가(`executor` 재사용 아님). 근거=least-privilege — 아티팩트 lifecycle 전용 운영 identity(`artifact_redaction_job`/`artifact_retention_sweeper`)만 resolve, executor user-traffic와 격리. 백엔드 alias/credential 값은 여전히 배포 시 [EXTERNAL-FACT] 8(지어내지 않음).

## [PROPOSED] B4. D5 Codex SSE 라이브 capability 증거 형태 (체크리스트 row 47)

증거의 **형태/금지 규칙**은 `app/poc/d5-codex-sse` 하니스가 이미 강제 — 레포가 정한다. 라이브 **출력**은 외부 사실([EXTERNAL-FACT] 9).

- 입력: 절대 HTTPS `CODEX_BASE_URL`(자격증명/query/fragment 금지), `CODEX_API_KEY`·`CODEX_MODEL`은 SecretRef/SecretStore로 레포 밖 해석.
- 기록: redacted `CODEX_EVIDENCE_ENDPOINT_ALIAS` / `CODEX_EVIDENCE_MODEL_ALIAS`만 — 원시 endpoint/model 식별자 금지.
- 필수 PASS: #1 basic SSE, #2 prompt-schema safe path, #4 abort. #3 native `json_schema`·#5 model metadata는 fallback 명시 시에만 GAP 허용.
- 하니스가 provider error body·secret-유사 필드를 출력 전 redaction(자체 테스트 `run test:redaction`).

---

## [EXTERNAL-FACT] 배포 시 사실 — 남은 항목과 해소된 항목

아래는 **현실에 존재해야만 하는 사실**이라 레포가 결정/생성할 수 없다. 이미 오너 증거가 제공된 항목은
해소 상태로 고정하고, 아직 남은 항목은 배포 시 오너가 redacted release packet으로 제공한다.

### 1. 구체 배포 거버넌스 (체크리스트 row 34)
거버넌스 모델은 release-decisions #13에서 확정(`staging` env, 승인·롤백은 단일 프로젝트 오너,
SecretRef 경유 — 외부 승인자/oncall 팀 없음). **남은 배포 시 사실**:
- [ ] 실제 플랫폼 repo (배포 코드 위치):
- [ ] GitHub Environment `staging` 보호/승인자 **실제 설정** (protection rules, required reviewers):
- [ ] 구체 배포 타깃 식별자 (namespace/service):
- [ ] 릴리즈 승인 주체 확인 (단일 오너 본인 — 외부 승인자 팀 없음):
- [ ] 롤백 주체 확인 (단일 오너 본인 — 외부 oncall 팀 없음):

### 2. SecretStore 백엔드 (체크리스트 row 35)
- [x] **(채택: HashiCorp Vault — D8-A14)** 실제 Vault mount/path: **KV v2, mount `secret/`, base `secret/data/rpa/staging/<runtime>/<purpose>/<name>`** (오너 확인, 평문 없음; auth=AppRole는 row 48 smoke에서 실증).

### 5. 로테이션 오너 (해소 — release-decisions #13 / D8-A13)
- [x] 로테이션 오너 = **단일 프로젝트 오너**(별도 release/oncall 팀 없음, #13과 동일 주체). 실 핸들=배포 시 오너 본인.

### 6. CI/배포 로그 증거 (row 43 release packet 입력)
- [ ] 프로비저닝 증거 아티팩트 **실제 위치**:
- [ ] CI/배포 로그의 "평문 미노출 + env dump 없음 + RBAC/redaction 미약화" **실제 증거 위치**:

> 위 항목은 실제 인프라가 프로비저닝되고 배포 CI가 한 번 돌아야 생성되는 **런타임/조직 사실**이다.
> 제공 즉시 release-decisions.md 승격 + 해당 체크리스트 행/blocked-decision 마커 정리(양방향 동시)로 닫는다.

### 8. Artifact object-store 백엔드/영수증 (해소 — D8-A15)
- [x] **(채택: S3/S3-호환 — D8-A14/D8-A15)** owner-operated S3-compatible store(MinIO), backend alias `[s3-staging-1]`, SecretRef-backed credential only; host/credential 평문 없음.
- [x] redaction 실 영수증: `artifact/object-io-evidence@1`, operation `redact`, `sha256`, `receiptId`, public `ArtifactRef`, internal `ObjectRef` 미노출. 근거: `product-open-candidate-report.md` object-I/O evidence packet.
- [x] retention 실 삭제 영수증: operation `delete`, `deleted` / `not_found` idempotent success, transient failure leaves tombstone unset. 근거: `product-open-candidate-report.md` object-I/O evidence packet.
- [x] operational `bypassrls.use` audit scope split and plaintext/PII/`ObjectRef` 미노출 증명은 `release-open-checklist.md` row 51/52와 runtime-worker claim evidence로 추적.

### 9. D5 라이브 모델 출력 (해소 — row 47)
- [x] staging LLM 오너의 `run poc` redacted 출력: aliases `[codex-staging-1]` / `[model-a]`, mandatory #1/#2/#4 PASS, #3 PASS, #5 documented GAP fallback. 평문 key/raw endpoint/model/env dump 없음.

### 10. Remote CI gate (해소 — current main evidence)
- [x] GitHub Actions hosted runner 복구 후 current `main` `Contract Gates` 재실행 완료: run `28098885737` / commit `a84d8b2a0cb3a8f0677e0149a0f1b930b7561425`.
- [x] 필수 job URL: secret-scan https://github.com/xorrbss/RPA-Enterprise/actions/runs/28098885737/job/83195321282 / migration smoke https://github.com/xorrbss/RPA-Enterprise/actions/runs/28098885737/job/83195321351 / app-runtime https://github.com/xorrbss/RPA-Enterprise/actions/runs/28098885737/job/83195321235 / web console https://github.com/xorrbss/RPA-Enterprise/actions/runs/28098885737/job/83195321285.

> 현재 남은 외부 입력은 1번 구체 배포 거버넌스와 6번 프로비저닝/배포 로그 위치다. 제공 즉시 row 43
> release packet을 validator로 통과시킨 뒤 체크리스트 행과 `product-open-candidate-report.md`의 blocked marker를 동시에 갱신한다.
