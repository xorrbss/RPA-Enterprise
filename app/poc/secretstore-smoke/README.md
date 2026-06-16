# SecretStore resolution smoke — checklist row 48 evidence

라이브 HashiCorp Vault + PostgreSQL `audit_log` 에 대고 **프로덕션 코드**(`app/src/secrets/VaultSecretStore`
+ `VaultSecretStoreBoundary` + `app/src/api/PgDurableSecurityAuditDecisionWriter`)를 그대로 실증한다 — 재구현
아님. AppRole 인증 + 최소권한 resolve 매트릭스(release-decisions D8-A12) + `secret.resolve` 감사를 한 번에 증명한다.

목적: `release-open-checklist.md` **row 48** ("SecretStore backend AppRole smoke") + `staging-decision-proposals.md`
§[EXTERNAL-FACT] 2 ("auth=AppRole는 row 48 smoke에서 실증") 를 닫을 redacted 증거 생성.

## 사전 조건 (오너 측, 배포 시 1회)

Vault (KV v2, mount `secret`, base `secret/data/rpa/staging/<runtime>/<purpose>/<name>`):

- 시드: `rpa/staging/runtime-worker/resume_token_hmac/active` 경로에 `value=<임의 시크릿>` (값은 증거에 안 나옴).
- AppRole 2개(런타임 identity 격리, 각자 자기 namespace 만 read 정책):
  - `runtime-worker` role → `secret/data/rpa/staging/runtime-worker/*` read 허용.
  - `browser-worker` role → `secret/data/rpa/staging/browser-worker/*` 만 read (gateway_policy 불가).

PostgreSQL: `audit_log` 테이블이 있는 staging DB (마이그레이션 적용 완료). 표준 `PG*` 환경변수로 접속.

## 환경변수 (모두 필수, env 로만 — 레포에 남기지 않음)

| 변수 | 의미 |
|---|---|
| `VAULT_ADDR` | 절대 https Vault 주소, 예: `https://vault.internal:8200` |
| `VAULT_MOUNT` | (선택) KV v2 mount, 기본 `secret` |
| `SMOKE_TENANT_ID` | 감사 append 대상 tenant UUID (RLS 바인딩) |
| `VAULT_RUNTIME_WORKER_ROLE_ID` / `VAULT_RUNTIME_WORKER_SECRET_ID` | runtime-worker AppRole 자격 |
| `VAULT_BROWSER_WORKER_ROLE_ID` / `VAULT_BROWSER_WORKER_SECRET_ID` | browser-worker AppRole 자격 |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | PG 접속 (audit writer) |

## 실행

```bash
npm ci --prefix app
npm --prefix app run secretstore:smoke
```

## 시나리오 (오너 확정 access matrix, D8-A12)

- **[A] authorized**: identity=`runtime-worker`, purpose=`resume_token_hmac`,
  ref=`rpa/staging/runtime-worker/resume_token_hmac/active` → **ALLOW**.
  감사 append 성공 후에만 resolve 한다(반환 시크릿 값은 출력하지 않음).
- **[B] unauthorized**: identity=`browser-worker`, purpose=`gateway_policy`,
  ref=`rpa/staging/llm-gateway/gateway_policy/codex-primary` → **DENY** (`SECRET_ACCESS_DENIED`, least-privilege).
  매트릭스에서 거부되므로 Vault read 까지 가지 않고, `outcome=deny` 감사가 남는다.

`[A]=ALLOW && [B]=DENY && redaction self-check PASS` 가 아니면 nonzero exit.

## 캡처할 증거 (row 48 — redacted)

stdout 의 redacted 마크다운 표 + 결과 라인을 그대로 `product-open-candidate-report.md` 의 row 48
blocked-decision 마커 자리에 붙이고, `release-open-checklist.md` row 48 을 redacted 증거 참조로 교체한다:

- 표: `시나리오 / identity / ref path / expected / observed(ALLOW|DENY) / audit(seq#) / audit hash(redacted) / detail`.
- `redaction self-check: PASS (no AppRole credential in output)` 라인.
- `결과: [A]=ALLOW [B]=DENY → PASS` 라인.

**절대 캡처/기록 금지**: Vault 토큰, AppRole role_id/secret_id, resolve 된 시크릿 값. 하니스가 출력 전
이들을 검열하지만(self-check 로 강제), 캡처 시에도 육안 확인할 것. ref **경로**는 시크릿 값이 아니므로 노출 안전.
