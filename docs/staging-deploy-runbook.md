# Staging Deploy Runbook

이 문서는 staging 배포자가 계약을 바꾸지 않고 운영 값을 연결할 때 보는 짧은 runbook이다.
상세 동작의 권위는 `api-surface.md`, `security-contracts.md`, `ops-defaults.md`, `schema/ir.schema.json`에 있다.

## Operator/Deployer: Natural-language Scenario Generation

### 1. 기능 경계

- API는 `POST /v1/scenario-generations`로 자연어 prompt를 IR 초안으로 만들고, 기존 scenario 저장/검증/실행 경계를 재사용한다.
- 기본 planner는 `deterministic_mvp`다. 외부 LLM 없이 `observe`/`extract` 중심의 read-only IR을 만든다.
- `planner="llm_v1"`은 선택 구현체다. API 프로세스에 주입되지 않으면 `RESOURCE_NOT_FOUND`로 닫힌다. 켜져도 결과 IR은 동일하게 `compileScenario`와 blocker/run enqueue 경계를 통과해야 한다.
- prompt 원문은 generation ledger에 저장하지 않는다. `prompt_hash`와 선택적 redacted artifact만 남기며, 실행 가능한 원본 IR은 `scenario_versions.ir` 계약 경계에만 둔다.

### 2. 공통 배포 env

API만 띄워 초안 저장을 검증할 때도 아래 값은 fail-closed로 필요하다.

| 목적 | Env |
|---|---|
| 모드 | `RUN_MODE=api` 또는 `RUN_MODE=all` |
| 환경 이름 | `RPA_ENV=staging` |
| DB | `DATABASE_URL` 또는 `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` |
| Auth | `JWKS_URL` plus optional `JWT_ISSUER`, `JWT_AUDIENCE`, 또는 v1 `JWT_HS256_SECRET` |
| signed command registry | `SIGNED_COMMAND_REGISTRY_MODE=deny_all` 또는 `vault` plus `VAULT_ADDR`, `VAULT_MOUNT`, `VAULT_API_ROLE_ID`, `VAULT_API_SECRET_ID`, optional `SIGNED_COMMAND_REGISTRY_REF` |
| artifact read store | FS: optional `API_ARTIFACT_DIR` 또는 shared `GATEWAY_ARTIFACT_DIR`; S3: `ARTIFACT_OBJECT_STORE_KIND=s3`, `ARTIFACT_OBJECT_STORE_REF`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, optional `S3_FORCE_PATH_STYLE`, plus `VAULT_API_ROLE_ID`, `VAULT_API_SECRET_ID` |

Artifact 본문/blob 조회 라우트를 운영 smoke에 포함하려면 object_ref scheme에 맞춰 API read store를 설정한다. `file://` artifact는 API에 `API_ARTIFACT_DIR` 또는 shared `GATEWAY_ARTIFACT_DIR`를 추가한다.
`API_ARTIFACT_DIR`와 `GATEWAY_ARTIFACT_DIR`를 함께 설정하는 경우 두 값은 같은 filesystem root로 resolve되어야 한다. 다르면 API가 worker/gateway가 저장한 redacted artifact blob을 읽을 수 없으므로 production config가 fail-closed로 시작을 거부한다.
`s3://<bucket>/...` runtime visual evidence는 API도 SecretRef-backed S3 reader를 켜야 한다. API는 configured bucket과 일치하지 않는 S3 ref 또는 알 수 없는 scheme을 404 fail-closed로 처리한다.

`save_and_run`까지 staging에서 확인하려면 worker도 필요하다.

| 목적 | Env |
|---|---|
| 모드 | `RUN_MODE=worker` 또는 `RUN_MODE=all` |
| worker Vault identity | `VAULT_ADDR`, optional `VAULT_MOUNT`, `VAULT_RUNTIME_WORKER_ROLE_ID`, `VAULT_RUNTIME_WORKER_SECRET_ID` |
| artifact lifecycle object store SecretRef | `ARTIFACT_OBJECT_STORE_REF`, optional `ARTIFACT_OBJECT_STORE_BACKEND_ALIAS` |
| browser | `CHROME_EXECUTABLE_PATH`, optional `BROWSER_HEADLESS`, `BROWSER_DOWNLOAD_ROOT_DIR` |
| worker queue | optional `GRAPHILE_WORKER_SCHEMA`, `GRAPHILE_CONCURRENCY`, `GRAPHILE_POLL_INTERVAL_MS` |
| runtime LLM gateway for `observe`/`extract` | `CODEX_BASE_URL`(https only), `CODEX_API_KEY`, `CODEX_MODEL`; default FS artifact store uses `GATEWAY_ARTIFACT_DIR`; staging S3 producer mode uses `GATEWAY_ARTIFACT_STORE_MODE=s3`, `GATEWAY_ARTIFACT_OBJECT_STORE_REF`, and optional `GATEWAY_ARTIFACT_OBJECT_STORE_S3_*` overrides |

