/**
 * Dev 시드 — 실행 가능 데모 시나리오의 컴파일 + 영속(scenario_versions/site_profiles/browser_identities).
 * 주문수집(raw) + 데모 리뷰 + 로그인 + 세션 재사용 + 하이웍스 + 삼성 공지를 단일 트랜잭션으로 시드한다.
 */
import { withTenantTx, type PgPool } from "../src/db/pool";
import { compileScenario } from "../src/api/compile-pipeline";
import { DEV_BROWSER_IDENTITY_ID } from "./run-loop";
import {
  PORT,
  TENANT,
  SCEN,
  SVER1,
  SVER2,
  DEMO_SCEN,
  DEMO_SVER,
  DEMO_SITE,
  LOGIN_SCEN,
  LOGIN_SVER,
  SESS_SCEN,
  SESS_SVER,
  HIWORKS_SITE,
  HIWORKS_BID,
  HIWORKS_SCEN,
  HIWORKS_SVER,
  HIWORKS_LOGIN_URL,
  HIWORKS_OFFICE_ORIGIN,
  SAMSUNG_SITE,
  SAMSUNG_SCEN,
  SAMSUNG_SVER,
  SAMSUNG_ORIGIN,
} from "./dev-constants";

// 데모 사이트 프로파일의 PageState 산출 규칙(마커 없는 /fixture/reviews 셀렉터 매핑) — page_state_selectors 로 영속.
// loginUrl: 운영자-보조 캡처가 headful 로 띄울 로그인 페이지(사이트별 — resolver 는 무시, capture API 가 읽음).
const DEMO_PAGE_STATE_SELECTORS = {
  authenticatedWhen: { selector: ".user-menu" },
  loginUrl: `http://127.0.0.1:${PORT}/fixture/login`,
  flags: {
    reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
    not_found: { kind: "present", selector: ".empty-results" },
    no_next_page: { kind: "present", selector: "a.next-page.disabled" },
    login_required: { kind: "present", selector: ".login-form" },
    blocked: { kind: "present", selector: ".blocked-banner" },
  },
};
// 삼성 공지 그리드 PageState(route B 데모): 행 렌더(.grid-row-rendered)=reviews_visible. observe 게이트가 이 flag 로
// 비동기 그리드 렌더를 settle 폴링 대기한다(아래 시나리오 ready 노드). ⚠ .grid-row-rendered 는 실 그리드의 행 클래스여야
// 한다(capture-grid-dom recon 으로 확정) — 불일치면 run 이 IR_NO_BRANCH_MATCHED 로 loud 실패(무음 빈 추출 아님). 로그인 없음 → flags 만.
const SAMSUNG_PAGE_STATE_SELECTORS = {
  flags: {
    reviews_visible: { kind: "min_count", selector: ".grid-row-rendered", n: 1 },
  },
};

