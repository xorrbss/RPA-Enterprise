/**
 * Unit test for SecretRef-backed integration handoff dispatch port.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/integration-handoff-dispatch-port.unit.ts
 */
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type {
  SecretAccessDecision,
  SecretAccessRequest,
  SecretStoreBoundary,
} from "../../ts/security-middleware-contract";
import {
  SecretRefIntegrationHandoffDispatchPort,
  type IntegrationHandoffDispatchFetch,
} from "../src/runtime/integration-handoff-dispatch-port";

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
  const calls: Array<{ url: string; init: Parameters<IntegrationHandoffDispatchFetch>[1] }> = [];
  const okFetch: IntegrationHandoffDispatchFetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 202, headers: headers({ "x-rpa-receipt-id": "dispatch-receipt-1", "x-rpa-external-job-id": "job-1" }) };
  };
  const boundary = new FakeSecretBoundary("https://uipath.example.com/jobs");
  const port = new SecretRefIntegrationHandoffDispatchPort({ secrets: boundary, fetchImpl: okFetch, timeoutMs: 1_000 });
  const accepted = await port.dispatch({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    attemptId: "10000000-0000-4000-8000-000000000001",
    handoffId: "20000000-0000-4000-8000-000000000001",
    providerAlias: "uipath-primary",
    endpointSecretRef: "secret://rpa/test/integration/uipath/dispatch-endpoint" as SecretRef,
    allowedHosts: ["uipath.example.com"],
    payload: { handoff_id: "20000000-0000-4000-8000-000000000001" },
    attemptNo: 1,
  });
  check(
    "resolve uses connector purpose and handoff dispatcher identity",
    boundary.requests.length === 1 &&
      boundary.requests[0]?.purpose === "connector" &&
      boundary.requests[0]?.connectorId === "uipath-primary" &&
      boundary.requests[0]?.principal.claims.runtime_identity === "integration-handoff-dispatcher",
    JSON.stringify(boundary.requests[0]),
  );
  check(
    "2xx provider response maps to accepted receipt",
    accepted.kind === "accepted" &&
      accepted.receiptId === "dispatch-receipt-1" &&
      accepted.providerStatusCode === 202 &&
      accepted.externalJobId === "job-1",
    JSON.stringify(accepted),
  );
  check(
    "fetch uses resolved endpoint without Authorization header",
    calls.length === 1 &&
      calls[0]?.url === "https://uipath.example.com/jobs" &&
      calls[0]?.init.headers.authorization === undefined &&
      calls[0]?.init.headers["x-rpa-integration-handoff-id"] === "20000000-0000-4000-8000-000000000001",
    JSON.stringify(calls[0]),
  );

  const mismatchCalls: typeof calls = [];
  const mismatchPort = new SecretRefIntegrationHandoffDispatchPort({
    secrets: new FakeSecretBoundary("https://evil.example.net/jobs"),
    fetchImpl: async (url, init) => {
      mismatchCalls.push({ url, init });
      return { status: 202, headers: headers({}) };
    },
  });
  const mismatch = await mismatchPort.dispatch({
    tenantId: "00000000-0000-4000-8000-000000000001" as never,
    correlationId: "00000000-0000-4000-8000-000000000002" as never,
    attemptId: "10000000-0000-4000-8000-000000000002",
    handoffId: "20000000-0000-4000-8000-000000000001",
    providerAlias: "uipath-primary",
    endpointSecretRef: "secret://rpa/test/integration/uipath/dispatch-endpoint" as SecretRef,
    allowedHosts: ["uipath.example.com"],
    payload: { handoff_id: "20000000-0000-4000-8000-000000000001" },
    attemptNo: 1,
  });
  check(
    "host allowlist mismatch fails before fetch",
    mismatch.kind === "permanent_failed" && mismatch.reason === "handoff_host_not_allowed" && mismatchCalls.length === 0,
    JSON.stringify({ mismatch, mismatchCalls }),
  );

  if (failures > 0) {
    console.error(`FAIL: ${failures} integration handoff dispatch port check(s) failed`);
    process.exit(1);
  }
  console.log("integration handoff dispatch port tests: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