`CODEX_API_KEY`는 현재 D8-A16 v1 gap 때문에 env-sourced provider secret이다. 평문 값을 runbook, log, screenshot, PR 본문에 남기지 말고 배포 플랫폼 secret으로 주입한다.

For split worker/lifecycle staging with S3 artifacts, run this before process
start and require PASS:

```powershell
npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle
```

The preflight accepts `fs + local_fs` for local/dev shared-volume deployments and
`s3 + s3` for staging when producer and lifecycle endpoint/region/bucket/path-style
match. It rejects mixed `fs + s3`, `s3 + local_fs`, and S3 target drift.

### 3. `llm_v1` 켜기

API 프로세스에 아래 값을 추가한다.

| 목적 | Env |
|---|---|
| planner enable | `SCENARIO_GENERATION_LLM_V1_ENABLED=true` |
| planner prompt version | optional `SCENARIO_GENERATION_LLM_PROMPT_TEMPLATE_VERSION` default `scenario-planner@1` |
| gateway | `CODEX_BASE_URL`, `CODEX_API_KEY`, `CODEX_MODEL`, `GATEWAY_ARTIFACT_DIR` |
| gateway knobs | optional `CODEX_MAX_CONTEXT_TOKENS`, `CODEX_PRICE_PER_1K_INPUT_USD`, `CODEX_PRICE_PER_1K_OUTPUT_USD`, `GATEWAY_ARTIFACT_RETENTION_DAYS` |

`SCENARIO_GENERATION_LLM_V1_ENABLED=false` 또는 미설정이면 MVP planner만 사용된다. `true`인데 gateway env가 빠지면 프로세스가 시작 시 실패한다.

### 4. Evidence screenshot/video behavior

- evidence 생략 시 서버 기본값은 `screenshot="each_step"`이고, video recorder capability가 켜져 있으면 `video="always"`, 꺼져 있으면 `video="never"`다. 콘솔은 `/v1/scenario-generations/capabilities`의 같은 기본값을 따라 표시한다.
- `screenshot="each_step"` 또는 `video="always"`는 IR `node.policy.recording="always"`로 투영된다.
- 둘 다 `never`면 `recording="never"`다. 그 외는 `masked_on_failure`다.
- screenshot은 step 후 마스킹된 PNG artifact(`screenshot_masked`, `image/png`)로 저장된다. `masked_on_failure`에서는 실패 step만 캡처한다.
- video는 run-level WebM artifact(`video_masked`, `video/webm`)다. `video="failure"`는 성공 run에서는 폐기하고 실패 run에서만 보존한다.
- `video!="never"` 요청은 API와 worker 모두 video recorder capability가 켜져 있어야 자동 실행된다. 꺼져 있으면 generation은 `status=blocked`, blocker는 `video_recording_port_not_configured`, `run_id=null`이다.
- 모든 evidence artifact는 먼저 `pending`이며 redaction/retention lifecycle 뒤에만 조회된다. v1 RLS에서는 pending/failed/quarantined/deleted artifact가 존재 비노출로 떨어질 수 있다.
- `action.sensitive=true` 입력은 recording mode와 무관하게 항상 마스킹한다. 평문 secret, token, credential은 artifact에 남기지 않는다.

Video recorder env는 API와 worker가 분리 배포된 경우 양쪽에 맞춰 넣는다.

```powershell
$env:VISUAL_EVIDENCE_VIDEO_ENABLED="true"
$env:VISUAL_EVIDENCE_FFMPEG_PATH="C:\tools\ffmpeg.exe"
$env:VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED="true" # API-only deployment: operator confirms the worker fleet also has video enabled
$env:VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS="1000" # optional
$env:VISUAL_EVIDENCE_VIDEO_FPS="1"                  # optional
```

### 5. Operator verification

정적/단위 확인:

```powershell
npm --prefix app run typecheck
npm --prefix app exec -- tsx app/test/main-config.unit.ts
```

DB가 있는 staging-like 환경에서 generation 경계를 확인한다:

```powershell
node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/api-scenario-generations.int.ts
```

FFmpeg 바인딩은 별도 smoke로 확인한다:

```powershell
$env:VISUAL_EVIDENCE_FFMPEG_PATH="C:\tools\ffmpeg.exe"
npm --prefix app run smoke:video-recorder
```

운영 smoke는 토큰과 UUID를 redacted packet에만 기록한다.

```powershell
$headers = @{
  Authorization = "Bearer <operator-token>"
  "Idempotency-Key" = "staging-gen-<unique>"
  "Content-Type" = "application/json"
}
$body = @{
  prompt = "공지 목록에서 최근 게시글 제목과 날짜를 추출"
  name = "staging-nl-generation-smoke"
  mode = "save_and_run"
  planner = "deterministic_mvp"
  start_url = "https://example.com/notices"
  target = @{
    site_profile_id = "<site-profile-uuid>"
    browser_identity_id = "<browser-identity-uuid>"
    network_policy_id = "<network-policy-uuid>"
  }
  evidence = @{ screenshot = "each_step"; video = "never" }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri "https://<api-host>/v1/scenario-generations" -Headers $headers -Body $body
```

