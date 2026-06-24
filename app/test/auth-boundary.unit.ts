import type { JWTPayload } from "jose";

import { JwtAuthenticationBoundary, readJwtClaim, type JwtVerifier } from "../src/api/auth";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

function verifier(payload: JWTPayload): JwtVerifier {
  return async () => payload;
}

async function main(): Promise<void> {
  const tenant = "00000000-0000-4000-8000-0000000000a1";

  check(
    "readJwtClaim prefers exact namespaced claim before dot traversal",
    readJwtClaim({ "https://idp.example.com/roles": ["admin"] }, "https://idp.example.com/roles") instanceof Array,
  );
  check(
    "readJwtClaim supports dotted object paths",
    readJwtClaim({ realm_access: { roles: ["operator"] } }, "realm_access.roles") instanceof Array,
  );

  const mapped = await new JwtAuthenticationBoundary(
    verifier({
      sub: "auth0|alice",
      app: { tenant_id: tenant },
      realm_access: { roles: ["RPA Operator", "RPA Reviewer", "RPA Operator"] },
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
    {
      claimMapping: {
        tenantClaim: "app.tenant_id",
        rolesClaim: "realm_access.roles",
      },
      roleMap: {
        "RPA Operator": "operator",
        "RPA Reviewer": "reviewer",
      },
    },
  ).authenticate({ authorization: "Bearer verified" });

  check("custom tenant claim authenticates", mapped.kind === "authenticated" && mapped.principal.tenantId === tenant, JSON.stringify(mapped));
  check(
    "custom roles claim maps IdP groups to distinct RPA roles",
    mapped.kind === "authenticated" && JSON.stringify(mapped.principal.roles) === JSON.stringify(["operator", "reviewer"]),
    JSON.stringify(mapped),
  );

  const namespaced = await new JwtAuthenticationBoundary(
    verifier({
      sub: "okta|bob",
      tenant_id: tenant,
      "https://idp.example.com/rpa/roles": ["RPA Admin"],
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
    {
      claimMapping: { rolesClaim: "https://idp.example.com/rpa/roles" },
      roleMap: { "RPA Admin": "admin" },
    },
  ).authenticate({ authorization: "Bearer verified" });
  check("namespaced roles claim authenticates by exact key", namespaced.kind === "authenticated" && namespaced.principal.roles[0] === "admin", JSON.stringify(namespaced));

  const unknownRole = await new JwtAuthenticationBoundary(
    verifier({ sub: "u", tenant_id: tenant, groups: ["External Finance"], exp: Math.floor(Date.now() / 1000) + 60 }),
    { claimMapping: { rolesClaim: "groups" } },
  ).authenticate({ authorization: "Bearer verified" });
  check("unmapped external role fails closed", unknownRole.kind === "denied" && unknownRole.reason === "invalid_roles_claim", JSON.stringify(unknownRole));
}

await main();
if (failures > 0) process.exit(1);
