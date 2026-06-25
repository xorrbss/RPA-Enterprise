# Enterprise ALM/RBAC Implementation Design

> 목적: 기업 도입 심사에서 차단 요소로 남은 ALM/변경관리와 RBAC 실운영 기능을 구현 가능한 수준으로 고정한다.
> 본 문서는 구현 설계안이며, 실제 SSoT 반영은 `api-surface.md`, `auth-rbac.md`, `db/`, `ts/`, `codegen/`, `app/`, `web/` 순서로 진행한다.

## 1. 현재 기준선

현재 저장소는 이미 다음 기반을 갖고 있다.

- `scenario_versions.promotion_status = draft|prod`와 `POST /v1/scenarios/{scenario_id}/promote`가 있다.
- `POST /v1/scenarios/{scenario_id}/versions/{version}/rollback`은 과거 IR을 최신 draft로 복제한다.
- `scenario.promote`는 현재 `admin`만 허용한다.
- `principals` 테이블과 `GET/POST/PATCH/DELETE /v1/principals`는 담당자 디렉터리와 수동 표시명 관리를 제공한다.
- RBAC 판정은 JWT/session principal의 `roles`와 `ts/rbac-policy.ts` 매트릭스를 기준으로 fail-closed 처리한다.
- `rbac.grant` 액션은 매트릭스에 존재하지만 역할 부여/회수 원장과 API/UI는 아직 없다.

따라서 새 설계는 기존 `prod` 승격 경로를 깨지 않고, 위에 release package, environment binding, role assignment 원장을 추가한다.

## 2. 목표와 비목표

### 목표

1. 시나리오 변경을 `dev -> staging -> prod` 환경 흐름으로 설명할 수 있게 한다.
2. 운영 배포는 maker-checker를 만족해야 한다.
3. prod 변경, 승인, 배포, 롤백이 모두 감사 가능해야 한다.
4. 사용자 역할을 콘솔/API에서 부여/회수할 수 있어야 한다.
5. JWT role claim 기반 운영과 수동 role assignment 기반 운영이 공존해야 한다.
6. 미확정 상태를 성공처럼 보이지 않는다. 모르면 명시 차단 결정으로 남긴다.

### 비목표

- GitHub Actions, ArgoCD, Terraform 같은 외부 배포 시스템을 이 저장소에서 구현하지 않는다.
- SCIM 동기화 전체 구현은 이번 범위가 아니다.
- 세분화된 부서/폴더/시나리오 단위 RBAC scope는 v1에서 열지 않는다. v1은 tenant-wide role assignment만 구현한다.
- 실행 중인 run을 강제로 새 prod 버전으로 갈아타지 않는다. 이미 시작된 run은 시작 시점의 `scenario_version_id`로 끝까지 간다.

## 3. ALM 도메인 모델

### 3.1 환경

v1 환경은 닫힌 enum으로 시작한다.

```ts
type ScenarioEnvironment = "dev" | "staging" | "prod";
```

- `dev`: draft 작성과 수동 테스트용. 기존 `POST /v1/runs`의 explicit `scenario_version_id` 실행은 dev 성격으로 유지한다.
- `staging`: 배포 전 검증 환경. release package가 승인되기 전 먼저 활성화될 수 있다.
- `prod`: 운영 기준 버전. 외부 트리거나 운영 실행의 기본 대상이다.

환경 자체는 tenant-scoped logical binding이다. 외부 인프라 환경 이름(`RPA_ENV=staging` 등)과 혼동하지 않는다.

### 3.2 신규 테이블

#### `scenario_environment_bindings`

환경별 현재 활성 버전을 나타낸다.

```sql
CREATE TABLE scenario_environment_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  scenario_id uuid NOT NULL REFERENCES scenarios(id),
  environment text NOT NULL CHECK (environment IN ('dev','staging','prod')),
  scenario_version_id uuid NOT NULL REFERENCES scenario_versions(id),
  release_id uuid,
  activated_by text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_by text,
  deactivated_at timestamptz,
  replaced_by_binding_id uuid
);

CREATE UNIQUE INDEX uq_current_scenario_environment_binding
  ON scenario_environment_bindings (tenant_id, scenario_id, environment)
  WHERE deactivated_at IS NULL;
```

