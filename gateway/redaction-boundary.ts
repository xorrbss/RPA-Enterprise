import type {
  GatewayRedactionBoundary,
  NetworkPolicy,
  PromptInjectionDecision,
  PromptInjectionDetector,
  RedactedContentBlock,
  RedactedImageRef,
  RunId,
  TenantId,
} from "../ts/security-middleware-contract";
import type { RedactedString } from "../ts/core-types";

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(password|passwd|secret|token|authorization|otp|api[-_ ]?key)\s*[:=]\s*["']?[^\s,;]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b\d{2,3}-\d{3,4}-\d{4}\b/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

const CREDENTIAL_EXFILTRATION_PATTERNS: readonly RegExp[] = [
  /\bexfiltrat(?:e|ion)\b/i,
  /\bsend\s+(?:the\s+)?(?:credential|credentials|secret|secrets|token|tokens|password|passwords|otp|api[-_ ]?key|authorization)\b/i,
  /\b(?:credential|credentials|secret|secrets|token|tokens|password|passwords|otp|api[-_ ]?key|authorization)\s+(?:to|into)\s+https?:\/\//i,
];

export class DeterministicPromptInjectionDetector implements PromptInjectionDetector {
  inspect(input: {
    tenantId: TenantId;
    runId?: RunId;
    redactedText: RedactedString;
    networkPolicy?: NetworkPolicy;
  }): PromptInjectionDecision {
    const text = String(input.redactedText).toLowerCase();

    if (text.includes("ignore previous") || text.includes("ignore system") || text.includes("system prompt")) {
      return {
        kind: "blocked",
        code: "PROMPT_INJECTION_DETECTED",
        evidence: [{
          signal: "instruction_override",
          excerpt: "[redacted prompt-injection instruction]" as RedactedString,
          source: "dom",
        }],
      };
    }

    if (CREDENTIAL_EXFILTRATION_PATTERNS.some((pattern) => pattern.test(text))) {
      return {
        kind: "blocked",
        code: "PROMPT_INJECTION_DETECTED",
        evidence: [{
          signal: "credential_exfiltration",
          excerpt: "[redacted credential exfiltration request]" as RedactedString,
          source: "dom",
        }],
      };
    }

    if (input.networkPolicy !== undefined) {
      for (const domain of extractDomains(text)) {
        if (!matchesAllowedDomain(domain, input.networkPolicy.allowedDomains)) {
          return {
            kind: "blocked",
            code: "PROMPT_INJECTION_DETECTED",
            evidence: [{
              signal: "off_allowlist_url",
              excerpt: "[redacted off-allowlist url]" as RedactedString,
              source: "dom",
            }],
          };
        }
      }
    }

    return { kind: "clean" };
  }
}

export class DeterministicGatewayRedactionBoundary implements GatewayRedactionBoundary {
  constructor(private readonly detector: PromptInjectionDetector = new DeterministicPromptInjectionDetector()) {}

  async redactForGateway(input: {
    tenantId: TenantId;
    runId?: RunId;
    rawTextOrObject: unknown;
    images?: readonly RedactedImageRef[];
    networkPolicy?: NetworkPolicy;
  }): ReturnType<GatewayRedactionBoundary["redactForGateway"]> {
    const rawText = stableStringify(input.rawTextOrObject);
    const decision = this.detector.inspect({
      tenantId: input.tenantId,
      runId: input.runId,
      redactedText: rawText as RedactedString,
      networkPolicy: input.networkPolicy,
    });

    if (decision.kind === "blocked") {
      return { kind: "blocked", code: decision.code, evidence: decision.evidence };
    }

    const redacted = redactText(rawText);
    const content: RedactedContentBlock[] = [{ type: "text", content: redacted }];
    return {
      kind: "redacted",
      content,
      images: input.images,
    };
  }
}

export function redactText(text: string): RedactedString {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted as RedactedString;
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function extractDomains(text: string): string[] {
  const domains: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s")]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const hostname = normalizeHostname(new URL(url).hostname);
      if (hostname !== undefined) domains.push(hostname);
    } catch {
      domains.push(url);
    }
  }
  return domains;
}

function matchesAllowedDomain(domain: string, allowedDomains: readonly string[]): boolean {
  const normalizedDomain = normalizeHostname(domain);
  if (normalizedDomain === undefined) return false;

  return allowedDomains.some((allowed) => {
    const normalizedAllowed = normalizeAllowedDomain(allowed);
    if (normalizedAllowed === undefined) return false;
    if (normalizedAllowed.startsWith("*.")) {
      const suffix = normalizedAllowed.slice(2);
      return normalizedDomain !== suffix && normalizedDomain.endsWith(`.${suffix}`);
    }
    return normalizedDomain === normalizedAllowed;
  });
}

function normalizeAllowedDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("*.")) {
    const suffix = normalizeHostname(trimmed.slice(2));
    return suffix === undefined ? undefined : `*.${suffix}`;
  }
  return normalizeHostname(trimmed);
}

function normalizeHostname(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0 || normalized.includes("/") || normalized.includes(":")) return undefined;
  return normalized;
}
