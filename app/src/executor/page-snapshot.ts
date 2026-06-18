/**
 * dom 페이지 스냅샷 정규화 — extract/act 의 LLM 컨텍스트용 페이지 원문(가시텍스트 우선 + HTML 절단). StagehandDomExecutor
 * 에서 분리(의미 단위, CLAUDE.md #7). LLM 이 셀렉터를 정하려면 원문 DOM 이 필요(PageState 파생 신호만으론 #password 등
 * 타깃 불가). user 메시지로 실어 Gateway redaction(§4) 경계가 redact/injection-탐지하게 한다. 토큰 예산 보호용 상한(초과분 절단).
 */
const MAX_PAGE_SNAPSHOT_CHARS = 24000;
const MAX_VISIBLE_TEXT_CHARS = 12000;
const MAX_NETWORK_JSON_CHARS = 12000;

export function normalizePageSnapshot(snapshot: unknown): string | undefined {
  if (typeof snapshot === "string") {
    const text = cleanSnapshotText(snapshot);
    return text.length > 0 ? text.slice(0, MAX_PAGE_SNAPSHOT_CHARS) : undefined;
  }
  if (typeof snapshot !== "object" || snapshot === null) return undefined;

  const rec = snapshot as { networkJson?: unknown; visibleText?: unknown; html?: unknown };
  const networkJson = typeof rec.networkJson === "string" ? cleanSnapshotText(rec.networkJson) : "";
  const visibleText = typeof rec.visibleText === "string" ? cleanSnapshotText(rec.visibleText) : "";
  const html = typeof rec.html === "string" ? cleanSnapshotText(rec.html) : "";
  const parts: string[] = [];
  if (networkJson.length > 0) parts.push(`[network_json]\n${networkJson.slice(0, MAX_NETWORK_JSON_CHARS)}`);

  let remaining = MAX_PAGE_SNAPSHOT_CHARS - parts.join("\n\n").length;
  if (visibleText.length > 0 && remaining > 128) {
    parts.push(`[visible_text]\n${visibleText.slice(0, Math.min(MAX_VISIBLE_TEXT_CHARS, remaining))}`);
  }

  remaining = MAX_PAGE_SNAPSHOT_CHARS - parts.join("\n\n").length;
  if (html.length > 0 && remaining > 128) parts.push(`[html]\n${html.slice(0, remaining)}`);

  const out = parts.join("\n\n").slice(0, MAX_PAGE_SNAPSHOT_CHARS);
  return out.length > 0 ? out : undefined;
}

function cleanSnapshotText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
