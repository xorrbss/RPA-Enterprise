# 인증·인가·테넌시 계약 (Auth / RBAC / Tenancy v1)

> RBAC 역할 레지스트리·권한 매트릭스·테넌시(RLS) 의 단일 진실원천.
> README §"외부 의존 맵" §4(인증·인가·테넌시)의 "위치 미확정(TODO)"와 v1.4 footer "Phase 2: RBAC 역할 + tenant/RLS"를 본 패키지 안에서 직접 정의한다(별도 PRD 소유자 없음 → 본 패키지가 완전한 SSoT).
> 원칙: **"조용한 false/unknown 금지"** — 권한 판정은 명시 허용만 통과, 미허용은 차단(typed 에러). tenant 경계는 미설정 시 통과시키지 않고 차단.
> 참조: `ts/error-catalog.ts`(security 코드군), `security-contracts.md` §1·§7·§8, `state-machine.md`(W10/R6/H1·H3), `schema/ir.schema.json`(`nodePolicy.requires_approval`), `reserved-handlers.md`(@human_task `assignee_role`/kind), `ts/core-types.ts`(`RunContext.tenantId`), `db/migration_concurrency_idempotency.sql`(모든 테이블 tenant_id + RLS(P2) 전제).

---

## 1. 역할 레지스트리 (Role Registry)

최소 역할 집합. 계약 참조에서 도출했다(괄호=근거):

```ts
// 권위: 본 문서. enum/CHECK·미들웨어·JWT role 클레임이 모두 이 값을 참조.
export type Role =
  | "viewer"     // 조회 전용
  | "operator"   // 운영 실행/복구 (run create/abort·W10 manual_replay)
  | "reviewer"   // Human Task 검증/예외 처리 (kind=validation|exception|captcha|mfa)
  | "approver"   // 승인 (nodePolicy.requires_approval, kind=approval, site risk=red)
  | "admin";     // 전권 (secret/connector/scenario promote 포함)
```

| 역할 | 설명 | 도출 근거 |
|---|---|---|
| `viewer` | run/workitem/human_task/대시보드·트레이스·artifact 조회만. 상태 변경 불가. | 운영 콘솔 read-only audience |
| `operator` | run `create`/`abort`(R6), DLQ `manual_replay`(W10 `operatorAuthorized`), sink DLQ replay, human_task 인박스 assign/start. 조회 포함. | api-surface run create, state-machine W10 "운영자 재처리 권한", R6, error-catalog `DEAD_LETTER`/`SINK_DELIVERY_FAILED` operatorAction |
| `reviewer` | human_task `resolve`(H3, kind=validation/exception/captcha/mfa) 및 manual `escalate`(H5). operator 권한 포함(assign/start). | reserved-handlers @human_task kind, state-machine H1/H2/H3/H5 |
| `approver` | human_task `resolve`(kind=approval), `nodePolicy.requires_approval` 승인, site risk=red 승인. reviewer 권한 포함. | ir.schema `requires_approval`, error-catalog `SITE_PROFILE_BLOCKED`(risk=red), reserved-handlers kind=approval |
| `admin` | scenario promote(prod 승격), secret 접근, connector enable, RBAC 역할 부여, network policy 편집. 전 권한 포함. | error-catalog `SECRET_ACCESS_DENIED`/`CONNECTOR_PERMISSION_DENIED`, SCENARIO_VERSION_CONFLICT(승격 경로) |

규칙:
- 역할은 **포함(inclusion) 관계가 아니라 매트릭스로 명시 평가**한다(§2). 위 "포함" 서술은 기본 정책 권고일 뿐, 실제 허용은 §2 표가 결정한다(조용한 상속 금지). 다중 역할 보유 시 합집합으로 평가.
- `assignee_role`(@human_task 입력)은 본 enum 값을 사용한다. human_task 생성 시 지정된 `assignee_role`을 가진 주체만 해당 task를 assign/resolve할 수 있다(§2 비고 참조).

---

## 2. 권한 매트릭스 (역할 × 액션)

`✓`=허용, `—`=거부(미허용 → 차단). 각 액션은 명시 허용 역할 집합으로만 통과한다.

