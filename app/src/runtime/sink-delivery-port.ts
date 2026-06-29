import type { PlainSecret, SecretRef } from "../../../ts/core-types";
import type {
  AuthenticatedPrincipal,
  PrincipalId,
  SecretStoreBoundary,
  TenantId,
} from "../../../ts/security-middleware-contract";
import {
  SINK_DELIVERY_EVIDENCE_SCHEMA_REF,
  type SinkDeliveryDecision,
  type SinkDeliveryPort,
  type SinkDeliveryRequest,
  type SinkRealDeliveryPortBinding,
} from "../../../ts/runtime-contract";

interface FetchHeadersLike {
  get(name: string): string | null;
}

interface FetchResponseLike {
  readonly status: number;
  readonly headers: FetchHeadersLike;
}

export type SinkDeliveryFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface SecretRefSinkDeliveryPortOptions {
  readonly secrets: SecretStoreBoundary;
  readonly endpointSecretRef: SecretRef;
  readonly allowedHosts: readonly string[];
  readonly backendAlias?: string;
  readonly fetchImpl?: SinkDeliveryFetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export class SecretRefSinkDeliveryPort implements SinkDeliveryPort {
  readonly binding: SinkRealDeliveryPortBinding;

  private readonly fetchImpl: SinkDeliveryFetch;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(private readonly options: SecretRefSinkDeliveryPortOptions) {
    const backendAlias = options.backendAlias ?? "secretref-sink";
    const normalizedAllowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
    this.binding = {
      kind: "real_sink",
      backendAlias,
      endpointSecretRef: options.endpointSecretRef,
      allowedHosts: normalizedAllowedHosts,
      evidenceSchemaRef: SINK_DELIVERY_EVIDENCE_SCHEMA_REF,
    };
    this.allowedHosts = new Set(normalizedAllowedHosts);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRedirects = options.maxRedirects ?? 3;
  }

  async deliver(input: SinkDeliveryRequest): Promise<SinkDeliveryDecision> {
    let rawEndpoint: PlainSecret;
    try {
      rawEndpoint = await this.options.secrets.resolveAuthorized({
        principal: sinkDeliveryPrincipal(input.tenantId),
        ref: this.options.endpointSecretRef,
        purpose: "connector",
        connectorId: input.sinkConfigId,
      });
    } catch {
      return { kind: "transient_failed", reason: "sink_secret_resolve_failed" };
    }
    const endpoint = parseSinkEndpoint(rawEndpoint);
    if (endpoint.kind === "invalid") return { kind: "transient_failed", reason: endpoint.reason };

    const hostDenial = sinkHostDenial(endpoint.url, this.allowedHosts);
    if (hostDenial !== null) return { kind: "transient_failed", reason: hostDenial };

    const body = JSON.stringify({
      schema: "sink-delivery@1",
      tenant_id: input.tenantId,
      correlation_id: input.correlationId,
      sink_config_id: input.sinkConfigId,
      normalized_record_id: input.normalizedRecordId,
      schema_ref: input.schemaRef,
      natural_key: input.naturalKey,
      record: input.record,
      attempt_no: input.attemptNo,
    });
    const headers = {
      "content-type": "application/json",
      "idempotency-key": input.sinkIdempotencyKey,
      "x-rpa-sink-config-id": input.sinkConfigId,
      "x-rpa-normalized-record-id": input.normalizedRecordId,
      "x-rpa-correlation-id": input.correlationId,
    };
    return this.postWithRedirects(endpoint.url, headers, body, input.normalizedRecordId, input.attemptNo);
  }

  private async postWithRedirects(
    firstUrl: URL,
    headers: Readonly<Record<string, string>>,
    body: string,
    normalizedRecordId: string,
    attemptNo: number,
  ): Promise<SinkDeliveryDecision> {
    let current = firstUrl;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const hostDenial = sinkHostDenial(current, this.allowedHosts);
      if (hostDenial !== null) return { kind: "transient_failed", reason: hostDenial };
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
            kind: "delivered",
            receiptRef: safeReceiptRef(
              response.headers.get("x-rpa-receipt-id") ?? response.headers.get("x-request-id"),
              normalizedRecordId,
              attemptNo,
            ),
          };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null || location.length === 0) {
            return { kind: "transient_failed", reason: "sink_redirect_missing_location" };
          }
          if (redirectCount === this.maxRedirects) {
            return { kind: "transient_failed", reason: "sink_redirect_limit" };
          }
          const redirected = parseRedirectLocation(current, location);
          if (redirected.kind === "invalid") return { kind: "transient_failed", reason: redirected.reason };
          current = redirected.url;
          continue;
        }
        return { kind: "transient_failed", reason: `sink_http_${response.status}` };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return { kind: "transient_failed", reason: "sink_timeout" };
        }
        return { kind: "transient_failed", reason: "sink_network_error" };
      } finally {
        clearTimeout(timer);
      }
    }
    return { kind: "transient_failed", reason: "sink_redirect_limit" };
  }
}

function sinkDeliveryPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "sink-delivery:runtime-worker" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "connector-runtime" },
  };
}

type ParseUrlResult = { readonly kind: "ok"; readonly url: URL } | { readonly kind: "invalid"; readonly reason: string };

function parseSinkEndpoint(secret: PlainSecret): ParseUrlResult {
  let url: URL;
  try {
    url = new URL(String(secret));
  } catch {
    return { kind: "invalid", reason: "sink_endpoint_invalid" };
  }
  const denial = sinkEndpointUrlDenial(url);
  if (denial !== null) return { kind: "invalid", reason: denial };
  return { kind: "ok", url };
}

function parseRedirectLocation(current: URL, location: string): ParseUrlResult {
  let url: URL;
  try {
    url = new URL(location, current);
  } catch {
    return { kind: "invalid", reason: "sink_redirect_invalid" };
  }
  const denial = sinkEndpointUrlDenial(url);
  if (denial !== null) return { kind: "invalid", reason: denial };
  return { kind: "ok", url };
}

function sinkEndpointUrlDenial(url: URL): string | null {
  if (url.protocol !== "https:") return "sink_endpoint_requires_https";
  if (url.username !== "" || url.password !== "") return "sink_endpoint_credentials_forbidden";
  if (url.hash !== "") return "sink_endpoint_fragment_forbidden";
  if (url.hostname.length === 0) return "sink_endpoint_host_required";
  return null;
}

function sinkHostDenial(url: URL, allowedHosts: ReadonlySet<string>): string | null {
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) return "sink_host_not_allowed";
  if (host === "localhost" || host.endsWith(".localhost")) return "sink_localhost_forbidden";
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return "sink_ip_literal_forbidden";
  return null;
}

function safeReceiptRef(raw: string | null, normalizedRecordId: string, attemptNo: number): string {
  if (raw !== null) {
    const trimmed = raw.trim();
    if (/^[A-Za-z0-9._:-]{1,180}$/.test(trimmed)) return trimmed;
  }
  return `sink:${normalizedRecordId}:${attemptNo}`;
}
