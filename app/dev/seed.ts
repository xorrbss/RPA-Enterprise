/**
 * Dev 시드 오케스트레이터 — seedScenarios(시나리오) 후 runs/human_tasks/workitems/dead_letter/gateway_policies/site_profiles 픽스처.
 * seedQueuedRun: scenario_version 존재 시에만 queued run INSERT(compile 실패 시 FK 크래시 방지).
 */
import { withTenantTx, type PgPool } from "../src/db/pool";
import { seedScenarios } from "./seed-scenarios";
import {
  TENANT,
  ASSIGNEE,
  SVER1,
  SVER2,
  DEMO_SVER,
  SESS_SVER,
  SAMSUNG_SVER,
  PORT,
  FIXTURE_PATH,
  LOGIN_FIXTURE_PATH,
  SAMSUNG_NOTICE_URL,
  ts,
} from "./dev-constants";

// 큐 run 시드 — scenario_version 이 실제로 시드된 경우에만 INSERT 한다. 시나리오 compile 실패 시(위에서 console.error 로
// 표면화) 해당 version 행이 없으므로, 무가드 INSERT 면 NOT NULL FK 위반으로 시드 전체가 크래시한다. EXISTS 가드로 그 run 만
// no-op 으로 건너뛴다(컴파일 실패는 이미 loud 로그됨 — 은폐 아님).
async function seedQueuedRun(
  pool: PgPool,
  run: { id: string; sver: string; entryUrl: string; createdAt: string },
): Promise<void> {
  await withTenantTx(pool, TENANT, (c) =>
    c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, params, as_of, created_at)
       SELECT $1::uuid,$2::uuid,$3::uuid,'queued',$1::uuid,1,$4::jsonb,'2026-06-15T00:00:00Z',$5::timestamptz
       WHERE EXISTS (SELECT 1 FROM scenario_versions WHERE id=$3::uuid AND tenant_id=$2::uuid)`,
      [run.id, TENANT, run.sver, JSON.stringify({ entry_url: run.entryUrl }), run.createdAt],
    ),
  );
}

export async function seed(pool: PgPool): Promise<void> {
  await seedScenarios(pool);

  // runs: running×3 / completed / suspended.
  const RUNS: ReadonlyArray<readonly [string, string, string, number]> = [
    ["71000000-0000-0000-0000-0000000000d1", "running", SVER1, 0],
    ["71000000-0000-0000-0000-0000000000d2", "running", SVER1, 1],
    ["71000000-0000-0000-0000-0000000000d3", "completed", SVER2, 2],
    ["71000000-0000-0000-0000-0000000000d4", "suspended", SVER1, 3],
    ["71000000-0000-0000-0000-0000000000d5", "running", SVER2, 4],
  ];
  for (const [id, status, sver, i] of RUNS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
         VALUES ($1,$2,$3,$4,$1,1,'2026-06-15T00:00:00Z',$5::timestamptz)`,
        [id, TENANT, sver, status, ts(i)],
      ),
    );
  }
  const SUSPENDED_RUN = RUNS[3][0];

  // 실행 가능 데모 run: queued + params.entry_url(navigate.url_ref 가 이 키로 해소) → 부팅 시 run-loop가 구동.
  // (콘솔 '실행' 버튼은 params:{} 를 보내므로 파라미터 시나리오엔 부족 — web 측 params 입력은 후속, 아래 TODO 참조)
  await seedQueuedRun(pool, {
    id: "71000000-0000-0000-0000-0000000000d6",
    sver: DEMO_SVER,
    entryUrl: `http://127.0.0.1:${PORT}${FIXTURE_PATH}`,
    createdAt: ts(6),
  });

  // 삼성 공지 수집 run(queued, route B 데모) — 부팅 시 run-loop가 실 Chrome로 navigate(bbsHPNO.do)→observe→extract 구동.
  await seedQueuedRun(pool, {
    id: "71000000-0000-0000-0000-0000000000d9",
    sver: SAMSUNG_SVER,
    entryUrl: SAMSUNG_NOTICE_URL,
    createdAt: ts(9),
  });

  // (LOGIN_SVER 데모 시나리오는 콘솔 참조용으로 시드돼 있으나 auto-run 하지 않는다 — SESS_SVER 와 세션 키
  //  (tenant/site/bid)를 공유해 먼저 캡처하면 아래 세션 재사용 cold 증명을 오염시키기 때문. 로그인 경로는 d8 cold 가 검증.)

  // 세션 재사용 cold-start run(Run 1): 저장된 세션 없음 → precheck 에서 login_required → 로그인 서브플로 → 성공 후 캡처.
  // 이후 warm run(API 생성)은 복원으로 로그인 스킵. (게이트 시나리오 SESS_SVER)
  await seedQueuedRun(pool, {
    id: "71000000-0000-0000-0000-0000000000d8",
    sver: SESS_SVER,
    entryUrl: `http://127.0.0.1:${PORT}${LOGIN_FIXTURE_PATH}`,
    createdAt: ts(8),
  });

  // human_tasks: open(exception) / assigned(approval) / open(approval) — assign·start·resolve·escalate 테스트용.
  const HTS: ReadonlyArray<readonly [string, string, string, string | null, number]> = [
    ["73000000-0000-0000-0000-0000000000d1", "open", "exception", null, 0],
    ["73000000-0000-0000-0000-0000000000d2", "assigned", "approval", ASSIGNEE, 1],
    ["73000000-0000-0000-0000-0000000000d3", "open", "approval", null, 2],
  ];
  for (const [id, state, kind, assignee, i] of HTS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, assignee, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::text,'2026-07-01T00:00:00Z',$7::timestamptz)`,
        [id, TENANT, SUSPENDED_RUN, kind, state, assignee, ts(i)],
      ),
    );
  }

  // workitems: new / processing / abandoned×2.
  const WIS: ReadonlyArray<readonly [string, string, string, number]> = [
    ["75000000-0000-0000-0000-0000000000d1", "wi-1", "new", 0],
    ["75000000-0000-0000-0000-0000000000d2", "wi-2", "processing", 1],
    ["75000000-0000-0000-0000-0000000000d3", "wi-3", "abandoned", 2],
    ["75000000-0000-0000-0000-0000000000d4", "wi-4", "abandoned", 3],
  ];
  for (const [id, ref, status, i] of WIS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, created_at)
         VALUES ($1,$2,'reviews',$3,$4,2,$5::timestamptz)`,
        [id, TENANT, ref, status, ts(i)],
      ),
    );
  }

  // dead_letter: 2 미복원(재처리 W10 테스트용).
  const DLS: ReadonlyArray<readonly [string, string, number]> = [
    ["77000000-0000-0000-0000-0000000000d1", WIS[2][0], 0],
    ["77000000-0000-0000-0000-0000000000d2", WIS[3][0], 1],
  ];
  for (const [id, wi, i] of DLS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable, created_at, replayed_at)
         VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',true,$4::timestamptz,null)`,
        [id, TENANT, wi, ts(i)],
      ),
    );
  }

  // gateway_policies: 2 모델. gpt-4o-mini=테넌트 기본(is_default) — 콘솔 '실행'(model 미지정)이 기본 정책으로
  // 자동 해소되게(부재 시 다정책 테넌트는 model_required 422). 실 Codex 게이트웨이가 gpt-4o-mini 라 기본 적합.
  for (const [id, model, isDefault] of [
    ["79000000-0000-0000-0000-0000000000d1", "gpt-4o-mini", true],
    ["79000000-0000-0000-0000-0000000000d2", "claude-haiku", false],
  ] as const) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO gateway_policies (id, tenant_id, model, version, is_default, capabilities, budget, fallback_config)
         VALUES ($1,$2,$3,1,$4,'{"jsonMode":true,"vision":false}'::jsonb,'{"maxInputTokens":1000}'::jsonb,'{"model":"fallback"}'::jsonb)`,
        [id, TENANT, model, isDefault],
      ),
    );
  }

  // site_profiles: risk/approval/circuit 혼합 3건.
  const SITES: ReadonlyArray<readonly [string, string, string, boolean, string, number]> = [
    ["7a000000-0000-0000-0000-0000000000d1", "red-site", "red", true, "open", 0],
    ["7a000000-0000-0000-0000-0000000000d2", "green-site", "green", false, "closed", 1],
    ["7a000000-0000-0000-0000-0000000000d3", "amber-site", "amber", false, "half_open", 2],
  ];
  for (const [id, name, risk, approved, circuit, i] of SITES) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, circuit_state, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [id, TENANT, name, `https://${name}.example/*`, risk, approved, circuit, ts(i)],
      ),
    );
  }

  // 모든 site 도메인 허용 network_policy 백필 — seed 가 site/identity 만 만들고 network_policy 를 안 만들어
  //   런타임 target 추론(inferRuntimeTargetForStartUrl)이 network_policy_unresolved 로 막혀, 쉬운 만들기/일반
  //   저장 시나리오 실행이 run_target_unresolved 였던 버그 수정. POST /v1/sites(applySiteCreate)와 동형.
  await backfillSiteNetworkPolicies(pool, TENANT);
}