규칙:
- `prod` binding은 기존 `scenario_versions.promotion_status='prod'`와 v1 동안 mirror한다.
- `dev` binding은 최신 draft를 자동 의미하지 않는다. 명시적으로 activation 된 버전만 binding이다.
- binding 변경은 기존 current row에 `deactivated_at`을 찍고 새 current row를 insert한다. 따라서 환경별 current row는 하나지만, 과거 binding 이력은 보존된다.
- `release_id`는 해당 binding을 만든 release를 가리킨다. 실제 migration에서는 `scenario_releases` 생성 뒤 FK를 추가한다.

#### `scenario_releases`

배포 후보 패키지와 승인 상태를 나타낸다.

```sql
CREATE TABLE scenario_releases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  scenario_id uuid NOT NULL REFERENCES scenarios(id),
  source_version_id uuid NOT NULL REFERENCES scenario_versions(id),
  target_environment text NOT NULL CHECK (target_environment IN ('staging','prod')),
  status text NOT NULL CHECK (status IN (
    'draft','submitted','approved','rejected','deployed','rolled_back','cancelled'
  )),
  package_hash text NOT NULL,
  validation_report jsonb NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  rejection_reason text,
  deployed_by text,
  deployed_at timestamptz,
  rollback_of_release_id uuid REFERENCES scenario_releases(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`package_hash`는 canonical JSON 기반으로 계산한다.

```text
sha256(canonical({
  scenario_id,
  source_version_id,
  target_environment,
  ir,
  params_schema,
  validation_report
}))
```

SecretRef 값, artifact body, prompt 원문은 package hash 입력에 넣지 않는다.

#### `scenario_release_events`

릴리스 상태 전이 이력을 제품 화면에서 보여주기 위한 원장이다. 보안 감사는 기존 `audit_log`에도 남긴다.

```sql
CREATE TABLE scenario_release_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  release_id uuid NOT NULL REFERENCES scenario_releases(id),
  event_type text NOT NULL CHECK (event_type IN (
    'created','submitted','approved','rejected','deployed','rolled_back','cancelled'
  )),
  actor_sub text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 3.3 상태 전이

```text
draft -> submitted -> approved -> deployed
draft -> cancelled
submitted -> rejected
submitted -> cancelled
approved -> cancelled
deployed -> rolled_back
```

불변식:
- `submitted` 이후 `source_version_id`, `target_environment`, `package_hash`는 불변이다.
- `approve`는 `requested_by != approved_by`를 강제한다.
- `deploy`는 release `status='approved'`에서만 가능하다.
- `prod` deploy 전에는 compile pipeline을 다시 실행한다. 최초 package 생성 시 통과했더라도 배포 시점에 다시 검증한다.
- compile 또는 validation warning이 있으면 prod deploy를 거부한다. 기존 prod 승격 규칙과 동일하게 보수적으로 닫는다.
- rollback은 과거 binding으로 직접 되돌리는 명령이 아니라 `rollback_of_release_id`가 있는 새 release를 만든 뒤 deploy하는 명령으로 모델링한다.

### 3.4 기존 `promote`와의 호환

기존 `POST /v1/scenarios/{scenario_id}/promote`는 즉시 제거하지 않는다.

v1 전환 정책:
- API는 유지하되 내부적으로 `target_environment='prod'` release를 생성, 승인, deploy까지 단일 트랜잭션으로 수행하는 legacy fast path로 감싼다.
- 이 fast path는 `admin`만 가능하고, `reason='legacy_promote'`를 release event와 audit log에 남긴다.
- 기업 모드(`ALM_ENFORCE_MAKER_CHECKER=true`)에서는 legacy fast path를 거부하고 새 release workflow만 허용한다.

## 4. ALM API 설계

새 권한 액션:

