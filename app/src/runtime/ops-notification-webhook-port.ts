import type { PlainSecret } from "../../../ts/core-types";
import type {
  AuthenticatedPrincipal,
  PrincipalId,
  SecretStoreBoundary,
  TenantId,
} from "../../../ts/security-middleware-contract";
import type {
  OpsNotificationDeliveryDecision,
  OpsNotificationDeliveryPort,
  OpsNotificationDeliveryRequest,
} from "../../../ts/runtime-contract";

interface FetchHeadersLike {
  get(name: string): string | null;
}

interface FetchResponseLike {
  readonly status: number;
  readonly headers: FetchHeadersLike;
}

export type OpsNotificationFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface SecretRefWebhookNotificationPortOptions {
  readonly secrets: SecretStoreBoundary;
  readonly fetchImpl?: OpsNotificationFetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export class SecretRefWebhookNotificationPort implements OpsNotificationDeliveryPort {
  readonly binding = {
    kind: "real_webhook",
    backendAlias: "secretref-webhook",
    evidenceSchemaRef: "ops/notification-delivery-evidence@1",
  } as const;

  private readonly fetchImpl: OpsNotificationFetch;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(private readonly options: SecretRefWebhookNotificationPortOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRedirects = options.maxRedirects ?? 3;
  }

  async deliver(input: OpsNotificationDeliveryRequest): Promise<OpsNotificationDeliveryDecision> {
    const rawEndpoint = await this.options.secrets.resolveAuthorized({
      principal: notificationSenderPrincipal(input.tenantId),
      ref: input.endpointSecretRef,
      purpose: "notification",
      connectorId: input.routePolicyRef,
    });
    const endpoint = parseWebhookEndpoint(rawEndpoint);
    if (endpoint === null) return { kind: "permanent_failed", reason: "webhook_endpoint_invalid" };
    const allowedHosts = new Set(input.allowedHosts.map((host) => host.toLowerCase()));
    const hostDenial = webhookHostDenial(endpoint, allowedHosts);
    if (hostDenial !== null) return { kind: "permanent_failed", reason: hostDenial };

    const body = JSON.stringify(input.payload);
    const headers = {
      "content-type": "application/json",
      "x-rpa-alert-id": input.alertId,
      "x-rpa-attempt-id": input.attemptId,
      "x-rpa-route-policy-ref": input.routePolicyRef,
    };
    return this.postWithRedirects(endpoint, allowedHosts, headers, body, input.attemptId);
  }

  private async postWithRedirects(
    firstUrl: URL,
    allowedHosts: ReadonlySet<string>,
    headers: Readonly<Record<string, string>>,
    body: string,
    attemptId: string,
  ): Promise<OpsNotificationDeliveryDecision> {
    let current = firstUrl;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const hostDenial = webhookHostDenial(current, allowedHosts);
      if (hostDenial !== null) return { kind: "permanent_failed", reason: hostDenial };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(current.toString(), {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status >= 200 && response.status < 300) {
          return {
            kind: "sent",
            receiptId: safeReceiptId(response.headers.get("x-rpa-receipt-id") ?? response.headers.get("x-request-id"), attemptId),
            providerStatusCode: response.status,
          };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null || location.length === 0) {
            return { kind: "permanent_failed", reason: "webhook_redirect_missing_location", providerStatusCode: response.status };
          }
          if (redirectCount === this.maxRedirects) {
            return { kind: "permanent_failed", reason: "webhook_redirect_limit", providerStatusCode: response.status };
          }
          const redirected = parseRedirectLocation(current, location);
          if (redirected === null) {
            return { kind: "permanent_failed", reason: "webhook_redirect_invalid", providerStatusCode: response.status };
          }
          current = redirected;
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          return { kind: "transient_failed", reason: `webhook_http_${response.status}`, providerStatusCode: response.status };
        }
        return { kind: "permanent_failed", reason: `webhook_http_${response.status}`, providerStatusCode: response.status };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return { kind: "transient_failed", reason: "webhook_timeout" };
        }
        return { kind: "transient_failed", reason: "webhook_network_error" };
      } finally {
        clearTimeout(timer);
      }
    }
    return { kind: "permanent_failed", reason: "webhook_redirect_limit" };
  }
}

function notificationSenderPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "notification-sender:ops-alerts" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "notification-sender" },
  };
}

function parseWebhookEndpoint(secret: PlainSecret): URL | null {
  let url: URL;
  try {
    url = new URL(String(secret));
  } catch {
    return null;
  }
  const denial = webhookEndpointUrlDenial(url);
  if (denial !== null) {
    return null;
  }
  return url;
}

function parseRedirectLocation(current: URL, location: string): URL | null {
  let url: URL;
  try {
    url = new URL(location, current);
  } catch {
    return null;
  }
  const denial = webhookEndpointUrlDenial(url);
  if (denial !== null) {
    return null;
  }
  return url;
}

function webhookEndpointUrlDenial(url: URL): string | null {
  if (url.protocol !== "https:") return "webhook_endpoint_requires_https";
  if (url.username !== "" || url.password !== "") return "webhook_endpoint_credentials_forbidden";
  if (url.search !== "") return "webhook_endpoint_query_forbidden";
  if (url.hash !== "") return "webhook_endpoint_fragment_forbidden";
  if (url.hostname.length === 0) return "webhook_endpoint_host_required";
  return null;
}

function webhookHostDenial(url: URL, allowedHosts: ReadonlySet<string>): string | null {
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) return "webhook_host_not_allowed";
  if (host === "localhost" || host.endsWith(".localhost")) return "webhook_localhost_forbidden";
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return "webhook_ip_literal_forbidden";
  return null;
}

function safeReceiptId(raw: string | null, attemptId: string): string {
  if (raw !== null) {
    const trimmed = raw.trim();
    if (/^[A-Za-z0-9._:-]{1,180}$/.test(trimmed)) return trimmed;
  }
  return `webhook:${attemptId}`;
}