export async function seedScenarios(pool: PgPool): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'주문 수집 자동화')`, [SCEN, TENANT]);
    // 실행 계획이 있는 IR(테스트 실행/편집 prefill 데모용). raw seed라 compile은 건너뜀(promote 시 재검증).
    const seedIr = JSON.stringify({
      meta: { name: "주문 수집 자동화", version: 1 },
      start: "n1",
      nodes: {
        n1: { what: [{ action: "navigate", url_ref: "orders_url" }], next: "n2" },
        n2: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "n3", priority: 2 },
            { when: "flags.not_found", target: "n4", priority: 1 },
          ],
        },
        n3: { what: [{ action: "extract", schema_ref: "order_rows" }], next: "n4" },
        n4: { terminal: "success" },
      },
    });
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod',$5::jsonb), ($4,$2,$3,2,'draft',$5::jsonb)`,
      [SVER1, TENANT, SCEN, SVER2, seedIr],
    );

    // 데모 자동화: site-profile 픽스처(/fixture/reviews, 마커 없음)를 가리켜 dev 런타임 루프가
    // SitePageStateResolver로 실제 completed까지 구동 가능(compiled_ast 포함).
    const demo = compileScenario(
      {
        meta: { name: "데모 — 리뷰 수집(실행 가능)", version: 1 },
        start: "open",
        nodes: {
          open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
          check: {
            what: [{ action: "observe" }],
            on: [
              { when: "flags.not_found", target: "empty", priority: 2 },
              { when: "flags.reviews_visible", target: "done", priority: 1 },
            ],
          },
          done: { terminal: "success" },
          empty: { terminal: "success_empty" },
        },
      },
      {},
    );
    if (demo.ok) {
      // 데모 site_profile + page_state_selectors(jsonb) 영속 — run-loop가 entry URL origin으로 이 사이트를 해소해
      // 산출 규칙을 DB에서 로드. url_pattern은 canonical origin(scheme://host:port) — 매칭은 URL.origin 동일성.
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, page_state_selectors)
         VALUES ($1,$2,'데모 사이트(리뷰)',$3,$4::jsonb)`,
        [DEMO_SITE, TENANT, `http://127.0.0.1:${PORT}`, JSON.stringify(DEMO_PAGE_STATE_SELECTORS)],
      );
      // dev 브라우저 정체성 — 세션 재사용(browser_sessions) 의 browser_identity_id FK 대상. run-loop 가 이 id 를 ClaimedRun 에 주입.
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'dev-identity',1)`,
        [DEV_BROWSER_IDENTITY_ID, TENANT, DEMO_SITE],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'데모 — 리뷰 수집(실행 가능)')`, [DEMO_SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [DEMO_SVER, TENANT, DEMO_SCEN, JSON.stringify(demo.ir), demo.compiledAst],
      );

      // 로그인 자동화 시나리오: navigate → act(fill 아이디) → act(fill 비밀번호) → act(클릭 로그인) →
      // observe+on[](authenticatedWhen/reviews_visible 분기) → extract. 자격증명 fill 은 act.vars(meta.assets)→
      // secretRef→SecretStore→CDP fill 로만 흐른다(LLM 미경유). DEMO_SITE(동일 origin)의 page_state_selectors 재사용.
      const login = compileScenario(
        {
          meta: { name: "그룹웨어 로그인 + 메일 수집(실행 가능)", version: 1 },
          assets: ["login.username", "login.password"],
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "fill_user" },
            fill_user: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 아이디(username) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<아이디 입력칸 CSS 셀렉터>"}',
                  vars: ["login.username"],
                },
              ],
              next: "fill_pw",
            },
            fill_pw: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 비밀번호(password) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<비밀번호 입력칸 CSS 셀렉터>"}',
                  vars: ["login.password"],
                  sensitive: true,
                },
              ],
              next: "submit",
            },
            submit: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 제출 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<로그인 버튼 CSS 셀렉터>"}',
                },
              ],
              next: "check_auth",
            },
            check_auth: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "collect", priority: 2 },
                { when: "flags.login_required", target: "login_failed", priority: 1 },
              ],
            },
            collect: {
              what: [
                {
                  action: "extract",
                  instruction:
                    '로그인 후 보이는 항목들(.review-item)의 텍스트를 추출. 반드시 JSON 으로만 응답: {"rows":[{"text":"..."}]}',
                  schema_ref: "mail_rows",
                },
              ],
              next: "done",
            },
            done: { terminal: "success" },
            login_failed: { terminal: "fail_business" },
          },
        },
        {},
      );
      if (login.ok) {
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'그룹웨어 로그인 + 메일 수집(실행 가능)')`, [LOGIN_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [LOGIN_SVER, TENANT, LOGIN_SCEN, JSON.stringify(login.ir), login.compiledAst],
        );
      } else {
        console.error("LOGIN scenario compile FAILED:", JSON.stringify(login));
      }

      // 세션 재사용(방식 A) 데모: 로그인 서브플로를 precheck(observe)+on[] 으로 **게이트**한다(LOGIN_SVER 는 login 노드가
      // observe 전에 next-체인이라 스킵 증명 불가). warm(쿠키 복원)이면 precheck 에서 reviews_visible→collect 로 바로 가
      // 로그인 노드(fill_user/fill_pw/submit)를 건너뛴다. cold 면 login_required→로그인 서브플로→recheck→collect.
      const sess = compileScenario(
        {
          meta: { name: "그룹웨어 세션 재사용 데모(실행 가능)", version: 1 },
          assets: ["login.username", "login.password"],
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "precheck" },
            precheck: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "collect", priority: 2 }, // 이미 인증(세션 복원됨) → 로그인 스킵
                { when: "flags.login_required", target: "fill_user", priority: 1 }, // 미인증 → 로그인 서브플로
              ],
            },
            fill_user: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 아이디(username) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<아이디 입력칸 CSS 셀렉터>"}',
                  vars: ["login.username"],
                },
              ],
              next: "fill_pw",
            },
            fill_pw: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 비밀번호(password) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<비밀번호 입력칸 CSS 셀렉터>"}',
                  vars: ["login.password"],
                  sensitive: true,
                },
              ],
              next: "submit",
            },
            submit: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 제출 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<로그인 버튼 CSS 셀렉터>"}',
                },
              ],
              next: "recheck",
            },
            recheck: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "collect", priority: 2 },
                { when: "flags.login_required", target: "login_failed", priority: 1 },
              ],
            },
            collect: {
              what: [
                {
                  action: "extract",
                  instruction:
                    '로그인 후 보이는 항목들(.review-item)의 텍스트를 추출. 반드시 JSON 으로만 응답: {"rows":[{"text":"..."}]}',
                  schema_ref: "mail_rows",
                },
              ],
              next: "done",
            },
            done: { terminal: "success" },
            login_failed: { terminal: "fail_business" },
          },
        },
        {},
      );
      if (sess.ok) {
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'그룹웨어 세션 재사용 데모(실행 가능)')`, [SESS_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [SESS_SVER, TENANT, SESS_SCEN, JSON.stringify(sess.ir), sess.compiledAst],
        );
      } else {
        console.error("SESSION-REUSE scenario compile FAILED:", JSON.stringify(sess));
      }

      // 실 하이웍스 — 운영자-보조 캡처 데모. site_profile(office origin) + browser_identity + page_state_selectors
      // (authenticatedWhen=.new_header 오피스홈, login_required=로그인 ID 입력칸, loginUrl=login.office.hiworks.com).
      // '세션 등록' 버튼 → headful 로그인창 → 운영자 직접 로그인 → 세션 저장. 재사용 run 은 office 로 navigate → 인증 유지 확인.
      const HW_SELECTORS = {
        authenticatedWhen: { selector: ".new_header" },
        loginUrl: HIWORKS_LOGIN_URL,
        flags: {
          reviews_visible: { kind: "present", selector: ".new_header" }, // 오피스홈(로그인됨) 표시
          login_required: { kind: "present", selector: "input[placeholder='로그인 ID']" }, // 로그인 폼 표시
        },
      };
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors)
         VALUES ($1,$2,'하이웍스(ibizsoftware.net)',$3,'green',$4::jsonb)`,
        [HIWORKS_SITE, TENANT, HIWORKS_OFFICE_ORIGIN, JSON.stringify(HW_SELECTORS)],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'hiworks-identity',1)`,
        [HIWORKS_BID, TENANT, HIWORKS_SITE],
      );
      // 재사용 검증 시나리오: office 로 navigate → observe → on[](reviews_visible=인증유지→done / login_required=세션만료→fail).
      const hw = compileScenario(
        {
          meta: { name: "하이웍스 세션 재사용 확인", version: 1 },
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
            check: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "done", priority: 2 }, // 오피스홈 보임 = 세션 재사용 성공(로그인 스킵)
                { when: "flags.login_required", target: "session_expired", priority: 1 }, // 로그인 폼 = 세션 없음/만료
              ],
            },
            done: { terminal: "success" },
            session_expired: { terminal: "fail_business" },
          },
        },
        {},
      );
      if (hw.ok) {
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 세션 재사용 확인')`, [HIWORKS_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [HIWORKS_SVER, TENANT, HIWORKS_SCEN, JSON.stringify(hw.ir), hw.compiledAst],
        );
      } else {
        console.error("HIWORKS scenario compile FAILED:", JSON.stringify(hw));
      }

      // 삼성디스플레이 공지 수집(route B 데모) — navigate(bbsHPNO.do) → observe(그리드 렌더 대기) → extract. 봇차단/로그인 없음(실측).
      const samsung = compileScenario(
        {
          meta: { name: "삼성디스플레이 공지 수집", version: 1 },
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "ready" },
            // 비동기 그리드(getBbsList.json AJAX) 렌더 게이트 — observe 가 SitePageStateResolver 의 settle 폴링(≤10s)을 돌려
            // .grid-row-rendered 가 나타날 때까지 대기한 뒤 extract 로 진행한다(navigate 직후 즉시 extract 시 빈 그리드 경합 방지).
            // 끝까지 미렌더면 on[] 무매칭 → IR_NO_BRANCH_MATCHED 로 표면화(빈 그리드 무음 추출 금지 — "조용한 false 금지").
            ready: {
              what: [{ action: "observe" }],
              on: [{ when: "flags.reviews_visible", target: "collect", priority: 1 }],
            },
            collect: {
              what: [
                {
                  action: "extract",
                  instruction: "공지사항 목록 그리드의 각 행에서 제목, 작성자, 작성일, 조회수를 추출하라.",
                  schema_ref: "notice_rows",
                },
              ],
              next: "done",
            },
            done: { terminal: "success" },
          },
        },
        {},
      );
      if (samsung.ok) {
        await c.query(
          `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, page_state_selectors)
           VALUES ($1,$2,'삼성디스플레이(게스트 공지)',$3,$4::jsonb)`,
          [SAMSUNG_SITE, TENANT, SAMSUNG_ORIGIN, JSON.stringify(SAMSUNG_PAGE_STATE_SELECTORS)],
        );
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'삼성디스플레이 공지 수집')`, [SAMSUNG_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [SAMSUNG_SVER, TENANT, SAMSUNG_SCEN, JSON.stringify(samsung.ir), samsung.compiledAst],
        );
      } else {
        console.error("SAMSUNG scenario compile FAILED:", JSON.stringify(samsung));
      }
    }
  });
}