| 액션 | API/계약 근거 | viewer | operator | reviewer | approver | admin | 거부 시 ErrorCode |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| run/workitem/human_task 조회 | 콘솔 read | ✓ | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| run `create` | api-surface `POST /v1/runs` | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| run `abort` (R6 → cancelled) | error-catalog `RUN_ABORTED` 어휘체인 | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| human_task `assign`/`start` (H1/H2) | state-machine H1·H2 | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| human_task `escalate` (H5) | state-machine H5, api-surface fail-closed routing 규칙 | — | — | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| human_task `resolve` — kind=validation/exception/captcha/mfa (H3) | reserved-handlers @human_task | — | — | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| human_task `resolve` — kind=approval (H3) | reserved-handlers kind=approval | — | — | — | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| `nodePolicy.requires_approval` 승인 | ir.schema `requires_approval` | — | — | — | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| DLQ `manual_replay` (W10) | state-machine W10 `operatorAuthorized` | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| sink DLQ replay | error-catalog `SINK_DELIVERY_FAILED` operatorAction | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| scenario 조회/검증(read·validate dry-run) | api-surface §2 `GET /v1/scenarios` · `POST .../validate` | ✓ | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| scenario 작성/수정(create·save) | api-surface §2 `POST /v1/scenarios`·`PUT` (D4 결정: operator+ 작성) | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| scenario promote(prod 승격) | error-catalog `SCENARIO_VERSION_CONFLICT`(If-Match 412) | — | — | — | — | ✓ | `AUTHZ_FORBIDDEN` |
| artifact 조회 | security-contracts §8(redaction→RBAC 게이트) | ✓ | ✓ | ✓ | ✓ | ✓ | `SECRET_ACCESS_DENIED` |
| site 조회(risk/circuit 상태) | api-surface §7 `GET /v1/sites`·`/{id}` (콘솔 read) | ✓ | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| site 신규 등록(온보딩) | api-surface §7 `POST /v1/sites` (`site.create`; scenario 작성과 동일 레벨) | — | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| site risk=red 승인 권한 | approver 게이트(권한 부족=일반 RBAC 거부) | — | — | — | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| secret 접근(SecretStore.resolve 스코프) | security-contracts §1, core-types `SecretStore` | — | — | — | — | ✓ | `SECRET_ACCESS_DENIED` |
| connector enable/install | security-contracts §7, error-catalog `CONNECTOR_PERMISSION_DENIED` | — | — | — | — | ✓ | `CONNECTOR_PERMISSION_DENIED` |
| gateway policy 조회 | api-surface §6 `GET /v1/gateway/policy` (콘솔 read) | ✓ | ✓ | ✓ | ✓ | ✓ | `AUTHZ_FORBIDDEN` |
| gateway policy 편집 | api-surface §6 `PUT /v1/gateway/policy` | — | — | — | — | ✓ | `AUTHZ_FORBIDDEN` |
| network policy 편집(allowed_domains) | security-contracts §6 | — | — | — | — | ✓ | `AUTHZ_FORBIDDEN` |
| RBAC 역할 부여/회수 | 본 문서 §1 | — | — | — | — | ✓ | `AUTHZ_FORBIDDEN` |

거부 ErrorCode 선택 규칙(조용한 false/unknown 금지):
- **자원 종류가 특정된 보안 게이트**는 그 자원 코드를 쓴다: artifact·secret → `SECRET_ACCESS_DENIED`(security, 403), connector → `CONNECTOR_PERMISSION_DENIED`(security, 403). `SITE_PROFILE_BLOCKED`는 **런타임 실행 차단**(미승인 red 사이트 실행 시도) 전용이며, site **승인 권한** 부족은 일반 RBAC 거부 `AUTHZ_FORBIDDEN`이다(api-surface §7과 정합).
- **그 외 일반 역할/액션 권한 부족**(run create/abort·DLQ replay·promote·human_task resolve·역할관리 등)은 신규 `AUTHZ_FORBIDDEN`(security, 403, retryable=false)로 통일한다. 이는 SECRET/CONNECTOR/SITE 어느 자원 게이트에도 속하지 않는 RBAC 거부의 단일 코드다.

비고(assignee 스코핑):
- human_task `resolve`는 **역할 충족 AND 해당 task의 `assignee_role`/`assignee` 스코프 일치**를 함께 검사한다. 역할은 충족하나 다른 담당자에게 배정된 task를 가로채는 것을 막는다(H1에서 assignee set). 둘 다 만족해야 통과(security-contracts §8과 동일한 "복수 게이트 순차 검사" 패턴).
- artifact 조회는 security-contracts §8 그대로 **2게이트 순서 검사**: ① `redaction_status ∈ {redacted, not_required}`(미통과 → `ARTIFACT_NOT_REDACTED`) → ② 호출자 역할의 해당 tenant/run artifact 조회 권한(미통과 → `SECRET_ACCESS_DENIED`). 미들웨어 1지점(impl-bundle §C)에서 redaction → RBAC 순으로 평가.

