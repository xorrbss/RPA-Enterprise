# DG-4 설계 스펙 — 콘솔 자격증명 *참조* 등록/회전 (값 아님)

> Status: **PROPOSED** (설계 제안). `release-decisions.md` DG-4 의 "재고 조건"을 구체화한다.
> **이 문서는 설계 제안이며 코드·계약을 바꾸지 않는다.** 구현 착수 전 오너가 §8 "결정 필요"를 확정해야 한다.
>
> ⛔ **불변 경계 (협상 불가)**: 앱은 시크릿 **값**을 절대 쓰지 않는다 — `security-contracts.md §1`,
> `SecretStore = resolve(ref) → PlainSecret` **읽기 전용**(write API 없음). 이 기능은 **SecretRef
> 식별자(Vault 경로 문자열) + 정책 메타데이터**만 관리한다. 실제 값은 **out-of-band(Vault/KMS)**.
> 값 write 는 `release-decisions.md` DG-4 에서 **영구 거부**로 못박혀 있다.

## 1. 목적 / 비목적

**목적**: 운영자가 콘솔에서 자격증명 **바인딩**을 등록·회전한다 — "사이트 X 의 로그인 자격증명 =
Vault 경로 `rpa/prod/runtime-worker/executor/<name>`, 동시성 3슬롯". 현재
`credential_concurrency_policies` 는 out-of-band 시드만 되고 D5(`GET /v1/credentials/concurrency`,
`app/src/api/concurrency-policies.ts`)가 **읽기만** 노출한다. 이 기능은 그 정책의 **콘솔 write**(등록·회전)다.

**비목적 (⛔ 영구 거부 — 계약 위반)**:
- 시크릿 **값** write/입력/표시. 요청 스키마에 value 필드 **부재**(§5 가드).
- Vault/KMS 값 프로비저닝. 콘솔은 "이 경로에 값을 넣으라" 안내(runbook 링크)만 — 값 주입은 배포-오너.
- 자격증명을 LLM 으로 평문 전달(이미 redaction 경계가 차단, `security-contracts.md §4`).

## 2. 현재 구조 (앵커 — 구현 시 재확인)

- **`SecretStore`** = `resolve(ref: SecretRef): Promise<PlainSecret>` **단일 메서드**(`ts/core-types.ts`).
  write/put/rotate 없음 — 경계 확정. Vault 어댑터(`app/src/secrets/vault-secret-store.ts`)도 `resolve` 만 공개.
- **SecretRef** = `string & { __brand: "SecretRef" }`(`ts/core-types.ts`). 문법 `rpa/<env>/<runtime>/<purpose>/<name>`
  (≥5 세그먼트, `seg[0]='rpa'`), `refNamespaceDenial()`(`app/src/secrets/vault-secret-store-boundary.ts`)이
  resolve 시점에 `seg[2]=runtime`·`seg[3]=purpose` 결속을 검증(percent-encoding·`.`/`..`·빈 세그 거부).
- **`credentials` 테이블 없음.** 자격증명 정체성 = `credential_ref`(SecretRef 문자열) **자체**.
  `credential_concurrency_policies(tenant_id, credential_ref, site_profile_id, max_concurrency)` PK 가
  (자격증명 ↔ 사이트) 바인딩 + 동시성 정책(`db/migration_concurrency_idempotency.sql`).
  `credential_leases(…, slot_no, run_id, status, locked_until)` = 런타임 슬롯.
- **D5 read**: `GET /v1/credentials/concurrency`(`concurrency-policies.ts`, `rbacAction: ops_alert.read`) —
  policies + site_profiles + active·미만료 leases 조인. 응답은 ref **문자열**만(값 없음, 이미 안전).
- **`site_profiles`**(`migration_core_entities.sql`): `id, tenant_id, name, url_pattern, risk, approved` —
  자격증명 컬럼 없음(바인딩은 policies.site_profile_id FK 로).

## 3. 설계 (KISS — 기존 테이블 확장, 새 테이블 0)

자격증명 정체성을 `credential_ref` **자연키**로 유지(surrogate `credentials` 테이블 = YAGNI). 기능 =
`credential_concurrency_policies` 행의 **콘솔 관리 write** + (선택) 메타데이터 컬럼. D5 모듈을 확장한다.

### 3.1 등록 — `POST /v1/credentials`

body `{ credential_ref, site_profile_id, max_concurrency, label? }` (⛔ value 필드 **없음**):

- `credential_ref` **문법 검증**(`refNamespaceDenial` 로직 재사용): ≥5 세그, `seg[0]='rpa'`,
  `seg[3] ∈ 허용 자격증명 purpose`(예: `executor`) — `resume_token_hmac`·`signed_command` 등
  **비-자격증명 경로 등록 거부**(loud, `IR_SCHEMA_INVALID` reason=`credential_ref_invalid`).
