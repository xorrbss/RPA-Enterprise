-- ============================================================
-- Migration: 동시성 & idempotency 보강 (리뷰 #4 #6 #7 #11)
-- 대상: credential_leases, browser_leases, raw_items unique,
--       action_plan_cache insert-race 처리
-- 전제: 모든 테이블 tenant_id 보유 + RLS(P2). 단일 Postgres 스택.
-- ============================================================

-- ------------------------------------------------------------
-- #6 Credential Lease — "count 후 checkout" race 제거
--   조건부 insert(PK 충돌)로 원자적 획득. 동시성 상한(max_concurrency)을 slot으로 표현.
--   [FIX #5] 기존 PK(tenant_id,credential_ref,site_profile_id)는 동시성=1을 DDL로 못박아
--   README §19 "credential 동시성 기본값" 미결정과 충돌했다. slot_no를 PK에 포함해
--   사이트별 동시 세션 N개를 설정 가능하게 한다. N=1이면 기존과 동일 동작.
-- ------------------------------------------------------------
-- [FIX #5b] 동시성 상한은 lease row가 아니라 정책 테이블에 둔다(슬롯별 값 불일치 방지).
CREATE TABLE credential_concurrency_policies (
  tenant_id        uuid        NOT NULL,
  credential_ref   text        NOT NULL,
  site_profile_id  uuid        NOT NULL,
  max_concurrency  int         NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1),
  PRIMARY KEY (tenant_id, credential_ref, site_profile_id)
);

CREATE TABLE credential_leases (
  tenant_id        uuid        NOT NULL,
  credential_ref   text        NOT NULL,
  site_profile_id  uuid        NOT NULL,
  slot_no          int         NOT NULL DEFAULT 0,        -- 0 .. (policy.max_concurrency-1)
  run_id           uuid        NOT NULL,
  workitem_id      uuid,
  status           text        NOT NULL CHECK (status IN ('active','released','expired')),
  locked_until     timestamptz NOT NULL,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, credential_ref, site_profile_id, slot_no)  -- slot당 1 active
);
-- 획득(원자적, slot 1개를 점유):
--   dispatcher는 credential_concurrency_policies.max_concurrency(없으면 기본 1)를 읽어
--   0..max_concurrency-1 중 하나의 slot_no를 골라 조건부 upsert.
--   INSERT INTO credential_leases (tenant_id,credential_ref,site_profile_id,slot_no,run_id,status,locked_until)
--     VALUES ($tenant,$cred,$site,$slot,$run,'active',$until)
--   ON CONFLICT (tenant_id,credential_ref,site_profile_id,slot_no)
--     DO UPDATE SET run_id=excluded.run_id, status='active',
--                   locked_until=excluded.locked_until, acquired_at=now()
--     WHERE credential_leases.status IN ('released','expired')
--        OR credential_leases.locked_until < now();      -- 만료 회수 동시 처리
--   → 1 row면 그 slot 획득. 0 row면 그 slot 점유 중 → 다음 slot 시도.
--   모든 slot 0 row → 동시성 상한 도달 → dispatcher가 defer(SESSION_LOCKED).
--   slot 순회는 랜덤/라운드로빈으로 시작해 동일 slot 경합(thundering herd) 완화.
CREATE INDEX idx_credlease_expiry ON credential_leases (locked_until) WHERE status='active';

-- ------------------------------------------------------------
-- #7 Browser Lease — DDL + heartbeat + 만료 회수
-- ------------------------------------------------------------
CREATE TABLE browser_leases (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  site_profile_id     uuid        NOT NULL,
  browser_identity_id uuid        NOT NULL,
  run_id              uuid,
  owner_worker_id     uuid        NOT NULL,
  isolation           text        NOT NULL CHECK (isolation IN ('browser','context','page')),
  state               text        NOT NULL CHECK (state IN ('reserved','active','draining','expired')),
  cleanup_policy      text        NOT NULL CHECK (cleanup_policy IN ('clear_all','preserve_session','preserve_downloads')),
  download_dir_ref    text,                        -- lease별 다운로드 격리 경로
  heartbeat_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,        -- heartbeat 갱신 시 연장(renewal)
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_browserlease_expiry ON browser_leases (expires_at) WHERE state IN ('reserved','active');
-- renewal: 긴 step/Live Assist 중 UPDATE ... SET heartbeat_at=now(), expires_at=now()+ttl WHERE id=? AND owner_worker_id=?
-- sweeper(애플리케이션 job): expires_at < now() AND state IN ('reserved','active')
--   → 프로세스 kill + cleanup 재실행(idempotent) + state='expired'. 책임 주체 = lease-sweeper job(§artifact-lifecycle와 동일 스케줄러).

-- ------------------------------------------------------------
-- #11 raw_items idempotency — extract/page retry 시 중복 인입 방지
-- ------------------------------------------------------------
CREATE TABLE raw_items (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  connector_id         text        NOT NULL,
  target_id            uuid        NOT NULL,
  source_item_key      text,                       -- 아이템 단위 키(review_id 등)
  source_page_key      text,                       -- 페이지 단위 키(page no/cursor)
  collection_attempt_id uuid       NOT NULL,        -- 동일 raw의 재시도 구분
  raw_hash             text        NOT NULL,        -- payload 해시. canonicalization 규칙은 아래 [FIX #6] 고정
  -- [FIX #6] raw_hash 산출 규칙(멱등의 전제 — 미고정 시 동일 내용이 다른 해시로 중복 인입):
  --   raw_hash = sha256( canonical_json( raw_payload − volatile_fields ) )
  --   - canonical_json: object key 정렬 + 공백 normalize + UTF-8 NFC
  --   - volatile_fields 제외: collected_at, page timestamp, request id, 서버 echo nonce 등 매 수집 변동값
  --   - collect_tier는 hash에 **미포함**(동일 내용을 다른 tier로 재수집해도 dedup되도록)
  --   - 이미지/바이너리 메타는 콘텐츠 식별자(URL canonical 또는 자체 해시)만 포함, 휘발 헤더 제외
  raw_payload          jsonb       NOT NULL,
  collect_tier         text,
  pipeline_run_id      uuid,                        -- 재처리 라운드 식별
  collected_at         timestamptz NOT NULL DEFAULT now(),
  -- 중복 저장 정책: source_page_key + attempt 기준(replay·비용 중간점).
  -- 같은 (item, hash)가 다른 attempt로 또 들어오면 dedup(normalized 단계에서 자연키로 흡수).
  --
  -- [FIX #1] NULLS NOT DISTINCT 필수.
  --   source_item_key는 페이지 단위 수집에서 NULL이 될 수 있다. 표준 SQL은 NULL을
  --   서로 다른 값으로 취급하므로, NULLS NOT DISTINCT 없이는 source_item_key=NULL인
  --   동일 payload가 무한 중복 인입된다(#11 멱등 목적 무력화).
  --   Postgres 15+ : NULLS NOT DISTINCT. 14 이하 스택이면 아래 표현식 인덱스로 대체.
  UNIQUE NULLS NOT DISTINCT (tenant_id, connector_id, target_id, source_item_key, raw_hash)
);
-- PG14 이하 fallback(위 UNIQUE 대신):
--   CREATE UNIQUE INDEX uq_raw_items_dedup ON raw_items
--     (tenant_id, connector_id, target_id, COALESCE(source_item_key,''), raw_hash);
--
-- 정책 선택(커넥터 설정) — 어느 정책이든 NULLS NOT DISTINCT(또는 COALESCE) 유지:
--   keep_all          : UNIQUE 제거(모든 attempt 저장) — 디버깅↑ 저장비↑
--   dedup_by_hash     : 위 UNIQUE 적용(기본) — 동일 내용 재수집 무시
--   page_attempt      : UNIQUE NULLS NOT DISTINCT (…, source_page_key, collection_attempt_id)
--                       — source_page_key도 nullable이므로 동일하게 NULLS NOT DISTINCT 필수
-- 기본은 dedup_by_hash. cursor commit은 raw 영속화 성공 직후(§9 파이프라인).

CREATE TABLE normalized_records (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  raw_item_id   uuid NOT NULL REFERENCES raw_items(id),
  schema_ref    text NOT NULL,
  natural_key   text NOT NULL,                     -- 예: product_id+review_id
  record        jsonb NOT NULL,
  masked        boolean NOT NULL DEFAULT true,
  dedup_action  text CHECK (dedup_action IN ('insert','keep_existing','update_latest','merge')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, schema_ref, natural_key)        -- 자연키 dedup
);

CREATE TABLE sink_deliveries (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  normalized_record_id uuid NOT NULL REFERENCES normalized_records(id),
  sink_config_id      uuid NOT NULL,
  attempt_no          int NOT NULL,
  -- [FIX #7] 외부 sink로 보내는 멱등키. 재시도/at-least-once에도 다운스트림 중복 방지.
  --   값 규약: tenant_id:sink_config_id:schema_ref:natural_key (attempt_no는 포함 안 함 — 같은 레코드의
  --   모든 attempt가 동일 키를 보내 외부에서 1건으로 흡수). 외부 API의 Idempotency-Key 헤더 등에 사용.
  sink_idempotency_key text NOT NULL,
  status              text CHECK (status IN ('pending','delivered','failed','dead_letter')),
  response_ref        text,
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_record_id, sink_config_id, attempt_no)   -- 내부 attempt 이력 멱등
);
CREATE INDEX idx_sink_deliveries_idem ON sink_deliveries (sink_idempotency_key);

-- ------------------------------------------------------------
-- #4 ActionPlanCache insert-race — 동시 miss 해석 시 unique conflict 처리
-- (테이블 본체는 PRD §7. 여기서는 race 처리 규약만 코멘트로 고정)
-- ------------------------------------------------------------
-- 여러 워커가 같은 page_signature를 동시에 miss → 각자 LLM 해석 → 동시 insert 시도.
-- UNIQUE(scenario_version_id, step_id, url_pattern, dom_structural_hash, model, prompt_template_version, browser_identity_version)
-- 충돌 시: INSERT ... ON CONFLICT DO UPDATE
--   SET success_count = action_plan_cache.success_count + 1, last_success_at = now()
--   WHERE action_plan_cache.status = 'active';        -- 먼저 들어온 active 후보를 채택, 늦은 해석은 폐기
-- → "마지막 해석이 이긴다"가 아니라 "먼저 검증된 active가 이긴다". 늦은 워커는 자기 해석 버리고 기존 재사용.
-- failed plan 저장: verify 실패한 해석은 cache에 active로 넣지 않음. status='suspect'로 1회 기록(반복 실패 추적용),
--   재히트 시 suspect는 재생하지 않고 재해석 강제(§7.2 전이).

-- ------------------------------------------------------------
-- [FIX #8] Challenge Resolution Attempts — @challenge 핸들러 멱등 보장 테이블
--   reserved-handlers.md @challenge: "동일 challenge_event에 같은 action 중복 발화 금지
--   (attempt 테이블로 보장)"의 근거 테이블. 이전엔 참조만 되고 DDL이 패키지에 없었다.
--   UNIQUE로 같은 challenge_event×action의 중복 실행을 원천 차단.
-- ------------------------------------------------------------
CREATE TABLE challenge_resolution_attempts (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  challenge_event_id  uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  workitem_id         uuid,
  action              text        NOT NULL CHECK (action IN
                        ('session_refresh','retry_same_identity','network_retry',
                         'human_assist','provider','fail','open_circuit')),
  attempt_seq         int         NOT NULL,                 -- 순차 실행 순번(1-base)
  status              text        NOT NULL CHECK (status IN ('started','resolved','failed','skipped')),
  session_generation  int,                                  -- 해소 시 갱신된 세션 세대
  detail_ref          text,                                 -- evidence/사유 참조
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  -- 동일 challenge_event에 같은 action 1회만 — 중복 발화 차단(핸들러 멱등)
  UNIQUE (tenant_id, challenge_event_id, action)
);
CREATE INDEX idx_challenge_attempts_event ON challenge_resolution_attempts (challenge_event_id, attempt_seq);
-- 규칙: provider action은 site risk=red면 status='skipped'로 기록(실행 안 함).
--   attempt 추가는 INSERT ... ON CONFLICT (tenant_id,challenge_event_id,action) DO NOTHING
--   → 0 row면 이미 시도된 action → 핸들러가 다음 action으로 진행(중복 부작용 방지).
