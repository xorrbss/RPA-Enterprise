/**
 * extract.rowAnchor — 결정형 행별 필드 추출(LLM 속성 환각 차단).
 *
 * LLM 이 신뢰성 있게 못 읽는 필드(특히 속성값 파생; 예 SPA 의 data-href docId)를 DOM 에서 결정형으로 채운다. LLM 은 가시
 * 텍스트(제목 등)만 추출하고, 이 필드는 DOM querySelector 로 권위 세팅한다(act.valueRef 와 동형 — "LLM 추측 금지, 결정형
 * 우선"). 조인: 앵커 요소의 textContent(공백 정규화) == 각 행의 matchField.
 *
 * **조용한 false 금지(잘못된 doc_ref→비가역 결재 차단)** — 다음은 전부 loud throw 또는 drop+로그로 처리한다:
 *  - 셀렉터 0매칭(DOM 미settle/오셀렉터) → loud.
 *  - 앵커는 있으나 attribute/pattern 으로 추출한 키 0개(data-href·getView 포맷 드리프트) → loud(빈 인박스 은폐 금지).
 *  - 전 행 키-조인 실패(matchField↔앵커 textContent 불일치) → loud(0건 인박스로 진성 결함 은폐 금지).
 *  - 빈 정규화 키(앵커 또는 행) → 조인 배제(빈키 교차오염으로 다른 문서 doc_ref 부착 방지).
 *  - 중복 정규화 앵커 키 → 모호로 표시·해소 불가 처리(Map last-wins 로 WRONG doc_ref 부착 방지) + 로그.
 *  - 매칭 없는 행 → drop(환각 행/가짜 값 노출 금지) + 카운트 로그.
 */
import type { CdpSession } from "./cdp-session";
import { StagehandDomExecutorError } from "./dom-executor-error";

export interface ExtractRowAnchor {
  /** 행별 앵커 요소 셀렉터(예 "td.docu-num"). textContent 가 조인 키. */
  selector: string;
  /** 각 LLM 행에서 앵커 textContent 와 매칭할 필드명(예 "approval_id"). */
  matchField: string;
  /** 결정형으로 세팅할 행 필드명(예 "doc_ref"). */
  field: string;
  /** 앵커 요소에서 읽을 속성(예 "data-href"). */
  attribute: string;
  /** 속성값에서 id 를 뽑는 정규식(캡처 그룹 1 = id). */
  pattern: string;
  /** field 값 템플릿 — "$1" 가 캡처 id 로 리터럴 치환($ 시퀀스 미해석). */
  template: string;
}

// ReDoS 방어(defense-in-depth) — 정규식 exec 입력(외부 DOM 속성값)을 상한으로 절단해 파국적 백트래킹의 hang 시간을 bound.
// 시드 패턴(getView 숫자 캡처)은 안전하나, 운영자-저작 pattern 의 footgun 을 막는다.
const MAX_ATTR_CHARS = 4096;

const norm = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * extract.rowAnchor 런타임 검증(권위 경계 — output 검증과 동일 패턴). 6개 필드 모두 비빈 문자열 + pattern 정규식 유효성.
 * 미선언(undefined)은 통과(옵션). 부분/오타 선언은 loud(조용한 false 금지 — 잘못된 결정형 추출 설정을 묵인하지 않음).
 */
export function coerceRowAnchor(raw: unknown, stepId: string): ExtractRowAnchor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.rowAnchor must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const need = (k: keyof ExtractRowAnchor): string => {
    const v = r[k];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.rowAnchor.${String(k)} must be a non-empty string`);
    }
    return v;
  };
  const pattern = need("pattern");
  try {
    new RegExp(pattern);
  } catch {
    throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.rowAnchor.pattern is not a valid RegExp`);
  }
  return {
    selector: need("selector"),
    matchField: need("matchField"),
    field: need("field"),
    attribute: need("attribute"),
    pattern,
    template: need("template"),
  };
}

/**
 * extract.rowAnchor 적용 — DOM 앵커 요소를 querySelectorAll 로 결정형 읽어(textContent=조인키, attribute=원천),
 * 각 LLM 행의 matchField 와 키-조인해 field(예 doc_ref)를 권위 세팅한다. 빈키/중복키/매칭없음은 위 docstring 의 규율대로
 * 배제·drop 하고, 전면 실패(추출 키 0 / 전 행 drop)는 loud throw 한다(조용한 false 금지).
 */
