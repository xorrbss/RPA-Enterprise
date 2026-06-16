# S3 object-store retention smoke — checklist row 52 evidence (+ row 51 status)

라이브 S3(또는 S3 호환/MinIO)에 대고 **프로덕션 코드**(`app/src/artifacts` 의 `S3ObjectStore` +
`S3ArtifactRetentionStore` + `S3ArtifactRedactor`)를 그대로 실증한다 — 재구현 아님. AWS SigV4 서명 +
retention object 삭제 멱등(`deleted` → `not_found`)을 한 번에 증명하고 REDACTED 영수증을 생성한다.

목적:
- **row 52** (artifact retention / object deletion) 를 라이브 S3 삭제 증거로 닫는다 — **이 하니스로 완결**.
- **row 51** (artifact redaction object I/O) 은 specified 범위까지: 어댑터는 실 S3 read→transform→write
  I/O + evidence + fail-closed wiring 을 제공한다. **마스킹 ALGORITHM 자체는 미결정**(open decision —
  `impl-contracts-bundle.md` 은 "마스킹 수행"만 명시)이라, 변환(`ArtifactContentTransform`)이 주입되지
  않은 본 하니스는 redaction 을 실행하지 않고 "transform not configured" 를 출력한다(가짜 redaction 금지).

## 사전 조건 (오너 측)

S3/MinIO:
- 쓰기 가능한 throwaway 버킷(예: `rpa-staging-artifacts`). 본 하니스는 임시 test object 를 PUT 한 뒤
  곧바로 삭제하므로 잔여물이 남지 않는다.
- IAM 권한: 해당 버킷에 `s3:PutObject` + `s3:DeleteObject` (그리고 redaction 실증 시 `s3:GetObject`).

secretAccessKey 주입(둘 중 하나):
- (a) 직접 env `S3_SECRET_ACCESS_KEY`, 또는
- (b) Vault credentialRef(purpose `object_store`, D8-A10) → `VaultSecretStore.resolve`:
  `VAULT_ADDR` + AppRole(`VAULT_ARTIFACT_LIFECYCLE_ROLE_ID`/`_SECRET_ID`) + `S3_CREDENTIAL_REF` 경로.

## 환경변수 (env 로만 — 레포에 남기지 않음)

| 변수 | 필수 | 의미 |
|---|---|---|
| `S3_ENDPOINT` | ✓ | 절대 https endpoint. AWS 예: `https://s3.us-east-1.amazonaws.com`, MinIO 예: `https://minio.internal:9000` |
| `S3_REGION` | ✓ | 서명 region(MinIO 는 보통 `us-east-1`) |
| `S3_BUCKET` | ✓ | throwaway 버킷명 |
| `S3_ACCESS_KEY_ID` | ✓ | S3 access key id |
| `S3_SECRET_ACCESS_KEY` | (a) | S3 secret access key — 직접 주입 경로 |
| `S3_FORCE_PATH_STYLE` | | `false` 면 virtual-hosted-style. 기본 `true`(MinIO/호환) |
| `S3_BACKEND_ALIAS` | | evidence backendAlias. 기본 `s3-smoke` |
| `S3_CREDENTIAL_REF` | | evidence credentialRef(SecretRef 경로). 기본 `rpa/staging/artifact-lifecycle/object_store/s3` |
| `SMOKE_TENANT_ID` | ✓ | tenant UUID |
| `VAULT_ADDR` `VAULT_MOUNT` | (b) | Vault 경로(secretAccessKey 를 Vault 에서 해소할 때) |
| `VAULT_ARTIFACT_LIFECYCLE_ROLE_ID` / `_SECRET_ID` | (b) | artifact-lifecycle AppRole 자격 |

## 실행

```bash
npm ci --prefix app
npm --prefix app run objectstore:smoke
```

## 시나리오

- **[row52-A] first delete**: 임시 object PUT → `S3ArtifactRetentionStore.deleteObject` → **`deleted`**.
- **[row52-B] re-delete**: 같은 ObjectRef 재삭제 → **`not_found`**(멱등 — `transient_failed` 가 아니어야 함).
- **[row 51] redaction**: transform 미구성 → "redaction transform not configured" 출력(가짜 redaction 없음).

`first=deleted && re-delete=not_found && redaction self-check PASS` 가 아니면 nonzero exit.

## 캡처할 증거 (row 52 — redacted)

stdout 의 redacted 마크다운 표 + self-check 라인 + 결과 라인을 그대로 캡처한다:

- 표: `시나리오 / expected / observed / operation / artifactRef / backendAlias / receiptId / sha256 / detail`.
- `redaction self-check: PASS (...)` 라인.
- `결과: retention [A]=deleted [B]=not_found → PASS` 라인.
- `redaction (row 51): redaction transform not configured — row 51 needs the masking-algorithm decision` 라인.

**절대 캡처/기록 금지**: S3 secretAccessKey, accessKeyId, **ObjectRef(내부 전용 locator)**, Vault 토큰,
Authorization/X-Amz-* 헤더, Signature/Credential, object 바이트. 하니스가 출력 전 이들을 검열하고
self-check 로 강제하지만(누출 시 nonzero exit), 캡처 시에도 육안 확인할 것. artifactRef·credentialRef
**경로**·backendAlias·receiptId·sha256 은 노출 안전(증거 메타).
