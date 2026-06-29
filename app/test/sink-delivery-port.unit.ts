/**
 * Unit test for SecretRef-backed real sink delivery egress.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/sink-delivery-port.unit.ts
 */
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type {
  SecretAccessDecision,
  SecretAccessRequest,
  SecretStoreBoundary,
} from "../../ts/security-middleware-contract";
import { SecretRefSinkDeliveryPort, type SinkDeliveryFetch } from "../src/runtime/sink-delivery-port";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";

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
  const endpointSecretRef = "rpa/staging/connector-runtime/connector/sink-primary-endpoint" as SecretRef;
  const calls: Array<{ url: string; init: Parameters<SinkDeliveryFetch>[1] }> = [];
  const okFetch: SinkDeliveryFetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 202, headers: headers({ "x-rpa-receipt-id": "sink-receipt-1" }) };
  };
  const boundary = new FakeSecretBoundary("https://sink.example.com/ingest");
  const port = new SecretRefSinkDeliveryPort({
    secrets: boundary,
    endpointSecretRef,
    allowedHosts: ["sink.example.com"],
    fetchImpl: okFetch,
    timeoutMs: 1_000,
  });

  const delivered = await port.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    sinkConfigId: "50000000-0000-4000-8000-000000000001",
    sinkIdempotencyKey: "idem-key-1",
    normalizedRecordId: "70000000-0000-4000-8000-000000000001",
    schemaRef: "schemas/review@1",
    naturalKey: "review-1",
    record: { rating: 5, comment: "ok" },
    attemptNo: 1,
    portBinding: port.binding,
  });
  check(
    "resolve uses connector purpose and connector-runtime identity",
    boundary.requests.length === 1 &&
      boundary.requests[0]?.purpose === "connector" &&
      boundary.requests[0]?.connectorId === "50000000-0000-4000-8000-000000000001" &&
      boundary.requests[0]?.principal.claims.runtime_identity === "connector-runtime",
    JSON.stringify(boundary.requests[0]),
  );
  check(
    "2xx sink response maps to delivered receipt",
    delivered.kind === "delivered" && delivered.receiptRef === "sink-receipt-1",
    JSON.stringify(delivered),
  );
  const sentBody = calls[0] !== undefined ? JSON.parse(calls[0].init.body) as Record<string, unknown> : {};
  check(
    "fetch sends normalized record with idempotency key and no Authorization header",
    calls.length === 1 &&
      calls[0]?.url === "https://sink.example.com/ingest" &&
      calls[0]?.init.headers.authorization === undefined &&
      calls[0]?.init.headers["idempotency-key"] === "idem-key-1" &&
      sentBody.schema_ref === "schemas/review@1" &&
      sentBody.natural_key === "review-1" &&
      (sentBody.record as { rating?: number }).rating === 5,
    JSON.stringify({ call: calls[0], sentBody }),
  );

  const mismatchCalls: typeof calls = [];
  const mismatchPort = new SecretRefSinkDeliveryPort({
    secrets: new FakeSecretBoundary("https://evil.example.net/ingest"),
    endpointSecretRef,
    allowedHosts: ["sink.example.com"],
    fetchImpl: async (url, init) => {
      mismatchCalls.push({ url, init });
      return { status: 202, headers: headers({}) };
    },
  });
  const mismatch = await mismatchPort.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    sinkConfigId: "50000000-0000-4000-8000-000000000001",
    sinkIdempotencyKey: "idem-key-2",
    normalizedRecordId: "70000000-0000-4000-8000-000000000002",
    schemaRef: "schemas/review@1",
    naturalKey: "review-2",
    record: { rating: 1 },
    attemptNo: 1,
    portBinding: mismatchPort.binding,
  });
  check(
    "host allowlist mismatch fails before fetch",
    mismatch.kind === "transient_failed" && mismatch.reason === "sink_host_not_allowed" && mismatchCalls.length === 0,
    JSON.stringify({ mismatch, mismatchCalls }),
  );

  const redirectCalls: typeof calls = [];
  const redirectPort = new SecretRefSinkDeliveryPort({
    secrets: new FakeSecretBoundary("https://sink.example.com/start"),
    endpointSecretRef,
    allowedHosts: ["sink.example.com"],
    fetchImpl: async (url, init) => {
      redirectCalls.push({ url, init });
      return { status: 302, headers: headers({ location: "https://evil.example.net/final" }) };
    },
  });
  const redirect = await redirectPort.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    sinkConfigId: "50000000-0000-4000-8000-000000000001",
    sinkIdempotencyKey: "idem-key-3",
    normalizedRecordId: "70000000-0000-4000-8000-000000000003",
    schemaRef: "schemas/review@1",
    naturalKey: "review-3",
    record: { rating: 3 },
    attemptNo: 1,
    portBinding: redirectPort.binding,
  });
  check(
    "redirect to unapproved host is blocked",
    redirect.kind === "transient_failed" && redirect.reason === "sink_host_not_allowed" && redirectCalls.length === 1,
    JSON.stringify({ redirect, redirectCalls }),
  );

  const throwingBoundary: SecretStoreBoundary = {
    store: { resolve: async () => "unused" as PlainSecret },
    authorize: async () => ({ kind: "allow", ref: endpointSecretRef }),
    resolveAuthorized: async () => {
      throw new Error("vault unavailable");
    },
  };
  const secretFailurePort = new SecretRefSinkDeliveryPort({
    secrets: throwingBoundary,
    endpointSecretRef,
    allowedHosts: ["sink.example.com"],
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });
  const secretFailure = await secretFailurePort.deliver({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    sinkConfigId: "50000000-0000-4000-8000-000000000001",
    sinkIdempotencyKey: "idem-key-4",
    normalizedRecordId: "70000000-0000-4000-8000-000000000004",
    schemaRef: "schemas/review@1",
    naturalKey: "review-4",
    record: { rating: 4 },
    attemptNo: 1,
    portBinding: secretFailurePort.binding,
  });
  check(
    "SecretRef resolve failure maps to redacted transient failure",
    secretFailure.kind === "transient_failed" && secretFailure.reason === "sink_secret_resolve_failed",
    JSON.stringify(secretFailure),
  );

  const worker = new PgRuntimeWorker({} as never, { sinkDeliveryRetryAfterMs: 777 });
  const missingEgress = await worker.handle({
    kind: "sink_deliver",
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    sinkDelivery: {
      sinkConfigId: "50000000-0000-4000-8000-000000000001",
      normalizedRecordId: "70000000-0000-4000-8000-000000000004",
    },
  });
  check(
    "worker without egress binding surfaces typed retry failure",
    missingEgress.kind === "deferred" && missingEgress.code === "SINK_DELIVERY_FAILED" && missingEgress.retryAfterMs === 777,
    JSON.stringify(missingEgress),
  );

  if (failures > 0) {
    console.error(`FAIL: ${failures} sink delivery port check(s) failed`);
    process.exit(1);
  }
  console.log("sink delivery port tests: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