```ts
type RbacAction =
  | existing
  | "scenario_release.read"
  | "scenario_release.submit"
  | "scenario_release.approve"
  | "scenario_release.deploy"
  | "scenario_release.rollback";
```

권한 기본값:

| 액션 | viewer | operator | reviewer | approver | admin |
|---|:--:|:--:|:--:|:--:|:--:|
| `scenario_release.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `scenario_release.submit` | — | ✓ | ✓ | ✓ | ✓ |
| `scenario_release.approve` | — | — | — | — | ✓ |
| `scenario_release.deploy` | — | — | — | — | ✓ |
| `scenario_release.rollback` | — | — | — | — | ✓ |

초기 구현은 `admin` 승인/배포로 시작한다. `approver`에게 prod release 승인 권한을 줄지는 기업별 SoD 정책 문제이므로 기본 허용하지 않는다.

신규 엔드포인트:

| Method | Path | 요지 |
|---|---|---|
| GET | `/v1/scenarios/{scenario_id}/environment-bindings` | 환경별 current binding 조회 |
| GET | `/v1/scenarios/{scenario_id}/releases` | 릴리스 목록 조회 |
| POST | `/v1/scenarios/{scenario_id}/releases` | source version과 target env로 draft release 생성 |
| GET | `/v1/scenario-releases/{release_id}` | release 상세, validation report, event history |
| POST | `/v1/scenario-releases/{release_id}/submit` | draft -> submitted |
| POST | `/v1/scenario-releases/{release_id}/approve` | submitted -> approved, maker-checker 강제 |
| POST | `/v1/scenario-releases/{release_id}/reject` | submitted -> rejected |
| POST | `/v1/scenario-releases/{release_id}/deploy` | approved -> deployed, environment binding 갱신 |
| POST | `/v1/scenario-releases/{release_id}/rollback` | deployed release 기준 rollback release 생성 또는 배포 |

명령형 endpoint는 모두 `Idempotency-Key`를 요구한다. version 관련 명령은 `If-Match`를 병행한다.

응답은 공통으로 `release`, `events`, `current_binding`을 포함한다. 실패 시 `AUTHZ_FORBIDDEN`, `SCENARIO_VERSION_CONFLICT`, `IR_SCHEMA_INVALID`, `IR_EXPRESSION_COMPILE_ERROR`, `RESOURCE_NOT_FOUND` 중 하나로 닫는다.

## 5. RBAC 도메인 모델

### 5.1 원칙

현재 JWT role claim은 계속 유효하다. 새 수동 role assignment는 claim을 대체하지 않고 보강한다.

```text
effective_roles = union(valid_jwt_roles, active_manual_role_assignments)
```

규칙:
- 알 수 없는 role은 저장과 평가 모두 거부한다.
- 만료된 assignment는 effective role에 포함하지 않는다.
- revoked assignment는 포함하지 않는다.
- role 변경은 `rbac.grant` 권한이 있는 principal만 수행한다.
- 역할 부여/회수는 반드시 audit log와 role assignment event에 남긴다.
- 수동 assignment는 tenant-wide만 지원한다. scope 확장은 별도 계약 전까지 금지한다.

### 5.2 신규 테이블

#### `principal_role_assignments`

```sql
CREATE TABLE principal_role_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  principal_sub text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','operator','reviewer','approver','admin')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  reason text,
  expires_at timestamptz,
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_active_principal_role_assignment
  ON principal_role_assignments (tenant_id, principal_sub, role)
  WHERE status = 'active';
```

`principal_sub`는 `principals.sub`와 동형 text다. FK는 v1에서 두지 않는다. 이유는 기존 `human_tasks.assignee`와 동일하게 IdP `sub`가 자유형이고, 아직 디렉터리에 없는 사용자에게도 사전 부여가 필요할 수 있기 때문이다.

#### `principal_role_assignment_events`

```sql
CREATE TABLE principal_role_assignment_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  assignment_id uuid NOT NULL REFERENCES principal_role_assignments(id),
  event_type text NOT NULL CHECK (event_type IN ('granted','revoked','expired')),
  actor_sub text NOT NULL,
  target_sub text NOT NULL,
  role text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 5.3 인증/RBAC 해소 흐름

