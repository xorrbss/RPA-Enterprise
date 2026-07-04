// stagehand-dom-executor.ts 에서 추출 — 결정형 act 핸들러(click_selector/click_text/rich_body_frame/
// assert_absent, 동작 무변경). 전부 무상태(세션·컨텍스트는 인자) — 클래스가 역import.
import type { RunContext, SideEffectKind, StepResult } from "../../../ts/core-types";
import type { CdpSession } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";
import { StagehandDomExecutorError } from "./dom-executor-error";
import { CLICK_POLL_MS, clickSettleMs, nowIso, sleep } from "./stagehand-dom-executor-support";
import { detectDomChallenge, suspendForChallenge, waitForSelectorState } from "./stagehand-dom-executor-dom";

/**
 * 결정형 클릭 — IR 선언 셀렉터(click_selector)를 settle 폴링 후 CDP 클릭. LLM 미경유(셀렉터 환각 차단). 무거운 SPA 상세/
 * async 모달(예 하이웍스 결재 레이어)을 위해 존재 폴링 후 클릭한다. 비가역 결재 안전:
 *  - settle 직후~클릭 직전 abort 재확인(TOCTOU — 취소된 run 이 비가역 커밋을 발사하지 않게).
 *  - radio/checkbox 타깃이면 클릭 후 checked read-back(무효 클릭/페이지 JS 재설정으로 의도와 다른 값 커밋 방지).
 *  - click 자체는 Playwright actionability(visible/enabled/stable)를 검사해 비액셔너블 시 throw(=loud).
 */
