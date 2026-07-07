// 자동화 정의(ir.schema) 원문 헬퍼 — 출발 템플릿, 버전 bump, studio_mode(에디터 모드) 왕복.

export type EditorMode = "easy" | "form" | "visual" | "ir";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 권위 있는 유효 IR(app/test/scenarios.int.ts validIr 기준). 새 자동화 작성의 출발 템플릿.
export function template(name: string, version: number): string {
  return JSON.stringify(
    {
      meta: { name, version, studio_mode: "ir" },
      start: "n1",
      nodes: {
        n1: {
          what: [{ action: "observe" }],
          next: "n2",
        },
        n2: {
          what: [
            {
              action: "extract",
              instruction: "현재 페이지에서 extracted_rows 데이터를 추출하라.",
              schema_ref: "extracted_rows",
            },
          ],
          terminal: "success",
        },
      },
    },
    null,
    2,
  );
}

// 직전 IR을 새 버전 번호로 bump해 편집 출발점으로 사용(meta.version=현재+1, PUT 규칙).
export function bumpVersion(ir: unknown, version: number): string {
  if (isRecord(ir)) {
    const meta = isRecord(ir.meta) ? ir.meta : {};
    return JSON.stringify({ ...ir, meta: { ...meta, version } }, null, 2);
  }
  return JSON.stringify(ir, null, 2);
}

export function studioModeFromIr(ir: unknown): EditorMode {
  if (!isRecord(ir) || !isRecord(ir.meta)) return "ir";
  return ir.meta.studio_mode === "easy" ||
    ir.meta.studio_mode === "form" ||
    ir.meta.studio_mode === "visual" ||
    ir.meta.studio_mode === "ir"
    ? ir.meta.studio_mode
    : "ir";
}

export function withStudioMode(ir: unknown, studioMode: EditorMode): unknown {
  if (!isRecord(ir)) return ir;
  const meta = isRecord(ir.meta) ? ir.meta : {};
  return { ...ir, meta: { ...meta, studio_mode: studioMode } };
}
