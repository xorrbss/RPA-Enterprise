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
| Auth | `JWKS_URL` plus optional `JWT_ISSUER`, `JWT_AUDIENCE`, 또는 v1 `JWT_HS256_SECRET`(≥32자). HS256 모드의 최초 접속 토큰 발급은 아래 ‘최초 접속 토큰 발급’ 절 참고 |
| signed command registry | `SIGNED_COMMAND_REGISTRY_MODE=deny_all` 또는 `vault` plus `VAULT_ADDR`, `VAULT_MOUNT`, `VAULT_API_ROLE_ID`, `VAULT_API_SECRET_ID`, optional `SIGNED_COMMAND_REGISTRY_REF` |
| artifact read store | FS: optional `API_ARTIFACT_DIR` 또는 shared `GATEWAY_ARTIFACT_DIR`; S3: `ARTIFACT_OBJECT_STORE_KIND=s3`, `ARTIFACT_OBJECT_STORE_REF`, 엔드포인트/리전/버킷/키는 플랫폼 공용 `ARTIFACT_OBJECT_STORE_S3_*`(매니페스트 ConfigMap 이 제공하는 이름) 또는 API 전용 `S3_*`(설정 시 우선), optional `*_FORCE_PATH_STYLE`, plus `VAULT_API_ROLE_ID`, `VAULT_API_SECRET_ID` |

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

For Kubernetes or Helm packaging review, run the static deployment contract gate
before cluster dry-run or install:

```powershell
npm --prefix codegen run k8s:static-smoke
```

#### Kubernetes release overlay gate

Treat `deploy/k8s/base/` as a fail-closed template only. For cluster review,
start from `deploy/k8s/overlays/staging-sample/`, then copy the overlay into the
platform-owned deployment repository before replacing documentation-only values.
The owner-approved overlay must provide an immutable runtime image digest,
approved destination CIDRs for PostgreSQL, Vault, object storage, OTLP, and LLM
egress, and the SecretStore-backed runtime Secret. SBOM, provenance, and image
signature verification evidence must be retained with the release packet before
`kubectl apply` or server-side dry-run is used as release evidence.

#### Helm release values gate

Render the chart only with a release values file that sets `image.repository`
and `image.digest`. The default chart values intentionally omit the image
identity so a plain render fails closed. `deploy/helm/rpa/values.release.example.yaml`
is sample evidence only; owner-approved release values must replace the sample
registry, immutable digest, and egress CIDRs outside this contract repository.

#### Console deployment

The production console artifact is the Dockerfile `console-runtime` target:
Vite builds `web/dist`, then an nginx stage serves static files and provides the
same-origin reverse proxy. Keep the browser API base at `/api`; nginx strips the
`/api` prefix and forwards to the API service, so `/api/v1/runs` reaches the
upstream as `/v1/runs`. Do not publish a separate `/v1` browser proxy.

| Setting | Where | Required value or note |
|---|---|---|
| `VITE_API_BASE_URL` | console image build arg | Default `/api`; use this for same-origin deployments. |
| `VITE_OIDC_AUTH_URL` | console image build arg | Optional SSO login URL shown on the access screen. |
| `RPA_API_UPSTREAM` | nginx runtime env | Compose uses `http://api:8080`; Kubernetes/Helm use `http://rpa-api:8080`. |
| `RPA_CONSOLE_PORT` | compose env | Local host port for the console, default `8088`. |

For Docker Compose, set the required DB/API secrets from `deploy/docker.env.example`
and run `docker compose up --build web`. The `web` service depends on the API
healthcheck and exposes the console on `http://127.0.0.1:${RPA_CONSOLE_PORT:-8088}`.

For Kubernetes and Helm, promote the console image separately from the runtime
image and pin it by immutable sha256 digest (`ghcr.io/example/rpa-console` in
base templates, `console.image.*` in Helm values). Route ingress to the console
service, not directly to `rpa-api`, so browser calls remain same-origin.

Use HTTPS for staging and production console access. The console has HTTP-safe
fallbacks for local review, but browser token storage, OIDC redirect handling,
and session-capture flows should be treated as secure-context-only operational
paths outside local development.

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

### 최초 접속 토큰 발급 (파일럿, IdP 연동 전)

IdP(SSO)를 연동하기 전 파일럿 단계에서는 콘솔 접속 화면의 '접속 코드'로 쓸 JWT를 직접 발급한다. `JWT_HS256_SECRET`(공통 배포 env, HS256 모드)와 동일한 시크릿으로 서명한 토큰만 서버가 검증하므로, 아래 발급기는 그 시크릿을 사용한다. 이 절차는 `JWKS_URL`(RS256/JWKS 운영 모드)로 전환하면 더 이상 필요 없다 — IdP가 토큰을 발급한다.

발급기(`scripts/mint-operator-token.mjs`)는 의존성이 없어 `npm install --prefix app` 없이 실행된다.

