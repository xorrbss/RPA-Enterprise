/**
 * Dev 메일 답장 데모 픽스처 (serve.ts 분리 — CLAUDE.md #7 500라인 규칙).
 *
 * 실 하이웍스 발신 전 "로그인 → 메일 목록 → 열기 → 답장 → 전송" 전체 흐름을 안전하게 증명하기 위한 self-contained 픽스처.
 * cold(쿠키 없음)면 로그인 폼(#username/#password/#login-submit — 로그인 시나리오의 act 가 그대로 동작)을 렌더하고,
 * warm(rpa_sess=1)이면 메일 목록(.mail-item.review-item — reviews_visible flag 재사용)을 렌더한다. ?view=<id> 면 상세
 * (.reply-btn 답장 → .reply-body textarea → .send-btn 전송). 전송은 POST /fixture/mail/send 로 서버 메모리에 기록되어
 * "실제 전송"을 증명한다(비-발신, dev 전용). 전송 후 .send-btn 은 DOM 에서 제거 → 회신 시나리오의 assert_absent 커밋 witness.
 *
 * 상태는 프로세스 메모리(MailSendStore) — dev 서버 수명 동안만 유지. 실 발신/실 시크릿은 여전히 오너 실행 영역.
 */

export interface DemoMail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

/** 데모 받은편지함(첫 페이지). 실 하이웍스 메일을 흉내낸 한국어 업무 메일. */
export const DEMO_MAILS: readonly DemoMail[] = [
  { id: "1", from: "김소진", subject: "6월분 세금계산서 발행 확인 요청", body: "안녕하세요. 6월분 세금계산서 발행 건 최종 확인 부탁드립니다. 회신 주시면 발행 처리하겠습니다." },
  { id: "2", from: "이주아", subject: "연봉 계약서 서명 안내", body: "연봉 계약서 서명이 필요합니다. 첨부 확인 후 서명 여부를 회신해 주세요." },
  { id: "3", from: "베트남팀 이혜리", subject: "6월 18일 자금일보 공유", body: "금일 자금일보 공유드립니다. 잔액 및 지출 내역 검토 후 이상 여부 회신 부탁드립니다." },
];

/** 전송된 답장 기록(프로세스 메모리). "실제 전송" 증명용 — 회신 run 이 POST 하면 여기에 남는다. */
export class MailSendStore {
  private readonly sent = new Map<string, { id: string; body: string; at: string }>();
  record(id: string, body: string, at: string): void {
    this.sent.set(id, { id, body, at });
  }
  all(): Array<{ id: string; body: string; at: string }> {
    return [...this.sent.values()];
  }
  has(id: string): boolean {
    return this.sent.has(id);
  }
}

/**
 * 메일 픽스처 페이지(단일 HTML). 클라이언트 JS 가 쿠키·?view 로 로그인폼/목록/상세를 렌더한다. origin 은 msg_ref 절대 URL 구성용.
 */
export function mailFixturePage(origin: string): string {
  const mailsJson = JSON.stringify(DEMO_MAILS);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>그룹웨어 메일</title></head>
<body>
<header role="banner"><h1>그룹웨어 메일</h1></header>
<main role="main" id="app"></main>
<footer role="contentinfo"><small>&copy;</small></footer>
<script>
var ORIGIN = ${JSON.stringify(origin)};
var MAILS = ${mailsJson};
function hasSession(){return /(^|;\\s*)rpa_sess=1(;|$)/.test(document.cookie);}
function qs(k){return new URLSearchParams(location.search).get(k);}
function loginHtml(){return '<form class="login-form" id="login-form" onsubmit="return doLogin(event)">'+
  '<label>아이디 <input id="username" name="username" type="text" autocomplete="username"></label>'+
  '<label>비밀번호 <input id="password" name="password" type="password" autocomplete="current-password"></label>'+
  '<button id="login-submit" type="submit">로그인</button></form>';}
function listHtml(){
  return '<section class="mail-list">'+MAILS.map(function(m){
    return '<article class="mail-item review-item">'+
      '<a class="mail-no" data-msgref="'+ORIGIN+'/fixture/mail?view='+m.id+'" href="/fixture/mail?view='+m.id+'">M-'+m.id+'</a>'+
      '<span class="mail-from">'+m.from+'</span>'+
      '<span class="mail-subject">'+m.subject+'</span>'+
      '<span class="mail-body">'+m.body+'</span>'+
    '</article>';
  }).join('')+'</section>';
}
function detailHtml(m){
  // 답장 본문을 SmartEditor 처럼 iframe 내부 contenteditable 로 렌더(실 하이웍스 리치에디터 모사) — executor 의
  //   rich_body_frame(iframe 본문 focus + Input.insertText) 경로를 실 하이웍스와 동형으로 검증한다.
  return '<div class="mail-detail">'+
    '<h2 class="mail-subject">'+m.subject+'</h2>'+
    '<div class="mail-from">'+m.from+'</div>'+
    '<div class="mail-body">'+m.body+'</div>'+
    '<button class="reply-btn" id="reply-btn" type="button" onclick="showReply()">답장</button>'+
    '<form class="reply-form" id="reply-form" style="display:none" onsubmit="return doSend(event,\\''+m.id+'\\')">'+
      '<iframe class="reply-editor" id="reply-editor" style="width:100%;height:120px;border:1px solid #ccc"></iframe>'+
      '<button class="send-btn" id="send-btn" type="submit">전송</button>'+
    '</form>'+
  '</div>';
}
function render(){
  var app=document.getElementById('app');
  if(!hasSession()){ app.innerHTML=loginHtml(); return; }
  var view=qs('view');
  if(view){ var m=MAILS.filter(function(x){return x.id===view;})[0]; app.innerHTML = m ? detailHtml(m) : '<div>메일 없음</div>'; return; }
  app.innerHTML=listHtml();
}
function doLogin(e){e.preventDefault();var u=document.getElementById('username').value,p=document.getElementById('password').value;if(u&&p){document.cookie='rpa_sess=1; path=/';render();}return false;}
function showReply(){
  document.getElementById('reply-form').style.display='block';
  document.getElementById('reply-btn').style.display='none';
  // about:blank iframe(같은 출처) 본문을 contenteditable 로 초기화 — SmartEditor 처럼 리치 본문 편집.
  var ed=document.getElementById('reply-editor'); var d=ed.contentDocument; d.body.contentEditable='true'; d.body.focus();
}
function doSend(e,id){
  e.preventDefault();
  var ed=document.getElementById('reply-editor'); var body=(ed.contentDocument.body.textContent||'');
  fetch('/fixture/mail/send?id='+encodeURIComponent(id),{method:'POST',headers:{'content-type':'text/plain'},body:body})
    .then(function(r){ if(!r.ok) throw new Error('send failed'); document.querySelector('.mail-detail').innerHTML='<div class="reply-sent">전송됨</div>'; })
    .catch(function(){ document.querySelector('.mail-detail').innerHTML='<div class="reply-error">전송 실패</div>'; });
  return false;
}
render();
</script>
</body></html>`;
}
