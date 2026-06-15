const MAX_EVIDENCE_CELL_CHARS = 500;

const CODEX_BASE_URL_ERROR = "CODEX_BASE_URL must be an absolute https URL without credentials, query, or fragment";
const EVIDENCE_ALIAS_PATTERN = /^\[[A-Za-z0-9][A-Za-z0-9._-]*\]$/;

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

export function redactEvidence(value: unknown): string {
  return String(value)
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

export function errorEvidence(error: unknown): string {
  if (error instanceof Error) return evidenceCell(`${error.name}: ${error.message}`);
  return evidenceCell(error);
}

export function markdownCell(value: unknown): string {
  return evidenceCell(value).replace(/\|/g, "\\|");
}

function evidenceCell(value: unknown): string {
  const normalized = redactEvidence(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (normalized.length <= MAX_EVIDENCE_CELL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EVIDENCE_CELL_CHARS - 3)}...`;
}
