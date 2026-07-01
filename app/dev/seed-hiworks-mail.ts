/**
 * Dev 시드 — 실 하이웍스 메일(mails.office.hiworks.com) 답장 시나리오 (seed-scenarios.ts 에서 호출, CLAUDE.md #7).
 *
 * "메일 답장 수집"(추출) + "메일 답장 검토·전송(하이웍스)"(단일 run @human_task) 시나리오를 시드한다. 회신은 전용 메뉴가
 * 아니라 **범용 사람-확인 인박스**에 @human_task 로 뜬다 — 운영자가 콘솔 안에서만 [원문+AI 초안]을 검토·편집·승인하면
 * 백그라운드 자동화(워커/headful Chrome + 캡처 세션)가 하이웍스를 대신 구동해 실제 답장을 보낸다(하이웍스 화면 미노출). 실 recon 확정:
 *   - 목록 행 = <a href="/view/inbox/{mailNo}"> → row_anchor 로 msg_ref(작성창 URL) 결정형 추출(LLM 환각 차단).
 *   - 답장 작성창 = /write?mode=reply&mail_no={mailNo} (받는사람·제목 자동) — navigate 로 직접 진입(open→답장 클릭 생략).
 *   - 본문 = SmartEditor iframe(iframe.se-contents-edit) → rich_body_frame(iframe 본문 focus + 삽입)로 결정형 채움(값=사람 편집값).
 *   - 전송 = "보내기" 버튼(React 해시 클래스) → click_text 로 안정 클릭.
 * 세션은 캡처된 브라우저 세션 재사용 전제(운영자-보조 '세션 등록' 1회). 실 발신은 사람이 인박스에서 승인할 때만 일어난다.
 */
import type { PgClient } from "../src/db/pool";
import { compileScenario } from "../src/api/compile-pipeline";
import {
  TENANT,
  HIWORKS_LOGIN_URL,
  HIWORKS_MAIL_ORIGIN,
  HIWORKS_MAIL_INBOX_URL,
  HIWORKS_MAIL_SITE,
  HIWORKS_MAIL_BID,
  HIWORKS_MAIL_NETWORK_POLICY,
  HIWORKS_MAIL_COLLECT_SCEN,
  HIWORKS_MAIL_COLLECT_SVER,
  HIWORKS_MAIL_REPLY_SCEN,
  HIWORKS_MAIL_REPLY_SVER,
} from "./dev-constants";

function target(): { site_profile_id: string; browser_identity_id: string; network_policy_id: string } {
  return { site_profile_id: HIWORKS_MAIL_SITE, browser_identity_id: HIWORKS_MAIL_BID, network_policy_id: HIWORKS_MAIL_NETWORK_POLICY };
}

