/**
 * 자연어 generation start_url 추출 · http(s) URL/host 유틸 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * 순수 leaf 군집(외부 의존 0, node URL만): extractFirstHttpUrl(프롬프트 산문에서 첫 http URL 추출 + 산문
 * 접미부·짝 없는 닫음 구두점 트리밍), isHttpUrl/hostOfHttpUrl(http(s) 검증·host 추출), isHostAllowed
 * (network_policy allowed_domains 매칭, `*.` 와일드카드 지원). 클러스터 내부 전용 헬퍼는 비-export.
 */

export function extractFirstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  const candidate = match?.[0];
  if (candidate === undefined) return undefined;
  const trimmed = trimUrlProseSuffix(candidate);
  return isHttpUrl(trimmed) ? trimmed : undefined;
}

const URL_TRAILING_PROSE_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "。",
  "．",
  "，",
  "、",
  "；",
  "：",
  "！",
  "？",
  "…",
]);

const URL_TRAILING_CLOSERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  ["）", "（"],
  ["】", "【"],
  ["」", "「"],
  ["』", "『"],
  ["》", "《"],
  ["〉", "〈"],
  ["”", "“"],
  ["’", "‘"],
]);

function trimUrlProseSuffix(value: string): string {
  let trimmed = value;
  while (trimmed.length > 0) {
    const char = lastChar(trimmed);
    if (char === undefined) break;
    if (URL_TRAILING_PROSE_PUNCTUATION.has(char)) {
      trimmed = trimLastChar(trimmed, char);
      continue;
    }
    const opener = URL_TRAILING_CLOSERS.get(char);
    if (opener !== undefined && hasUnmatchedClosingDelimiter(trimmed, opener, char)) {
      trimmed = trimLastChar(trimmed, char);
      continue;
    }
    break;
  }
  return trimmed;
}

function hasUnmatchedClosingDelimiter(value: string, opener: string, closer: string): boolean {
  let opens = 0;
  let closes = 0;
  for (const char of value) {
    if (char === opener) opens += 1;
    if (char === closer) closes += 1;
  }
  return closes > opens;
}

function lastChar(value: string): string | undefined {
  const chars = Array.from(value);
  return chars[chars.length - 1];
}

function trimLastChar(value: string, char: string): string {
  return value.slice(0, value.length - char.length);
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostOfHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isHostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const normalizedHost = host.toLowerCase();
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase();
    if (domain.length === 0) return false;
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(2);
      return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === domain;
  });
}
