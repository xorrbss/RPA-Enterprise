-- ============================================================
-- Migration: 핵심 엔티티 DDL (Phase 2 — README §외부 의존 맵 잔여 TODO 해소)
-- 대상: runs, run_steps, workitems, human_tasks, scenarios,
--       scenario_versions, artifacts, events_outbox, dead_letter,
--       stagehand_calls, action_plan_cache, site_profiles,
--       site_profile_approvals, browser_identities, network_policies,
--       gateway_policies, control_plane_idempotency_keys, workers
-- 범위: 상태머신·job·캐시·이벤트가 의존하는 영속 컬럼/제약의 단일 진실원천.
--   migration_concurrency_idempotency.sql(동시성·idempotency 보강)과 **별개 파일**이며
--   그 파일이 정의한 테이블(credential_*/browser_leases/raw_items/normalized_records/
--   sink_deliveries/challenge_resolution_attempts)은 **재정의하지 않고 FK로만 참조**한다.
-- 전제:
--   - 모든 테이블 tenant_id 보유 + RLS(P2). RLS 정책 본문은 rbac 정책 파일에서 정의(여기선 컬럼만).
--   - 상태 컬럼 CHECK enum은 ts/state-machine-types.ts(RunState/WorkitemState/HumanTaskState/
--     HumanTaskKind)·ts/core-types.ts(StepStatus)와 **정확히 일치**.
--   - 모든 상태 전이는 DB 조건부 UPDATE(CAS): UPDATE ... WHERE id=? AND status=<cur> (state-machine.md §4).
--   - 어휘 체인: API abort → Run cancelled → 이벤트 run.cancelled.
--   - §19 결정: credential 동시성 기본=1(credential_concurrency_policies), Codex/vLLM는 capabilities 게이트.
--   - "조용한 false/unknown 금지": 미정의 전이는 IllegalTransition(throw), reason_code는 항상 명시.
--   - PostgreSQL 15+.
-- ============================================================

-- ============================================================
-- 1. site_profiles / browser_identities / network_policies
--    lease 테이블(migration_concurrency_idempotency.sql)이 uuid로 참조하는 본체.
--    먼저 생성해 FK 대상이 되게 한다.
-- ============================================================

-- site_profiles — 사이트 위험 등급·정책 묶음. risk=red는 미승인 시 SITE_PROFILE_BLOCKED(security).
CREATE TABLE site_profiles (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  name            text        NOT NULL,
  url_pattern     text        NOT NULL,                     -- 사이트 식별 패턴(정규화)
  risk            text        NOT NULL DEFAULT 'green'
                    CHECK (risk IN ('green','amber','red')),  -- red = 승인 워크플로우 필요(amber=중간; api-surface/openapi SiteRisk와 정합)
  approved        boolean     NOT NULL DEFAULT false,       -- risk=red 승인 여부(SITE_PROFILE_BLOCKED 게이트)
  approved_at     timestamptz,
  approved_by     uuid,                                      -- approver subject id(JWT/session principal)
  approval_reason text,
  approval_expires_at timestamptz,
  circuit_state   text        NOT NULL DEFAULT 'closed'
                    CHECK (circuit_state IN ('closed','open','half_open')),  -- 사이트 서킷(event site.circuit_opened/closed, GET /sites 조회원)
  circuit_until   timestamptz,                              -- open cooldown 만료 — ops-defaults §3 site.circuit.open_duration
  page_state_selectors jsonb,                                -- D3 executor PageState 산출 규칙(SitePageStateConfig: authenticatedWhen?·flags{닫힌 6키:present/absent/min_count}). 마커 없는 실 사이트에서 닫힌 flags 산출 근거(executor/site-page-state-config). null=미설정 → 해당 사이트 비-마커 실행 시 PAGE_STATE_UNRESOLVED.
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_site_profiles_tenant ON site_profiles (tenant_id);

CREATE TABLE site_profile_approvals (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  site_profile_id uuid        NOT NULL REFERENCES site_profiles(id),
  approved_by     uuid        NOT NULL,
  reason          text,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_site_profile_approvals_site ON site_profile_approvals (tenant_id, site_profile_id, created_at DESC);

-- ------------------------------------------------------------
-- workers — 실행기 생존(heartbeat) + 워커 서킷 상태 레지스트리.
--   runs.worker_id / browser_leases.owner_worker_id / credential_leases.run_id 연계 워커의 영속처.
--   worker.* health/circuit telemetry is infrastructure telemetry, not tenant-scoped events_outbox.
--   **인프라 레벨(테넌트 비종속) — RLS 미적용**(auth-rbac §4 BYPASSRLS 도메인). tenant_id 없음.
-- ------------------------------------------------------------
CREATE TABLE workers (
  id              uuid        PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('orchestrator','browser','gateway','sweeper')),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','draining','dead')),
  heartbeat_at    timestamptz NOT NULL DEFAULT now(),       -- 생존 신호. 만료 시 dead 판정 → lease sweeper 회수(ops-defaults §2)
  circuit_state   text        NOT NULL DEFAULT 'closed'
                    CHECK (circuit_state IN ('closed','open','half_open')),  -- worker 서킷(ops-defaults §3 worker.circuit.*)
  circuit_until   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workers_heartbeat ON workers (heartbeat_at) WHERE status = 'active';
-- 참고: runs.worker_id·browser_leases.owner_worker_id는 workers.id를 논리 참조(인프라/테넌트 도메인 분리로 hard FK는 선택).

-- browser_identities — 브라우저 지문/정체성. version은 action_plan_cache family 키 구성요소.
CREATE TABLE browser_identities (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  site_profile_id uuid        REFERENCES site_profiles(id),
  label           text        NOT NULL,
  version         int         NOT NULL DEFAULT 1,           -- 정체성 변경 시 증가 → cache browser_identity_version과 정합
  fingerprint_ref text,                                     -- UA/뷰포트/locale 등 지문 정의 참조(값 아님)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, label, version)
);
CREATE INDEX idx_browser_identities_tenant ON browser_identities (tenant_id);

-- network_policies — security-contracts.md §6 NetworkPolicy 구조와 일치. RunContext.networkPolicyId 대상.
CREATE TABLE network_policies (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  allowed_domains    text[]      NOT NULL DEFAULT '{}',     -- 정확/와일드카드(*.vendor.com) 허용 목록
  block_on_violation boolean     NOT NULL DEFAULT true CHECK (block_on_violation = true), -- Product Open: monitor-only mode is not contracted; 이탈 시 DOMAIN_POLICY_VIOLATION(security)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_network_policies_tenant ON network_policies (tenant_id);

-- gateway_policies — /v1/gateway/policy If-Match(version) 영속 근거.
CREATE TABLE gateway_policies (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  model           text        NOT NULL,
  version         int         NOT NULL DEFAULT 1 CHECK (version >= 1),
  capabilities    jsonb       NOT NULL,                    -- llm-gateway-adapter.md ModelCapabilities
  budget          jsonb       NOT NULL,                    -- maxInputTokens/maxOutputTokens/maxCost 등
  fallback_config jsonb,                                   -- fallback model/transport policy
  is_default      boolean     NOT NULL DEFAULT false,      -- Gap2(B+C): 테넌트 기본 정책 — 무인 run의 model 해소원. 부분 UNIQUE로 테넌트당 ≤1.
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model)
);
CREATE INDEX idx_gateway_policies_tenant ON gateway_policies (tenant_id);
CREATE UNIQUE INDEX uq_gateway_policies_default ON gateway_policies (tenant_id)
  WHERE is_default;                                          -- 테넌트당 기본 정책 1건(uq_scenario_versions_prod 동형)

-- control_plane_idempotency_keys — api-surface.md §0.4 명령형 POST 중복 제출 보호.
CREATE TABLE control_plane_idempotency_keys (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  endpoint         text        NOT NULL,
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash     text        NOT NULL,                   -- method/path/body canonical hash
  status           text        NOT NULL DEFAULT 'processing'
                     CHECK (status IN ('processing','succeeded','failed')),
  response_status  int         CHECK (response_status BETWEEN 100 AND 599),
  response_body    jsonb,
  retention_until  timestamptz,
  legal_hold       boolean     NOT NULL DEFAULT false,
  deleted_at       timestamptz,
  response_ref     text,                                   -- 큰 응답/첨부가 있으면 artifact/object ref
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint, idempotency_key)
);
CREATE INDEX idx_control_plane_idempotency_expiry
  ON control_plane_idempotency_keys (expires_at);
