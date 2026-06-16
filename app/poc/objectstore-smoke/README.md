# S3 object-store smoke — rows 51/52 object-I/O code evidence (real S3/MinIO)

라이브 S3(또는 S3 호환/MinIO)에 대고 **프로덕션 코드**(`app/src/artifacts` 의 `S3ObjectStore` +
`S3ArtifactRetentionStore` + `S3ArtifactRedactor` + 주입된 `ContentRedactionTransform`)를 그대로 실증한다 —
재구현 아님. AWS SigV4 서명 + retention object 삭제 멱등(`deleted` → `not_found`) + redaction object I/O
(read → §4 transform → write redacted object)를 한 번에 실증하고 REDACTED 영수증을 생성한다.

**증거 성격(중요 — 오해 금지):** 본 하니스는 어댑터가 **실 S3 프로토콜**(SigV4 · HEAD/GET/PUT/DELETE)과
**SecretRef-backed 자격**(Vault `resolve` 경로)으로 올바로 동작함을 보이는 **repo-controlled 코드 증거**다.
deploy-time 체크리스트 행 51/52 의 **종료**는 이것과 별개다 — `release-open-checklist.md` 의
"Deploy-Time Provisioning Blockers" 게이트에 따라 행 51/52 는 **오너가 프로비저닝한 실 staging object store**
(local fixture / agent-spun-up 로컬 서비스로는 닫을 수 없음)의 증거가 있어야 닫힌다. 또한 row 52 의
legal-hold/quarantine **skip** 은 worker SQL claim 경로(repo-controlled 통합테스트)에서 강제되며 본
객체-I/O 하니스의 범위 밖이다(여기서 다루지 않는다).

- **row 52** (artifact retention / object deletion): 삭제 멱등(`deleted`/`not_found`) 객체-I/O 영수증.
- **row 51** (artifact redaction object I/O): `ContentRedactionTransform`(security-contracts §4 best-effort
  text/JSON masker)을 주입해 read → transform → write 를 end-to-end 실증한다. planted credential+email 이
  redacted object 에서 실제로 사라졌는지 검증한다(마스킹 실패 시 nonzero exit). 마스킹은 **best-effort §4**
  이며 임의 콘텐츠에 대한 완전성 증명이 아니다(exotic 형식/자유서술 임베드 시크릿은 owner DLP 필요).

## 사전 조건 (오너 측)

S3/MinIO:
- 쓰기 가능한 throwaway 버킷(예: `rpa-staging-artifacts`). 본 하니스는 임시 test object 를 PUT 한 뒤
  곧바로 삭제/검증하므로 잔여물이 남지 않는다.
- IAM 권한: 해당 버킷에 `s3:PutObject` + `s3:GetObject` + `s3:DeleteObject`(redaction 이 GET 으로 redacted
  바이트를 다시 읽으므로 `s3:GetObject` 는 **필수**다).

secretAccessKey 주입(둘 중 하나):
- (a) 직접 env `S3_SECRET_ACCESS_KEY`(빠른 배관 점검용), 또는
- (b) Vault credentialRef(purpose `object_store`, D8-A10) → `VaultSecretStore.resolve`(**SecretRef-backed** —
  deploy-time 증거는 이 경로를 써야 한다): `VAULT_ADDR` + AppRole(`VAULT_ARTIFACT_LIFECYCLE_ROLE_ID`/`_SECRET_ID`)
  + `S3_CREDENTIAL_REF` 경로. `S3_SECRET_ACCESS_KEY` 미설정 시 (b) 로 동작한다.

## 환경변수 (env 로만 — 레포에 남기지 않음)

| 변수 | 필수 | 의미 |
|---|---|---|
| `S3_ENDPOINT` | ✓ | 절대 https endpoint. AWS 예: `https://s3.us-east-1.amazonaws.com`, MinIO 예: `https://minio.internal:9000` |
| `S3_REGION` | ✓ | 서명 region(MinIO 는 보통 `us-east-1`) |
| `S3_BUCKET` | ✓ | throwaway 버킷명 |
| `S3_ACCESS_KEY_ID` | ✓ | S3 access key id |
| `S3_SECRET_ACCESS_KEY` | (a) | S3 secret access key — 직접 주입 경로(미설정 시 Vault (b) 경로) |
| `S3_FORCE_PATH_STYLE` | | `false` 면 virtual-hosted-style. 기본 `true`(MinIO/호환) |
| `S3_BACKEND_ALIAS` | | evidence backendAlias(redacted alias 권장). 기본 `s3-smoke` |
| `S3_CREDENTIAL_REF` | | evidence credentialRef(SecretRef 경로). 기본 `rpa/staging/artifact-lifecycle/object_store/s3` |
| `SMOKE_TENANT_ID` | ✓ | tenant UUID |
| `VAULT_ADDR` `VAULT_MOUNT` | (b) | Vault 경로(secretAccessKey 를 Vault 에서 해소할 때) |
| `VAULT_ARTIFACT_LIFECYCLE_ROLE_ID` / `_SECRET_ID` | (b) | artifact-lifecycle AppRole 자격 |

자체서명 TLS(MinIO/Vault local)일 때 Node 가 CA 를 신뢰하도록 `NODE_EXTRA_CA_CERTS=<ca.crt>` 를 설정한다.

## 실행

```bash
npm ci --prefix app
npm --prefix app run objectstore:smoke
```

## 시나리오

- **[row52-A] first delete**: 임시 object PUT → `S3ArtifactRetentionStore.deleteObject` → **`deleted`**.
- **[row52-B] re-delete**: 같은 ObjectRef 재삭제 → **`not_found`**. 실 S3/MinIO 의 DELETE 는 부재여도 204 라
  `deleteDistinguishing` 이 **HEAD 로 존재를 먼저 확인**해 부재면 not_found 로 판정한다(멱등 — `transient_failed`
  가 아니어야 함).
- **[row51] redact**: planted credential+email 텍스트 PUT → `S3ArtifactRedactor.redact`(ContentRedactionTransform
  주입) → redacted ObjectRef 에서 다시 GET → planted 시크릿 부재 검증 → **`redacted`**(masked=true).

`first=deleted && re-delete=not_found && row51 redact=redacted(masked) && self-check PASS` 가 아니면 nonzero exit.

## 캡처할 증거 (redacted)

stdout 의 redacted 마크다운 표 + self-check 라인 + 결과 라인을 그대로 캡처한다:

- 표: `시나리오 / expected / observed / operation / artifactRef / backendAlias / receiptId / sha256 / detail`.
- `redaction self-check: PASS (...)` 라인.
- `결과: retention [A]=deleted [B]=not_found / redaction=redacted masked=true → PASS` 라인.

**절대 캡처/기록 금지**: S3 secretAccessKey, accessKeyId, **ObjectRef(내부 전용 locator)**, Vault 토큰,
Authorization/X-Amz-* 헤더, Signature/Credential, object 바이트. 하니스가 출력 전 이들을 검열하고
self-check 로 강제하지만(누출 시 nonzero exit), 캡처 시에도 육안 확인할 것. artifactRef · credentialRef
**경로** · backendAlias · receiptId · sha256 은 노출 안전(증거 메타).