`llm_v1` smoke는 같은 body에서 `planner="llm_v1"`만 바꿔 실행한다. 응답이 `201`이고 `planner`, `generation_id`, `scenario_version_id`가 채워지면 저장 경계가 통과한 것이다. `save_and_run`은 `status=run_queued`와 `run_id`를 확인하고, evidence는 lifecycle 후 `GET /v1/runs/{run_id}/artifacts` 및 필요한 경우 `GET /v1/artifacts/{artifact_id}/blob`에서 redacted metadata/blob만 확인한다.

## DB 역할 분리 (최소권한, DG1)

`db/roles.sql`은 DDL 권한과 런타임 데이터 접근을 두 역할로 분리한다. 런타임이 스키마를 바꾸거나 RLS를 우회하지 못하게 하는 최소권한 경계다.

- `rpa_migrator` — 스키마/객체 소유 + DDL/마이그레이션 전용. **런타임 연결에 쓰지 않는다.**
- `rpa_app` — 런타임(제어평면 API + 워커) DML 전용. `SUPERUSER`·`BYPASSRLS`·DDL 없음 → RLS 적용, 스키마 변경 불가.

### 배포 순서

1. 슈퍼유저(배포 관리자)로 역할 + 기본권한 생성(마이그레이션 **전에**, idempotent):
   ```bash
   psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f db/roles.sql
   ```
2. 역할 LOGIN·비밀번호 주입(배포 비밀 — `roles.sql`에 비밀번호를 넣지 않는다):
   ```sql
   ALTER ROLE rpa_migrator LOGIN PASSWORD '<migrator-secret>';
   ALTER ROLE rpa_app      LOGIN PASSWORD '<app-secret>';
   ```
3. **`rpa_migrator`로** 마이그레이션 실행 — 테이블이 `rpa_migrator` 소유가 되어 `ALTER DEFAULT PRIVILEGES`가 신규 객체의 DML을 `rpa_app`에 자동 부여한다:
   ```bash
   psql "$MIGRATOR_DSN" -v ON_ERROR_STOP=1 -f db/migration_concurrency_idempotency.sql
   psql "$MIGRATOR_DSN" -v ON_ERROR_STOP=1 -f db/migration_core_entities.sql
   ```
4. **제어평면 API와 워커는 `rpa_app`으로 연결**한다(`DATABASE_URL` 사용자 = `rpa_app`). 절대 슈퍼유저/`rpa_migrator`로 런타임을 연결하지 않는다.
5. 이후 모든 마이그레이션은 `rpa_migrator`로 실행한다(기본권한이 신규 객체에 계속 자동 적용).

### 검증

```bash
node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/db-roles-least-privilege.int.ts
```
임시 PostgreSQL에서 `rpa_app`이 **DML 동작 · RLS 적용(타 테넌트 0건) · DDL 거부(CREATE TABLE 차단)**임을 증명한다. 구조 회귀는 `node scripts/db-static-smoke.mjs`(Contract Gate)가 막는다.

### app/worker 연결 분리 (선택)

제어평면 API와 워커는 같은 런타임 데이터평면(`runs`·`run_steps`·`credential_leases` 등)을 크게 공유하므로 기본적으로 `rpa_app` 하나를 함께 쓴다. 연결 단위 자격 분리(회전·감사)가 필요하면 배포에서 `rpa_app`과 동일 권한의 복제 역할(`rpa_worker`)을 추가하고 워커만 그 역할로 연결한다 — 테이블별 app/worker 권한 세분은 두 경로의 런타임 테이블 중첩이 커 실익이 작다.

## 환경 ALM (dev→staging→prod, DG2)

플랫폼은 **환경 무관(env-agnostic)**이다. 환경(dev/staging/prod) 식별은 코드·계약에 박히지 않고 **배포 설정**으로만 들어온다:

- 시크릿/키 네임스페이스 = Vault mount `rpa/<env>/...` (env 별 AppRole — prod AppRole 은 prod mount 만, `security-contracts.md §3`).
- 데이터평면 = `DATABASE_URL`(env 별 독립 PostgreSQL 스택).
- 배포별 override = `*_REF`(예: `SIGNED_COMMAND_REGISTRY_REF`).

따라서 **환경 간 승격은 운영 절차**이지 런타임 기능이 아니다:

1. 각 env 를 **독립 배포**한다(별도 DB·Vault·워커 — 위 "공통 배포 env"·"DB 역할 분리" 절을 env 마다 반복).
2. `db/` 마이그레이션을 **동일 순서**로 각 env 에 적용한다(`rpa_migrator`, DG1 절).
3. 시나리오/설정은 소스(계약·codegen)에서 각 env 로 재배포한다.

**환경 *내부* 시나리오 draft→prod 승격은 D4 maker-checker**(`scenario_promotion_requests`, 요청자≠승인자 SoD)가 콘솔에서 처리한다 — 환경 간 ALM 과 별개 레이어다. 중앙 제어평면이 여러 env 를 오케스트레이션하는 단일 승격 콘솔은 v1 범위 밖이다(net-new, `release-decisions.md` DG-2).