CREATE INDEX idx_control_plane_idempotency_retention
  ON control_plane_idempotency_keys (retention_until)
  WHERE legal_hold = false AND deleted_at IS NULL;

-- ============================================================
-- 2. scenarios / scenario_versions
--    SCENARIO_VERSION_CONFLICT(412, If-Match) 근거 = scenario_versions.version 낙관적 락(ETag).
--    IREL은 컴파일 타임 검증(README §결정3) → compiled_ast는 검증 통과분만 영속.
-- ============================================================

CREATE TABLE scenarios (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX idx_scenarios_tenant ON scenarios (tenant_id);
CREATE UNIQUE INDEX uq_scenarios_active_name ON scenarios (tenant_id, name)
  WHERE archived_at IS NULL;                                -- 보관된 시나리오 이름은 재사용 가능, active 이름만 유일

CREATE TABLE scenario_versions (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  scenario_id       uuid        NOT NULL REFERENCES scenarios(id),
  version           int         NOT NULL,                   -- ir.schema meta.version. optimistic lock/ETag 근거
  promotion_status  text        NOT NULL DEFAULT 'draft'
                      CHECK (promotion_status IN ('draft','prod')),  -- prod 승격은 ValidationReport warnings 차단(ir-static-validation §3)
  ir                jsonb       NOT NULL,                   -- ir.schema.json 원본
  compiled_ast      text,                                   -- IREL AST 캐시 참조(저장/승격 시 컴파일 통과분만)
  params_schema     jsonb,                                  -- ir.schema params_schema(IREL params.* 타입 추론 근거)
  created_at        timestamptz NOT NULL DEFAULT now(),
  promoted_at       timestamptz,
  -- (scenario, version) 유일 → If-Match 충돌 시 SCENARIO_VERSION_CONFLICT(412)
  UNIQUE (tenant_id, scenario_id, version)
);
CREATE INDEX idx_scenario_versions_scenario ON scenario_versions (scenario_id, version);
CREATE UNIQUE INDEX uq_scenario_versions_prod ON scenario_versions (tenant_id, scenario_id)
  WHERE promotion_status = 'prod';                          -- scenario당 prod 1건

-- ============================================================
-- 3. workitems
--    state-machine.md §2 (W1..W11). unique_reference = tenant+connector 단위 dedup.
--    checkout timer pause/resume(W9/W11)는 cursor/evidence와 함께 추적.
-- ============================================================

CREATE TABLE workitems (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  connector_id      text        NOT NULL,
  unique_reference  text        NOT NULL,                   -- W1: 중복 checkout 차단 키
  status            text        NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','processing','successful','retry',
                                        'failed_business','failed_system','abandoned')),  -- WorkitemState 7개
  attempts          int         NOT NULL DEFAULT 0,         -- W4/W5/W6/W7 attempts < max 판정
  checked_out_by    uuid,                                   -- W1 checked_out_by set(worker)
  checked_out_at    timestamptz,                            -- W1
  checkout_expires_at timestamptz,                          -- W6/W7 checkout_expired 판정(W9 pause 구간 제외 계산)
  checkout_paused_at  timestamptz,                          -- W9 timer pause 시각(W11 resume 시 잔여 TTL 재개)
  cursor            jsonb,                                  -- W8 cursor 보존(재시도 시 리셋 안 함)
  evidence_ref      text,                                   -- W4/W6 evidence 유지(artifact 참조)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- tenant+connector 내 unique_reference 유일(W1 멱등 checkout)
  UNIQUE (tenant_id, connector_id, unique_reference)
);
CREATE INDEX idx_workitems_status ON workitems (tenant_id, status);
CREATE INDEX idx_workitems_checkout_expiry ON workitems (checkout_expires_at)
  WHERE status = 'processing';                              -- checkout 만료 sweeper

-- ============================================================
-- 4. runs
--    state-machine.md §1 (R1..R28). 1 Workitem = 1 Run(기본).
--    resume_token = reserved-handlers.md ResumeToken(kid/hmac 포함). 키 자료는 SecretStore/KMS,
--    DB에는 봉투(jsonb)만 — hmac은 위변조 서명값일 뿐 시크릿 평문 아님(security-contracts §5).
-- ============================================================

