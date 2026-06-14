import { createHash } from "node:crypto";

import type {
  ArtifactRef,
  PlainSecret,
  RedactedString,
  SecretRef,
  SecretStore,
} from "../ts/core-types";
import type { ErrorCode } from "../ts/error-catalog";
import {
  MINIMUM_BYPASS_RLS_POLICY,
  type ArtifactAccessDecision,
  type ArtifactAccessGate,
  type ArtifactAccessSubject,
  type AuthenticatedPrincipal,
  type AuthorizationCheck,
  type AuthorizationDecision,
  type BypassRlsUseCase,
  type ConnectorManifestPermissionCheck,
  type ConnectorManifestPermissionDecision,
  type ConnectorManifestPermissionChecker,
  type ConnectorManifestPermissions,
  type DomainAllowlistMiddleware,
  type ImmutableAuditLogAppendInput,
  type ImmutableAuditLogAppendOnly,
  type ImmutableAuditLogRecord,
  type NetworkPolicyCheck,
  type NetworkPolicyDecision,
  type PlainSecretSerializationBoundary,
  type PromptInjectionDecision,
  type PromptInjectionDetector,
  type PromptInjectionEvidence,
  type PromptInjectionSignal,
  type RbacAction,
  type RbacMiddleware,
  type Role,
} from "../ts/security-middleware-contract";

export { MINIMUM_BYPASS_RLS_POLICY };

type AuthorizationDenyCode = Extract<AuthorizationDecision, { kind: "deny" }>["code"];

type SecurityScaffoldErrorCode = Extract<
  ErrorCode,
  | "AUTHZ_FORBIDDEN"
  | "SECRET_ACCESS_DENIED"
  | "CONNECTOR_PERMISSION_DENIED"
  | "ARTIFACT_NOT_REDACTED"
  | "DOMAIN_POLICY_VIOLATION"
  | "PROMPT_INJECTION_DETECTED"
>;

export class SecurityContractError extends Error {
  constructor(
    readonly code: SecurityScaffoldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecurityContractError";
  }
}

const trackedPlainSecrets = new Set<string>();

export function asSecretRef(value: string): SecretRef {
  return value as SecretRef;
}

export function asRedactedString(value: string): RedactedString {
  return value as RedactedString;
}

export function markPlainSecretFromStore(value: string): PlainSecret {
  if (value.length === 0) {
    throw new SecurityContractError("SECRET_ACCESS_DENIED", "SecretStore returned an empty secret");
  }
  trackedPlainSecrets.add(value);
  return value as PlainSecret;
}

export class FakeSecretStore implements SecretStore {
  private readonly values: ReadonlyMap<string, string>;

  constructor(seed: Readonly<Record<string, string>>) {
    this.values = new Map(Object.entries(seed));
  }

  async resolve(ref: SecretRef): Promise<PlainSecret> {
    const value = this.values.get(ref);
    if (value === undefined) {
      throw new SecurityContractError("SECRET_ACCESS_DENIED", "SecretRef is outside the fake store scope");
    }
    return markPlainSecretFromStore(value);
  }
}

export class PlainSecretSerializationError extends SecurityContractError {
  constructor(path: string) {
    super("SECRET_ACCESS_DENIED", `PlainSecret reached serialization boundary at ${path}`);
    this.name = "PlainSecretSerializationError";
  }
}

export function redactPlainSecret(_secret: PlainSecret): RedactedString {
  return "[REDACTED:PlainSecret]" as RedactedString;
}

export function safeSerialize(value: unknown): string {
  assertNoTrackedPlainSecret(value, "$", new WeakSet<object>());
  return JSON.stringify(value) ?? "null";
}

export const plainSecretSerializationBoundary: PlainSecretSerializationBoundary = {
  safeSerialize,
  redactPlainSecret,
};

function assertNoTrackedPlainSecret(value: unknown, path: string, seen: WeakSet<object>): void {
  if (typeof value === "string") {
    if (trackedPlainSecrets.has(value)) throw new PlainSecretSerializationError(path);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoTrackedPlainSecret(item, `${path}[${index}]`, seen));
    return;
  }

  for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    assertNoTrackedPlainSecret(child, `${path}.${key}`, seen);
  }
}

