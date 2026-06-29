import { randomUUID } from "node:crypto";

import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type DurableSecurityAuditDecisionWriter,
  type IdempotencyKey,
  type IsoDateTime,
  type PrincipalId,
  type Role,
  type TenantId,
  type NetworkRequestKind,
} from "../../../ts/security-middleware-contract";

export interface BrowserNetworkGuardPolicy {
  readonly tenantId: string;
  readonly runId?: string;
  readonly correlationId?: string;
  readonly networkPolicyId: string;
  readonly allowedDomains: readonly string[];
  readonly audit?: BrowserNetworkGuardAuditOptions;
}

export interface BrowserNetworkGuardAuditOptions {
  readonly writer: DurableSecurityAuditDecisionWriter;
  readonly actor: {
    readonly subjectId: string;
    readonly roles: readonly Role[];
  };
  readonly retentionDays?: number;
  readonly clock?: () => Date;
}

export interface BrowserNetworkGuardHandle {
  assertNoViolation(): void;
  dispose(): Promise<void>;
}

export interface BrowserNetworkGuardCdpSession {
  readonly id: string | null;
  send<T = unknown>(method: string, params?: object): Promise<T>;
  on<T = unknown>(event: string, handler: (params: T) => void): void;
  off<T = unknown>(event: string, handler: (params: T) => void): void;
}

export interface FetchRequestPausedEvent {
  readonly requestId?: unknown;
  readonly request?: { readonly url?: unknown };
  readonly resourceType?: unknown;
}

export interface WebSocketHandshakeEvent {
  readonly requestId?: unknown;
  readonly request?: { readonly url?: unknown };
}

export interface DownloadWillBeginEvent {
  readonly guid?: unknown;
  readonly url?: unknown;
  readonly suggestedFilename?: unknown;
}

export interface BrowserNetworkViolation {
  readonly kind: NetworkRequestKind;
  readonly url: string;
  readonly host: string;
  readonly resourceType?: string;
  readonly reason: string;
}

interface BrowserNetworkAllowDecision {
  readonly kind: NetworkRequestKind;
  readonly url: string;
  readonly host: string;
  readonly resourceType?: string;
}

interface TrackedSession {
  readonly session: BrowserNetworkGuardCdpSession;
  readonly detach: () => void;
}

interface StagehandPageWithCdp {
  mainSession?: BrowserNetworkGuardCdpSession;
  sessions?: Map<string, BrowserNetworkGuardCdpSession>;
  registerSessionForNetwork?: (session: BrowserNetworkGuardCdpSession) => void;
  unregisterSessionForNetwork?: (sessionId: string | undefined) => void;
}

const INTERNAL_PROTOCOLS = new Set(["about:", "data:", "devtools:", "chrome:", "chrome-error:", "chrome-extension:"]);

export class BrowserNetworkPolicyViolationError extends Error {
  readonly code = "DOMAIN_POLICY_VIOLATION" as const;

  constructor(readonly violation: BrowserNetworkViolation, readonly policy: BrowserNetworkGuardPolicy) {
    super(
      `${violation.kind} host '${violation.host}' is outside network policy '${policy.networkPolicyId}'`,
    );
    this.name = "BrowserNetworkPolicyViolationError";
  }
}

export class BrowserNetworkGuardInstallError extends Error {
  readonly code = "CDP_DISCONNECTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "BrowserNetworkGuardInstallError";
  }
}

export function createNoopBrowserNetworkGuard(): BrowserNetworkGuardHandle {
  return {
    assertNoViolation: () => undefined,
    dispose: async () => undefined,
  };
}

export function evaluateBrowserNetworkPolicy(
  url: string,
  allowedDomains: readonly string[],
): { kind: "allow"; host: string } | { kind: "deny"; host: string; reason: string } {
  const parsed = parsePotentiallyNestedUrl(url);
  if (parsed === null) return { kind: "deny", host: "invalid", reason: "invalid URL" };
  if (INTERNAL_PROTOCOLS.has(parsed.protocol)) return { kind: "allow", host: "internal" };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { kind: "deny", host: "invalid", reason: `unsupported scheme '${parsed.protocol}'` };
  }
  const host = parsed.hostname.toLowerCase();
  if (isHostAllowed(host, allowedDomains)) return { kind: "allow", host };
  return { kind: "deny", host, reason: "host not in allowed_domains" };
}