- ⛔ **value/secret/password/token 등 값 필드가 body 에 존재하면 즉시 거부**(방어심층, "조용한 false
  금지" — 값 유입 자체 차단). 스키마 부재 + 런타임 거부 **이중**.
- `site_profile_id` 존재·tenant 일치 확인. 멱등(`Idempotency-Key`).
- INSERT policies 행(또는 `ON CONFLICT (tenant_id, credential_ref, site_profile_id)` 업데이트). 값은 안 받음.

### 3.2 회전 — `PATCH /v1/credentials`

body `{ credential_ref, site_profile_id, new_credential_ref?, max_concurrency? }`:

- 회전 = `credential_ref` 를 **새 Vault 경로로 교체**(예 `.../hiworks` → `.../hiworks-v2`). 값 회전 자체는
  **out-of-band**(Vault 에서 새 경로에 새 값 주입) — 콘솔은 *어느 경로를 가리킬지*만 바꾼다.
- 활성 lease 가 있는 ref 회전 시 정책(거부 vs grace) = §8 결정.

### 3.3 메타데이터 (선택)

`credential_concurrency_policies` 에 `label text?`·`rotated_at timestamptz?`·`registered_by text?` 추가 →
D5 read 에 투영(가시성: "표시명", "마지막 회전", "등록자"). 없어도 핵심 기능 동작(KISS 트레이드오프).

## 4. 계약 변경 (제안)

- **DDL**: `credential_concurrency_policies` + `label`/`rotated_at`/`registered_by`(선택). **새 테이블 0.**
- **RBAC**: 신규 `credential.manage`(admin; operator 포함 여부 = §8). 감사 = security-audit append-only
  경계에 `credential.manage` 결정 추가(`security-contracts.md §8` 경계). 읽기는 D5 의 `ops_alert.read` 유지.
- **api-surface.md** + `codegen` openapi: `POST/PATCH/DELETE /v1/credentials`. ErrorCode 재사용
  (`IR_SCHEMA_INVALID` reason / `AUTHZ_FORBIDDEN`). consistency 게이트 동기.
- ⛔ **`ts/` SecretStore·brand 타입 무변경**(경계 불변 — 이 기능은 SecretStore 를 건드리지 않는다).

## 5. 보안 가드 (핵심 — 이 스펙의 존재 이유)

1. **값 필드 부재 + 런타임 거부**(이중): 요청 스키마에 value 가 없고, 혹시 들어오면 loud reject.
2. **purpose 화이트리스트**: `credential_ref` 의 `seg[3]` 가 자격증명 purpose(`executor` 등)일 때만 허용 →
   서명키·resume-token 경로를 "자격증명"으로 등록하는 우회 차단.
3. **값 비노출**: 값은 로그·이벤트·응답·artifact 어디에도 안 나타남(애초에 안 받음). D5 read 도 ref 문자열만.
4. **감사**: `credential.manage` 결정을 append-only audit 에 기록(누가 어떤 ref 를 등록/회전).
5. **secret-scan 게이트** 통과(값 리터럴 0).

## 6. web (콘솔)

- Security 뷰의 `ConcurrencyPolicyPanel`(D5) 확장: 등록 폼(`credential_ref` + 사이트 + `max_concurrency` +
  `label`)·회전·삭제(ActionButton `credential.manage`). ⛔ **값 입력란 없음.** 안내 문구 = "비밀번호 값은
  Vault 에 운영자가 직접 넣습니다 — 여기서는 경로(참조)만 등록" + runbook 링크. 운영자 언어(STATUS/ERROR 라벨).

## 7. 검증

- **실 PG int**: 등록(문법 OK)→정책 행 생성; **잘못된 ref**(세그<5·`purpose=resume_token_hmac`)→거부;
  ⛔ **value 필드 주입→거부**(가드 증명, negative control); 회전→ref 교체·`rotated_at` 갱신; RLS 격리; 멱등.
- **secret-scan**·**db-static-smoke**(컬럼 추가 시 매니페스트 동기) 게이트.
- web vitest(값 입력란 부재 단언 포함) + console-e2e 목.

## 8. 결정 필요 (DECISION REQUIRED — 오너 확인)

- **DG4-D1 RBAC 역할**: ✅ **결정 = 신규 `credential.manage`, admin 전용**(자격증명 바인딩은 민감).
  D5 읽기는 `ops_alert.read` 유지. [오너 확정 2026-06-26]
- **DG4-D2 회전 시 활성 lease**: ▶ 권장 활성 lease 있는 ref 의 즉시 회전은 **거부**(in-flight run 보호,
  `WORKITEM_CHECKOUT_CONFLICT` 류) — lease 소진 후 회전. 대안: grace(양쪽 ref 일시 유효). 확정?
- **DG4-D3 메타 컬럼**: `label`/`rotated_at`/`registered_by` 추가 여부 — 가시성 vs KISS. 어디까지?
- **DG4-D4 purpose 화이트리스트**: 자격증명 허용 purpose 집합 = `{executor}` 만? 다른 fill purpose 추가 예정?

## 9. 추정 규모 / 리스크

- 작은~중간 규모: 새 테이블 0(기존 확장) + 엔드포인트 2~3 + RBAC 1 + web 패널 확장 + 컬럼 0~3.
- **리스크의 본질은 규모가 아니라 경계**: 값 유입을 막는 §5 가드가 핵심 — int 의 negative control(value
  주입→거부)이 이 스펙의 합격 기준. 경계만 지키면 계약 위반 0(SecretStore 불변, 값은 out-of-band 유지).
