import type { ApprovalRow } from "./types";

// 결재 인박스 — 수집 run이 남긴 아티팩트(결재 목록)를 읽어 요약·표시하기 위한 순수 로직(뷰와 분리해 단위 테스트 가능).
// 콘솔은 '하이웍스 결재 수집' 시나리오를 이름으로 식별한다(시드된 명명 시나리오) — 이름 변경 시 함께 갱신.
export const COLLECT_SCENARIO_NAME = "하이웍스 결재 수집";
// 수집 run의 결재 목록 아티팩트 type. 미존재 시 run의 첫 아티팩트로 폴백.
export const APPROVAL_ARTIFACT_TYPE = "approval_inbox";

export interface ApprovalSummary {
  readonly total: number;
  readonly byStatus: ReadonlyArray<readonly [string, number]>;
  readonly byType: ReadonlyArray<readonly [string, number]>;
}

/** 아티팩트 content(JSON) → ApprovalRow[]. 형식이 아니면 throw(조용한 false 금지 — 뷰가 오류로 표면화). */
export function parseApprovalRows(content: string): ApprovalRow[] {
  const data: unknown = JSON.parse(content); // 잘못된 JSON → throw
  const raw = Array.isArray(data)
    ? data
    : data !== null && typeof data === "object"
      ? (data as { rows?: unknown }).rows
      : undefined;
  if (!Array.isArray(raw)) throw new Error("결재 목록 형식이 아닙니다(rows 배열 없음).");
  return raw.map((r, i): ApprovalRow => {
    if (r === null || typeof r !== "object") throw new Error(`행 ${i}: 객체가 아닙니다.`);
    const row = r as Record<string, unknown>;
    if (typeof row.doc_ref !== "string" || row.doc_ref.trim() === "") {
      throw new Error(`행 ${i}: doc_ref(문서 참조)가 없습니다 — 건별 결재 불가.`);
    }
    const str = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
    return {
      doc_ref: row.doc_ref,
      approval_id: typeof row.approval_id === "string" ? row.approval_id : undefined,
      title: str(row.title, "(제목 없음)"),
      status: str(row.status, "unknown"),
      doc_type: str(row.doc_type, "(유형 미상)"),
      drafter: str(row.drafter, "(기안자 미상)"),
      drafted_at: typeof row.drafted_at === "string" ? row.drafted_at : undefined,
    };
  });
}

/** doc_ref를 외부 링크로 안전하게 노출할 수 있는지 — http/https scheme만 허용(javascript:/data: 등 XSS 차단).
 *  parseApprovalRows는 doc_ref를 비-빈 문자열로만 검증하므로, 링크화 직전 실제 scheme를 파싱해 화이트리스트한다(가정 금지). */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 상태/유형별 카운트(내림차순). LLM 미사용 — 수집된 행 그대로 집계. */
export function summarize(rows: readonly ApprovalRow[]): ApprovalSummary {
  const countBy = (key: (r: ApprovalRow) => string): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  return { total: rows.length, byStatus: countBy((r) => r.status), byType: countBy((r) => r.doc_type) };
}