export async function installBrowserNetworkGuardForStagehandPage(
  page: unknown,
  policy: BrowserNetworkGuardPolicy,
): Promise<BrowserNetworkGuardHandle> {
  const stagehandPage = page as StagehandPageWithCdp;
  const sessions = currentStagehandSessions(stagehandPage);
  if (sessions.length === 0) {
    throw new BrowserNetworkGuardInstallError("browser network guard requires a CDP event session");
  }

  const guard = new CdpBrowserNetworkGuard(policy);
  for (const session of sessions) await guard.trackSession(session);

  const originalRegister = stagehandPage.registerSessionForNetwork;
  const originalUnregister = stagehandPage.unregisterSessionForNetwork;

  if (originalRegister !== undefined) {
    stagehandPage.registerSessionForNetwork = (session: BrowserNetworkGuardCdpSession): void => {
      originalRegister.call(stagehandPage, session);
      void guard.trackSession(session).catch((error) => guard.failClosed(error));
    };
  }

  if (originalUnregister !== undefined) {
    stagehandPage.unregisterSessionForNetwork = (sessionId: string | undefined): void => {
      originalUnregister.call(stagehandPage, sessionId);
      guard.untrackSession(sessionId);
    };
  }

  return {
    assertNoViolation: () => guard.assertNoViolation(),
    dispose: async () => {
      if (originalRegister !== undefined) stagehandPage.registerSessionForNetwork = originalRegister;
      if (originalUnregister !== undefined) stagehandPage.unregisterSessionForNetwork = originalUnregister;
      await guard.dispose();
    },
  };
}

class CdpBrowserNetworkGuard {
  private readonly tracked = new Map<string, TrackedSession>();
  private violation: BrowserNetworkViolation | undefined;

  constructor(private readonly policy: BrowserNetworkGuardPolicy) {}

  async trackSession(session: BrowserNetworkGuardCdpSession): Promise<void> {
    const key = sessionKey(session);
    if (this.tracked.has(key)) return;

    const onPaused = (event: FetchRequestPausedEvent): void => {
      void this.handleFetchPaused(session, event).catch((error) => this.failClosed(error));
    };
    const onWebSocket = (event: WebSocketHandshakeEvent): void => {
      void this.handleWebSocketHandshake(event).catch((error) => this.failClosed(error));
    };
    const onDownload = (event: DownloadWillBeginEvent): void => {
      void this.handleDownload(session, event).catch((error) => this.failClosed(error));
    };

    session.on("Fetch.requestPaused", onPaused);
    session.on("Network.webSocketWillSendHandshakeRequest", onWebSocket);
    session.on("Browser.downloadWillBegin", onDownload);
    try {
      await session.send("Network.enable");
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
        handleAuthRequests: false,
      });
    } catch (error) {
      session.off("Fetch.requestPaused", onPaused);
      session.off("Network.webSocketWillSendHandshakeRequest", onWebSocket);
      session.off("Browser.downloadWillBegin", onDownload);
      throw new BrowserNetworkGuardInstallError(unknownMessage(error));
    }

    this.tracked.set(key, {
      session,
      detach: () => {
        session.off("Fetch.requestPaused", onPaused);
        session.off("Network.webSocketWillSendHandshakeRequest", onWebSocket);
        session.off("Browser.downloadWillBegin", onDownload);
      },
    });
  }

  untrackSession(rawSessionId: string | undefined): void {
    const key = rawSessionId ?? "__main__";
    const tracked = this.tracked.get(key);
    if (tracked === undefined) return;
    tracked.detach();
    this.tracked.delete(key);
  }

  failClosed(error: unknown): void {
    if (this.violation !== undefined) return;
    this.violation = {
      kind: "browser_subrequest",
      url: "",
      host: "invalid",
      reason: unknownMessage(error),
    };
  }

  assertNoViolation(): void {
    if (this.violation !== undefined) {
      throw new BrowserNetworkPolicyViolationError(this.violation, this.policy);
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.tracked.values()];
    this.tracked.clear();
    for (const tracked of sessions) {
      tracked.detach();
      await tracked.session.send("Fetch.disable").catch(() => undefined);
    }
  }

  private async handleFetchPaused(session: BrowserNetworkGuardCdpSession, event: FetchRequestPausedEvent): Promise<void> {
    const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
    if (requestId === undefined) {
      this.failClosed("Fetch.requestPaused missing requestId");
      return;
    }
    const url = typeof event.request?.url === "string" ? event.request.url : "";
    const resourceType = typeof event.resourceType === "string" ? event.resourceType : undefined;
    const decision = this.evaluate(url, requestKindFromResource(resourceType));
    if (decision.kind === "allow") {
      try {
        await this.recordNetworkAudit("allow", "network policy allowed", decision.allow);
      } catch (error) {
        this.failClosed(error);
        await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
        return;
      }
      await session.send("Fetch.continueRequest", { requestId });
      return;
    }
    this.violation = decision.violation;
    await this.recordNetworkAudit("blocked", decision.violation.reason, decision.violation).catch((error) => this.failClosed(error));
    await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  }

  private async handleWebSocketHandshake(event: WebSocketHandshakeEvent): Promise<void> {
    const url = typeof event.request?.url === "string" ? event.request.url : "";
    const decision = this.evaluate(url, "browser_subrequest", "WebSocket");
    if (decision.kind === "allow") {
      await this.recordNetworkAudit("allow", "network policy allowed", decision.allow);
      return;
    }
    if (this.violation === undefined) this.violation = decision.violation;
    await this.recordNetworkAudit("blocked", decision.violation.reason, decision.violation).catch((error) => this.failClosed(error));
  }

  private async handleDownload(session: BrowserNetworkGuardCdpSession, event: DownloadWillBeginEvent): Promise<void> {
    const url = typeof event.url === "string" ? event.url : "";
    const decision = this.evaluate(url, "download");
    if (decision.kind === "allow") {
      try {
        await this.recordNetworkAudit("allow", "network policy allowed", decision.allow);
      } catch (error) {
        this.failClosed(error);
        await this.cancelDownload(session, event);
      }
      return;
    }
    this.violation = decision.violation;
    await this.recordNetworkAudit("blocked", decision.violation.reason, decision.violation).catch((error) => this.failClosed(error));
    await this.cancelDownload(session, event);
  }

  private async cancelDownload(session: BrowserNetworkGuardCdpSession, event: DownloadWillBeginEvent): Promise<void> {
    if (typeof event.guid === "string" && event.guid.length > 0) {
      await session.send("Browser.cancelDownload", { guid: event.guid }).catch(() => undefined);
    }
  }

  private async recordNetworkAudit(
    outcome: "allow" | "blocked",
    reason: string,
    decision: BrowserNetworkAllowDecision | BrowserNetworkViolation,
  ): Promise<void> {
    const audit = this.policy.audit;
    if (audit === undefined) return;
    const now = audit.clock?.() ?? new Date();
    const occurredAt = now.toISOString() as IsoDateTime;
    const retentionMs = Math.max(1, audit.retentionDays ?? 365) * 24 * 60 * 60 * 1000;
    const retentionUntil = new Date(now.getTime() + retentionMs).toISOString() as IsoDateTime;
    await audit.writer.recordDecision(
      {
        failClosed: true,
        tenantId: this.policy.tenantId as TenantId,
        actor: { subjectId: audit.actor.subjectId as PrincipalId, roles: audit.actor.roles },
        action: "network.request",
        outcome,
        resource: { kind: "network_policy", id: this.policy.networkPolicyId },
        reason,
        correlationId: (this.policy.correlationId ?? this.policy.runId ?? randomUUID()) as CorrelationId,
        idempotencyKey: randomUUID() as IdempotencyKey,
        occurredAt,
        retentionUntil,
        payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
        payload: {
          decision_kind: "network.request",
          network_policy_id: this.policy.networkPolicyId,
          request_kind: decision.kind,
          url: decision.url,
          host: decision.host,
          outcome,
          ...(this.policy.runId !== undefined ? { run_id: this.policy.runId } : {}),
          ...(decision.resourceType !== undefined ? { resource_type: decision.resourceType } : {}),
          ...("reason" in decision ? { violation_reason: decision.reason } : {}),
        },
      },
      outcome,
    );
  }

  private evaluate(
    url: string,
    kind: NetworkRequestKind,
    resourceType?: string,
  ): { kind: "allow"; allow: BrowserNetworkAllowDecision } | { kind: "deny"; violation: BrowserNetworkViolation } {
    const decision = evaluateBrowserNetworkPolicy(url, this.policy.allowedDomains);
    if (decision.kind === "allow") {
      return {
        kind: "allow",
        allow: {
          kind,
          url,
          host: decision.host,
          ...(resourceType !== undefined ? { resourceType } : {}),
        },
      };
    }
    return {
      kind: "deny",
      violation: {
        kind,
        url,
        host: decision.host,
        reason: decision.reason,
        ...(resourceType !== undefined ? { resourceType } : {}),
      },
    };
  }
}

