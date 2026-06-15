const MAX_EVIDENCE_CELL_CHARS = 500;

const CODEX_BASE_URL_ERROR = "CODEX_BASE_URL must be an absolute https URL without credentials, query, or fragment";
const EVIDENCE_ALIAS_PATTERN = /^\[[A-Za-z0-9][A-Za-z0-9._-]*\]$/;

export interface EvidenceRedactionRule {
  value: string;
  replacement: string;
}

export interface CodexEvidenceRedactionInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointAlias: string;
  modelAlias: string;
}

export function validateCodexBaseUrl(value: string): string {
  const input = value.trim();
  if (!/^https:\/\//i.test(input)) {
    throw new Error(CODEX_BASE_URL_ERROR);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(CODEX_BASE_URL_ERROR);
  }
  if (url.protocol !== "https:" || url.hostname === "" || url.origin === "null") {
    throw new Error(CODEX_BASE_URL_ERROR);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("CODEX_BASE_URL must not include username/password material");
  }
  if (url.search !== "" || url.hash !== "" || input.includes("?") || input.includes("#")) {
    throw new Error("CODEX_BASE_URL must not include query or fragment parameters");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function validateEvidenceAlias(name: string, value: string): string {
  const input = value.trim();
  if (
    input === "" ||
    input.length > 120 ||
    !EVIDENCE_ALIAS_PATTERN.test(input) ||
    /[:/?#@\\\s]/.test(input) ||
    /(bearer|sk-|api[-_ ]?key|token|secret|password)/i.test(input)
  ) {
    throw new Error(`${name} must be a redacted alias, not a URL, credential, or raw identifier`);
  }
  return input;
}

export function validatePositiveIntegerEnv(name: string, value: string | undefined, fallback: number): number {
  if (!Number.isSafeInteger(fallback) || fallback <= 0) {
    throw new Error(`${name} fallback must be a positive safe integer`);
  }
  const input = value?.trim();
  if (input === undefined || input === "") return fallback;
  if (!/^[1-9]\d*$/.test(input)) {
    throw new Error(`${name} must be a positive integer when provided`);
  }
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function buildCodexEvidenceRedactions(input: CodexEvidenceRedactionInput): EvidenceRedactionRule[] {
  const url = new URL(input.baseUrl);
  return dedupeRules([
    { value: input.baseUrl, replacement: input.endpointAlias },
    { value: `${input.baseUrl}/`, replacement: `${input.endpointAlias}/` },
    { value: url.origin, replacement: input.endpointAlias },
    { value: url.host, replacement: input.endpointAlias },
    { value: url.hostname, replacement: input.endpointAlias },
    { value: input.model, replacement: input.modelAlias },
    { value: input.apiKey, replacement: "[REDACTED]" },
  ]);
}

export function redactEvidence(value: unknown, rules: readonly EvidenceRedactionRule[] = []): string {
  return applyEvidenceRedactions(String(value), rules)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\/\/([^/?#\s:@]+):([^/?#\s@]+)@/g, "//[REDACTED]@")
    .replace(/([?&][^=&#\s]*(?:api[-_]?key|token|secret|password)[^=&#\s]*=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(
      /(["']?)([A-Za-z0-9_-]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_-]*|authorization|api[-_ ]?key|token|secret|password)\1\s*[:=]\s*(["'])(?:\\.|(?!\3).)*\3/gi,
      "$1$2$1=[REDACTED]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(authorization|api[-_ ]?key|token|secret|password)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    );
}

export function errorEvidence(error: unknown, rules: readonly EvidenceRedactionRule[] = []): string {
  if (error instanceof Error) return evidenceCell(`${error.name}: ${error.message}`, rules);
  return evidenceCell(error, rules);
}

export function markdownCell(value: unknown, rules: readonly EvidenceRedactionRule[] = []): string {
  return evidenceCell(value, rules).replace(/\|/g, "\\|");
}

function evidenceCell(value: unknown, rules: readonly EvidenceRedactionRule[]): string {
  const normalized = redactEvidence(value, rules)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (normalized.length <= MAX_EVIDENCE_CELL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EVIDENCE_CELL_CHARS - 3)}...`;
}

function dedupeRules(rules: readonly EvidenceRedactionRule[]): EvidenceRedactionRule[] {
  const seen = new Set<string>();
  const out: EvidenceRedactionRule[] = [];
  for (const rule of rules) {
    const value = rule.value.trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, replacement: rule.replacement });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

function applyEvidenceRedactions(value: string, rules: readonly EvidenceRedactionRule[]): string {
  let redacted = value;
  for (const rule of rules) {
    redacted = redacted.split(rule.value).join(rule.replacement);
  }
  return redacted;
}
