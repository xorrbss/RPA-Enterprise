// 시나리오 IR에서 실행에 필요한 파라미터 키를 도출한다.
// navigate.url_ref 는 run params 의 키(런타임 v2.11) — 실행 전 운영자가 그 값(URL)을 공급해야 한다.
// 목록(ScenarioItem)엔 IR이 없으므로 실행 시 getScenario(detail.ir)로 받아 추출한다.

// url_ref 키(navigate 대상의 심볼릭 키) → 운영자용 한국어 라벨. 시드/위저드가 쓰는 알려진 키만 매핑하고,
// 미매핑 키는 원본 그대로 폴백(조용한 공백 금지) — raw "entry_url" 직노출 대신 의미를 보여준다.
const URL_REF_LABELS: Record<string, string> = {
  entry_url: "접속 주소 (시작 URL)",
  orders_url: "주문 페이지 주소",
  login_url: "로그인 페이지 주소",
};
export function urlRefLabel(key: string): string {
  return URL_REF_LABELS[key] ?? key;
}

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

// ir.params_schema.properties[key].default 를 키→기본값(string) 맵으로 반환한다.
// '쉬운 만들기'가 입력 URL을 params 키의 default 로 실으므로, 실행 대화상자가 이 값으로 입력을 prefill한다.
// (url_ref 는 리터럴 URL이 아니라 키 — 런타임 site-resolution 계약. default 는 string 값만 채택.)
export function extractParamDefaults(ir: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const props = (ir as { params_schema?: { properties?: unknown } | null } | null)?.params_schema?.properties;
  if (props === null || typeof props !== "object") return out;
  for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
    const d = (def as { default?: unknown } | null)?.default;
    if (typeof d === "string" && d.length > 0) out[key] = d;
  }
  return out;
}
