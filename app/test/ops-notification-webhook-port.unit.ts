/**
 * Unit test for SecretRef-backed ops notification webhook port.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/ops-notification-webhook-port.unit.ts
 */
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type {
  SecretAccessDecision,
  SecretAccessRequest,
  SecretStoreBoundary,
} from "../../ts/security-middleware-contract";
import { SecretRefWebhookNotificationPort, type OpsNotificationFetch } from "../src/runtime/ops-notification-webhook-port";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

class FakeSecretBoundary implements SecretStoreBoundary {
  readonly store: SecretStore = {
    resolve: async () => this.endpoint as PlainSecret,
  };
  readonly requests: SecretAccessRequest[] = [];

  constructor(private readonly endpoint: string) {}

  async authorize(request: SecretAccessRequest): Promise<SecretAccessDecision> {
    return { kind: "allow", ref: request.ref };
  }

  async resolveAuthorized(request: SecretAccessRequest): Promise<PlainSecret> {
    this.requests.push(request);
    return this.endpoint as PlainSecret;
  }
}

function headers(values: Record<string, string>): { get(name: string): string | null } {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

async function main(): Promise<void> {
  const calls: Array<{ url: string; init: Parameters<OpsNotificationFetch>[1] }> = [];
  const okFetch: OpsNotificationFetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 202, headers: headers({ "x-request-id": "provider-req-1" }) };
  };
  const boundary = new FakeSecretBoundary("https://hooks.example.com/services/T000");
  const port = new SecretRefWebhookNotificationPort({ secrets: boundary, fetchImpl: okFetch, timeoutMs: 1_000 });
  const sent = await port.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    attemptId: "10000000-0000-4000-8000-000000000001",
    alertId: "bot_pool:browser-default",
    endpointSecretRef: "secret://rpa/test/notification-sender/notification/webhook/ops-primary" as SecretRef,
    routePolicyRef: "ops-alerts-webhook-primary",
    recipientGroupRef: "ops-primary-oncall",
    allowedHosts: ["hooks.example.com"],
    payload: { alert_id: "bot_pool:browser-default" },
    attemptNo: 1,
  });
  check("resolve uses notification purpose and notification-sender identity",
    boundary.requests.length === 1 &&
      boundary.requests[0]?.purpose === "notification" &&
      boundary.requests[0]?.principal.claims.runtime_identity === "notification-sender",
    JSON.stringify(boundary.requests[0]));
  check("2xx webhook response maps to sent provider receipt",
    sent.kind === "sent" && sent.receiptId === "provider-req-1" && sent.providerStatusCode === 202,
    JSON.stringify(sent));
  check("fetch uses resolved endpoint but does not send Authorization header",
    calls.length === 1 &&
      calls[0]?.url === "https://hooks.example.com/services/T000" &&
      calls[0]?.init.headers.authorization === undefined &&
      calls[0]?.init.headers["x-rpa-alert-id"] === "bot_pool:browser-default",
    JSON.stringify(calls[0]));

  const mismatchCalls: typeof calls = [];
  const mismatchPort = new SecretRefWebhookNotificationPort({
    secrets: new FakeSecretBoundary("https://evil.example.net/hook"),
    fetchImpl: async (url, init) => {
      mismatchCalls.push({ url, init });
      return { status: 202, headers: headers({}) };
    },
  });
  const mismatch = await mismatchPort.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    attemptId: "10000000-0000-4000-8000-000000000002",
    alertId: "bot_pool:browser-default",
    endpointSecretRef: "secret://rpa/test/notification-sender/notification/webhook/ops-primary" as SecretRef,
    routePolicyRef: "ops-alerts-webhook-primary",
    recipientGroupRef: "ops-primary-oncall",
    allowedHosts: ["hooks.example.com"],
    payload: { alert_id: "bot_pool:browser-default" },
    attemptNo: 1,
  });
  check("host allowlist mismatch fails before fetch",
    mismatch.kind === "permanent_failed" && mismatch.reason === "webhook_host_not_allowed" && mismatchCalls.length === 0,
    JSON.stringify({ mismatch, mismatchCalls }));

  const redirectCalls: typeof calls = [];
  const redirectPort = new SecretRefWebhookNotificationPort({
    secrets: new FakeSecretBoundary("https://hooks.example.com/start"),
    fetchImpl: async (url, init) => {
      redirectCalls.push({ url, init });
      return { status: 302, headers: headers({ location: "https://evil.example.net/final" }) };
    },
  });
  const redirect = await redirectPort.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    attemptId: "10000000-0000-4000-8000-000000000003",
    alertId: "bot_pool:browser-default",
    endpointSecretRef: "secret://rpa/test/notification-sender/notification/webhook/ops-primary" as SecretRef,
    routePolicyRef: "ops-alerts-webhook-primary",
    recipientGroupRef: "ops-primary-oncall",
    allowedHosts: ["hooks.example.com"],
    payload: { alert_id: "bot_pool:browser-default" },
    attemptNo: 1,
  });
  check("redirect to unapproved host is permanent failure",
    redirect.kind === "permanent_failed" && redirect.reason === "webhook_host_not_allowed" && redirectCalls.length === 1,
    JSON.stringify({ redirect, redirectCalls }));

  const queryCalls: typeof calls = [];
  const queryPort = new SecretRefWebhookNotificationPort({
    secrets: new FakeSecretBoundary("https://hooks.example.com/services/T000?token=inline"),
    fetchImpl: async (url, init) => {
      queryCalls.push({ url, init });
      return { status: 202, headers: headers({}) };
    },
  });
  const queryEndpoint = await queryPort.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    attemptId: "10000000-0000-4000-8000-000000000004",
    alertId: "bot_pool:browser-default",
    endpointSecretRef: "secret://rpa/test/notification-sender/notification/webhook/ops-primary" as SecretRef,
    routePolicyRef: "ops-alerts-webhook-primary",
    recipientGroupRef: "ops-primary-oncall",
    allowedHosts: ["hooks.example.com"],
    payload: { alert_id: "bot_pool:browser-default" },
    attemptNo: 1,
  });
  check("resolved webhook endpoint query string fails before fetch",
    queryEndpoint.kind === "permanent_failed" && queryEndpoint.reason === "webhook_endpoint_invalid" && queryCalls.length === 0,
    JSON.stringify({ queryEndpoint, queryCalls }));

  if (failures > 0) {
    console.error(`FAIL: ${failures} ops notification webhook port check(s) failed`);
    process.exit(1);
  }
  console.log("ops notification webhook port tests: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
