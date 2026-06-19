import type {
  GatewayRedactionBoundary,
  NetworkPolicy,
  PromptInspectionTextRun,
  PromptInjectionDecision,
  PromptInjectionDetector,
  RedactedContentBlock,
  RedactedImageRef,
  RunId,
  TenantId,
} from "../ts/security-middleware-contract";
import type { RedactedString } from "../ts/core-types";
import { matchesInstructionOverride } from "../security/prompt-injection-patterns";

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

// §3(b) instruction-override 패턴은 single SSoT(security/prompt-injection-patterns.ts)에서 가져온다(RQ-031) —
// 자매 detector security/compliance-scaffold.ts 와 동일 사전을 참조해 §3(b) 비대칭 판정을 제거한다.

// §3(a) hidden-instruction: DOM visibility side-channel(textRuns)과 zero-width/invisible/format 문자 난독화를 모두
// Gateway redaction 단계에서 차단한다. textRuns는 adapter로 전달하지 않는 검사 메타이며, 모델 입력 포맷과 분리된다.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;

export class DeterministicPromptInjectionDetector implements PromptInjectionDetector {
  inspect(input: {
    tenantId: TenantId;
    runId?: RunId;
    redactedText: RedactedString;
    textRuns?: readonly PromptInspectionTextRun[];
    networkPolicy?: NetworkPolicy;
  }): PromptInjectionDecision {
    const rawText = String(input.redactedText);
    const text = rawText.toLowerCase();

    const hiddenEvidence = hiddenInstructionEvidence(input.textRuns ?? []);
    if (hiddenEvidence.length > 0) {
      return {
        kind: "blocked",
        code: "PROMPT_INJECTION_DETECTED",
        evidence: hiddenEvidence,
      };
    }

    // §3(a): invisible/zero-width 문자가 명령·자격증명 요청을 가리거나 난독화 → hidden_instruction(보수적 차단).
    //   제거해 드러나는 지시를 판정(가시 텍스트 분기보다 먼저 — "조용한 false 금지").
    const deobfuscated = text.replace(INVISIBLE_CHARS, "");
    if (deobfuscated.length !== text.length && hasHiddenInstructionSignal(text)) {
      return {
        kind: "blocked",
        code: "PROMPT_INJECTION_DETECTED",
        evidence: [{
          signal: "hidden_instruction",
          excerpt: "[redacted hidden instruction]" as RedactedString,
          source: "dom",
        }],
      };
    }

    if (matchesInstructionOverride(text)) {
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

function hiddenInstructionEvidence(textRuns: readonly PromptInspectionTextRun[]): Array<{
  signal: "hidden_instruction";
  excerpt: RedactedString;
  source: PromptInspectionTextRun["source"];
}> {
  for (const run of textRuns) {
    if (run.visibility === "visible") continue;
    if (hasHiddenInstructionSignal(String(run.text))) {
      return [{
        signal: "hidden_instruction",
        excerpt: "[redacted hidden instruction]" as RedactedString,
        source: run.source,
      }];
    }
  }
  return [];
}

function hasHiddenInstructionSignal(value: string): boolean {
  const deobfuscated = value.toLowerCase().replace(INVISIBLE_CHARS, "");
  return matchesInstructionOverride(deobfuscated) || CREDENTIAL_EXFILTRATION_PATTERNS.some((pattern) => pattern.test(deobfuscated));
}

export class DeterministicGatewayRedactionBoundary implements GatewayRedactionBoundary {
  constructor(private readonly detector: PromptInjectionDetector = new DeterministicPromptInjectionDetector()) {}

  async redactForGateway(input: {
    tenantId: TenantId;
    runId?: RunId;
    rawTextOrObject: unknown;
    textRuns?: readonly PromptInspectionTextRun[];
    images?: readonly RedactedImageRef[];
    networkPolicy?: NetworkPolicy;
  }): ReturnType<GatewayRedactionBoundary["redactForGateway"]> {
    const rawText = stableStringify(input.rawTextOrObject);
    const decision = this.detector.inspect({
      tenantId: input.tenantId,
      runId: input.runId,
      redactedText: rawText as RedactedString,
      textRuns: input.textRuns,
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