export function redactSensitiveText(value: string): RedactedString {
  return value
    .replace(/\b(authorization)\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]+/gi, "$1: Bearer [REDACTED]")
    .replace(/\b(password|passwd|secret|token|otp|api[-_ ]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[CARD_OR_ACCOUNT]")
    .replace(/\b\d{2,3}-\d{3,4}-\d{4}\b/g, "[PHONE]") as RedactedString;
}

export function redactArtifactPayload(value: unknown): RedactedString {
  return redactSensitiveText(safeSerialize(value));
}

const RBAC_ALLOWED_ROLES = {
  "run.read": ["viewer", "operator", "reviewer", "approver", "admin"],
  "run.create": ["operator", "reviewer", "approver", "admin"],
  "run.abort": ["operator", "reviewer", "approver", "admin"],
  "workitem.read": ["viewer", "operator", "reviewer", "approver", "admin"],
  "human_task.read": ["viewer", "operator", "reviewer", "approver", "admin"],
  "human_task.assign": ["operator", "reviewer", "approver", "admin"],
  "human_task.escalate": ["reviewer", "approver", "admin"],
  "human_task.start": ["operator", "reviewer", "approver", "admin"],
  "human_task.resolve.validation": ["reviewer", "approver", "admin"],
  "human_task.resolve.exception": ["reviewer", "approver", "admin"],
  "human_task.resolve.captcha": ["reviewer", "approver", "admin"],
  "human_task.resolve.mfa": ["reviewer", "approver", "admin"],
  "human_task.resolve.approval": ["approver", "admin"],
  "node_policy.approve": ["approver", "admin"],
  "dlq.replay": ["operator", "reviewer", "approver", "admin"],
  "sink_dlq.replay": ["operator", "reviewer", "approver", "admin"],
  "scenario.read": ["viewer", "operator", "reviewer", "approver", "admin"],
  "scenario.create": ["operator", "reviewer", "approver", "admin"],
  "scenario.update": ["operator", "reviewer", "approver", "admin"],
  "scenario.promote": ["admin"],
  "artifact.read": ["viewer", "operator", "reviewer", "approver", "admin"],
  "site.approve": ["approver", "admin"],
  "secret.resolve": ["admin"],
  "connector.enable": ["admin"],
  "gateway_policy.edit": ["admin"],
  "network_policy.edit": ["admin"],
  "rbac.grant": ["admin"],
} as const satisfies Record<RbacAction, readonly Role[]>;

export function authorizeRbac(
  principal: AuthenticatedPrincipal,
  check: AuthorizationCheck,
): AuthorizationDecision {
  if (principal.tenantId !== check.tenantId) {
    return denyAuthorization(check.action, "AUTHZ_FORBIDDEN", "principal tenant does not match resource tenant");
  }

  const allowedRoles: readonly Role[] = RBAC_ALLOWED_ROLES[check.action];
  if (!principal.roles.some((role) => allowedRoles.includes(role))) {
    return denyAuthorization(check.action, denyCodeForAction(check.action), "role is not explicitly allowed");
  }

  if (check.humanTask?.assigneeRole !== undefined && !principal.roles.includes(check.humanTask.assigneeRole)) {
    return denyAuthorization(check.action, "AUTHZ_FORBIDDEN", "human task assignee_role does not match principal roles");
  }

  if (check.humanTask?.assigneeId !== undefined && check.humanTask.assigneeId !== principal.subjectId) {
    return denyAuthorization(check.action, "AUTHZ_FORBIDDEN", "human task assignee does not match principal");
  }

  return { kind: "allow", principal, action: check.action };
}

export const deterministicRbacMiddleware: RbacMiddleware = {
  authorize: async (principal, check) => authorizeRbac(principal, check),
};

function denyAuthorization(
  action: RbacAction,
  code: AuthorizationDenyCode,
  reason: string,
): AuthorizationDecision {
  return { kind: "deny", action, code, reason };
}

function denyCodeForAction(action: RbacAction): SecurityScaffoldErrorCode {
  if (action === "connector.enable") return "CONNECTOR_PERMISSION_DENIED";
  if (action === "artifact.read" || action === "secret.resolve") return "SECRET_ACCESS_DENIED";
  return "AUTHZ_FORBIDDEN";
}

export class ContractArtifactAccessGate implements ArtifactAccessGate {
  constructor(private readonly rbac: RbacMiddleware = deterministicRbacMiddleware) {}

  async check(
    principal: AuthenticatedPrincipal,
    artifact: ArtifactAccessSubject,
  ): Promise<ArtifactAccessDecision> {
    if (
      artifact.deletedAt !== undefined ||
      (artifact.redactionStatus !== "redacted" && artifact.redactionStatus !== "not_required")
    ) {
      return {
        kind: "deny",
        stage: "redaction",
        code: "ARTIFACT_NOT_REDACTED",
        reason: "artifact is not queryable until redaction is complete",
      };
    }

    const decision = await this.rbac.authorize(principal, {
      action: "artifact.read",
      tenantId: artifact.tenantId,
      resource: { kind: "artifact", id: artifact.artifactId },
    });
    if (decision.kind === "deny") {
      return {
        kind: "deny",
        stage: "rbac",
        code: "SECRET_ACCESS_DENIED",
        reason: decision.reason,
      };
    }

    return { kind: "allow", artifactRef: `artifact:${artifact.artifactId}` as ArtifactRef };
  }
}

export function matchAllowedDomain(url: string, allowedDomains: readonly string[]): string | undefined {
  const host = hostnameFromUrl(url);
  if (host === undefined) return undefined;

  for (const pattern of allowedDomains) {
    const normalized = normalizeDomainPattern(pattern);
    if (normalized === undefined) continue;
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(2);
      if (host !== suffix && host.endsWith(`.${suffix}`)) return pattern;
      continue;
    }
    if (host === normalized) return pattern;
  }
  return undefined;
}