export async function applyRowAnchor(
  stepId: string,
  anchor: ExtractRowAnchor,
  parsed: object,
  session: CdpSession,
): Promise<object> {
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.row_anchor: 출력 봉투에 rows 배열 없음`);
  }
  // 결정형 DOM 읽기: 앵커 요소별 {k:textContent(공백정규화), v:attribute}. 동일 lease 세션, read-only.
  const expr =
    `[...document.querySelectorAll(${JSON.stringify(anchor.selector)})]` +
    `.map(function(e){return {k:(e.textContent||"").replace(/\\s+/g," ").trim(), v:e.getAttribute(${JSON.stringify(anchor.attribute)})};})`;
  const pairs = await session.evaluate<Array<{ k: string; v: string | null }>>(expr);
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new StagehandDomExecutorError(
      "IR_SCHEMA_INVALID",
      `step '${stepId}' extract.row_anchor: 셀렉터 '${anchor.selector}' 0개 매칭(DOM 미settle/오셀렉터) — 조용한 false 금지`,
    );
  }

  const re = new RegExp(anchor.pattern);
  const byKey = new Map<string, string>();
  const ambiguous = new Set<string>(); // 중복 정규화 키(값 상이) — last-wins 대신 모호로 처리(WRONG doc_ref 부착 차단).
  for (const p of pairs) {
    if (typeof p.v !== "string") continue;
    const m = re.exec(p.v.length > MAX_ATTR_CHARS ? p.v.slice(0, MAX_ATTR_CHARS) : p.v);
    if (m === null || m[1] === undefined) continue;
    const k = norm(p.k);
    if (k === "") continue; // 빈 앵커 키 배제(빈키 교차오염 방지).
    const value = anchor.template.split("$1").join(m[1]); // 리터럴 치환($ 시퀀스 미해석).
    const prior = byKey.get(k);
    if (prior !== undefined && prior !== value) {
      ambiguous.add(k);
      continue;
    }
    byKey.set(k, value);
  }
  // 앵커는 있으나 결정형 키 0개 = attribute/pattern 전면 실패(data-href/getView 드리프트) → loud(빈 인박스 은폐 금지).
  if (byKey.size === 0) {
    throw new StagehandDomExecutorError(
      "IR_SCHEMA_INVALID",
      `step '${stepId}' extract.row_anchor: 앵커 ${pairs.length}개이나 attribute '${anchor.attribute}'/pattern 으로 추출된 키 0개(드리프트) — 조용한 false 금지`,
    );
  }
  for (const k of ambiguous) byKey.delete(k); // 모호 키는 해소 불가 → 조인에서 제거(해당 행은 drop 된다).

  const kept: unknown[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      dropped++;
      continue;
    }
    const key = norm((row as Record<string, unknown>)[anchor.matchField]);
    if (key === "") {
      dropped++; // 빈 매치 키(누락/비-문자열 matchField) → drop(빈키 오조인 방지).
      continue;
    }
    const value = byKey.get(key);
    if (value === undefined) {
      dropped++; // 미매칭(환각 행/모호 키) → drop(가짜 doc_ref 노출 금지).
      continue;
    }
    kept.push({ ...(row as Record<string, unknown>), [anchor.field]: value });
  }
  if (dropped > 0 || ambiguous.size > 0) {
    // 은폐 금지 — drop/모호 카운트 가시화.
    console.log(`[ROW-ANCHOR ${stepId}] ${anchor.field} 결정형 세팅: ${kept.length}행 유지 / ${dropped}행 drop / 모호키 ${ambiguous.size}.`);
  }
  // 전 행 키-조인 실패(matchField↔앵커 textContent 불일치/모호) = 포맷 드리프트 진성 결함 → loud(0건 인박스 은폐 금지).
  if (kept.length === 0 && rows.length > 0) {
    throw new StagehandDomExecutorError(
      "IR_SCHEMA_INVALID",
      `step '${stepId}' extract.row_anchor: ${rows.length}행 모두 키-조인 실패(matchField '${anchor.matchField}' ↔ 앵커 textContent 불일치/모호) — 조용한 false 금지`,
    );
  }
  return { ...parsed, rows: kept };
}
