export interface ExtractResultPage {
  readonly nodeId: string;
  readonly stepId: string;
  readonly output: unknown;
  readonly artifactRef?: string;
}

export interface ExtractMergeOptions {
  readonly naturalKeys?: readonly string[];
}

export interface MergedExtractResult {
  readonly records: readonly unknown[];
  readonly pageCount: number;
  readonly inputCount: number;
  readonly duplicateCount: number;
  readonly naturalKeys: readonly string[];
}

const DEFAULT_NATURAL_KEYS = [
  "BBSCTT_ID",
  "bbscttId",
  "noticeId",
  "SEQ",
  "seq",
  "id",
  "ID",
  "no",
  "NO",
] as const;

const ARRAY_CONTAINER_KEYS = [
  "records",
  "rows",
  "items",
  "data",
  "list",
  "results",
  "result",
  "grid",
] as const;

export function recordsFromExtractOutput(output: unknown): readonly unknown[] {
  return findRecordArray(output, 0) ?? [];
}

export function mergeExtractOutputs(
  outputs: readonly unknown[],
  options: ExtractMergeOptions = {},
): MergedExtractResult {
  const naturalKeys = [...(options.naturalKeys ?? DEFAULT_NATURAL_KEYS)];
  const records: unknown[] = [];
  const seen = new Set<string>();
  let inputCount = 0;
  let duplicateCount = 0;

  for (const output of outputs) {
    for (const record of recordsFromExtractOutput(output)) {
      inputCount += 1;
      const key = dedupeKey(record, naturalKeys);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      records.push(record);
    }
  }

  return {
    records,
    pageCount: outputs.length,
    inputCount,
    duplicateCount,
    naturalKeys,
  };
}

function findRecordArray(value: unknown, depth: number): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value) || depth > 3) return undefined;

  for (const key of ARRAY_CONTAINER_KEYS) {
    const child = value[key];
    if (Array.isArray(child)) return child;
    if (isRecord(child)) {
      const found = findRecordArray(child, depth + 1);
      if (found !== undefined) return found;
    }
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) return child;
  }
  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      const found = findRecordArray(child, depth + 1);
      if (found !== undefined) return found;
    }
  }

  return Object.keys(value).length > 0 ? [value] : [];
}

function dedupeKey(record: unknown, naturalKeys: readonly string[]): string {
  if (isRecord(record)) {
    for (const naturalKey of naturalKeys) {
      const value = record[naturalKey];
      if (isNaturalKeyValue(value)) return `${naturalKey}:${String(value)}`;
    }
  }
  return `json:${stableStringify(record)}`;
}

function isNaturalKeyValue(value: unknown): value is string | number | boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(normalizeForStableStringify(value, seen));
}

function normalizeForStableStringify(value: unknown, seen: WeakSet<object>): unknown {
  if (!isRecord(value)) {
    if (Array.isArray(value)) return value.map((item) => normalizeForStableStringify(item, seen));
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeForStableStringify(value[key], seen);
  }
  return normalized;
}
