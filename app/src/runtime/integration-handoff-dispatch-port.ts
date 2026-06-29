import type { PlainSecret } from "../../../ts/core-types";
import type {
  AuthenticatedPrincipal,
  PrincipalId,
  SecretStoreBoundary,
  TenantId,
} from "../../../ts/security-middleware-contract";
import type {
  IntegrationHandoffDispatchDecision,
  IntegrationHandoffDispatchPort,
  IntegrationHandoffDispatchRequest,
} from "../../../ts/runtime-contract";

interface FetchHeadersLike {
  get(name: string): string | null;
}

interface FetchResponseLike {
  readonly status: number;
  readonly headers: FetchHeadersLike;
}

export type IntegrationHandoffDispatchFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface SecretRefIntegrationHandoffDispatchPortOptions {
  readonly secrets: SecretStoreBoundary;
  readonly fetchImpl?: IntegrationHandoffDispatchFetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export class SecretRefIntegrationHandoffDispatchPort implements IntegrationHandoffDispatchPort {
  readonly binding = {
    kind: "real_provider",
    backendAlias: "secretref-integration-handoff",
    evidenceSchemaRef: "integration/handoff-dispatch-evidence@1",
  } as const;

  private readonly fetchImpl: IntegrationHandoffDispatchFetch;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(private readonly options: SecretRefIntegrationHandoffDispatchPortOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRedirects = options.maxRedirects ?? 3;
  }

  async dispatch(input: IntegrationHandoffDispatchRequest): Promise<IntegrationHandoffDispatchDecision> {
    const rawEndpoint = await this.options.secrets.resolveAuthorized({
      principal: integrationHandoffDispatcherPrincipal(input.tenantId),
      ref: input.endpointSecretRef,
      purpose: "connector",
      connectorId: input.providerAlias,
    });
    const endpoint = parseProviderEndpoint(rawEndpoint);
    if (endpoint === null) return { kind: "permanent_failed", reason: "handoff_endpoint_invalid" };
    const allowedHosts = new Set(input.allowedHosts.map((host) => host.toLowerCase()));
    const hostDenial = providerHostDenial(endpoint, allowedHosts);
    if (hostDenial !== null) return { kind: "permanent_failed", reason: hostDenial };

    const body = JSON.stringify(input.payload);
    const headers = {
      "content-type": "application/json",
      "x-rpa-integration-handoff-id": input.handoffId,
      "x-rpa-integration-attempt-id": input.attemptId,
      "x-rpa-provider-alias": input.providerAlias,
    };
    return this.postWithRedirects(endpoint, allowedHosts, headers, body, input.attemptId);
  }

  private async postWithRedirects(
    firstUrl: URL,
    allowedHosts: ReadonlySet<string>,
    headers: Readonly<Record<string, string>>,
    body: string,
    attemptId: string,
  ): Promise<IntegrationHandoffDispatchDecision> {
    let current = firstUrl;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const hostDenial = providerHostDenial(current, allowedHosts);
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
            kind: "accepted",
            receiptId: safeReceiptId(response.headers.get("x-rpa-receipt-id") ?? response.headers.get("x-request-id"), attemptId),
            providerStatusCode: response.status,
            ...(safeExternalJobId(response.headers.get("x-rpa-external-job-id") ?? response.headers.get("x-provider-job-id")) === undefined
              ? {}
              : { externalJobId: safeExternalJobId(response.headers.get("x-rpa-external-job-id") ?? response.headers.get("x-provider-job-id")) }),
          };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null || location.length === 0) {
            return { kind: "permanent_failed", reason: "handoff_redirect_missing_location", providerStatusCode: response.status };
          }
          if (redirectCount === this.maxRedirects) {
            return { kind: "permanent_failed", reason: "handoff_redirect_limit", providerStatusCode: response.status };
          }
          const redirected = parseRedirectLocation(current, location);
          if (redirected === null) {
            return { kind: "permanent_failed", reason: "handoff_redirect_invalid", providerStatusCode: response.status };
          }
          current = redirected;
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          return { kind: "transient_failed", reason: `handoff_http_${response.status}`, providerStatusCode: response.status };
        }
        return { kind: "permanent_failed", reason: `handoff_http_${response.status}`, providerStatusCode: response.status };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return { kind: "transient_failed", reason: "handoff_timeout" };
        }
        return { kind: "transient_failed", reason: "handoff_network_error" };
      } finally {
        clearTimeout(timer);
      }
    }
    return { kind: "permanent_failed", reason: "handoff_redirect_limit" };
  }
}

function integrationHandoffDispatcherPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "integration-handoff-dispatcher" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "integration-handoff-dispatcher" },
  };
}

function parseProviderEndpoint(secret: PlainSecret): URL | null {
  let url: URL;
  try {
    url = new URL(String(secret));
  } catch {
    return null;
  }
  const denial = providerEndpointUrlDenial(url);
  if (denial !== null) return null;
  return url;
}

function parseRedirectLocation(current: URL, location: string): URL | null {
  let url: URL;
  try {
    url = new URL(location, current);
  } catch {
    return null;
  }
  const denial = providerEndpointUrlDenial(url);
  if (denial !== null) return null;
  return url;
}

function providerEndpointUrlDenial(url: URL): string | null {
  if (url.protocol !== "https:") return "handoff_endpoint_requires_https";
  if (url.username !== "" || url.password !== "") return "handoff_endpoint_credentials_forbidden";
  if (url.hash !== "") return "handoff_endpoint_fragment_forbidden";
  if (url.hostname.length === 0) return "handoff_endpoint_host_required";
  return null;
}

function providerHostDenial(url: URL, allowedHosts: ReadonlySet<string>): string | null {
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) return "handoff_host_not_allowed";
  if (host === "localhost" || host.endsWith(".localhost")) return "handoff_localhost_forbidden";
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return "handoff_ip_literal_forbidden";
  return null;
}

function safeReceiptId(raw: string | null, attemptId: string): string {
  if (raw !== null) {
    const trimmed = raw.trim();
    if (/^[A-Za-z0-9._:-]{1,180}$/.test(trimmed)) return trimmed;
  }
  return `dispatch:${attemptId}`;
}

function safeExternalJobId(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9._:-]{1,200}$/.test(trimmed)) return trimmed;
  return undefined;
}