CREATE TABLE runs (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  scenario_version_id uuid        NOT NULL REFERENCES scenario_versions(id),
  workitem_id         uuid        REFERENCES workitems(id),  -- 1 Workitem = 1 Run(기본). run-less 경로 위해 nullable
  worker_id           uuid,                                 -- R1/R17 lease 확보 시 set
  abort_source_status text
                        CHECK (abort_source_status IS NULL OR abort_source_status IN ('running','suspended','resume_requested','resuming')), -- run_abort worker must not infer whether drain was required.
  status              text        NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','claimed','running','suspending','suspended',
                                          'resume_requested','resuming','completing','completed',
                                          'aborting','cancelled','failed_business','failed_system')),  -- RunState 13개
  attempts            int         NOT NULL DEFAULT 0,        -- R3a 재큐 시 attempts+1
  resume_token        jsonb,                                 -- ResumeToken 봉투(runId/resumeNodeId/loopContext/pageStateRef/kid/hmac)
  bookmark            jsonb,                                 -- suspend bookmark(startBookmark side-effect 영속, RQ-016). resume_token 과 분리:
                                                             --   bookmark = 재개 지점 마커(stepId/attempt/reason), resume_token = 서명 봉투(kid/hmac, R11 후속).
  params              jsonb,                                 -- 실행 파라미터(params_schema로 검증)
  as_of               timestamptz,                           -- ir-expression §5: Run 생성 시 1회 고정(params.as_of)
  model               text,                                  -- Gap2(B+C): run-create 시 1회 해소·동결한 gateway_policies.model
                                                             --   (as_of 동형 결정성; action_plan_cache 키 일부). NULL=utility-only run 또는
                                                             --   미해소(LLM 노드 도달 시 run-time fail-closed). gateway_policies 자연키가
                                                             --   복합(tenant,model)이라 단일컬럼 FK 불성립 + 정책 삭제 시 재현성 파괴 → 느슨한 text 스냅샷.
  correlation_id      uuid        NOT NULL,                  -- 이벤트 envelope·trace span 공통 상관키
  failure_reason      jsonb,                                 -- failed_* 진입 사유 요약 {code,message}; UI 표시용 비민감 진단
  -- usage 누계(R21 usage flush) — 비용/토큰 집계
  usage_input_tokens  bigint      NOT NULL DEFAULT 0,
  usage_output_tokens bigint      NOT NULL DEFAULT 0,
  usage_cost          numeric(14,6) NOT NULL DEFAULT 0,
  started_at          timestamptz,                           -- R2 run.started
  ended_at            timestamptz,                           -- terminal 진입 시각
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_status ON runs (tenant_id, status);
CREATE INDEX idx_runs_workitem ON runs (workitem_id);
CREATE UNIQUE INDEX idx_runs_one_per_workitem ON runs (tenant_id, workitem_id)
  WHERE workitem_id IS NOT NULL;                              -- Product Open: 1 Workitem = 1 Run
CREATE INDEX idx_runs_correlation ON runs (correlation_id);

-- ============================================================
-- 4b. scenario_generations
--    자연어 프롬프트 → IR 초안 → 저장/실행 자동화 원장. prompt 원문은 저장하지 않고 hash/ref만 둔다.
--    실제 실행은 기존 scenario_versions + runs 계약을 재사용한다.
-- ============================================================

CREATE TABLE scenario_generations (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  mode                text        NOT NULL
                        CHECK (mode IN ('draft_only','save','save_and_run')),
  status              text        NOT NULL
                        CHECK (status IN ('drafted','saved','run_queued','blocked','failed')),
  prompt_hash         text        NOT NULL CHECK (length(prompt_hash) > 0),
  prompt_redacted_ref text,                                  -- optional redacted prompt artifact/ref. 원문 저장 금지.
  planner             text        NOT NULL DEFAULT 'deterministic_mvp',
  model               text,                                  -- LLM planner 사용 시 모델 스냅샷. deterministic MVP는 NULL 가능.
  params_context      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  draft_ir            jsonb       NOT NULL,
  validation_report   jsonb,
  evidence_policy     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  blockers            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  scenario_id         uuid        REFERENCES scenarios(id),
  scenario_version_id uuid        REFERENCES scenario_versions(id),
  run_id              uuid        REFERENCES runs(id),
  created_by          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_scenario_generations_tenant ON scenario_generations (tenant_id, created_at DESC);
CREATE INDEX idx_scenario_generations_run ON scenario_generations (tenant_id, run_id)
  WHERE run_id IS NOT NULL;

-- ============================================================
-- 5. run_steps
--    executor attempt row를 영속화. status='started'는 step.started/FK 선점용
--    nonterminal 상태이고, 그 외 8개 값은 core-types.ts StepResult final StepStatus.
--    page_state_before/after = PageStateRef(참조). artifacts/stagehand_call_ids는 배열.
-- ============================================================

CREATE TABLE run_steps (
  id                 uuid        PRIMARY KEY,
  run_id             uuid        NOT NULL REFERENCES runs(id),
  tenant_id          uuid        NOT NULL,
  step_id            text        NOT NULL,                  -- StepResult.stepId
  node_id            text        NOT NULL,                  -- IR 노드 id
  attempt            int         NOT NULL DEFAULT 0,        -- step 재시도 회차(DB층 멱등 단위)
  action             text        NOT NULL
                       CHECK (action IN ('act','observe','extract','navigate','download','upload',
                                         'api_call','file','human_task','shell')),  -- IRActionType
  status             text        NOT NULL
                       CHECK (status IN ('started','success','failed_business','failed_system','failed_challenge',
                                         'failed_security','uncertain','skipped','suspended')),
  cache_mode         text        NOT NULL DEFAULT 'bypass'
                       CHECK (cache_mode IN ('hit','miss','bypass','suspect','stale','quarantined')),  -- StepResult.cache.mode
  action_plan_cache_id uuid,                                 -- StepResult.cache.actionPlanCacheId. FK는 §10 말미 ALTER로 보강(테이블 생성 순서)
  page_state_before  text,                                  -- PageStateRef
  page_state_after   text,                                  -- PageStateRef
  artifacts          text[]      NOT NULL DEFAULT '{}',     -- ArtifactRef[]
  stagehand_call_ids text[]      NOT NULL DEFAULT '{}',     -- StepResult.stagehandCallIds
  side_effect        jsonb,                                 -- {kind,idempotencyKey?,receiptRef?,committed}
  exception          jsonb,                                 -- ClassifiedException {class,code,message,evidenceRefs?}
  started_at         timestamptz,                           -- timings.startedAt
  ended_at           timestamptz,                           -- timings.endedAt
  duration_ms        int,                                   -- timings.durationMs
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- step 재시도/replay의 DB층 멱등: 같은 (run,step)의 동일 attempt 중복 INSERT 차단.
  --   부작용 외부 멱등은 side_effect.idempotency_key(다른 계층, ir.schema sideEffect)로 별도 보장.
  UNIQUE (tenant_id, run_id, step_id, attempt)
);
-- NOTE: action_plan_cache는 §10에서 생성되므로 위 FK는 선언 불가 — 아래 §10 이후 ALTER로 추가.
-- (테이블 정의 순서 의존을 피하기 위해 위 컬럼은 일단 참조만, 실제 FK는 §10 말미에서 보강.)
CREATE INDEX idx_run_steps_run ON run_steps (run_id);
CREATE INDEX idx_run_steps_tenant ON run_steps (tenant_id);

-- ============================================================
-- 6. human_tasks
--    state-machine.md §3 (H1..H8). state=HumanTaskState 7개, kind=HumanTaskKind 5개.
--    on_timeout = fail|escalate (H4a/H4b 분기, reserved-handlers @human_task 입력 정책).
-- ============================================================

CREATE TABLE human_tasks (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  run_id        uuid        NOT NULL REFERENCES runs(id),
  kind          text        NOT NULL
                  CHECK (kind IN ('approval','validation','exception','captcha','mfa')),  -- HumanTaskKind 5개
  state         text        NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','assigned','in_progress','resolved',
                                   'expired','cancelled','escalated')),  -- HumanTaskState 7개
  assignee      uuid,                                       -- H1 assignee set
  assignee_role text,                                       -- RBAC 역할(Phase 2 역할 레지스트리)
  on_timeout    text        NOT NULL DEFAULT 'fail'
                  CHECK (on_timeout IN ('fail','escalate')),  -- H4a(fail→expired)/H4b(escalate→escalated)
  expires_at    timestamptz,                                -- timeout 기준 시각
  payload_ref   text,                                       -- 작업 본문 참조(artifact/payload)
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_human_tasks_run ON human_tasks (run_id);
CREATE INDEX idx_human_tasks_state ON human_tasks (tenant_id, state);
CREATE INDEX idx_human_tasks_expiry ON human_tasks (expires_at)
  WHERE state IN ('open','assigned','in_progress','escalated');  -- timeout sweeper(H4/H8)