export async function seedHiworksMail(c: PgClient): Promise<void> {
  // mails 사이트 — office/approval 과 다른 서브도메인(별도 site_profile). authenticatedWhen=메일 목록 링크(로그인 시만 렌더).
  //   login_required=비밀번호 필드(만료 시 login.office.hiworks.com 로 바운스). reviews_visible=목록 행 렌더 settle.
  const SELECTORS = {
    // 캡처 성공 감지 = 오피스 홈 마커(.new_header, 결재 사이트와 동일) — SSO 로그인 후 리다이렉트되는 office 홈에 나타난다.
    //   하이웍스는 .office.hiworks.com 공유 쿠키라 office 홈에서 캡처한 세션이 mails 서브도메인에도 통한다. 메일 인박스
    //   전용 셀렉터(a[href*=/view/inbox/])를 authenticatedWhen 으로 쓰면 로그인 후 office 홈에서 매칭 실패 → 캡처 무한대기.
    authenticatedWhen: { selector: ".new_header" },
    loginUrl: HIWORKS_LOGIN_URL,
    flags: {
      login_required: { kind: "present", selector: 'input[type="password"]' },
      reviews_visible: { kind: "min_count", selector: 'a[href*="/view/inbox/"]', n: 1 },
    },
  };
  await c.query(
    `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors)
     VALUES ($1,$2,'하이웍스 메일',$3,'green',$4::jsonb)`,
    [HIWORKS_MAIL_SITE, TENANT, HIWORKS_MAIL_ORIGIN, JSON.stringify(SELECTORS)],
  );
  await c.query(
    `INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,$3::text[])`,
    [HIWORKS_MAIL_NETWORK_POLICY, TENANT, ["mails.office.hiworks.com", "login.office.hiworks.com"]],
  );
  await c.query(
    `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'hiworks-mail-identity',1)`,
    [HIWORKS_MAIL_BID, TENANT, HIWORKS_MAIL_SITE],
  );

  // 수집: 로그인(세션 재사용 전제) 상태로 받은메일함 목록에서 각 메일의 발신자·제목을 추출하고 LLM 답장 초안을 작성.
  //   msg_ref 는 행 <a href="/view/inbox/{id}"> 에서 mailNo 를 읽어 **작성창 URL**(write?mode=reply)로 결정형 구성(회신 run 이 직접 진입).
  const collect = compileScenario(
    {
      meta: { name: "메일 답장 수집", version: 1 },
      target: target(),
      params_schema: {
        type: "object",
        properties: { entry_url: { type: "string", title: "접속 주소 (시작 주소)", format: "uri", default: HIWORKS_MAIL_INBOX_URL } },
        required: ["entry_url"],
        additionalProperties: false,
      },
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
        check: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "collect", priority: 2 },
            { when: "flags.login_required", target: "session_expired", priority: 1 },
          ],
        },
        collect: {
          what: [
            {
              action: "extract",
              instruction:
                "받은편지함 목록에서 최근 메일 몇 건의 from(보낸사람), subject(제목)를 가시 텍스트로 추출하라. " +
                "그리고 각 메일에 대해 정중한 한국어 업무 답장 초안 reply_body 를 2~4문장으로 작성하라(수신 확인·조치 예정). " +
                "msg_ref 는 만들지 말 것 — 시스템이 각 행의 링크에서 결정형으로 채운다. " +
                '반드시 JSON 으로만 응답: {"rows":[{"from":"","subject":"","reply_body":""}]}',
              schema_ref: "email_inbox_rows",
              args: {
                // 행 <a href="/view/inbox/{id}"> 의 mailNo → 작성창 URL 로 결정형 msg_ref. 행 텍스트는 발신자+제목+크기+시간
                //   연결이라 subject 와 정확 매칭 불가 → text_selector 로 **제목만 담은 자식**(span[class*=MailListItem_subject__])
                //   을 조인키로 사용(href 는 행에서, 조인키는 제목 자식에서).
                row_anchor: {
                  selector: 'a[href*="/view/inbox/"]',
                  text_selector: '[class*="MailListItem_subject__"]',
                  match_field: "subject",
                  field: "msg_ref",
                  attribute: "href",
                  pattern: "/view/inbox/(\\d+)",
                  template: "https://mails.office.hiworks.com/write?mode=reply&mail_no=$1",
                  // 받은편지함은 수십 건 중 일부만 초안 대상 — 미커버 앵커를 loud 하지 않는다(결재의 완전-커버리지와 구분).
                  require_full_coverage: false,
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
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'메일 답장 수집')`, [HIWORKS_MAIL_COLLECT_SCEN, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
       VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
      [HIWORKS_MAIL_COLLECT_SVER, TENANT, HIWORKS_MAIL_COLLECT_SCEN, JSON.stringify(collect.ir), collect.compiledAst],
    );
  } else {
    console.error("HIWORKS MAIL COLLECT scenario compile FAILED:", JSON.stringify(collect));
  }

  // 회신 검토·전송(단일 run — 픽스처 "메일 답장 검토·전송"과 동형, 실 하이웍스 셀렉터): params{msg_ref(작성창 URL),
  //   mail_subject, mail_from, mail_body, ai_draft}. review(@human_task) 가 먼저 suspend → 범용 사람-확인 인박스에 실 메일
  //   [제목/보낸사람/원문/AI초안] 표시(payload from_param) + reply_body textarea 를 AI초안으로 pre-fill. 사람이 승인+편집 →
  //   resume(open) → navigate(작성창) → route(승인만 진행) → (세션만료 검사) → 본문 채움(SmartEditor iframe, value_from_node=
  //   사람 편집값) → 전송(보내기, 비가역) → 커밋 witness(작성 에디터 소멸). 반려는 발신 없이 종료. 실 발신은 오너 승인에서만.
  const reply = compileScenario(
    {
      meta: { name: "메일 답장 검토·전송(하이웍스)", version: 1 },
      target: target(),
      params_schema: {
        type: "object",
        properties: {
          msg_ref: { type: "string", title: "작성창 URL(write?mode=reply)" },
          mail_subject: { type: "string", title: "메일 제목" },
          mail_from: { type: "string", title: "보낸 사람" },
          mail_body: { type: "string", title: "메일 원문" },
          ai_draft: { type: "string", title: "AI 답장 초안" },
        },
        required: ["msg_ref", "mail_subject", "mail_from", "mail_body", "ai_draft"],
      },
      start: "review",
      nodes: {
        // 사람 승인 게이트(범용 인박스) — payload 를 이 run 의 실 메일 데이터로 해소, reply_body textarea 를 AI초안으로 pre-fill.
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
        open: { what: [{ action: "navigate", url_ref: "msg_ref" }], next: "route" },
        route: {
          on: [
            { when: 'node.review.decision == "approve"', target: "check", priority: 2 },
            { when: "true", target: "rejected", priority: 1 },
          ],
        },
        check: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "session_expired", priority: 2 }, // 세션 만료(로그인 바운스)
            { when: "true", target: "fill_body", priority: 1 }, // 작성창 로드 → 본문 채움
          ],
        },
        // SmartEditor iframe 본문을 사람이 승인·편집한 초안으로 결정형 채움(value_from_node review.reply_body, LLM 미경유).
        fill_body: {
          what: [
            {
              action: "act",
              instruction: "답장 본문(SmartEditor)을 사람이 승인·편집한 초안으로 채운다.",
              args: { rich_body_frame: "iframe.se-contents-edit", value_from_node: { node: "review", key: "reply_body" } },
            },
          ],
          next: "send",
        },
        // 전송(비가역) — "보내기" 버튼 텍스트 클릭(React 해시 클래스 무관). side_effect 로 커밋 표식+멱등키.
        send: {
          what: [{ action: "act", instruction: '답장 "보내기" 버튼을 클릭한다.', args: { click_text: "보내기" } }],
          side_effect: { kind: "submit", idempotency_key: "hiworks-mail-reply-send" },
          next: "verify_after",
        },
        verify_after: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.login_required", target: "submit_failed", priority: 2 },
            { when: "true", target: "verify_sent", priority: 1 },
          ],
        },
        // 커밋 witness: 전송되면 작성 에디터(SmartEditor iframe)가 사라진다(목록/성공 화면으로 전환). 잔존 시 loud.
        verify_sent: { what: [{ action: "act", instruction: "전송 커밋 witness — 작성 에디터 소멸 확인", args: { assert_absent: "iframe.se-contents-edit" } }], next: "done" },
        done: { terminal: "success" },
        rejected: { terminal: "fail_business" }, // 사람이 반려/수정거부 → 발신 없이 종료.
        session_expired: { terminal: "fail_business" },
        submit_failed: { terminal: "fail_business" },
      },
    },
    {},
  );
  if (reply.ok) {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'메일 답장 검토·전송(하이웍스)')`, [HIWORKS_MAIL_REPLY_SCEN, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
       VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
      [HIWORKS_MAIL_REPLY_SVER, TENANT, HIWORKS_MAIL_REPLY_SCEN, JSON.stringify(reply.ir), reply.compiledAst],
    );
  } else {
    console.error("HIWORKS MAIL REPLY scenario compile FAILED:", JSON.stringify(reply));
  }
}
