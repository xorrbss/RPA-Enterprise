/**
 * Dev 콘솔 공용 상수 — 테넌트/엔티티 id, 데모 URL, 포트, 픽스처 경로, 타임스탬프 헬퍼.
 * serve(서버)·seed·seed-scenarios 가 공유하는 leaf 모듈(단방향 의존: 이 파일은 다른 dev 모듈을 import 하지 않는다).
 */
export const PORT = Number(process.env.DEV_CONSOLE_PORT ?? 8080);
export const FIXTURE_PATH = "/fixture/reviews";
export const LOGIN_FIXTURE_PATH = "/fixture/login";
// 메일 답장 데모 픽스처(로그인 → 메일 목록 → 열기 → 답장 → 전송). 실 하이웍스 발신 전 전체 흐름을 안전하게 증명한다.
export const MAIL_FIXTURE_PATH = "/fixture/mail";
export const MAIL_SEND_PATH = "/fixture/mail/send";

export const TENANT = "00000000-0000-0000-0000-0000000000d1";
export const DEV_PRINCIPAL_SUBJECT = "00000000-0000-0000-0000-0000000000de";
export const ASSIGNEE = DEV_PRINCIPAL_SUBJECT;
export const SCEN = "70000000-0000-0000-0000-00000000d101";
export const SVER1 = "70000000-0000-0000-0000-00000000d102";
export const SVER2 = "70000000-0000-0000-0000-00000000d103";
export const DEMO_SCEN = "70000000-0000-0000-0000-00000000d201";
export const DEMO_SVER = "70000000-0000-0000-0000-00000000d202";
export const DEMO_SITE = "70000000-0000-4000-8000-00000000d203";
export const DEMO_NETWORK_POLICY = "9c000000-0000-4000-8000-00000000d203";
export const LOGIN_SCEN = "70000000-0000-0000-0000-00000000d301";
export const LOGIN_SVER = "70000000-0000-0000-0000-00000000d302";
export const SESS_SCEN = "70000000-0000-0000-0000-00000000d401";
export const SESS_SVER = "70000000-0000-0000-0000-00000000d402";
// 실 하이웍스(운영자-보조 캡처 데모): 로그인=login.office.hiworks.com, 로그인 후 office=dashboard.office.hiworks.com.
export const HIWORKS_SITE = "70000000-0000-4000-8000-00000000d501";
export const HIWORKS_BID = "9b000000-0000-4000-8000-0000000000b2";
export const HIWORKS_NETWORK_POLICY = "9c000000-0000-4000-8000-00000000d501";
export const HIWORKS_SCEN = "70000000-0000-0000-0000-00000000d502";
export const HIWORKS_SVER = "70000000-0000-0000-0000-00000000d503";
// 결재 수집 시나리오(= Phase 0 recon 차량). 결재함 URL은 run 파라미터(entry_url)로 받아 하드코딩 불필요.
// 이름은 web/src/api/approval-inbox.ts COLLECT_SCENARIO_NAME("하이웍스 결재 수집")과 정확히 일치해야 인박스가 발견한다.
export const HIWORKS_COLLECT_SCEN = "70000000-0000-0000-0000-00000000d504";
export const HIWORKS_COLLECT_SVER = "70000000-0000-0000-0000-00000000d505";
// 결재(승인/반려) 시나리오 — 건별 approver-게이트 결재 run 이 참조(POST /v1/approvals/decide 내부 createRun 의 sver).
// params{doc_ref, decision:"approve"|"reject", reason?}. navigate(doc_ref)→분기(결재 클릭/사유 fill+반려)→처리 판정.
export const HIWORKS_DECIDE_SCEN = "70000000-0000-0000-0000-00000000d507";
export const HIWORKS_DECIDE_SVER = "70000000-0000-0000-0000-00000000d508";
// 결재 검토·승인(단일-run @human_task) — 범용 사람-확인 인박스 통합판. review(@human_task, 문서정보 payload)→승인 대기→
// 사람이 승인/반려(node.review.decision)→resume→navigate(doc_ref)→결재 레이어→승인/반려 결정형 클릭→커밋 witness. Model-A /decide 대체.
export const HIWORKS_REVIEW_SCEN = "70000000-0000-0000-0000-00000000d509";
export const HIWORKS_REVIEW_SVER = "70000000-0000-0000-0000-00000000d50a";
// 하이웍스 결재(approval)는 office(dashboard)와 다른 서브도메인 — 결재함 URL: approval.office.hiworks.com/.../approval/document/lists/W.
// 별도 site_profile 필요(매칭=URL.origin 동일성). 로그인은 동일 login.office.hiworks.com(SSO). 세션 SSO 전파는 recon으로 확인.
export const HIWORKS_APPROVAL_SITE = "70000000-0000-4000-8000-00000000d506";
export const HIWORKS_APPROVAL_BID = "9b000000-0000-4000-8000-0000000000b3";
export const HIWORKS_APPROVAL_NETWORK_POLICY = "9c000000-0000-4000-8000-00000000d506";
export const HIWORKS_APPROVAL_ORIGIN = "https://approval.office.hiworks.com";
export const HIWORKS_LOGIN_URL = "https://login.office.hiworks.com/ibizsoftware.net";
export const HIWORKS_OFFICE_ORIGIN = "https://dashboard.office.hiworks.com";
// 삼성디스플레이 게스트 공지(route B 데모, 실측 recon 기반): bbsHPNO.do 그리드(getBbsList.json), 봇차단/로그인 없음.
export const SAMSUNG_SITE = "70000000-0000-4000-8000-00000000d601";
export const SAMSUNG_BID = "9b000000-0000-4000-8000-0000000000b4";
export const SAMSUNG_NETWORK_POLICY = "9c000000-0000-4000-8000-00000000d601";
export const SAMSUNG_SCEN = "70000000-0000-0000-0000-00000000d602";
export const SAMSUNG_SVER = "70000000-0000-0000-0000-00000000d603";
export const SAMSUNG_NOTICE_URL = "https://guest.samsungdisplay.com/bbs/bbsHPNO.do";
export const SAMSUNG_ORIGIN = "https://guest.samsungdisplay.com";
// 메일 답장 데모: 수집(로그인+목록+LLM 초안) / "메일 답장 검토·전송"(단일 run @human_task → 범용 사람-확인 인박스에서
//   검토·편집·승인 → value_from_node 로 편집값 주입 → 전송). DEMO_SITE(127.0.0.1) 재사용 — 픽스처가 같은 origin.
export const EMAIL_COLLECT_SCEN = "70000000-0000-0000-0000-00000000d701";
export const EMAIL_COLLECT_SVER = "70000000-0000-0000-0000-00000000d702";
export const EMAIL_REPLY_SCEN = "70000000-0000-0000-0000-00000000d703";
export const EMAIL_REPLY_SVER = "70000000-0000-0000-0000-00000000d704";
// 실 하이웍스 메일(mails.office.hiworks.com) — 별도 origin site_profile. 목록 행=<a href="/view/inbox/{id}">,
// 작성창=/write?mode=reply&mail_no={id}(iframe.se-contents-edit SmartEditor), 전송="보내기"(click_text). SSO=login.office.hiworks.com.
export const HIWORKS_MAIL_SITE = "70000000-0000-4000-8000-00000000d801";
export const HIWORKS_MAIL_BID = "9b000000-0000-4000-8000-0000000000b5";
export const HIWORKS_MAIL_NETWORK_POLICY = "9c000000-0000-4000-8000-00000000d801";
export const HIWORKS_MAIL_ORIGIN = "https://mails.office.hiworks.com";
export const HIWORKS_MAIL_INBOX_URL = "https://mails.office.hiworks.com/list/inbox?page=1";
export const HIWORKS_MAIL_COLLECT_SCEN = "70000000-0000-0000-0000-00000000d802";
export const HIWORKS_MAIL_COLLECT_SVER = "70000000-0000-0000-0000-00000000d803";
export const HIWORKS_MAIL_REPLY_SCEN = "70000000-0000-0000-0000-00000000d804";
export const HIWORKS_MAIL_REPLY_SVER = "70000000-0000-0000-0000-00000000d805";

export const ts = (i: number): string => `2026-06-15T10:0${i}:00Z`;
