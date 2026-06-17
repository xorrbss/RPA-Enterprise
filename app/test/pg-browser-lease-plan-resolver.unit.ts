/**
 * PgBrowserLeasePlanResolver unit test — resolves run → scenario_version → ir.target into a BrowserLeasePlan.
 * Uses a mock pg client (no DB). Locks: valid target → plan; missing/null/malformed target → null
 * (fail-closed, worker loud-throws upstream); query is tenant+run scoped with the right params.
 */
import { pgBrowserLeasePlanResolver } from "../src/worker/pg-browser-lease-plan-resolver";
import type { BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

type Client = Parameters<BrowserLeasePlanResolver>[0];

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

function mockClient(rows: Array<{ target: unknown }>, capture?: { sql?: string; params?: unknown[] }): Client {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (capture !== undefined) {
        capture.sql = sql;
        capture.params = params;
      }
      return { rows };
    },
  } as unknown as Client;
}

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const RUN = "00000000-0000-0000-0000-0000000000b2";
const SITE = "11111111-1111-1111-1111-111111111111";
const IDENT = "22222222-2222-2222-2222-222222222222";
const NET = "33333333-3333-3333-3333-333333333333";

async function main(): Promise<void> {
  // valid target → plan + tenant/run-scoped query
  {
    const cap: { sql?: string; params?: unknown[] } = {};
    const plan = await pgBrowserLeasePlanResolver(
      mockClient([{ target: { site_profile_id: SITE, browser_identity_id: IDENT, network_policy_id: NET } }], cap),
      { tenantId: TENANT, runId: RUN },
    );
    check("valid target → plan", plan?.siteProfileId === SITE && plan?.browserIdentityId === IDENT && plan?.networkPolicyId === NET);
    check("query is run+tenant scoped", cap.sql?.includes("r.tenant_id") === true && cap.sql?.includes("scenario_versions") === true);
    check("params = [runId, tenantId]", Array.isArray(cap.params) && cap.params[0] === RUN && cap.params[1] === TENANT, JSON.stringify(cap.params));
  }

  // no run row → null
  check("no row → null", (await pgBrowserLeasePlanResolver(mockClient([]), { tenantId: TENANT, runId: RUN })) === null);

  // scenario declares no target → null (fail-closed)
  check("null target → null", (await pgBrowserLeasePlanResolver(mockClient([{ target: null }]), { tenantId: TENANT, runId: RUN })) === null);

  // malformed target (missing network_policy_id) → null
  check(
    "malformed target → null",
    (await pgBrowserLeasePlanResolver(
      mockClient([{ target: { site_profile_id: SITE, browser_identity_id: IDENT } }]),
      { tenantId: TENANT, runId: RUN },
    )) === null,
  );

  // non-object target → null
  check("non-object target → null", (await pgBrowserLeasePlanResolver(mockClient([{ target: "nope" }]), { tenantId: TENANT, runId: RUN })) === null);

  if (failures > 0) {
    console.error(`\npg-browser-lease-plan-resolver.unit: ${failures} FAIL`);
    process.exit(1);
  }
  console.log("\npg-browser-lease-plan-resolver.unit: ALL PASS");
}

void main();
