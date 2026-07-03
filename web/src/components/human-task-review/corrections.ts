export type CorrectionRow = { readonly id: string; key: string; value: string };

function parseCorrectionValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function buildCorrections(rows: readonly CorrectionRow[]): Record<string, unknown> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), parseCorrectionValue(row.value)] as const)
    .filter(([key]) => key !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function correctionValueForInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function correctionRowsFromResult(corrections: Record<string, unknown> | undefined): CorrectionRow[] {
  if (corrections === undefined || Object.keys(corrections).length === 0) {
    return [{ id: crypto.randomUUID(), key: "", value: "" }];
  }
  return Object.entries(corrections).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value: correctionValueForInput(value),
  }));
}

export function manualCorrectionsError(rows: readonly CorrectionRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    if (seen.has(key)) return `중복된 수정 항목입니다: ${key}`;
    seen.add(key);
  }
  return null;
}
