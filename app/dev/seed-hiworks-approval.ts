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
  // 읽어 결정형으로 구성(LLM attribute 추출 신뢰도↓ → 명시 지시). doc_ref 존재가 Model A(건별 결재 run)의 사활.
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
  // navigate(doc_ref, origin=approval → 위 결재 site_profile/세션 재사용) → check observe: login_required→세션만료,
  // 아니면 params.decision 으로 승인/반려 분기(IREL params.* 는 params_schema 로 타입). 승인=결재 버튼 클릭,
  // 반려=사유 fill(args.value_ref:"reason" → ir-translate 가 params.reason 을 결정형 value 로 스레드, LLM 미경유)+반려 버튼.
  // 확인 모달 클릭 후 recheck observe 로 판정(IR verify 노드는 런타임 미실행 — observe/on[]로). 클릭 노드는 side_effect:submit.
  // ⚠ recheck 는 coarse(로그인 바운스=실패 / 그 외=성공): 문서-수준 "처리됨" witness 셀렉터는 Phase 2 실 recon(휴먼게이트)
  //   에서 확정해 reviews_visible 등 등록 flag 로 강화한다(현재 닫힌 레지스트리엔 detail-page 처리 witness 없음 — 발명 금지).
  //   클릭 act 는 버튼 부재 시 LLM plan 부재로 loud 실패(조용한 무성공 아님). reject⇒reason 필수성은 엔드포인트가 강제.
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
            { when: "flags.login_required", target: "session_expired", priority: 3 }, // 로그인 폼 = 세션 만료/미인증
            { when: 'params.decision == "reject"', target: "do_reject_reason", priority: 2 },
            { when: 'params.decision == "approve"', target: "do_approve", priority: 1 },
          ],
        },
        do_approve: {
          what: [
            {
              action: "act",
              instruction:
                '결재 문서 상세에서 현재 사용자의 "결재"(승인) 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<결재 버튼 CSS 셀렉터>"}',
            },
          ],
          side_effect: { kind: "submit", idempotency_key: "hiworks-decide-approve" },
          next: "confirm",
        },
        do_reject_reason: {
          what: [
            {
              action: "act",
              instruction:
                '반려 사유 입력칸(textarea/input)을 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<사유 입력칸 CSS 셀렉터>"}',
              args: { value_ref: "reason" }, // params.reason → 결정형 value 스레드(LLM 미경유 fill).
            },
          ],
          next: "do_reject_click",
        },
        do_reject_click: {
          what: [
            {
              action: "act",
              instruction:
                '결재 문서의 "반려" 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<반려 버튼 CSS 셀렉터>"}',
            },
          ],
          side_effect: { kind: "submit", idempotency_key: "hiworks-decide-reject" },
          next: "confirm",
        },
        confirm: {
          what: [
            {
              action: "act",
              instruction:
                '확인(제출) 모달이 떠 있으면 확인 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<확인 버튼 CSS 셀렉터>"}',
            },
          ],
          side_effect: { kind: "submit", idempotency_key: "hiworks-decide-confirm" },
          next: "recheck",
        },
        recheck: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "submit_failed", priority: 2 }, // 제출 후 로그인 바운스 = 실패
            { when: "true", target: "done", priority: 1 }, // 클릭 완료 + 인증 유지 = 성공(coarse; 문서 witness 는 recon 하드닝)
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