export function evaluateNetworkPolicy(check: NetworkPolicyCheck): NetworkPolicyDecision {
  const matchedDomain = matchAllowedDomain(check.url, check.policy.allowedDomains);
  if (matchedDomain !== undefined) return { kind: "allow", matchedDomain };
  return {
    kind: "deny",
    code: "DOMAIN_POLICY_VIOLATION",
    reason: check.policy.blockOnViolation
      ? `URL is outside policy ${check.policy.id}`
      : `URL is outside policy ${check.policy.id}; monitor-only mode is not contracted for Product Open`,
  };
}

export const domainAllowlistMiddleware: DomainAllowlistMiddleware = {
  evaluate: evaluateNetworkPolicy,
};

function hostnameFromUrl(url: string): string | undefined {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function normalizeDomainPattern(pattern: string): string | undefined {
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("://")) return hostnameFromUrl(trimmed);
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

const CONNECTOR_API_WHITELIST = ["migrateSchema", "registerTargets", "readConfig"] as const;

export function checkConnectorManifestPermissions(
  input: ConnectorManifestPermissionCheck,
): ConnectorManifestPermissionDecision {
  const reasons: string[] = [];
  if (!input.signatureVerified) reasons.push("manifest signature is not verified");

  const seenApi = new Set<string>();
  for (const permission of input.manifest.api as readonly string[]) {
    if (!CONNECTOR_API_WHITELIST.includes(permission as (typeof CONNECTOR_API_WHITELIST)[number])) {
      reasons.push(`api permission is outside whitelist: ${permission}`);
    }
    if (seenApi.has(permission)) reasons.push(`api permission is duplicated: ${permission}`);
    seenApi.add(permission);
  }

  if (input.manifest.network !== false) reasons.push("network permission must be false in v1");
  for (const ref of input.manifest.secret_refs) {
    if (ref.trim().length === 0) reasons.push("secret_refs must not contain empty namespaces");
  }

  if (reasons.length > 0) {
    return { kind: "deny", code: "CONNECTOR_PERMISSION_DENIED", reasons };
  }
  return { kind: "allow", permissions: input.manifest };
}

export const connectorManifestPermissionChecker: ConnectorManifestPermissionChecker = {
  check: checkConnectorManifestPermissions,
};

export type PromptTextVisibility = "visible" | "hidden" | "offscreen" | "zero_opacity";

export interface PromptInspectionTextRun {
  text: RedactedString;
  visibility: PromptTextVisibility;
  source: PromptInjectionEvidence["source"];
}

export interface DeterministicPromptInspectionInput {
  redactedText: RedactedString;
  textRuns?: readonly PromptInspectionTextRun[];
  networkPolicy?: NetworkPolicyCheck["policy"];
}

const INSTRUCTION_OVERRIDE_RE =
  /\b(ignore (all )?(previous|prior|above)|system prompt|developer message|you are now|너는 이제|이전 지시|무시하라)\b/i;
const CREDENTIAL_EXFIL_RE =
  /\b(password|passwd|secret|token|api[-_ ]?key|otp|authorization|credential|자격증명|비밀번호|토큰|시크릿)\b/i;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export function inspectPromptInjection(input: DeterministicPromptInspectionInput): PromptInjectionDecision {
  const evidence: PromptInjectionEvidence[] = [];
  const runs = input.textRuns ?? [{ text: input.redactedText, visibility: "visible", source: "dom" as const }];

  for (const run of runs) {
    const text = run.text.toString();
    const hidden = run.visibility !== "visible";
    if (hidden && (INSTRUCTION_OVERRIDE_RE.test(text) || CREDENTIAL_EXFIL_RE.test(text))) {
      evidence.push(makeEvidence("hidden_instruction", text, run.source));
    }
    if (INSTRUCTION_OVERRIDE_RE.test(text)) {
      evidence.push(makeEvidence("instruction_override", text, run.source));
    }
    if (CREDENTIAL_EXFIL_RE.test(text)) {
      evidence.push(makeEvidence("credential_exfiltration", text, run.source));
    }
  }

  if (input.networkPolicy !== undefined) {
    for (const url of urlsIn(input.redactedText.toString())) {
      const decision = evaluateNetworkPolicy({
        tenantId: input.networkPolicy.tenantId,
        policy: input.networkPolicy,
        requestKind: "browser_navigation",
        url,
      });
      if (decision.kind === "deny") {
        evidence.push(makeEvidence("off_allowlist_url", url, "dom"));
      }
    }
  }

  if (evidence.length === 0) return { kind: "clean" };
  return { kind: "blocked", code: "PROMPT_INJECTION_DETECTED", evidence: dedupeEvidence(evidence) };
}

export const deterministicPromptInjectionDetector: PromptInjectionDetector = {
  inspect: (input) => inspectPromptInjection({ redactedText: input.redactedText, networkPolicy: input.networkPolicy }),
};

function makeEvidence(
  signal: PromptInjectionSignal,
  text: string,
  source: PromptInjectionEvidence["source"],
): PromptInjectionEvidence {
  return { signal, excerpt: redactSensitiveText(text.slice(0, 200)), source };
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((match) => match[0].replace(/[),.;]+$/, ""));
}