-- ============================================================
-- 7. artifacts
--    impl-contracts-bundle.md §B/§C + security-contracts §8.
--    redaction_status 추상 게이트는 ARTIFACT_NOT_REDACTED로 모델링하지만,
--    v1 HTTP read는 RLS visibility로 pending/failed/quarantined/deleted/cross-tenant를 404 존재 비노출 처리.
-- ============================================================

CREATE TABLE artifacts (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  run_id           uuid        REFERENCES runs(id),         -- orphan_sweeper 대상(run 삭제/취소 후 참조 없으면 정리)
  generation_id    uuid        REFERENCES scenario_generations(id), -- 자연어 generation 단계 artifact(run/step 없음)
  step_id          text,                                    -- 생성 step(run_steps.step_id, 느슨 참조)
  attempt          int         CHECK (attempt >= 0),        -- step attempt; with run_id+step_id forms the canonical step key
  type             text        NOT NULL,                    -- vlm_input/screenshot/receipt/evidence 등(개방형)
  media_type       text,                                    -- image/png, video/webm, application/json 등. 미디어 미리보기/다운로드 힌트.
  filename         text,                                    -- 사용자 표시/다운로드용 파일명(비밀·경로 아님).
  byte_size        bigint      CHECK (byte_size IS NULL OR byte_size >= 0),
  duration_ms      int         CHECK (duration_ms IS NULL OR duration_ms >= 0), -- video/run clip 등 시간 기반 artifact.
  redaction_status text        NOT NULL DEFAULT 'pending'
                     CHECK (redaction_status IN ('pending','redacted','failed','not_required')),  -- §B redaction job
  redaction_attempts int       NOT NULL DEFAULT 0,          -- 실패 N회 → failed + 알림(§B)
  sha256           text,                                    -- §B integrity_checker 대조 대상
  object_ref       text        NOT NULL,                    -- 스토리지 객체 참조
  retention_until  timestamptz,                             -- §B retention_sweeper(법정 보존은 legal_hold로 예외)
  legal_hold       boolean     NOT NULL DEFAULT false,      -- true면 retention sweeper 예외
  quarantine       boolean     NOT NULL DEFAULT false,      -- §B integrity 불일치 시 격리
  lifecycle_claim_id uuid,
  lifecycle_claim_kind text CHECK (lifecycle_claim_kind IN ('artifact_redaction','artifact_retention')),
  lifecycle_claim_worker_id uuid REFERENCES workers(id),
  lifecycle_claim_correlation_id uuid,
  lifecycle_claimed_at timestamptz,
  lifecycle_claim_expires_at timestamptz,
  deleted_at       timestamptz,                             -- object 삭제 후 row soft-delete 시각
  deleted_reason   text,
  deleted_by_job   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (legal_hold OR retention_until IS NOT NULL),
  CHECK (generation_id IS NULL OR run_id IS NULL),
  CHECK (
    (
      lifecycle_claim_id IS NULL
      AND lifecycle_claim_kind IS NULL
      AND lifecycle_claim_worker_id IS NULL
      AND lifecycle_claim_correlation_id IS NULL
      AND lifecycle_claimed_at IS NULL
      AND lifecycle_claim_expires_at IS NULL
    )
    OR (
      lifecycle_claim_id IS NOT NULL
      AND lifecycle_claim_kind IS NOT NULL
      AND lifecycle_claim_worker_id IS NOT NULL
      AND lifecycle_claim_correlation_id IS NOT NULL
      AND lifecycle_claimed_at IS NOT NULL
      AND lifecycle_claim_expires_at IS NOT NULL
      AND lifecycle_claim_expires_at > lifecycle_claimed_at
    )
  ),
  CHECK (
    (step_id IS NULL AND attempt IS NULL)
    OR (run_id IS NOT NULL AND step_id IS NOT NULL AND attempt IS NOT NULL)
  )
);
CREATE INDEX idx_artifacts_run ON artifacts (run_id);
CREATE INDEX idx_artifacts_generation ON artifacts (tenant_id, generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX idx_artifacts_step ON artifacts (tenant_id, run_id, step_id, attempt)
  WHERE step_id IS NOT NULL;
CREATE INDEX idx_artifacts_redaction ON artifacts (redaction_status)
  WHERE redaction_status = 'pending';                       -- redaction_job 폴링
CREATE INDEX idx_artifacts_retention ON artifacts (retention_until)
  WHERE legal_hold = false AND deleted_at IS NULL;          -- retention_sweeper
CREATE UNIQUE INDEX idx_artifacts_lifecycle_claim ON artifacts (tenant_id, lifecycle_claim_id)
  WHERE lifecycle_claim_id IS NOT NULL;
CREATE INDEX idx_artifacts_lifecycle_claim_expiry ON artifacts (tenant_id, lifecycle_claim_kind, lifecycle_claim_expires_at)
  WHERE lifecycle_claim_id IS NOT NULL;

-- ============================================================
-- 7b. approval_decisions
--    하이웍스 결재 인박스(Model A) — 건별 approver-게이트 결재 결정의 불변 이력 + 이중결재 방지.
--    수집 run(source_run_id)이 인박스에 노출한 문서(doc_ref)에 대한 결정(approve/reject)을 1행으로 기록하고,
--    내부에서 스폰한 결재 처리 run(spawned_run_id)을 연결한다. UNIQUE(tenant, source_run, doc_ref) → 같은 수집본의
--    같은 문서 이중결재 차단(23505 → APPROVAL_ALREADY_DECIDED). runs FK 는 artifacts/run_steps 동형 — inline REFERENCES(runs 선생성)
--    + 아래 ALTER 의 복합 테넌트 FK(tenant_id, run_id)로 강화(cross-tenant 격리를 DB 불변식으로; auth-rbac §4 hardening).
-- ============================================================

CREATE TABLE approval_decisions (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  source_run_id   uuid        NOT NULL REFERENCES runs(id),   -- 결재 목록을 수집해 인박스에 노출한 run(인박스 출처)
  doc_ref         text        NOT NULL,                       -- 결재 문서 참조(approval origin 절대 URL)
  decision        text        NOT NULL CHECK (decision IN ('approve','reject')),
  reason          text,                                       -- 반려 사유(approve면 NULL)
  decided_by      text        NOT NULL,                       -- approver principal(JWT sub) — PrincipalId 는 자유형 string(UUID 보장 없음: OIDC sub auth0|… 등)
  spawned_run_id  uuid        REFERENCES runs(id),            -- 내부에서 시작한 결재 처리(decide) run
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_run_id, doc_ref)                  -- 이중결재 방지(23505 → APPROVAL_ALREADY_DECIDED)
);
CREATE INDEX idx_approval_decisions_source ON approval_decisions (tenant_id, source_run_id, created_at DESC);

