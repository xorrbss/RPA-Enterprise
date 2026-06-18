/**
 * Dev 시드 — 하이웍스 결재(approval) 시나리오 묶음 (의미 단위 분리, CLAUDE.md 규칙 #7).
 *
 * seed-scenarios.ts 의 단일 트랜잭션(seedScenarios)에서 호출되는 헬퍼. approval 서브도메인 site_profile +
 * browser_identity + 결재 수집(collect) + 결재 처리(decide) 시나리오를 시드한다. office(dashboard) 하이웍스
 * 블록과 별개의 의미 단위라 분리(파일 500라인 규칙 — 선례 41c2d3a3 serve.ts 분리 패턴).
 */
import type { PgClient } from "../src/db/pool";
import { compileScenario } from "../src/api/compile-pipeline";
import {
  TENANT,
  HIWORKS_LOGIN_URL,
  HIWORKS_APPROVAL_ORIGIN,
  HIWORKS_APPROVAL_SITE,
  HIWORKS_APPROVAL_BID,
  HIWORKS_COLLECT_SCEN,
  HIWORKS_COLLECT_SVER,
  HIWORKS_DECIDE_SCEN,
  HIWORKS_DECIDE_SVER,
} from "./dev-constants";

/** 하이웍스 결재 site_profile + 수집/처리 시나리오 시드(seedScenarios 의 tenant tx 안에서 호출). */
export async function seedHiworksApproval(c: PgClient): Promise<void> {
  // 하이웍스 결재(approval) 사이트 — office(dashboard)와 다른 서브도메인(approval.office.hiworks.com)이라 별도 profile.
  // 로그인은 동일 login.office.hiworks.com(SSO) → loginUrl 동일. authenticatedWhen=.new_header 는 로그인 직후 리다이렉트되는
  // office 홈 표지(캡처 감지용). login_required 는 로그인 폼.
  // reviews_visible(닫힌 flag 레지스트리의 범용 "대상 데이터 목록 가시")를 결재 목록 행에 재사용 — recon 확정 셀렉터
  // td.docu-num(문서번호 셀, 행당 1개)이 최소 1개 렌더되면 목록이 settle 된 것. observe 가 이 flag 를 settle 폴링해
  // SPA 행 렌더를 대기한 뒤 extract 로 진행한다(미완로드 빈 추출/환각 방지). 미등록 inbox_rows_visible 신설은 V8 위반이라 금지.
  const HW_APPROVAL_SELECTORS = {
    authenticatedWhen: { selector: ".new_header" },
    loginUrl: HIWORKS_LOGIN_URL,
    flags: {
      login_required: { kind: "present", selector: "input[placeholder='로그인 ID']" },
      reviews_visible: { kind: "min_count", selector: "td.docu-num", n: 1 },
    },
  };
  await c.query(
    `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors)
     VALUES ($1,$2,'하이웍스 결재(approval)',$3,'green',$4::jsonb)`,
    [HIWORKS_APPROVAL_SITE, TENANT, HIWORKS_APPROVAL_ORIGIN, JSON.stringify(HW_APPROVAL_SELECTORS)],
  );
  await c.query(
    `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'hiworks-approval-identity',1)`,
    [HIWORKS_APPROVAL_BID, TENANT, HIWORKS_APPROVAL_SITE],
  );

  // 하이웍스 결재 수집(= Phase 0 recon 차량 + 결재 인박스 데이터 소스). 캡처된 세션 재사용을 전제(실 하이웍스 로그인은
  // MFA라 cold 자동로그인 불가 — 운영자-보조 '세션 등록'으로 1회 캡처). 결재함 URL은 run 파라미터 entry_url 로 받는다
  // (origin = approval.office.hiworks.com → 위 결재 site_profile/세션으로 해소). observe 게이트: 로그인 폼이면 session_expired,
  // 결재 목록 행(td.docu-num)이 렌더되면 추출. recon 확정 셀렉터로 게이트 강화(catch-all 제거) → 미렌더 시 IR_NO_BRANCH_MATCHED
  // 로 loud 실패(빈 그리드 무음 추출 금지). doc_ref 는 행의 data-href(ApprovalDocument.getView('<docId>',...))에서 docId 를
  // 읽어 결정형으로 구성(extract.args.row_anchor — LLM 속성 환각 차단, 실행기가 권위 세팅). doc_ref 존재가 Model A(건별 결재 run)의 사활.
  // ⚠ **현 한계(명시): 현재 보이는 1페이지만 수집한다**(open→check→collect→done; 페이지 순회 루프 없음). 라이브 결재함은
  //   페이지네이션되므로(예 172건 중 1페이지) 인박스는 1페이지분만 담는다 — '전체 결재'가 아니다. 전 페이지 수집은 닫힌 flag
  //   no_next_page 로 check→collect→(no_next_page?done:next_page act→collect) 순회 루프를 구성하는 후속 작업(YAGNI 까지 보류).
  const collect = compileScenario(
    {
      meta: { name: "하이웍스 결재 수집", version: 1 },
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
        check: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "session_expired", priority: 2 }, // 로그인 폼 = 세션 없음/만료 → 재캡처 필요
            { when: "flags.reviews_visible", target: "collect", priority: 1 }, // 결재 목록 행 렌더(settle 완료) → 추출
          ],
        },
        collect: {
          what: [
            {
              action: "extract",
              instruction:
                "결재 대기 목록 테이블의 각 행(tr)에서 다음을 **가시 텍스트로만** 추출하라. " +
                'approval_id(문서번호 셀 td.docu-num 의 텍스트를 한 글자도 바꾸지 말고 그대로, 예 "IB-지출(거래처)-20260604-0001"), ' +
                'title(제목), drafter(기안자), drafted_at(기안일, 예 "2026-06-17"), doc_type(구분, 예 "결재"/"합의"), status(상태). ' +
                "doc_ref 는 만들지 말 것 — 시스템이 DOM 의 data-href 속성에서 결정형으로 채운다(LLM 의 속성값 추측은 환각이라 금지). " +
                '반드시 JSON 으로만 응답: {"rows":[{"approval_id":"","title":"","drafter":"","drafted_at":"","doc_type":"","status":""}]}',
              schema_ref: "approval_inbox_rows",
              args: {
                // 결정형 doc_ref(LLM 환각 차단) — td.docu-num 의 data-href(ApprovalDocument.getView('<docId>','W'))에서 docId 를
                // 읽어 approval_id(문서번호) 키-조인으로 각 행에 권위 세팅한다. 매칭 없는(환각) 행은 실행기가 drop(가짜 값 노출 금지).
                row_anchor: {
                  selector: "td.docu-num",
                  match_field: "approval_id",
                  field: "doc_ref",
                  attribute: "data-href",
                  pattern: "getView\\(['\"](\\d+)['\"]",
                  template: "https://approval.office.hiworks.com/ibizsoftware.net/approval/document/view/$1",
                },
              },
            },
          ],
          next: "done",
        },
        done: { terminal: "success" },
        session_expired: { terminal: "fail_business" },
      },
    },
    {},
  );
  if (collect.ok) {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 수집')`, [HIWORKS_COLLECT_SCEN, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
       VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
      [HIWORKS_COLLECT_SVER, TENANT, HIWORKS_COLLECT_SCEN, JSON.stringify(collect.ir), collect.compiledAst],
    );
  } else {
    console.error("HIWORKS COLLECT scenario compile FAILED:", JSON.stringify(collect));
  }

  // 하이웍스 결재 처리(승인/반려) — 건별 approver-게이트 결재 run 이 참조하는 단일 시나리오(params.decision 분기).
  // navigate(doc_ref → 결재 site_profile/세션 재사용) → check observe(login? 세션만료) → open_layer(결재 버튼 클릭=승인 레이어
  //   열기) → route observe(params.decision 분기) → 승인/반려 라디오 선택 → [반려: 의견 fill] → confirm(확인=커밋) → recheck.
  // **결정형 클릭(act.args.click_selector)**: 실 recon(2026-06-18)으로 확정한 onclick/속성 셀렉터로 LLM 미경유 클릭한다 —
  //   결재 버튼은 class/id 가 없어 LLM 이 button.approval-btn 으로 환각했었다(라이브 실패). 결정형 셀렉터:
  //   결재(레이어 열기)=button[onclick*=getApprovalLayer], 승인 라디오=input[name=approval_value][value=2](기본이지만 명시),
  //   반려 라디오=[value=4], 확인(커밋)=button[onclick*=approvalAction(false)](approvalAction(true)=다음문서·hidePopup 과 구분).
  // 커밋(비가역)은 confirm 의 확인 클릭뿐(결재/라디오/의견은 미커밋). click_selector 미존재 시 settle 초과로 loud(조용한 무성공
  //   금지). ⚠ 승인 경로는 라이브 검증; 반려 경로는 동일 레이어 recon 기반이나 라이브 미검증(의견 fill selector 는 LLM — 후속에
  //   fill_selector 로 결정형화). recheck 는 coarse(로그인 바운스=실패 / 그 외=성공); 문서-수준 "처리됨" witness 는 후속 하드닝.
  const APPROVAL_BTN = 'button[onclick*="getApprovalLayer"]'; // 결재 = 승인 레이어 열기.
  const CONFIRM_BTN = 'button[onclick*="approvalAction(false)"]'; // 확인 = 커밋(승인/반려 공통, 선택된 approval_value 반영).
  const decide = compileScenario(
    {
      meta: { name: "하이웍스 결재 처리", version: 1 },
      params_schema: {
        type: "object",
        properties: {
          doc_ref: { type: "string" },
          decision: { type: "string" },
          reason: { type: "string" },
        },
        required: ["doc_ref", "decision"],
      },
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "doc_ref" }], next: "check" },
        check: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "session_expired", priority: 2 }, // 로그인 폼 = 세션 만료/미인증
            { when: "true", target: "open_layer", priority: 1 }, // 인증 유지 → 결재 레이어 열기(분기는 route 에서)
          ],
        },
        // 결재 버튼 클릭 = 승인 레이어 열기(미커밋). settle 폴링이 무거운 SPA 상세 렌더를 대기한다.
        open_layer: { what: [{ action: "act", instruction: "결재(승인 레이어 열기) 버튼 클릭", args: { click_selector: APPROVAL_BTN } }], next: "route" },
        route: {
          what: [{ action: "observe" }],
          on: [
            { when: 'params.decision == "reject"', target: "reject_select", priority: 2 },
            { when: 'params.decision == "approve"', target: "approve_select", priority: 1 },
          ],
        },
        // 승인: 승인 라디오(value=2, 기본이지만 명시 선택=결정형 보장) → 확인(커밋).
        approve_select: {
          what: [{ action: "act", instruction: "승인 라디오 선택", args: { click_selector: 'input[name="approval_value"][value="2"]' } }],
          next: "confirm",
        },
        // 반려: 반려 라디오(value=4) → 의견 fill(value_ref:reason; selector 는 현재 LLM — 후속 fill_selector) → 확인(커밋).
        reject_select: {
          what: [{ action: "act", instruction: "반려 라디오 선택", args: { click_selector: 'input[name="approval_value"][value="4"]' } }],
          next: "reject_reason",
        },
        reject_reason: {
          what: [
            {
              action: "act",
              instruction: '반려 의견 입력칸(textarea#approvalReasonMessage 등 "의견을 입력하세요")을 채운다. JSON 한 줄: {"operation":"fill","selector":"<의견칸 CSS 셀렉터>"}',
              args: { value_ref: "reason" }, // params.reason → 결정형 value 스레드(LLM 미경유 fill value).
            },
          ],
          next: "confirm",
        },
        // 확인 = 커밋(비가역). 선택된 approval_value(승인2/반려4)와 의견이 함께 제출된다.
        confirm: {
          what: [{ action: "act", instruction: "확인(제출) 버튼 클릭 — 결재 커밋", args: { click_selector: CONFIRM_BTN } }],
          side_effect: { kind: "submit", idempotency_key: "hiworks-decide-confirm" },
          next: "recheck",
        },
        recheck: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "submit_failed", priority: 2 }, // 제출 후 로그인 바운스 = 실패
            { when: "true", target: "done", priority: 1 }, // 클릭 완료 + 인증 유지 = 성공(coarse; 문서 witness 는 후속 하드닝)
          ],
        },
        done: { terminal: "success" },
        session_expired: { terminal: "fail_business" },
        submit_failed: { terminal: "fail_business" },
      },
    },
    {},
  );
  if (decide.ok) {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 결재 처리')`, [HIWORKS_DECIDE_SCEN, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
       VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
      [HIWORKS_DECIDE_SVER, TENANT, HIWORKS_DECIDE_SCEN, JSON.stringify(decide.ir), decide.compiledAst],
    );
  } else {
    console.error("HIWORKS DECIDE scenario compile FAILED:", JSON.stringify(decide));
  }
}