---

## 3. tenant_id 인증 출처 & 경계 강제

`migration_concurrency_idempotency.sql`은 "모든 테이블 tenant_id 보유 + RLS(P2)"를 전제하나 tenant_id의 **인증 출처**를 정의하지 않았다. 본 절이 고정한다.

- **출처**: 인증 주체(JWT 또는 세션)의 클레임에서 `tenant_id`(+ `roles: Role[]`)를 도출한다. 클라이언트 입력 body/query의 tenant_id는 **신뢰하지 않는다**(위조 방지). 토큰 클레임만이 권위.
- **경계 강제**: 모든 요청 경계(제어평면 API 진입, queue job 소비, 이벤트 발행)에서 인증 컨텍스트의 tenant_id를 추출해 트랜잭션 세션에 바인딩(§4 `SET LOCAL`)한다. **인증 자체가 미성립**(Bearer 토큰 누락·서명 무효·만료)이면 → `UNAUTHENTICATED`(401). 인증은 성립했으나 **클레임에 tenant_id가 없거나 다중 모호**하면 → **요청 거부**(`AUTHZ_FORBIDDEN`, 403), 통과 금지(조용한 false 금지). authn(401)/authz(403)는 분리한다(§5).
- **정합**: 도출된 tenant_id는 `RunContext.tenantId`(core-types) 및 이벤트 envelope의 `tenant_id`(event-envelope, impl-bundle §E trace 공통 속성)와 **동일 값이어야 한다**. 불일치 시 system 무결성 위반으로 차단(cross-tenant 접근 의심).
- **자원 단위 일치**: run/workitem/artifact 등 자원 접근 시 자원 row의 tenant_id가 인증 tenant_id와 다르면 RLS(§4)가 row를 보이지 않게 하며, 미들웨어 레벨에서도 `RUN_NOT_FOUND` 등 자원 부재로 응답(존재 노출 회피). RBAC 역할 평가는 동일 tenant 내에서만 의미를 가진다.

---

## 4. RLS 정책 (Row-Level Security, P2)

전제: 단일 Postgres 스택(PostgreSQL 15+). tenant_id는 트랜잭션 세션 변수로 주입하고, 모든 멀티테넌트 테이블에 동일 패턴의 USING 정책을 적용한다.

세션 변수 주입(요청/트랜잭션 시작 시 1회):
```sql
-- 인증 컨텍스트(§3)에서 도출한 tenant_id를 트랜잭션 로컬로 바인딩.
-- SET LOCAL → 트랜잭션 종료 시 자동 해제(연결 풀 재사용 안전).
SET LOCAL app.tenant_id = '...';   -- uuid 문자열
```

표준 정책 패턴(테이블별 동일):
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;   -- 테이블 소유자에도 강제(우회 방지)

