# 보안 계약 (Security Contracts v1)

> 시크릿 경계·실행 격리·redaction·접근 통제의 단일 진실원천. `core-types.ts` brand 타입과 `impl-contracts-bundle.md` §A/§C를 보강해, 참조만 되고 정의가 없던 보안 항목을 고정한다.
> 원칙: **"조용한 false/unknown 금지"** — 미분류 위험은 `security` 예외로 차단(absorb 금지), 통과는 명시 통과만.

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
  side_effect_kind: "read_only" | "create" | "update" | "delete" | "upload";
};
```

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
  block_on_violation: boolean;   // 기본 true
};
```
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

---

## 9. action.sensitive & recording 동작

`ir.schema.json` action `sensitive`(기본 false)·nodePolicy `recording`(기본 `masked_on_failure`)의 런타임 의미:

| recording | 동작 |
|---|---|
| `always` | 매 step 화면 기록(증빙). `sensitive=true` 입력 영역은 항상 마스킹 후 저장. |
| `masked_on_failure` (기본) | 성공 step은 기록 안 함; **실패 시에만** 마스킹된 화면 저장(디버깅). |
| `never` | 화면 기록 없음(증빙 불가 — side_effect 노드엔 부적합). |

규칙: `sensitive=true` action의 입력값은 recording 모드와 무관하게 **항상 마스킹**(평문 화면 저장 금지). 어떤 모드든 저장 artifact는 §4/§8 게이트를 통과해야 조회 가능.