-- ============================================================
-- 8. events_outbox
--    event-envelope.schema.json 봉투를 컬럼화. 상태 변경과 **동일 트랜잭션** INSERT(README §결정2).
--    idempotency_key UNIQUE(소비자 중복 무시). published_at NULL = 미발행(outbox relay 대상).
-- ============================================================

CREATE TABLE events_outbox (
  event_id           uuid        PRIMARY KEY,               -- envelope event_id
  event_type         text        NOT NULL
                       CHECK (event_type IN (
                         'run.created','run.started','run.suspended','run.resume_requested','run.resumed',
                         'run.cancelled','run.completed','run.failed_business','run.failed_system',
                         'step.started','step.completed','step.verify.failed',
                         'llm.stream.started','llm.stream.completed','llm.stream.aborted',
                         'challenge.detected','challenge.resolved',
                         'human_task.created','human_task.resolved','human_task.expired','human_task.escalated',
                         'workitem.completed','workitem.dead_lettered',
                         'pipeline.stage.completed','sink.delivered','sink.dead_lettered',
                         'site.circuit_opened','site.circuit_closed'
                       )),                                  -- event-envelope eventType enum
  event_version      int         NOT NULL CHECK (event_version >= 1),
  tenant_id          uuid        NOT NULL,
  run_id             uuid,                                  -- run 없는 tenant-visible 이벤트(site.circuit_* 등)를 위해 nullable
  workitem_id        uuid,
  step_id            text,
  attempt            int         CHECK (attempt >= 0),
  correlation_id     uuid        NOT NULL,                  -- envelope required
  causation_id       uuid,                                  -- 유발 이벤트 id
  ordering_key       text,                                  -- 기본 run_id. run-less 이벤트는 생략(envelope optional)
  occurred_at        timestamptz NOT NULL,
  idempotency_key    text        NOT NULL CHECK (length(idempotency_key) > 0), -- 예: run:step:attempt:verify
  payload_schema_ref text        NOT NULL,                  -- 예: events/run.completed@1
  payload            jsonb       NOT NULL,
  retention_until    timestamptz NOT NULL,
  legal_hold         boolean     NOT NULL DEFAULT false,
  deleted_at         timestamptz,
  published_at       timestamptz,                           -- NULL = 미발행(relay가 발행 후 set)
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),                      -- 중복 인큐 차단(소비자 멱등) — 테넌트 스코프로 cross-tenant 키 충돌 방지
  CHECK (
    (step_id IS NULL AND attempt IS NULL)
    OR (run_id IS NOT NULL AND step_id IS NOT NULL AND attempt IS NOT NULL)
  )
);
ALTER TABLE events_outbox
  ADD CONSTRAINT ck_events_outbox_step_events_require_step_ref
  CHECK (
    event_type NOT LIKE 'step.%'
    OR (run_id IS NOT NULL AND step_id IS NOT NULL AND attempt IS NOT NULL)
  );
CREATE INDEX idx_events_outbox_unpublished ON events_outbox (created_at)
  WHERE published_at IS NULL;                               -- outbox relay 미발행 스캔
CREATE INDEX idx_events_outbox_run ON events_outbox (run_id);
CREATE INDEX idx_events_outbox_step ON events_outbox (tenant_id, run_id, step_id, attempt)
  WHERE step_id IS NOT NULL;
CREATE INDEX idx_events_outbox_retention ON events_outbox (retention_until)
  WHERE legal_hold = false AND deleted_at IS NULL;
-- outbox relay publish CAS:
--   UPDATE events_outbox
--      SET published_at = now()
--    WHERE event_id = $1 AND published_at IS NULL
--   RETURNING event_id;
-- 0 row면 이미 다른 relay가 발행했거나 row가 없으므로 재발행하지 않는다.

-- ============================================================
-- 9. dead_letter
--    state-machine W5/W7(생성)·W10(manual_replay 복원). error-catalog DEAD_LETTER.
--    reason_code = ErrorCode(text — ErrorCode는 TS enum, DB enum 아님. error-catalog.ts가 권위).
-- ============================================================

