/**
 * Dev 시드 — 메일 답장 데모 시나리오 묶음 (seed-scenarios.ts 에서 호출, CLAUDE.md #7 500라인 규칙).
 *
 * **단일-run 승인 템플릿**(전용 메뉴 폐지 → 하나의 "사람 확인" 인박스로 통합): 새 업무 자동화마다 코드/메뉴를 만들지 않고
 * 시나리오(데이터)만 추가한다. 사람 승인이 필요한 액션은 @human_task 노드로 표현하면 **범용 사람-확인 인박스**에 뜨고,
 * 리뷰어가 [원문+AI 초안]을 확인·편집·승인하면 그 편집값이 재개된 액션으로 결정형 주입(value_from_node)돼 실제 답장이 전송된다.
 *
 * 회신 시나리오 흐름(단일 run): review(@human_task, payload=이 run params 의 제목/보낸사람/원문/AI초안 from_param → 인박스에
 *   표시·textarea pre-fill; result_schema=business_form_v1[reply_body textarea]) → [suspend, 인박스 대기] → 사람이 승인+편집
 *   → resume(return_node open) → navigate(msg_ref) → route(node.review.decision 분기) → (cold 면 로그인) → 답장 열기 →
 *   본문 fill(rich_body_frame + value_from_node{review.reply_body}=사람이 편집한 값, LLM 미경유) → 전송(비가역, side_effect
 *   submit) → 커밋 witness(assert_absent .send-btn). 반려는 send 없이 fail_business 종료.
 *
 * 수집 시나리오는 로그인→목록 추출→각 메일 LLM 답장 초안을 아티팩트로 남긴다(fan-out=수집 행→검토 run 은 후속 트리거링 관심사).
 * 로그인/답장/전송 act 는 LLM-계획(click_selector 미지정) → 성공 run '봇으로 굳히기' 승격 대상. 편집 본문만 결정형(value_from_node).
 *
 * ⚠ 픽스처(/fixture/mail) 대상 — 실 발신 0. 실 하이웍스 발신은 seed-hiworks-mail.ts(오너 입회, 비가역 승인 게이트).
 */
import type { PgClient } from "../src/db/pool";
import { compileScenario } from "../src/api/compile-pipeline";
import { DEV_BROWSER_IDENTITY_ID } from "./run-loop";
import {
  TENANT,
  PORT,
  DEMO_SITE,
  DEMO_NETWORK_POLICY,
  MAIL_FIXTURE_PATH,
  EMAIL_COLLECT_SCEN,
  EMAIL_COLLECT_SVER,
  EMAIL_REPLY_SCEN,
  EMAIL_REPLY_SVER,
} from "./dev-constants";

const MAIL_URL = `http://127.0.0.1:${PORT}${MAIL_FIXTURE_PATH}`;

function runtimeTarget(siteProfileId: string, browserIdentityId: string, networkPolicyId: string): {
  site_profile_id: string;
  browser_identity_id: string;
  network_policy_id: string;
} {
  return { site_profile_id: siteProfileId, browser_identity_id: browserIdentityId, network_policy_id: networkPolicyId };
}

/** 로그인 서브플로 노드(LLM-계획 act — 자격증명은 vars→SecretStore, 셀렉터만 LLM). fillUserNext/fillPwNext/submitNext 로 체인. */
function loginNodes(fillUserId: string, fillPwId: string, submitId: string, afterSubmit: string): Record<string, unknown> {
  return {
    [fillUserId]: {
      what: [
        {
          action: "act",
          instruction:
            '로그인 폼의 아이디(username) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<아이디 입력칸 CSS 셀렉터>"}',
          vars: ["login.username"],
          args: { allow_llm_secret_selector: true },
        },
      ],
      next: fillPwId,
    },
    [fillPwId]: {
      what: [
        {
          action: "act",
          instruction:
            '로그인 폼의 비밀번호(password) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<비밀번호 입력칸 CSS 셀렉터>"}',
          vars: ["login.password"],
          args: { allow_llm_secret_selector: true },
          sensitive: true,
        },
      ],
      next: submitId,
    },
    [submitId]: {
      what: [
        {
          action: "act",
          instruction: '로그인 제출 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<로그인 버튼 CSS 셀렉터>"}',
        },
      ],
      next: afterSubmit,
    },
  };
}

