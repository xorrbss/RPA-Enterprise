# D5 Codex SSE 라이브 PoC (checklist row 50)

프로덕션 `CodexSseAdapter` / `FetchCodexSseTransport`(app/src/gateway)를 **라이브 Codex/OpenAI-호환 SSE
provider에 그대로** 검증한다 — 재구현 아님. 자격증명은 **env로만** 주입하고 레포에 남기지 않는다.

## .env (로컬 전용, 자동 로드)

`run-poc.ts`는 실행 시 **같은 폴더의 `.env`를 자동 로드**한다(있을 때만; **셸 env가 .env보다 우선**).
`.env`는 루트 `.gitignore`로 **커밋 차단**된다(이 레포는 `.env*` 파일을 절대 커밋하지 않는다).

1. 이 폴더(`app/poc/d5-codex-sse/`)에 `.env` 파일을 만들고 값을 채운다:

   ```dotenv
   CODEX_BASE_URL=https://api.openai.com/v1
   CODEX_MODEL=gpt-4o-mini
   CODEX_EVIDENCE_ENDPOINT_ALIAS=[codex-staging-1]
   CODEX_EVIDENCE_MODEL_ALIAS=[model-a]
   # CODEX_MAX_CONTEXT_TOKENS=8192
   CODEX_API_KEY=PUT-YOUR-KEY-HERE
   ```

   PowerShell로 한 번에:
   ```powershell
   @'
   CODEX_BASE_URL=https://api.openai.com/v1
   CODEX_MODEL=gpt-4o-mini
   CODEX_EVIDENCE_ENDPOINT_ALIAS=[codex-staging-1]
   CODEX_EVIDENCE_MODEL_ALIAS=[model-a]
   CODEX_API_KEY=PUT-YOUR-KEY-HERE
   '@ | Set-Content -Encoding utf8 app/poc/d5-codex-sse/.env
   # 그 후 CODEX_API_KEY 값을 실제 키로 교체(에디터에서). .env 는 gitignore 되어 커밋되지 않는다.
   ```

2. 실행:
   ```powershell
   npm --prefix app/poc/d5-codex-sse install
   npm --prefix app/poc/d5-codex-sse run poc
   ```

## 규칙 (하니스가 강제)
- `CODEX_BASE_URL`: 절대 HTTPS, 자격증명/쿼리/fragment 금지.
- alias 2개: **대괄호 필수** `[...]`, 안은 영숫자/`.`/`-`/`_`.
- **필수 PASS: #1 basic SSE · #2 prompt-schema · #4 abort.** #3 native `json_schema`·#5 model metadata는 fallback 명시 시 **GAP 허용**. 필수 미충족 시 exit 1.
- 출력은 **redacted**(alias만 — 원 endpoint/model/key 미노출).

## ⚠ 비밀 취급
- `.env`의 `CODEX_API_KEY`는 **평문이 디스크에 남는다(로컬 전용)**. 절대 커밋/공유 금지.
- 정공법은 **Vault(SecretRef)** — staging/product-open에서는 키를 Vault에 두고 SecretRef로 해소(`CODEX_API_KEY=<SecretRef-resolved>`). 이 `.env`는 로컬 스모크 편의용이다.

## 증거
`결과: X/5 PASS` + PASS/GAP 표를 `D5-POC-EVIDENCE.md`에 옮기거나 redacted로 제출한다(alias만).