CREATE TABLE dead_letter (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  workitem_id  uuid        REFERENCES workitems(id),        -- W5/W7 workitem 차원 DLQ
  run_id       uuid        REFERENCES runs(id),
  reason_code  text        NOT NULL,                        -- error-catalog.ts ErrorCode(예: DEAD_LETTER, WORKITEM_CHECKOUT_CONFLICT)
  evidence_ref text,                                        -- 실패 증빙(artifact 참조)
  replayable   boolean     NOT NULL DEFAULT true,           -- W10 manual_replay 가능 여부
  created_at   timestamptz NOT NULL DEFAULT now(),
  replayed_at  timestamptz                                  -- W10 복원 시각(NULL = 미복원)
);
CREATE INDEX idx_dead_letter_workitem ON dead_letter (workitem_id);
CREATE INDEX idx_dead_letter_replayable ON dead_letter (tenant_id)
  WHERE replayed_at IS NULL AND replayable = true;          -- DLQ replay 인박스

-- ============================================================
-- 10. action_plan_cache (§7 본체)
--    impl-bundle §D classifier + migration_concurrency_idempotency.sql의 ON CONFLICT 규약.
--    UNIQUE는 그 SQL 주석이 명시한 7개 컬럼과 **정확히 일치**(insert-race "먼저 검증된 active가 이긴다").
--    status는 core-types StepResult.cache.mode의 캐시 상태(active/suspect/stale/quarantined)와 정합(§7.2 전이).
-- ============================================================

CREATE TABLE action_plan_cache (
  id                       uuid        PRIMARY KEY,
  tenant_id                uuid        NOT NULL,
  scenario_version_id      uuid        NOT NULL REFERENCES scenario_versions(id),
  step_id                  text        NOT NULL,
  url_pattern              text        NOT NULL,             -- url_pattern_normalized(page/offset placeholder)
  dom_structural_hash      text        NOT NULL,             -- family 키(impl-bundle §D, visible_text 제외)
  model                    text        NOT NULL,
  prompt_template_version  text        NOT NULL,
  browser_identity_version int         NOT NULL,             -- browser_identities.version과 정합
  plan_ref                 text,                             -- 해석된 action plan 참조
  status                   text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','suspect','stale','quarantined')),  -- §7.2: suspect→stale(재생 차단)
  success_count            int         NOT NULL DEFAULT 0,   -- ON CONFLICT DO UPDATE 시 +1
  last_success_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- migration_concurrency_idempotency.sql §4 ON CONFLICT 규약이 참조하는 UNIQUE(7개 컬럼) — 정확히 일치
  UNIQUE (scenario_version_id, step_id, url_pattern, dom_structural_hash,
          model, prompt_template_version, browser_identity_version)
);
CREATE INDEX idx_action_plan_cache_lookup
  ON action_plan_cache (scenario_version_id, step_id, url_pattern, dom_structural_hash)
  WHERE status = 'active';                                  -- cache.lookup(active만 재생)

-- run_steps.action_plan_cache_id FK 보강(§5에서 선언 미룬 것 — action_plan_cache 생성 후)
ALTER TABLE run_steps
  ADD CONSTRAINT fk_run_steps_action_plan_cache
  FOREIGN KEY (action_plan_cache_id) REFERENCES action_plan_cache(id);

-- ============================================================
-- 11. stagehand_calls
--    llm-gateway-adapter.md(stream_status·transport)·core-types StepResult.stagehandCallIds.
--    transport: SSE 스트리밍 기본, sync 폴백. stream_status에 fallback 사유 기록(adapter §4).
-- ============================================================