CREATE POLICY tenant_isolation ON <table>
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- 미설정 시 current_setting(..., true)가 아니라 strict 호출 → 오류로 차단(조용한 전체노출 금지).
-- 운영 배치/마이그레이션 등 tenant 비종속 작업은 BYPASSRLS 역할로 명시 분리(애플리케이션 롤 아님).
```

artifact 예외(조회 게이트 DB 방어):
- `artifacts`는 generic tenant policy 대신 `FOR SELECT` 정책에 `deleted_at IS NULL AND redaction_status IN ('redacted','not_required')`를 추가한다. 즉 애플리케이션 쿼리가 redaction 필터를 빠뜨려도 pending/failed/deleted artifact row는 보이지 않는다.
- redaction/retention/integrity job은 pending/failed/deleted row를 다뤄야 하므로 애플리케이션 롤이 아니라 명시적 운영 롤(BYPASSRLS 도메인)에서 수행한다.

적용 대상 테이블(전부 tenant_id 보유):

기존 migration 정의 테이블:
- `credential_concurrency_policies`, `credential_leases`, `browser_leases`, `raw_items`, `normalized_records`, `sink_deliveries`, `challenge_resolution_attempts`
- (참고) `action_plan_cache`는 PRD §7 본체 정의 — 동일 패턴 적용 대상(tenant_id 보유 전제).

현재 core_entities 정의 테이블(tenant_id 보유, migration_core_entities.sql에서 RLS 활성화):
- `runs`, `run_steps`, `workitems`, `human_tasks`, `scenarios`, `scenario_versions`, `artifacts`, `events_outbox`, `dead_letter`, `stagehand_calls`, `site_profiles`, `site_profile_approvals`, `browser_identities`, `network_policies`, `gateway_policies`, `control_plane_idempotency_keys`

**RLS 제외(인프라, 테넌트 비종속)**: `workers`(실행기 생존·서킷 레지스트리, migration_core_entities.sql) — `tenant_id` 없음, **BYPASSRLS 도메인**(운영/스케줄러 롤). 서킷 상태는 사이트=`site_profiles.circuit_state`(tenant-scoped, RLS 적용)·워커=`workers.circuit_state`(인프라)에 각각 영속.

비고:
- `credential_leases`/`browser_leases`처럼 tenant_id가 복합 PK 일부인 테이블도 RLS는 행 단위 USING으로 추가 적용한다(PK 제약과 독립).
- FK 참조는 tenant 내부 일관성을 composite FK로 강제한다(예: `normalized_records.(tenant_id, raw_item_id) → raw_items.(tenant_id, id)`). cross-tenant 참조는 FK와 RLS 양쪽에서 차단한다.
- RLS는 P2 단계 활성화(migration 전제와 동일). P1에서는 미들웨어/쿼리 레벨 tenant 필터가 1차 방어, P2 RLS가 심층 방어(defense-in-depth).

---

## 5. error-catalog 정합

| 상황 | ErrorCode | exceptionClass | httpStatus | 비고 |
|---|---|---|---|---|
| 인증 미성립(Bearer 토큰 누락/서명 무효/만료) | `UNAUTHENTICATED` (신규) | security | 401 | §3 authn 경계 — authz(403)와 분리 |
| 일반 RBAC 역할/액션 권한 부족 | `AUTHZ_FORBIDDEN` (신규) | security | 403 | §2 거부 통일 코드 |
| secret/artifact 접근 거부 | `SECRET_ACCESS_DENIED` | security | 403 | security-contracts §1·§8 |
| connector enable/권한 위반 | `CONNECTOR_PERMISSION_DENIED` | security | 403 | security-contracts §7 |
| site risk=red 미승인 접근 | `SITE_PROFILE_BLOCKED` | security | 403 | error-catalog 기존 |
| artifact redaction 미완 | `ARTIFACT_NOT_REDACTED` | security | 409 | RBAC 게이트 이전 단계 |
| tenant 불일치/누락(무결성) | `AUTHZ_FORBIDDEN` | security | 403 | §3 경계 강제 실패 |

코드 `AUTHZ_FORBIDDEN`는 `error-catalog.ts`에 반영되어 있으며 메타는 아래와 일치해야 한다:
```ts
AUTHZ_FORBIDDEN: { retryable: false, httpStatus: 403, exceptionClass: "security",
  userMessage: "권한이 없습니다.", operatorAction: "RBAC 역할/권한 매트릭스 확인(auth-rbac.md §2)" },
```
- enum 정의는 `// --- Secret / Security ---` 그룹에 위치 권고.
- userMessage는 기존 security 코드(`SECRET_ACCESS_DENIED`)와 동일 "권한이 없습니다."로 외부 노출을 최소화(자원 종류·존재 비노출).

코드 `UNAUTHENTICATED`(신규, 401)도 `error-catalog.ts`에 반영되어 있으며 메타는 아래와 일치해야 한다:
```ts
UNAUTHENTICATED: { retryable: false, httpStatus: 401, exceptionClass: "security",
  userMessage: "인증이 필요합니다.", operatorAction: "유효한 Bearer JWT 제시(auth-rbac.md §3) — 토큰 누락/서명 무효" },
```
- 인증 경계(`security-middleware-contract.ts` `AuthenticationBoundary`)는 토큰 미성립 시 이 코드로 거부하고(401), 인증 성립 후 tenant/역할 권한 부족은 `AUTHZ_FORBIDDEN`(403)로 분리한다(`AuthFailureCode = UNAUTHENTICATED | AUTHZ_FORBIDDEN`).