function dedupeEvidence(evidence: readonly PromptInjectionEvidence[]): readonly PromptInjectionEvidence[] {
  const seen = new Set<string>();
  const deduped: PromptInjectionEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.signal}:${item.source}:${item.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

export class InMemoryImmutableAuditLog implements ImmutableAuditLogAppendOnly {
  private records: ImmutableAuditLogRecord[] = [];

  async append(input: ImmutableAuditLogAppendInput): Promise<ImmutableAuditLogRecord> {
    safeSerialize(input.payload ?? null);
    const previousHash = this.records.at(-1)?.hash ?? "GENESIS";
    const canonical = canonicalize({ ...input, previousHash });
    const hash = createHash("sha256").update(canonical).digest("hex");
    const record: ImmutableAuditLogRecord = {
      ...input,
      sequence: this.records.length + 1,
      previousHash,
      hash,
    };
    this.records.push(record);
    return record;
  }

  snapshot(): readonly ImmutableAuditLogRecord[] {
    return [...this.records];
  }
}

function canonicalize(value: unknown): string {
  assertNoTrackedPlainSecret(value, "$", new WeakSet<object>());
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;

  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}

export type BypassRlsDecision =
  | { kind: "allow"; useCase: BypassRlsUseCase }
  | { kind: "deny"; code: Extract<ErrorCode, "AUTHZ_FORBIDDEN">; reasons: readonly string[] };

export interface BypassRlsUseCheck {
  useCase: BypassRlsUseCase;
  applicationRole: boolean;
  servesUserTraffic: boolean;
  reasonCode?: string;
  immutableAuditAppendConfigured: boolean;
}

export function checkBypassRlsUse(input: BypassRlsUseCheck): BypassRlsDecision {
  const reasons: string[] = [];
  if (input.applicationRole && !MINIMUM_BYPASS_RLS_POLICY.applicationRoleMayBypassRls) {
    reasons.push("application role may not BYPASSRLS");
  }
  if (input.servesUserTraffic && !MINIMUM_BYPASS_RLS_POLICY.bypassRoleMayServeUserTraffic) {
    reasons.push("BYPASSRLS role may not serve user traffic");
  }
  if (MINIMUM_BYPASS_RLS_POLICY.requiresReasonCode && input.reasonCode?.trim()) {
    // explicit reason supplied
  } else {
    reasons.push("reason code is required");
  }
  if (MINIMUM_BYPASS_RLS_POLICY.requiresImmutableAuditAppend && !input.immutableAuditAppendConfigured) {
    reasons.push("immutable audit append is required");
  }
  if (!MINIMUM_BYPASS_RLS_POLICY.allowedUseCases.includes(input.useCase)) {
    reasons.push(`use case is not in the minimum BYPASSRLS allowlist: ${input.useCase}`);
  }

  if (reasons.length > 0) return { kind: "deny", code: "AUTHZ_FORBIDDEN", reasons };
  return { kind: "allow", useCase: input.useCase };
}

export function connectorManifest(
  permissions: ConnectorManifestPermissions,
): ConnectorManifestPermissions {
  return permissions;
}