CREATE TABLE stagehand_calls (
  id                      uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL,
  run_id                  uuid        NOT NULL REFERENCES runs(id),
  step_id                 text        NOT NULL,             -- run_steps.step_id(느슨 참조)
  attempt                 int         NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  idempotency_key         text        NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash            text        NOT NULL,
  model                   text        NOT NULL,             -- LLMRequest.model
  transport               text        NOT NULL DEFAULT 'sse'
                            CHECK (transport IN ('sse','sync')),  -- 기본 SSE, sync는 폴백(adapter §1)
  stream_status           text,                             -- open/done/aborted/error/fallback 사유(adapter §3/§4)
  ttfb_ms                 int,                              -- llm_gateway.call span attr
  input_tokens            int,
  output_tokens           int,
  cost                    numeric(14,6),
  prompt_template_version text,                             -- 캐시 키·기록(LLMRequest.promptTemplateVersion)
  output_ref              text,                             -- 누적 결과 참조(adapter §6)
  input_redacted_ref      text,                             -- 기본 hash만(adapter §6, redacted prompt)
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_stagehand_calls_run ON stagehand_calls (run_id);
CREATE INDEX idx_stagehand_calls_step ON stagehand_calls (tenant_id, run_id, step_id, attempt);

-- ============================================================
-- 11b. scenario_generation_llm_calls
--    자연어 generation planner 전용 LLM 멱등 원장.
--    planner 호출은 scenario_generations row 생성 전 일어나므로 generation_id는 논리 키로만 둔다
--    (FK 없음). 성공 저장 후 artifacts.generation_id가 같은 generation을 가리키며, 실패 경로는
--    API catch에서 이 원장을 삭제해 dangling output_ref를 남기지 않는다.
-- ============================================================

CREATE TABLE scenario_generation_llm_calls (
  id                      uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL,
  generation_id           uuid        NOT NULL,
  correlation_id          uuid        NOT NULL,
  step_id                 text        NOT NULL,
  attempt                 int         NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  idempotency_key         text        NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash            text        NOT NULL,
  model                   text        NOT NULL,
  prompt_template_version text        NOT NULL,
  transport               text        NOT NULL DEFAULT 'sse'
                            CHECK (transport IN ('sse','sync')),
  stream_status           text,                             -- open/done/aborted/error/fallback 사유(adapter §3/§4)
  ttfb_ms                 int CHECK (ttfb_ms IS NULL OR ttfb_ms >= 0),
  input_tokens            int CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens           int CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost                    numeric(14,6) CHECK (cost IS NULL OR cost >= 0),
  finish_reason           text CHECK (finish_reason IS NULL OR finish_reason IN ('stop','length','tool_call','content_filter')),
  output_ref              text,
  parsed_json             jsonb,
  error_code              text,
  retention_until         timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_scenario_generation_llm_calls_stream_status
    CHECK (stream_status IS NOT NULL AND stream_status IN ('open','done','error','aborted')),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_scenario_generation_llm_calls_generation
  ON scenario_generation_llm_calls (tenant_id, generation_id, created_at DESC);
CREATE INDEX idx_scenario_generation_llm_calls_status
  ON scenario_generation_llm_calls (tenant_id, stream_status)
  WHERE stream_status IN ('open','error','aborted');

-- ============================================================
-- 12. audit_log
--    PostgreSQL v1 authority for immutable audit records.
--    Hash chaining is tenant-scoped; external WORM mirroring is optional later.
-- ============================================================

CREATE TABLE audit_log (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  sequence_no      bigint      NOT NULL CHECK (sequence_no >= 1),
  actor            jsonb       NOT NULL,
  action           text        NOT NULL CHECK (length(action) > 0),
  outcome          text        NOT NULL CHECK (outcome IN ('allow','deny','blocked','error')),
  reason           text,
  correlation_id   uuid        NOT NULL,
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) > 0),
  occurred_at      timestamptz NOT NULL,
  payload          jsonb       NOT NULL,
  payload_schema_ref text      NOT NULL DEFAULT 'audit/security-boundary-decision@1'
                    CHECK (payload_schema_ref = 'audit/security-boundary-decision@1'),
  retention_until  timestamptz,
  legal_hold       boolean     NOT NULL DEFAULT false,
  deleted_at       timestamptz,
  previous_hash    text,
  hash             text        NOT NULL CHECK (length(hash) > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sequence_no),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, hash),
  FOREIGN KEY (tenant_id, previous_hash) REFERENCES audit_log(tenant_id, hash),
  CHECK (
    (sequence_no = 1 AND previous_hash IS NULL)
    OR (sequence_no > 1 AND previous_hash IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_audit_log_tenant_genesis ON audit_log (tenant_id)
  WHERE previous_hash IS NULL;
CREATE UNIQUE INDEX uq_audit_log_tenant_previous_hash ON audit_log (tenant_id, previous_hash)
  WHERE previous_hash IS NOT NULL;
CREATE INDEX idx_audit_log_tenant_time ON audit_log (tenant_id, occurred_at);
CREATE INDEX idx_audit_log_retention ON audit_log (retention_until)
  WHERE legal_hold = false AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = '55000';
  RETURN OLD;
END $$;

CREATE TRIGGER trg_audit_log_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- ============================================================
-- FK: lease 테이블(migration_concurrency_idempotency.sql)의 uuid 참조 보강
--   해당 파일은 site_profile_id/browser_identity_id/run_id/workitem_id를 uuid 컬럼으로만 두고
--   FK는 본 핵심 엔티티 마이그레이션(이 파일)에서 보강한다(테이블 본체가 여기 있으므로).
--   두 마이그레이션의 적용 순서: concurrency_idempotency 이후 core_entities (이 파일이 뒤).
-- ============================================================
ALTER TABLE credential_leases
  ADD CONSTRAINT fk_credlease_run FOREIGN KEY (run_id) REFERENCES runs(id),
  ADD CONSTRAINT fk_credlease_workitem FOREIGN KEY (workitem_id) REFERENCES workitems(id),
  ADD CONSTRAINT fk_credlease_site FOREIGN KEY (site_profile_id) REFERENCES site_profiles(id);

ALTER TABLE credential_concurrency_policies
  ADD CONSTRAINT fk_credpolicy_site FOREIGN KEY (site_profile_id) REFERENCES site_profiles(id);

ALTER TABLE browser_leases
  ADD CONSTRAINT fk_browserlease_site FOREIGN KEY (site_profile_id) REFERENCES site_profiles(id),
  ADD CONSTRAINT fk_browserlease_identity FOREIGN KEY (browser_identity_id) REFERENCES browser_identities(id),
  ADD CONSTRAINT fk_browserlease_run FOREIGN KEY (run_id) REFERENCES runs(id);

ALTER TABLE challenge_resolution_attempts
  ADD CONSTRAINT fk_challenge_run FOREIGN KEY (run_id) REFERENCES runs(id),
  ADD CONSTRAINT fk_challenge_workitem FOREIGN KEY (workitem_id) REFERENCES workitems(id);

-- raw_items.target_id는 connector 대상(target) 식별 — target 테이블은 connector 도메인(범위 외) → FK 미보강.

-- ============================================================
-- Tenant boundary hardening
--   RLS는 행 가시성을 차단하지만, FK 무결성은 tenant_id를 포함한 복합 FK로 한 번 더 고정한다.
--   workers는 auth-rbac.md §4의 인프라/BYPASSRLS 도메인이므로 제외.
-- ============================================================

ALTER TABLE site_profiles       ADD CONSTRAINT uq_site_profiles_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE browser_identities  ADD CONSTRAINT uq_browser_identities_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE scenarios           ADD CONSTRAINT uq_scenarios_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE scenario_versions   ADD CONSTRAINT uq_scenario_versions_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE workitems           ADD CONSTRAINT uq_workitems_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE runs                ADD CONSTRAINT uq_runs_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE scenario_generations ADD CONSTRAINT uq_scenario_generations_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE raw_items           ADD CONSTRAINT uq_raw_items_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE normalized_records  ADD CONSTRAINT uq_normalized_records_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE action_plan_cache   ADD CONSTRAINT uq_action_plan_cache_tenant_id_id UNIQUE (tenant_id, id);

ALTER TABLE site_profile_approvals
  ADD CONSTRAINT fk_site_profile_approvals_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id);

ALTER TABLE browser_identities
  ADD CONSTRAINT fk_browser_identities_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id);

ALTER TABLE scenario_versions
  ADD CONSTRAINT fk_scenario_versions_scenario_tenant
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios(tenant_id, id);

ALTER TABLE runs
  ADD CONSTRAINT fk_runs_scenario_version_tenant
  FOREIGN KEY (tenant_id, scenario_version_id) REFERENCES scenario_versions(tenant_id, id),
  ADD CONSTRAINT fk_runs_workitem_tenant
  FOREIGN KEY (tenant_id, workitem_id) REFERENCES workitems(tenant_id, id);

ALTER TABLE scenario_generations
  ADD CONSTRAINT fk_scenario_generations_scenario_tenant
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios(tenant_id, id),
  ADD CONSTRAINT fk_scenario_generations_scenario_version_tenant
  FOREIGN KEY (tenant_id, scenario_version_id) REFERENCES scenario_versions(tenant_id, id),
  ADD CONSTRAINT fk_scenario_generations_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id);