```powershell
$env:JWT_HS256_SECRET = "<서버 기동에 쓰는 것과 동일한 32자 이상 시크릿>"
node scripts/mint-operator-token.mjs --tenant <tenant-uuid> --sub <접속 주체 식별자> --roles admin
```

| 클레임 | 의미 | 규칙 |
|---|---|---|
| `--tenant` | 테넌트 ID(RLS/인가 경계) | UUID 필수 |
| `--sub` | 접속 주체(감사 로그 귀속) | 비어 있지 않은 문자열 필수 |
| `--roles` | 역할 CSV(기본 `admin`) | `viewer,operator,reviewer,approver,admin` 중 |
| `--expires` | 만료 기간(기본 `12h`) | `<N>s\|m\|h\|d` 또는 초 |

- 발급된 토큰은 stdout 1줄로만 출력된다(복사·파이프용). 진단은 stderr로 나가고 시크릿은 출력하지 않는다.
- 시크릿 미설정/32자 미만, 무효 tenant/role은 fail-closed(비-0 종료, 토큰 미발급)로 거부된다.
- 콘솔 접속: 접속 화면의 '접속 코드' 입력란에 stdout 토큰을 붙여넣는다.
- 만료되면 같은 명령으로 재발급한다(`--expires`로 기간 조정). 토큰은 접속 자격증명이므로 로그/PR/스크린샷에 남기지 않는다.

### 세션 등록 도우미(운영자 PC 단일 실행파일) 빌드·배포

운영 환경의 브라우저 로그인 세션 등록은 운영자 PC에서 등록 도우미를 실행하는 경로가 정식이다(서버측 캡처는 dev 전용). 운영자 PC에 저장소·Node.js 없이 "다운로드 → 실행 → 로그인" 3단계로 완주되도록, 도우미를 단일 실행파일로 빌드해 배포한다.

**빌드(배포 담당자, Windows x64에서 수행)** — Node SEA는 크로스컴파일이 없으므로 배포 대상과 같은 OS/아키텍처에서 빌드한다. 빌드 머신 요구: Node 24(CI와 동일), `npm --prefix app ci` 완료 상태.

```powershell
npm --prefix app run build:session-capture-exe
# 산출: app/dist/session-capture/rpa-session-capture.exe (+ 콘솔에 SHA-256 출력)
```

빌드 스크립트(`app/scripts/build-session-capture-exe.mjs`)는 esbuild 번들 → SEA blob → node 실행파일 복사 → postject 주입 → 무인자 smoke(USAGE + exit 2)까지 자가 검증한다. 산출물은 git에 커밋하지 않는다(`app/dist/` ignore) — 재현은 위 명령.

**배포**: `rpa-session-capture.exe`를 사내 공유 위치(파일 서버/포털)에 게시하고 빌드 시 출력된 SHA-256을 함께 공지한다(운영자는 `Get-FileHash`로 대조 가능). 운영자 실행 3단계는 콘솔의 '세션 등록' 안내 모달과 동일하다:

```powershell
$env:RPA_OPERATOR_TOKEN="<본인 접속 코드>"; .\rpa-session-capture.exe --api https://<콘솔 주소>/api --site <사이트 UUID>
```

- 접속 코드(operator 이상 역할)는 위 '최초 접속 토큰 발급' 절 또는 IdP 발급 토큰을 사용한다. 도우미는 DB/암호화키에 접근하지 않고 중앙 API(https 강제, loopback만 http 예외)로만 전송한다.
- 운영자 PC 전제: Chrome 설치(표준 경로 자동 탐색, 다른 경로는 `--chrome <경로>` 또는 `CHROME_PATH`).
- 실행파일은 신선한 임시 브라우저 프로필로 로그인 창을 띄우며(개인 프로필 미사용), 완료 시 창이 자동으로 닫히고 프로필은 폐기된다.

**코드 서명(비-코드, 인증서 오너 절차)**: SEA 주입은 복사한 node 실행파일의 기존 서명을 무효화하므로 배포 전 오너 인증서로 재서명한다.

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a app\dist\session-capture\rpa-session-capture.exe
```

미서명(또는 서명 무효) 상태로 배포하면 Windows SmartScreen이 "알 수 없는 게시자" 경고를 띄운다 — 운영자에게 "추가 정보 → 실행" 절차를 안내하거나, 사내 배포 정책(AppLocker/신뢰 게시자 등록)에 따라 예외를 등록한다. 서명 인증서는 오너 소유라 이 절차는 저장소 밖에서 수행한다.

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

`<operator-token>`은 위 ‘최초 접속 토큰 발급’ 절에서 만든 토큰(또는 IdP 발급 토큰)이다.

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
   ALTER ROLE rpa_lifecycle_bypass LOGIN PASSWORD '<lifecycle-bypass-secret>';
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
npm --prefix codegen run db:restore-drill:temp
```
`db:restore-drill:temp` proves pilot logical backup/restore in a disposable PostgreSQL cluster, then reruns baseline verification and non-BYPASSRLS smoke on the restored DB. Production PITR/managed-backup restore remains separate environment evidence.
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