/** 메일 답장 데모 시나리오 시드(seedScenarios 의 tenant tx 안에서 호출 — DEMO_SITE/browser_identity 는 그 전에 시드됨). */
export async function seedEmailReply(c: PgClient): Promise<void> {
  // ── 수집 시나리오: 로그인 → 메일 목록 → 각 메일 LLM 답장 초안(extract 로 추출+생성). msg_ref 는 row_anchor 로 DOM
  //    data-msgref 에서 결정형 세팅(LLM 환각 차단). email_inbox 아티팩트(=run 의 extract 산출)로 웹 인박스가 발견.
  const collect = compileScenario(
    {
      meta: { name: "메일 답장 수집(픽스처 데모)", version: 1 },
      target: runtimeTarget(DEMO_SITE, DEV_BROWSER_IDENTITY_ID, DEMO_NETWORK_POLICY),
      params_schema: {
        type: "object",
        properties: { entry_url: { type: "string", title: "접속 주소 (시작 주소)", format: "uri", default: MAIL_URL } },
        required: ["entry_url"],
        additionalProperties: false,
      },
      assets: ["login.username", "login.password"],
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "precheck" },
        // ⚠ act(fill) 전에 반드시 observe 로 페이지 settle — 로그인 폼 렌더 대기(없으면 fill_user 가 미렌더 폼에 실행돼 실패).
        //   warm(세션 복원)이면 reviews_visible→collect 로 로그인 스킵. cold 면 login_required→로그인 서브플로.
        precheck: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "collect", priority: 2 },
            { when: "flags.login_required", target: "fill_user", priority: 1 },
          ],
        },
        ...loginNodes("fill_user", "fill_pw", "submit", "check_auth"),
        check_auth: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "collect", priority: 2 }, // 메일 목록(.mail-item.review-item) 렌더 → 추출
            { when: "flags.login_required", target: "login_failed", priority: 1 },
          ],
        },
        collect: {
          what: [
            {
              action: "extract",
              instruction:
                "받은편지함 목록의 각 메일 행(.mail-item)에서 다음을 추출하라. " +
                'mail_no(메일 번호 셀 .mail-no 의 텍스트 그대로, 예 "M-1"), from(보낸사람), subject(제목), body(본문 미리보기). ' +
                "그리고 각 메일에 대해 정중한 한국어 업무 답장 초안 reply_body 를 2~4문장으로 작성하라(수신 확인·조치 예정을 담아). " +
                "msg_ref 는 만들지 말 것 — 시스템이 DOM data-msgref 속성에서 결정형으로 채운다. " +
                '반드시 JSON 으로만 응답: {"rows":[{"mail_no":"","from":"","subject":"","body":"","reply_body":""}]}',
              schema_ref: "email_inbox_rows",
              args: {
                // 결정형 msg_ref — .mail-no 의 data-msgref(메일 상세 절대 URL)를 mail_no 키-조인으로 각 행에 권위 세팅.
                row_anchor: {
                  selector: ".mail-no",
                  match_field: "mail_no",
                  field: "msg_ref",
                  attribute: "data-msgref",
                  pattern: "(.+)",
                  template: "$1",
                },
              },
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
  if (collect.ok) {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'메일 답장 수집(픽스처 데모)')`, [EMAIL_COLLECT_SCEN, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
       VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
      [EMAIL_COLLECT_SVER, TENANT, EMAIL_COLLECT_SCEN, JSON.stringify(collect.ir), collect.compiledAst],
    );
  } else {
    console.error("EMAIL COLLECT scenario compile FAILED:", JSON.stringify(collect));
  }

  // ── 회신 검토·전송 시나리오(단일 run): params{msg_ref, mail_subject, mail_from, mail_body, ai_draft}.
  //    review(@human_task) 가 먼저 suspend → 범용 사람-확인 인박스에 [제목/보낸사람/원문/AI초안] 표시(payload from_param) +
  //    reply_body textarea 를 AI초안으로 pre-fill(payload.reply_body). 사람이 승인+편집 → resume(return_node open) →
  //    navigate(msg_ref) → route(승인만 진행) → (cold 면 로그인) → 답장 열기 → 본문 fill(value_from_node{review.reply_body}=
  //    사람 편집값) → 전송(비가역) → 커밋 witness. 반려/수정거부는 send 없이 fail_business.
  const reply = compileScenario(
    {
      meta: { name: "메일 답장 검토·전송", version: 1 },
      target: runtimeTarget(DEMO_SITE, DEV_BROWSER_IDENTITY_ID, DEMO_NETWORK_POLICY),
      params_schema: {
        type: "object",
        properties: {
          // ⚠ 기본값은 픽스처 받은편지함 메일 id 1(fixture-mail.ts DEMO_MAILS[0])과 정합해야 한다 — 리뷰어가 검토하는
          //   payload(제목/보낸사람/원문)와 실제 답장 대상 msg_ref(?view=1)가 같은 메일을 가리키게(검토≠발신대상 방지, D4-1).
          //   실 트리거(collect→회신 fan-out)는 한 수집 행에서 5개 param 을 함께 채워 자연히 정합.
          msg_ref: { type: "string", title: "메일 주소(상세/작성 URL)", default: `${MAIL_URL}?view=1` },
          mail_subject: { type: "string", title: "메일 제목", default: "6월분 세금계산서 발행 확인 요청" },
          mail_from: { type: "string", title: "보낸 사람", default: "김소진" },
          mail_body: {
            type: "string",
            title: "메일 원문",
            default: "안녕하세요. 6월분 세금계산서 발행 건 최종 확인 부탁드립니다. 회신 주시면 발행 처리하겠습니다.",
          },
          ai_draft: {
            type: "string",
            title: "AI 답장 초안",
            default:
              "안녕하세요, 김소진님. 확인 요청 주셔서 감사합니다. 6월분 세금계산서 발행 건 확인했으며, 이대로 발행 진행하겠습니다. 처리 완료되면 다시 안내드리겠습니다. 감사합니다.",
          },
        },
        required: ["msg_ref", "mail_subject", "mail_from", "mail_body", "ai_draft"],
        additionalProperties: false,
      },
      assets: ["login.username", "login.password"],
      start: "review",
      nodes: {
        // 사람 승인 게이트(범용 인박스) — payload 는 이 run params 로 해소돼 리뷰어가 실제 메일을 확인하고, reply_body textarea 가
        //   AI초안으로 pre-fill 된다(HumanTaskReviewPanel.initialFormValues 가 payload[field.key] 사용). suspend→resume(open).
        review: {
          what: [],
          next: {
            handler: "@human_task",
            input: {
              kind: "validation",
              assignee_role: "reviewer",
              payload: {
                제목: { from_param: "mail_subject" },
                보낸사람: { from_param: "mail_from" },
                원문: { from_param: "mail_body" },
                reply_body: { from_param: "ai_draft" },
              },
              result_schema: {
                version: "business_form_v1",
                fields: [
                  { key: "reply_body", label: "답장 내용", type: "textarea", required: true, help_text: "AI 초안을 검토·수정하세요. 승인하면 이 내용으로 실제 답장이 전송됩니다." },
                ],
              },
            },
            return_node: "open",
          },
        },
        // resume 진입점 — 답장 대상으로 이동(fresh 세션이라 재-navigate). 이후 route 가 실제 페이지에서 관측/분기.
        open: { what: [{ action: "navigate", url_ref: "msg_ref" }], next: "route" },
        // 승인 판정만 전송으로 진행(node.review.decision). 반려/수정/재시도는 rejected(발신 없음). route 는 navigate 뒤라 실 페이지 관측.
        route: {
          on: [
            { when: 'node.review.decision == "approve"', target: "check_auth", priority: 2 },
            { when: "true", target: "rejected", priority: 1 },
          ],
        },
        check_auth: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "login_user", priority: 2 }, // cold(세션 없음) → 로그인 서브플로
            { when: "true", target: "open_reply", priority: 1 }, // warm(세션 재사용) → 바로 답장
          ],
        },
        ...loginNodes("login_user", "login_pw", "login_submit", "recheck_auth"),
        recheck_auth: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "session_expired", priority: 2 }, // 로그인 실패 → 세션만료 종료
            { when: "true", target: "open_reply", priority: 1 },
          ],
        },
        // 답장 버튼 클릭(LLM-계획) — 답장 폼(.reply-body/.send-btn)을 연다.
        open_reply: { what: [{ action: "act", instruction: '메일 상세의 "답장" 버튼을 클릭한다. 반드시 JSON 한 줄: {"operation":"click","selector":"<답장 버튼 CSS 셀렉터>"}' }], next: "fill_body" },
        // 답장 본문 입력 — 리치에디터(iframe contenteditable) 결정형 채움(rich_body_frame). 값=사람이 승인·편집한 초안
        //   (@human_task review 노드 correction.reply_body, value_from_node → LLM 미경유). main-frame fill 은 iframe 본문에
        //   못 미치므로 executor 가 iframe 본문 focus 후 삽입. 실 하이웍스 SmartEditor 는 iframe.se-contents-edit 로 동일 모드.
        fill_body: {
          what: [
            {
              action: "act",
              instruction: "답장 본문(리치에디터 iframe)을 사람이 승인·편집한 초안으로 채운다.",
              args: { rich_body_frame: "iframe.reply-editor", value_from_node: { node: "review", key: "reply_body" } },
            },
          ],
          next: "send",
        },
        // 전송(비가역) — LLM-계획 클릭. side_effect 로 커밋 표식 + 멱등키.
        send: {
          what: [{ action: "act", instruction: '답장 "전송" 버튼을 클릭한다. 반드시 JSON 한 줄: {"operation":"click","selector":"<전송 버튼 CSS 셀렉터>"}' }],
          side_effect: { kind: "submit", idempotency_key: "email-reply-send" },
          next: "verify_after",
        },
        verify_after: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "submit_failed", priority: 2 }, // 전송 후 로그인 바운스 = 실패
            { when: "true", target: "verify_sent", priority: 1 },
          ],
        },
        // 커밋 witness: 전송 후 .send-btn 이 사라져야(전송됨 상태로 교체) 실제 발신된 것. 잔존 시 loud(거짓 성공 금지).
        verify_sent: { what: [{ action: "act", instruction: "전송 커밋 witness — 전송 버튼 소멸 확인", args: { assert_absent: ".send-btn" } }], next: "done" },
        done: { terminal: "success" },
        rejected: { terminal: "fail_business" }, // 사람이 반려/수정거부 → 발신 없이 종료(정상적 사람 판정 결과).
        session_expired: { terminal: "fail_business" },
        submit_failed: { terminal: "fail_business" },
      },
    },
    {},
  );
  if (reply.ok) {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'메일 답장 검토·전송')`, [EMAIL_REPLY_SCEN, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
       VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
      [EMAIL_REPLY_SVER, TENANT, EMAIL_REPLY_SCEN, JSON.stringify(reply.ir), reply.compiledAst],
    );
  } else {
    console.error("EMAIL REPLY scenario compile FAILED:", JSON.stringify(reply));
  }
}