function currentStagehandSessions(page: StagehandPageWithCdp): BrowserNetworkGuardCdpSession[] {
  const sessions: BrowserNetworkGuardCdpSession[] = [];
  if (isCdpSession(page.mainSession)) sessions.push(page.mainSession);
  if (page.sessions instanceof Map) {
    for (const session of page.sessions.values()) {
      if (isCdpSession(session) && !sessions.some((known) => sessionKey(known) === sessionKey(session))) {
        sessions.push(session);
      }
    }
  }
  return sessions;
}

function isCdpSession(value: unknown): value is BrowserNetworkGuardCdpSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof (value as { send?: unknown }).send === "function" &&
    "on" in value &&
    typeof (value as { on?: unknown }).on === "function" &&
    "off" in value &&
    typeof (value as { off?: unknown }).off === "function"
  );
}

function sessionKey(session: BrowserNetworkGuardCdpSession): string {
  return session.id ?? "__main__";
}

function requestKindFromResource(resourceType: string | undefined): NetworkRequestKind {
  if (resourceType === "Document") return "browser_navigation";
  if (resourceType === "WebSocket") return "browser_subrequest";
  return "browser_subrequest";
}

function parsePotentiallyNestedUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "blob:") return parsed;
    const inner = value.slice("blob:".length);
    if (/^(https?|wss?):/i.test(inner)) return new URL(inner);
    return parsed;
  } catch {
    return null;
  }
}

function isHostAllowed(host: string, allowedDomains: readonly string[]): boolean {
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

function unknownMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) return value.message;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "browser network guard failed";
}