ALTER TABLE run_steps
  ADD CONSTRAINT fk_run_steps_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_run_steps_action_plan_cache_tenant
  FOREIGN KEY (tenant_id, action_plan_cache_id) REFERENCES action_plan_cache(tenant_id, id);

ALTER TABLE human_tasks
  ADD CONSTRAINT fk_human_tasks_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id);

ALTER TABLE artifacts
  ADD CONSTRAINT fk_artifacts_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_artifacts_generation_tenant
  FOREIGN KEY (tenant_id, generation_id) REFERENCES scenario_generations(tenant_id, id),
  ADD CONSTRAINT fk_artifacts_step_attempt_tenant
  FOREIGN KEY (tenant_id, run_id, step_id, attempt) REFERENCES run_steps(tenant_id, run_id, step_id, attempt);

-- approval_decisions 복합 테넌트 FK(다른 runs 참조 테이블 동형) — tenant_id 가 참조 run 의 tenant 와 일치하도록 DB 강제.
--   spawned_run_id 는 nullable(결정 INSERT 직후 NULL → createRunInTx 후 UPDATE 로 채움; NULL 행은 FK 미검사).
ALTER TABLE approval_decisions
  ADD CONSTRAINT fk_approval_decisions_source_run_tenant
  FOREIGN KEY (tenant_id, source_run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_approval_decisions_spawned_run_tenant
  FOREIGN KEY (tenant_id, spawned_run_id) REFERENCES runs(tenant_id, id);

ALTER TABLE events_outbox
  ADD CONSTRAINT fk_events_outbox_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_events_outbox_workitem_tenant
  FOREIGN KEY (tenant_id, workitem_id) REFERENCES workitems(tenant_id, id),
  ADD CONSTRAINT fk_events_outbox_step_attempt_tenant
  FOREIGN KEY (tenant_id, run_id, step_id, attempt) REFERENCES run_steps(tenant_id, run_id, step_id, attempt);

ALTER TABLE dead_letter
  ADD CONSTRAINT fk_dead_letter_workitem_tenant
  FOREIGN KEY (tenant_id, workitem_id) REFERENCES workitems(tenant_id, id),
  ADD CONSTRAINT fk_dead_letter_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id);

ALTER TABLE action_plan_cache
  ADD CONSTRAINT fk_action_plan_cache_scenario_version_tenant
  FOREIGN KEY (tenant_id, scenario_version_id) REFERENCES scenario_versions(tenant_id, id);

ALTER TABLE stagehand_calls
  ADD CONSTRAINT fk_stagehand_calls_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_stagehand_calls_step_attempt_tenant
  FOREIGN KEY (tenant_id, run_id, step_id, attempt) REFERENCES run_steps(tenant_id, run_id, step_id, attempt);

ALTER TABLE credential_leases
  ADD CONSTRAINT fk_credlease_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_credlease_workitem_tenant
  FOREIGN KEY (tenant_id, workitem_id) REFERENCES workitems(tenant_id, id),
  ADD CONSTRAINT fk_credlease_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id);

ALTER TABLE credential_concurrency_policies
  ADD CONSTRAINT fk_credpolicy_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id);

ALTER TABLE browser_leases
  ADD CONSTRAINT fk_browserlease_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id),
  ADD CONSTRAINT fk_browserlease_identity_tenant
  FOREIGN KEY (tenant_id, browser_identity_id) REFERENCES browser_identities(tenant_id, id),
  ADD CONSTRAINT fk_browserlease_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id);

ALTER TABLE browser_sessions
  ADD CONSTRAINT fk_browsersession_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id),
  ADD CONSTRAINT fk_browsersession_identity_tenant
  FOREIGN KEY (tenant_id, browser_identity_id) REFERENCES browser_identities(tenant_id, id);

ALTER TABLE capture_sessions
  ADD CONSTRAINT fk_capturesession_site_tenant
  FOREIGN KEY (tenant_id, site_profile_id) REFERENCES site_profiles(tenant_id, id),
  ADD CONSTRAINT fk_capturesession_identity_tenant
  FOREIGN KEY (tenant_id, browser_identity_id) REFERENCES browser_identities(tenant_id, id);

ALTER TABLE challenge_resolution_attempts
  ADD CONSTRAINT fk_challenge_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id),
  ADD CONSTRAINT fk_challenge_workitem_tenant
  FOREIGN KEY (tenant_id, workitem_id) REFERENCES workitems(tenant_id, id);

ALTER TABLE normalized_records
  ADD CONSTRAINT fk_normalized_records_raw_item_tenant
  FOREIGN KEY (tenant_id, raw_item_id) REFERENCES raw_items(tenant_id, id);

ALTER TABLE sink_deliveries
  ADD CONSTRAINT fk_sink_deliveries_normalized_record_tenant
  FOREIGN KEY (tenant_id, normalized_record_id) REFERENCES normalized_records(tenant_id, id);

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'credential_concurrency_policies',
    'credential_leases',
    'browser_leases',
    'browser_sessions',
    'capture_sessions',
    'raw_items',
    'normalized_records',
    'sink_deliveries',
    'challenge_resolution_attempts',
    'site_profiles',
    'site_profile_approvals',
    'approval_decisions',
    'browser_identities',
    'network_policies',
    'gateway_policies',
    'control_plane_idempotency_keys',
    'scenarios',
    'scenario_versions',
    'workitems',
    'runs',
    'scenario_generations',
    'run_steps',
    'human_tasks',
    'events_outbox',
    'dead_letter',
    'action_plan_cache',
    'stagehand_calls',
    'scenario_generation_llm_calls',
    'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      tenant_table
    );
  END LOOP;
END $$;

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY artifacts_visible_isolation ON artifacts
  FOR SELECT
  USING (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND deleted_at IS NULL
    AND quarantine = false
    AND redaction_status IN ('redacted','not_required')
  );

CREATE POLICY artifacts_insert_isolation ON artifacts
  FOR INSERT
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND lifecycle_claim_id IS NULL
    AND lifecycle_claim_kind IS NULL
    AND lifecycle_claim_worker_id IS NULL
    AND lifecycle_claim_correlation_id IS NULL
    AND lifecycle_claimed_at IS NULL
    AND lifecycle_claim_expires_at IS NULL
  );

-- redaction/retention/integrity jobs that must read pending/failed/deleted artifact rows run under
-- an explicit operational role with BYPASSRLS, not the application role(auth-rbac.md §4).