1. AuthenticationBoundary가 JWT/session을 검증하고 `subjectId`, `tenantId`, claim roles를 만든다.
2. 서버 preHandler가 tenant DB에서 active assignment를 조회한다.
3. unknown/invalid role은 저장 단계에서 차단되어야 하며, 조회 중 발견되면 fail-closed로 요청을 거부한다.
4. `AuthenticatedPrincipal.roles`는 claim roles와 assignment roles의 합집합으로 설정한다.
5. 기존 `RoleMatrixRbacMiddleware`는 변경된 effective roles로 그대로 판정한다.

구현 위치:
- `app/src/api/server.ts` auth preHandler 뒤 principal directory upsert 근처에 `RoleAssignmentResolver`를 주입한다.
- 테스트에서는 resolver 미주입 시 기존 JWT-only 동작을 유지한다.
- 운영 모드에서 resolver 미주입은 `RBAC_ASSIGNMENTS_ENABLED=true`일 때 fail-closed 한다.

### 5.4 RBAC API 설계

| Method | Path | 요지 |
|---|---|---|
| GET | `/v1/principals/{principal_id}/role-assignments` | 해당 principal의 active/revoked 역할 이력 조회 |
| POST | `/v1/principals/{principal_id}/role-assignments` | `{ role, reason?, expires_at? }` 부여 |
| POST | `/v1/role-assignments/{assignment_id}/revoke` | `{ reason }` 회수 |
| GET | `/v1/role-assignments` | role, status, principal_sub 필터로 전체 조회 |

모든 쓰기 명령은 `Idempotency-Key`를 요구한다. 쓰기 권한은 `rbac.grant`다.

보호 규칙:
- 자기 자신의 마지막 `rbac.grant` 근거를 제거하는 revoke는 거부한다.
- 자기 자신에게 `admin`을 부여하는 것은 거부한다. break-glass는 별도 외부 절차로 남긴다.
- `expires_at`이 과거면 저장 거부한다.
- 동일 active `(tenant_id, principal_sub, role)` 중복 부여는 `IR_SCHEMA_INVALID(reason=role_assignment_already_active)`로 거부한다.
- IdP claim role은 이 API로 회수할 수 없다. UI는 source를 `token`과 `manual`로 분리 표시한다.

TODO: [BLOCKED] SCIM 동기화의 provider, inbound schema, conflict rule이 정해지지 않았다. v1은 `source='manual'`만 저장하고, SCIM은 별도 계약이 열릴 때까지 성공 응답을 만들지 않는다.
Required decision: choose the SCIM provider boundary, inbound principal/group schema, role-mapping source of truth, and token/manual/SCIM conflict resolution rule before any `source='scim'` assignment can be accepted.

## 6. Web 콘솔 설계

### 6.1 시나리오 릴리스 관리

`Scenarios` 화면에 "릴리스" 탭을 추가한다.

주요 영역:
- 환경별 활성 버전: dev/staging/prod badge, version, activated_at, actor
- 릴리스 목록: status, target env, source version, requester, approver, deployed_at
- 릴리스 상세: validation report, event timeline, package hash, reason
- 작업 버튼:
  - draft 생성
  - 제출
  - 승인
  - 반려
  - 배포
  - 롤백 릴리스 생성

UX 원칙:
- prod 배포 버튼은 validation 결과와 maker-checker 조건을 통과할 때만 활성화한다.
- 비활성 버튼은 숨기지 않고 권한/상태 사유를 표시한다.
- legacy `prod 승격` 버튼은 enterprise mode에서 `릴리스 요청` CTA로 대체한다.

### 6.2 역할 관리

`Security` 화면의 RBAC 섹션을 확장한다.

주요 영역:
- Principal 목록과 상세 drawer
- token roles와 manual assignments 분리 표시
- 역할 부여 modal: role, reason, optional expires_at
- 역할 회수 confirm: reason 필수
- 역할 변경 이력 timeline