export async function executeDeterministicClick(
  stepId: string,
  selector: string,
  sideEffect: SideEffectKind | undefined,
  ctx: RunContext,
  session: CdpSession,
  before: ReturnType<typeof pageStateRef>,
  startedAt: string,
): Promise<StepResult> {
  await waitForSelectorState(session, selector, stepId, ctx, true);
  if (ctx.abortSignal.aborted) {
    throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted before deterministic click '${selector}'`);
  }
  await session.click(selector);
  // radio/checkbox 클릭 후 실제 선택(checked) read-back — 무효 클릭이면 loud(비가역 커밋 전 의도된 값 보장).
  const checkState = await session.evaluate<string>(
    `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e||(e.type!=="radio"&&e.type!=="checkbox"))return "na";return e.checked?"checked":"unchecked";})()`,
  );
  if (checkState === "unchecked") {
    throw new StagehandDomExecutorError(
      "IR_SCHEMA_INVALID",
      `step '${stepId}' click_selector '${selector}'(radio/checkbox) 클릭 후 미선택(checked=false) — 무효 클릭, 조용한 false 금지`,
    );
  }
  const postChallenge = await detectDomChallenge(session);
  if (postChallenge !== undefined) {
    return suspendForChallenge(stepId, "act", ctx, postChallenge, {
      sideEffect: { kind: sideEffect ?? "update", committed: true },
    });
  }
  const endedAt = nowIso();
  return {
    stepId,
    action: "act",
    status: "success",
    output: { plan: { operation: "click", selector } },
    pageStateBefore: before,
    pageStateAfter: before,
    artifacts: [],
    stagehandCallIds: [],
    cache: { mode: "bypass" },
    sideEffect: { kind: sideEffect ?? "update", committed: true },
    timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
  };
}

/**
 * 결정형 텍스트 클릭(click_text) — IR 선언 텍스트를 포함한 첫 가시 상호작용 요소를 브라우저 JS 로 찾아 nonce 속성
 * (data-rpa-ct)으로 스탬프 후 그 속성 셀렉터로 클릭한다. session.click 은 CSS 셀렉터만 받으므로(text= 불가) 스탬프
 * 경유. LLM·CSS 미경유(셀렉터 환각 차단 + CSS 텍스트매칭 한계 회피) + 매 폴 재해소(동적 목록 docId 변동에 강함).
 * settle 폴링(executeDeterministicClick 동형) — 미발견 시 deadline 까지 폴 후 loud. 클릭 직전 abort 재확인(TOCTOU).
 * 다중 매칭은 DOM 순서 첫 가시 요소(문서화된 결정 — 모호성에 fail 하지 않고 사용 가능 유지).
 */
export async function executeClickText(
  stepId: string,
  text: string,
  sideEffect: SideEffectKind | undefined,
  ctx: RunContext,
  session: CdpSession,
  before: ReturnType<typeof pageStateRef>,
  startedAt: string,
): Promise<StepResult> {
  // 보이는 텍스트 포함 첫 상호작용 요소(a/button/input/[role=button]/[onclick]/[data-href])를 스탬프. 없으면 텍스트를
  //   직접 가진 leaf 요소로 폴백(클릭 버블링 의존). vis 는 challenge-detection 스크립트의 visible 과 동형.
  const stampScript = `(function(t){
    document.querySelectorAll('[data-rpa-ct]').forEach(function(e){ e.removeAttribute('data-rpa-ct'); });
    var vis = function(el){ if(!(el instanceof Element)) return false; var s=window.getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false; if(el.getAttribute('aria-hidden')==='true') return false; var r=el.getBoundingClientRect(); return (r.width>0&&r.height>0)||el.getClientRects().length>0; };
    var hit=null, inter=document.querySelectorAll('a,button,input,[role="button"],[onclick],[data-href]');
    for(var i=0;i<inter.length;i++){ if((inter[i].textContent||'').indexOf(t)!==-1 && vis(inter[i])){ hit=inter[i]; break; } }
    if(!hit){ var all=document.querySelectorAll('*'); for(var j=0;j<all.length;j++){ if(all[j].children.length===0 && (all[j].textContent||'').indexOf(t)!==-1 && vis(all[j])){ hit=all[j]; break; } } }
    if(!hit) return false;
    hit.setAttribute('data-rpa-ct','1');
    return true;
  })(${JSON.stringify(text)})`;
  const deadline = Date.now() + clickSettleMs();
  let stamped = false;
  for (;;) {
    if (ctx.abortSignal.aborted) {
      throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted while awaiting click_text '${text}'`);
    }
    try {
      stamped = await session.evaluate<boolean>(stampScript);
    } catch {
      // 네비게이션/일시 단절 — 다음 폴에서 재시도(waitForSelectorState 동형).
    }
    if (stamped) break;
    if (Date.now() >= deadline) {
      throw new StagehandDomExecutorError(
        "IR_SCHEMA_INVALID",
        `step '${stepId}' click_text '${text}' 포함 가시 요소 미발견(settle ${clickSettleMs()}ms 초과) — 조용한 false 금지`,
      );
    }
    await sleep(CLICK_POLL_MS);
  }
  if (ctx.abortSignal.aborted) {
    throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted before click_text click '${text}'`);
  }
  await session.click("[data-rpa-ct]");
  const postChallenge = await detectDomChallenge(session);
  if (postChallenge !== undefined) {
    return suspendForChallenge(stepId, "act", ctx, postChallenge, {
      sideEffect: { kind: sideEffect ?? "update", committed: true },
    });
  }
  const endedAt = nowIso();
  return {
    stepId,
    action: "act",
    status: "success",
    output: { plan: { operation: "click", selector: `[data-rpa-ct] (click_text: ${text})` } },
    pageStateBefore: before,
    pageStateAfter: before,
    artifacts: [],
    stagehandCallIds: [],
    cache: { mode: "bypass" },
    sideEffect: { kind: sideEffect ?? "update", committed: true },
    timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
  };
}

/**
 * 결정형 리치 본문 fill(rich_body_frame) — SmartEditor 등 리치에디터의 **iframe 내부 contenteditable 본문**을 채운다.
 * main-frame 대상 session.fill 은 iframe 내부에 못 미치므로, same-origin iframe 본문을 focus(+커서 최상단) 한 뒤
 * CDP Input.insertText 로 값을 삽입한다(사용자 타이핑과 동일한 beforeinput/input 이벤트 → 에디터 모델 동기화). 값은
 * valueRef→params 로 결정형 해소(LLM 미경유); 미해소면 loud(조용한 빈 본문 금지). 삽입 후 본문에 값이 반영됐는지
 * witness 검증(미반영 시 loud — 전송돼도 빈 본문 나가는 것을 success 로 은폐 금지).
 */
export async function executeRichBodyFill(
  stepId: string,
  frameSelector: string,
  value: string | undefined,
  sideEffect: SideEffectKind | undefined,
  ctx: RunContext,
  session: CdpSession,
  before: ReturnType<typeof pageStateRef>,
  startedAt: string,
): Promise<StepResult> {
  if (typeof value !== "string" || value.length === 0) {
    // valueRef 선언됐으나 params 미해소 → LLM/캐시 값 무음 fill 금지(fill_selector 와 동일 규율).
    throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' rich_body_frame 은 value_ref 해소값 필요(빈/미해소 본문 금지)`);
  }
  // 리치에디터 본문 삽입 — 에디터 종류별 adapter. 값 출처는 결정형(value_ref/value_from_node), LLM 미경유.
  //   (1) SynapEditor(사이냅 에디터 — 하이웍스 등 상용): iframe 본문이 non-editable 이고 **제출은 에디터 내부 모델에서
  //       직렬화**되므로 DOM 직접 삽입(execCommand/prepend)은 렌더는 되어도 제출 본문에 반영되지 않는다(실 하이웍스에서
  //       전송 메일에 인용문만 남던 회귀 — recon 으로 확정). 인스턴스 API `insertHTML` 로 삽입해야 모델+렌더 iframe 에 반영된다.
  //       인스턴스 초기화 전이면 'synap-init'(재시도). (2) 그 외 일반 contenteditable iframe(픽스처 등): 본문 직접 삽입.
  //   반영 witness(probe)까지 한 스크립트에서(미반영=빈 본문 전송 은폐 금지). 교차출처면 접근 불가 → loud. 재시도 idempotent.
  const probe = value.slice(0, Math.min(24, value.length));
  const insertScript = `(function(sel, val, probe){
    try {
      if (window.SynapEditor && typeof window.SynapEditor.getEditors === 'function') {
        var eds = window.SynapEditor.getEditors();
        var wrap = eds && typeof eds === 'object' ? (Array.isArray(eds) ? eds[0] : Object.values(eds)[0]) : null;
        var ed = wrap && wrap.editor ? wrap.editor : wrap;
        if (!ed || typeof ed.insertHTML !== 'function') return 'synap-init';
        var fr = document.querySelector(sel);
        var present = false;
        try { present = fr && fr.contentDocument && (fr.contentDocument.body.textContent||'').indexOf(probe)!==-1; } catch(e){}
        if (!present) {
          var esc = val.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\r?\\n/g,'<br>');
          try { ed.insertHTML('<div>'+esc+'</div>'); } catch(e){ return 'synap-insert-err'; }
        }
        try { var fd = document.querySelector(sel); if (fd && fd.contentDocument && (fd.contentDocument.body.textContent||'').indexOf(probe)!==-1) return 'ok'; } catch(e){}
        return 'synap-not-reflected';
      }
    } catch(e) { /* SynapEditor 부재/오류 → 일반 contenteditable 경로 */ }
    var f=document.querySelector(sel);
    if(!f) return 'no-frame';
    var d; try{ d=f.contentDocument; }catch(e){ return 'cross-origin'; }
    if(!d||!d.body) return 'no-body';
    var b=d.body;
    if((b.textContent||'').indexOf(probe)!==-1) return 'ok'; // 재시도 idempotent(이미 삽입됨)
    try{ b.focus(); var r=d.createRange(); r.setStart(b,0); r.collapse(true); var s=d.getSelection(); s.removeAllRanges(); s.addRange(r); }catch(e){}
    try{ d.execCommand('insertText', false, val); }catch(e){}
    if((b.textContent||'').indexOf(probe)===-1){
      try{ var p2=d.createElement('div'); p2.textContent=val; b.insertBefore(p2, b.firstChild); b.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}
    }
    return ((b.textContent||'').indexOf(probe)!==-1) ? 'ok' : 'not-reflected';
  })(${JSON.stringify(frameSelector)}, ${JSON.stringify(value)}, ${JSON.stringify(probe)})`;
  const deadline = Date.now() + clickSettleMs();
  // 실 리치에디터(예 하이웍스 답장 작성창 SmartEditor)는 인용 템플릿("Original Message")을 **비동기로 늦게** 로드해
  //   먼저 삽입한 본문을 덮어쓴다 — 단발 witness 는 삽입 직후 통과해도 이후 덮어써져 **빈/인용문만 있는 본문**이 전송된다
  //   (실 하이웍스 회귀: 전송 메일에 인용문만 남고 초안 본문 소실). 삽입값(probe)이 STABLE_MS 동안 **연속 유지**될 때만
  //   정착으로 보고 진행한다. 사라지면 insertScript 가 다음 폴에서 재삽입하고 안정 타이머를 리셋한다(안정될 때까지 반복).
  const STABLE_MS = 2000;
  let status = "";
  let okSince = 0; // probe 가 연속 present 하기 시작한 시각(0=아직/방금 덮어써짐).
  for (;;) {
    if (ctx.abortSignal.aborted) {
      throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted while filling rich body frame '${frameSelector}'`);
    }
    try {
      status = await session.evaluate<string>(insertScript);
    } catch {
      status = ""; // 네비게이션/일시 단절 — 다음 폴에서 재시도(안정 리셋).
    }
    if (status === "cross-origin") {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' rich_body_frame '${frameSelector}' 는 교차 출처라 본문 접근 불가`);
    }
    if (status === "ok") {
      if (okSince === 0) okSince = Date.now();
      if (Date.now() - okSince >= STABLE_MS) break; // 삽입값이 STABLE_MS 연속 유지 → 정착(늦은 덮어쓰기 없음).
    } else {
      okSince = 0; // 미반영/덮어써짐 → 안정 타이머 리셋(insertScript 가 재삽입).
    }
    if (Date.now() >= deadline) {
      throw new StagehandDomExecutorError(
        "IR_SCHEMA_INVALID",
        `step '${stepId}' rich_body_frame '${frameSelector}' 본문 채움 정착 실패(마지막 상태: ${status || "none"}, settle ${clickSettleMs()}ms 초과) — 빈 본문 전송 방지(조용한 false 금지)`,
      );
    }
    await sleep(CLICK_POLL_MS);
  }
  const endedAt = nowIso();
  return {
    stepId,
    action: "act",
    status: "success",
    output: { plan: { operation: "fill", selector: `${frameSelector} (rich_body_frame)` } },
    pageStateBefore: before,
    pageStateAfter: before,
    artifacts: [],
    stagehandCallIds: [],
    cache: { mode: "bypass" },
    sideEffect: { kind: sideEffect ?? "update", committed: true },
    timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
  };
}

/**
 * 결정형 부재 단언(assert_absent) — 셀렉터가 사라질 때까지 settle 폴링. 비가역 커밋의 **효과 witness**(예 확인 클릭 후
 * 결재 버튼 소멸 = 실제 커밋됨)로 쓴다. deadline 까지 잔존하면 loud(효과 미반영=커밋 실패를 success 로 은폐 금지).
 */
export async function executeAssertAbsent(
  stepId: string,
  selector: string,
  sideEffect: SideEffectKind | undefined,
  ctx: RunContext,
  session: CdpSession,
  before: ReturnType<typeof pageStateRef>,
  startedAt: string,
): Promise<StepResult> {
  await waitForSelectorState(session, selector, stepId, ctx, false);
  const endedAt = nowIso();
  return {
    stepId,
    action: "act",
    status: "success",
    output: { plan: { operation: "assert_absent", selector } },
    pageStateBefore: before,
    pageStateAfter: before,
    artifacts: [],
    stagehandCallIds: [],
    cache: { mode: "bypass" },
    sideEffect: { kind: sideEffect ?? "read_only", committed: true },
    timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
  };
}