/**
 * site host 허용 network_policy 백필(idempotent). POST /v1/sites 가 site 등록 시 net policy 를 만드는 것과 동형으로,
 * seed 사이트도 실행 가능 상태(추론 가능)가 되도록 누락된 network_policy 를 채운다. 이미 host 를 허용하는 정책이
 * 있으면 건너뛴다. url_pattern 의 `/*` 글롭은 제거 후 hostname 추출(파싱 불가 시 skip — 조용한 통과 아님: skip 카운트 외부 미반영이나 added 로 동작 확인).
 */
export async function backfillSiteNetworkPolicies(pool: PgPool, tenantId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (c) => {
    const sites = await c.query<{ url_pattern: string }>(
      `SELECT url_pattern FROM site_profiles WHERE tenant_id=$1::uuid`,
      [tenantId],
    );
    let added = 0;
    for (const { url_pattern } of sites.rows) {
      let host: string | null = null;
      try {
        host = new URL(url_pattern.replace("/*", "")).hostname || null;
      } catch {
        host = null;
      }
      if (host === null) continue;
      const exists = await c.query(
        `SELECT 1 FROM network_policies WHERE tenant_id=$1::uuid AND $2 = ANY(allowed_domains)`,
        [tenantId, host],
      );
      if (exists.rowCount === 0) {
        await c.query(
          `INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES (gen_random_uuid(), $1::uuid, ARRAY[$2])`,
          [tenantId, host],
        );
        added += 1;
      }
    }
    return added;
  });
}
