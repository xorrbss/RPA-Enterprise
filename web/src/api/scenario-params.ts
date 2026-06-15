// 시나리오 IR에서 실행에 필요한 파라미터 키를 도출한다.
// navigate.url_ref 는 run params 의 키(런타임 v2.11) — 실행 전 운영자가 그 값(URL)을 공급해야 한다.
// 목록(ScenarioItem)엔 IR이 없으므로 실행 시 getScenario(detail.ir)로 받아 추출한다.

/** ir.nodes 의 모든 navigate.url_ref(=params 키)를 등장 순서로 중복 없이 반환. */
export function extractUrlRefKeys(ir: unknown): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const nodes = (ir as { nodes?: unknown } | null)?.nodes;
  if (nodes === null || typeof nodes !== "object") return keys;
  for (const node of Object.values(nodes as Record<string, unknown>)) {
    const what = (node as { what?: unknown } | null)?.what;
    if (!Array.isArray(what)) continue;
    for (const action of what) {
      if (action !== null && typeof action === "object" && (action as { action?: unknown }).action === "navigate") {
        const ref = (action as { url_ref?: unknown }).url_ref;
        if (typeof ref === "string" && ref.length > 0 && !seen.has(ref)) {
          seen.add(ref);
          keys.push(ref);
        }
      }
    }
  }
  return keys;
}