UX 원칙:
- `rbac.grant`가 없으면 읽기 전용으로 보여준다.
- 자기 자신 admin/self-grant 금지는 API와 UI에서 모두 설명한다.
- claim 기반 role은 "IdP에서 관리"로 표시하고 콘솔 회수 버튼을 제공하지 않는다.

## 7. 감사와 보안

모든 ALM/RBAC 쓰기는 두 경로에 남긴다.

1. 제품 원장: `scenario_release_events`, `principal_role_assignment_events`
2. 보안 감사: 기존 `audit_log`

감사 payload 원칙:
- actor, target, action, outcome, correlation_id, reason은 남긴다.
- IR 전문, SecretRef resolved value, artifact body, token 원문은 남기지 않는다.
- package hash와 version id는 남겨 추적성을 확보한다.

## 8. 테스트 계획

### 계약/codegen

- `auth-rbac.md` 매트릭스와 `ts/rbac-policy.ts` 동기화 테스트
- `api-surface.md` 신규 endpoint OpenAPI 생성 확인
- DB migration smoke: 신규 테이블, enum check, unique active assignment, RLS 정책

### app

- release 생성 시 compile/validation 실패면 저장 거부
- submit/approve/deploy 상태 전이 정상
- `requested_by == approved_by` approve 거부
- deploy 시 environment binding 갱신 및 기존 prod mirror 유지
- rollback release 생성과 배포 검증
- legacy promote가 enterprise mode에서 거부되는지 검증
- role grant/revoke effective roles 반영
- token role과 manual role union
- 자기 자신 admin 부여/마지막 grant 회수 거부
- cross-tenant principal/release 접근 404 또는 AUTHZ 거부
- 모든 쓰기 명령 idempotency replay 검증

### web

- 릴리스 탭 상태별 버튼 노출/비활성 사유
- validation warning/error 표시
- maker-checker 실패 메시지
- 역할 부여/회수 modal과 history 갱신
- `rbac.grant` 없는 사용자 읽기 전용 렌더링

## 9. 구현 순서

1. 계약 반영
   - `auth-rbac.md`: 신규 ALM 액션, role assignment 규칙
   - `api-surface.md`: release/RBAC endpoint
   - `ts/security-middleware-contract.ts`, `ts/rbac-policy.ts`: 액션 추가
2. DB migration
   - `scenario_releases`
   - `scenario_release_events`
   - `scenario_environment_bindings`
   - `principal_role_assignments`
   - `principal_role_assignment_events`
   - RLS 정책
3. codegen 갱신
   - OpenAPI/types/fixtures
4. app API
   - release store/service/routes
   - role assignment resolver/routes
   - audit log writer integration
5. web
   - Scenarios release tab
   - Security role assignment panel
6. 검증
   - package별 typecheck/test
   - `node scripts/run-local-gates.mjs --skip-db`
   - DB integration은 PostgreSQL 환경에서 별도 실행

## 10. 완료 기준

ALM 완료 기준:
- operator가 release를 제출하고 admin이 다른 주체로 승인/배포할 수 있다.
- prod 배포는 environment binding과 기존 prod marker가 일치한다.
- rollback은 과거 버전을 새 release로 만들어 감사 가능하게 수행된다.
- legacy promote는 enterprise mode에서 maker-checker를 우회하지 못한다.

RBAC 완료 기준:
- admin이 콘솔/API에서 사용자 역할을 부여/회수할 수 있다.
- 부여/회수 결과가 다음 요청의 effective roles에 반영된다.
- token role은 유지되고 manual role과 합집합으로 평가된다.
- 자기 권한 상승과 자기 마지막 grant 회수가 차단된다.
- 모든 권한 변경은 제품 이력과 audit log에 남는다.

이 기준을 만족하면 기업 도입 담당자 관점의 핵심 질문인 "누가 만들고, 누가 승인했고, 어떤 권한으로 배포/운영되는가"에 제품이 직접 답할 수 있다.
