# 오프보딩 원문 데이터 반출 + 셀프서비스 삭제 설계

Date: 2026-07-03
Status: design draft for implementation (오너 정책 3건 확정 반영)
Scope: 테넌트 오프보딩 시 ① 민감 원문 데이터 패키지 반출(raw export) ② 2단계(soft→유예 후 hard) 셀프서비스 삭제 플로우
Out of scope: metadata export(PR #388, 완료) 재설계 · 테넌트 프로비저닝/과금 해지 절차(제품 밖) · audit_log 삭제(WORM 불변 — 아래 §5.4)

## 1. Why This Exists

두-페르소나 감사(`audit/rpa-two-persona-audit-2026-07-02/notes.md`)의 비평관 횡단 발견 "오프보딩 데이터 반출 부재"는 PR #388(metadata export)로 절반만 닫혔다. 남은 절반이 이 설계다:

- **반출**: 현행 export는 metadata-only다 — `runs.params`, human task `payload/result`, artifact 본문을 **의도적으로 미노출**한다(`offboarding-export.ts` manifest `omitted_fields`). 오프보딩하는 테넌트는 자신의 업무 원문을 가져갈 권리가 있고, 도입 심사자는 "나갈 때 데이터를 돌려받고 지울 수 있는가"를 묻는다.
- **삭제**: 현재 테넌트 데이터를 지우는 셀프서비스 경로가 없다. hard-delete 인프라는 artifacts 한 곳뿐이고(retention sweeper), `runs`/`human_tasks`/`run_steps`/`stagehand_calls`에는 `deleted_at` 컬럼조차 없다.

## 2. 오너 확정 정책 (2026-07-03)

| 결정 | 확정값 |
| --- | --- |
| 반출 범위 | `runs.params` 원문 + human task `payload`/`result` 원문 + artifact 본문(**redacted/not_required만** — 원본(비-redacted) 제외) |
| 삭제 정책 | **2단계**: 승인 즉시 soft(신규 활동 차단 + 삭제 예약) → 유예기간(기본 7일) 경과 후 sweeper가 비가역 삭제. `legal_hold` 행 제외 |
| 승인 게이트 | **maker-checker**: 요청자 ≠ 승인자(admin 2인), `scenario_promotion_requests` SoD 선례 재사용 |

공통 전제(범위와 무관한 불변): 자격증명·쿠키·SecretRef 해석값·resume_token·bookmark 은 어떤 반출에도 포함하지 않는다(SecretRef 규율, `security-contracts.md` §1; resume_token/bookmark 은 실행 재개용 내부 봉투 — 테넌트 업무 데이터가 아님).

## 3. References (verify-before-build 근거)

- `app/src/api/offboarding-export.ts` — metadata export 선례: `tenant_data.export`(admin 전용), created_at 범위, CSV BOM+formula guard, manifest `omitted_fields`
- `app/src/api/reads-artifacts.ts` — artifact 본문 read 경계: RLS visible-isolation(redacted/not_required·미삭제·비격리만) + security-audit **fail-closed**(기록 실패 시 본문 미반환)
- `app/src/api/security-audit.ts` — `PgDurableSecurityAuditDecisionWriter`(hash-chain, advisory-lock 직렬화, `SECURITY_AUDIT_REQUIRED_ACTIONS` 허용목록)
- `app/src/worker/artifact-retention-processor.ts` — 유일한 hard-delete 선례: legal_hold=false 강제(claim→재락→finalize CAS, AUD-11 TOCTOU 해소), object 삭제 + row tombstone
- `db/migration_core_entities.sql` — `deleted_at`/`legal_hold`/`retention_until` 3종 보유 테이블 목록(§5.4 레지스트리 근거), `prevent_audit_log_mutation` WORM 트리거(:2061-2073)
- `app/src/api/scenarios.ts:587-655` — maker-checker 선례(SoD `self_approval_forbidden` 403, reason 필수, `runIdempotentCommand`)
- `ts/runtime-contract.ts:1013-1033` — 잡 kind 레지스트리(신규 sweeper kind 추가 지점), `maintenance-scheduler.ts` daily 틱(KST 02시)
- `scripts/mint-operator-token.mjs` — 무의존 루트 스크립트 선례(반출 다운로드 스크립트의 배치 기준)

## 4. 설계 원칙

1. **기존 경계 재사용** — artifact 본문은 새 반출 경로를 만들지 않고 기존 `/v1/artifacts/{id}/blob`(RLS redaction 게이트 + fail-closed audit)를 그대로 쓴다. 새 코드가 새 노출 경로가 되지 않게 한다.
2. **삭제는 테넌트-원장 단위** — 행별 `deleted_at`을 4개 테이블에 신설·전파(RLS/조회 전면 수정)하는 대신, **오프보딩 원장 1테이블 + 원장 상태 게이트 + purge sweeper**로 구성한다. 오프보딩 삭제는 본질적으로 테넌트 전체 스코프라 행별 tombstone 이 주는 가치가 없다(KISS).
3. **WORM/legal_hold 존중** — `audit_log`는 트리거가 UPDATE/DELETE 를 차단하므로 삭제 대상에서 제외(불변 증거로 보존·명시). `legal_hold=true` 행(artifacts 등)은 purge 에서 건너뛰고 잔존 목록을 원장에 기록한다(조용한 skip 금지).
4. **모든 반출·삭제 결정은 fail-closed 감사** — `tenant_data.export`/신규 purge 액션을 `SECURITY_AUDIT_REQUIRED_ACTIONS`에 추가, audit append 실패 시 동작 자체를 실패시킨다.
5. **계약 additive** — 신규 테이블 1, 잡 kind 1, rbacAction 2, API 4 전부 additive. 상태머신(run/workitem/human_task) 무변경.

## 5. 슬라이스

### O1. 원문 반출 (raw export) — 규모 M

**API**: `GET /v1/offboarding/export/raw?section=runs|human_tasks&created_at_from&created_at_to` (`tenant_data.export`, admin)

- 응답: **JSON Lines**(`application/x-ndjson`, attachment). CSV 를 쓰지 않는 이유: params/payload/result 는 중첩 jsonb 라 CSV 평탄화가 원문 훼손(lossy)이고, 원문 반출의 목적은 기계-재수입 가능성이다. metadata export(CSV)와 역할 분담: 사람이 읽는 목록=CSV, 기계가 가져가는 원문=JSONL.
- runs 섹션 행: `{ run_id, scenario_id, scenario_name, created_at, params }` — **params 만 원문**. `resume_token`/`bookmark`/`failure_reason.message` 는 계속 제외(§2 전제).
- human_tasks 섹션 행: `{ human_task_id, run_id, kind, state, created_at, resolved_at, payload, result, result_schema, payload_ref }`.
- 요청 1회당 security-audit 1건(fail-closed): `action=tenant_data.export`, payload 에 section/범위/행수(원문 미포함).
- 페이지네이션: keyset(created_at,id) 커서 + `limit`(기본 1000, 최대 5000) — 동기 응답이되 대용량은 커서 체이닝(list-cursor-precision 선례). 비동기 잡+zip 패키징은 기각: 패키지 산출물 자체가 새 민감 저장물이 되어 lifecycle(보존/삭제/암호화)을 또 요구한다(YAGNI, 자기증식).

**artifact 본문**: 신규 API 없음. 기존 metadata export 의 artifacts 섹션(artifact_id 목록, redacted/not_required·미삭제·비격리만)을 목록으로 쓰고, 본문은 기존 `GET /v1/artifacts/{id}/blob` 재사용(개별 fail-closed audit 자동 기록).

**다운로드 도우미**: `scripts/offboarding-download.mjs`(무의존, node 단독 — mint-operator-token 선례). env `RPA_OPERATOR_TOKEN` + `--api <base> --out <dir> [--from --to]` 로 ① metadata CSV ② runs/human_tasks JSONL(커서 순회) ③ artifacts blob 전량을 디렉터리에 저장하고 manifest(건수/누락 사유)를 남긴다. "패키지" = 이 디렉터리. 실행 주체가 admin 토큰 소유자이므로 서버측 패키징 없이 클라이언트 조립(경계 단순).

**수용 기준**: params/payload/result 원문이 JSONL 로 왕복 가능(재파싱 동등성) · 자격/쿠키/SecretRef/resume_token 미포함(회귀 시드 테스트) · 비-redacted artifact 본문은 어떤 경로로도 안 나감(RLS 게이트 재사용 확인) · export 마다 audit_log 행 증가 · 스크립트가 빈 테넌트/부분 실패에서 loud.

### O2. 삭제 원장 + maker-checker (규모 M, DDL additive 1)

**DDL**: `tenant_offboarding_requests`
```
id uuid PK, tenant_id uuid NOT NULL,
status text CHECK (pending|approved|rejected|cancelled|purging|purged),
reason text NOT NULL,
requested_by text NOT NULL, decided_by text, decided_at timestamptz,
purge_after timestamptz,          -- 승인 시 now()+grace(기본 7d, ops-defaults 오버라이드)
purged_at timestamptz,
held_rows jsonb NOT NULL DEFAULT '{}'::jsonb,  -- legal_hold 로 잔존한 행 카운트(table→count)
created_at/updated_at,
UNIQUE (tenant_id) WHERE status IN ('pending','approved','purging')  -- 활성 요청 1건
```

**API** (전부 Idempotency-Key, `runIdempotentCommand`):
- `POST /v1/offboarding/purge-requests` — 신규 rbacAction `tenant_data.purge.request`(admin). body `{reason}`.
- `POST /v1/offboarding/purge-requests/{id}/decide` — 신규 rbacAction `tenant_data.purge.approve`(admin). body `{decision: approved|rejected, reason}`. **SoD: `requested_by === principal.subjectId` → 403 `self_approval_forbidden`**(scenarios.ts 선례 그대로). 승인 시 `purge_after = now() + grace`.
- `POST /v1/offboarding/purge-requests/{id}/cancel` — 유예 중 취소(admin, 요청자·승인자 무관 — 복구 창의 목적상 넓게). `approved → cancelled`.
- `GET /v1/offboarding/purge-requests` — 목록/상태(read 는 `tenant_data.export` 재사용 — 오프보딩 조회 권한과 동일 스코프, 액션 증식 회피).

모든 상태 전이는 security-audit fail-closed 기록(`tenant_data.purge.*` 를 `SECURITY_AUDIT_REQUIRED_ACTIONS`에 추가).

### O3. 오프보딩 잠금 (soft 단계의 의미) — 규모 S

승인(approved) 상태의 테넌트는:
- **명령(command) 차단**: run 생성·rerun·resume·trigger 발화·scenario 저장 등 쓰기 명령을 preHandler 게이트에서 409 `TENANT_OFFBOARDING`(신규 에러코드가 아니라 기존 `WORKITEM_CHECKOUT_CONFLICT` 류 재사용 여부는 구현 시 error-catalog 검토 — 없으면 catalog additive 1건).
- **읽기·반출은 허용**: 유예기간의 존재 이유가 "반출 완료 + 오조작 복구"이므로 read/export 는 열어 둔다.
- 콘솔 전역 배너: "이 테넌트는 오프보딩 진행 중 — {purge_after} 이후 데이터가 영구 삭제됩니다. [취소]" (admin 에게 취소 버튼).

구현: 원장 활성행 조회를 요청당 1회(캐시 불요 — 인덱스 단건). run-trigger 스케줄러/스위퍼도 approved 테넌트를 발화 대상에서 제외.

### O4. purge sweeper (hard 단계) — 규모 M~L

신규 잡 kind `tenant_offboarding_purge`(runtime-contract union + maintenance-scheduler daily 틱 sibling, KST 02시).

- 대상: `status='approved' AND purge_after <= now()` 원장 → CAS 로 `purging` 전이 후 진행.
- **삭제 레지스트리(명시 순서, FK 역순)** — 설계 시점 기준:
  1. artifact 본문: 기존 retention 경로 재사용(legal_hold=false 만 object delete + row tombstone; **legal_hold 행은 잔존 + `held_rows` 기록**).
  2. `stagehand_calls` → `run_steps` → `human_tasks`(+`approval_row_claims`/`approval_decisions`) → `workitems` → `runs` — deleted_at 없는 테이블은 **물리 DELETE**(테넌트 스코프, per-tick cap 배치).
  3. `browser_sessions`/`capture_sessions` — **세션 쿠키 봉투 필수 삭제**(민감도 최상).
  4. `events_outbox`·기타 deleted_at 보유 테이블 — soft 마킹 후 동일 sweeper 가 물리 삭제(v1 payload 는 closed empty 라 위험도 낮지만 일관 처분).
  5. `scenarios`/`scenario_versions`/`site_profiles`/`run_triggers` 등 정의 데이터 — **포함**(오프보딩=테넌트 철수; Open Decision D2 로 뒤집기 가능).
  6. **제외(명시)**: `audit_log`·`audit_verifier_runs`(WORM/증거 — 트리거가 차단하기도 함), `control_plane_idempotency_keys`(TTL 자체 소멸), 원장 자신.
- 완료: 원장 `purged` + `purged_at` + `held_rows` 확정, security-audit 기록. 부분 실패는 잡 재시도로 이어지되 배치가 멱등(잔여만 재삭제).
- 구현 시 레지스트리는 하드코딩 나열이 아니라 **테스트가 정보스키마와 대조**(payload-bearing 테이블 신설 시 레지스트리 누락을 CI 가 잡도록 — db-static-smoke 패턴).

**수용 기준**: 유예 전 취소 → 데이터 무손실 · 유예 경과 → 대상 테이블 행 0(해당 테넌트) + object store 본문 삭제 + 타 테넌트 무영향(실PG) · legal_hold artifact 잔존 + held_rows 보고 · audit_log 는 그대로 · purge 후 원장/감사로 처분 증빙 조회 가능.

### O5. 콘솔 UI — 규모 S~M

보안 허브에 '오프보딩' 섹션(admin 전용): ① 반출 안내(스크립트 명령 복사 — CaptureGuide 패턴) ② 삭제 요청 폼(사유 필수) ③ pending 요청의 승인/반려(SoD 안내: 요청자 본인 버튼 비활성) ④ approved 카운트다운 + 취소 ⑤ purged 후 처분 요약(held_rows 포함). O3 전역 배너 포함.

## 6. 구현 순서와 계약 영향

| 슬라이스 | 순서 | 계약 영향 (전부 additive) |
| --- | --- | --- |
| O1 반출 | 1 | openapi path 1 + ControlPlanePath + api-surface §9 행 + 루트 스크립트 1 |
| O2 원장/승인 | 2 | DDL 테이블 1 + rbacAction 2 + openapi path 3~4 + SECURITY_AUDIT_REQUIRED_ACTIONS |
| O3 잠금 | 3 (O2 뒤) | error-catalog 검토(필요 시 코드 1) |
| O4 sweeper | 4 (O2·O3 뒤) | 잡 kind 1 + ops-defaults grace 항목 |
| O5 UI | O2 이후 병렬 | 없음(표시 계층) |

## 7. 검증

각 슬라이스 공통 게이트(리포 표준): app typecheck+test:unit, focused 실PG int(신규 테스트는 test:int 체인 배선+wiring-audit), web typecheck/test/build, codegen typecheck/fixtures/consistency/spectral(계약 터치 시), db-static-smoke+PG15 migration smoke(DDL 터치 시), git diff --check.

전용 검증:
- O1: 민감 미포함 회귀(시드 시크릿 문자열 grep — api-offboarding-export.int 패턴 확장), JSONL 왕복 동등성, 커서 정합(list-cursor-precision 패턴).
- O2: SoD 403, 활성 요청 UNIQUE 409, Idempotency replay.
- O4: **실PG 2-테넌트 시드 → purge → 대상 테넌트 0행/타 테넌트 불변/legal_hold 잔존/audit_log 불변** — 이 테스트가 이 기능의 핵심 게이트. sim-clock 으로 grace 경과 재현.
- 라이브 스모크: dev:serve 에서 요청→승인→배너→취소, 재요청→승인→(grace 단축 env)→purge→콘솔 빈 상태 확인.

## 8. Open Decisions

| # | 결정 | 오너 | 기본값(설계 가정) |
| --- | --- | --- | --- |
| D1 | 유예기간(grace) | 제품 오너 | **7일**(ops-defaults, env 오버라이드) |
| D2 | 정의 데이터(scenarios/sites/triggers) 포함 여부 | 제품 오너 | **포함**(테넌트 철수 = 전체 처분) |
| D3 | 취소 권한 | 제품 오너 | **admin 누구나**(복구 창은 넓게) |
| D4 | 원본(비-redacted) artifact 반출 | 제품 오너 | **불허 유지**(2026-07-03 확정) — 필요 시 경고+감사 전제 별도 설계 |
| D5 | purge 후 원장 보존 기간 | 제품 오너 | **무기한**(처분 증빙 — 행 수 미미) |

## 9. 이 설계가 감사 레지스터에서 닫는 것

`audit/rpa-two-persona-audit-2026-07-02/notes.md` 비평관 횡단 "오프보딩 데이터 반출 부재"의 잔여 절반(원문 반출)과, D 레지스터 "오프보딩 데이터 반출 — 원문 데이터 패키지/셀프서비스 삭제 플로우는 별도 오너 결정" 항목 전체. 구현 완료 시 `docs/rpa-console-usability-hardening-design-2026-07-02.md` §6 D 표의 해당 행을 ✅로 갱신한다.
