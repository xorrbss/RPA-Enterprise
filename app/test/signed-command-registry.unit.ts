import assert from "node:assert/strict";

import { DenyAllSignedCommandRegistry, SecretStoreSignedCommandRegistry } from "../src/api/signed-command-registry";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { AuthenticatedPrincipal } from "../../ts/security-middleware-contract";

const principal: AuthenticatedPrincipal = {
  subjectId: "user-1" as AuthenticatedPrincipal["subjectId"],
  tenantId: "tenant-1" as AuthenticatedPrincipal["tenantId"],
  roles: ["admin"],
  source: "jwt",
  claims: {},
};

function store(value: string | Error): SecretStore {
  return {
    async resolve(): Promise<PlainSecret> {
      if (value instanceof Error) throw value;
      return value as PlainSecret;
    },
  };
}

async function main(): Promise<void> {
  const request = { principal, purpose: "scenario.save" as const };

  {
    const registry = new DenyAllSignedCommandRegistry();
    const result = await registry.listAllowedCommandRefs(request);
    assert.equal(result.kind, "available");
    if (result.kind === "available") {
      assert.deepEqual(result.snapshot.commands, []);
    }
  }

  {
    const registry = new SecretStoreSignedCommandRegistry(
      store(JSON.stringify({
        commands: [
          {
            cmd_ref: "signed.export_report",
            kid: "kid-1",
            signature: "sig",
            side_effect_kind: "read_only",
            verification_key_ref: "rpa/staging/kms/signed-command/kid-1",
          },
        ],
      })),
      "rpa/staging/api/signed_command/registry" as SecretRef,
    );
    const result = await registry.listAllowedCommandRefs(request);
    assert.equal(result.kind, "available");
    if (result.kind === "available") {
      assert.equal(result.snapshot.commands[0]?.cmdRef, "signed.export_report");
      assert.equal(result.snapshot.commands[0]?.sideEffectKind, "read_only");
    }
  }

  {
    const registry = new SecretStoreSignedCommandRegistry(store("{"), "rpa/staging/api/signed_command/registry" as SecretRef);
    const result = await registry.listAllowedCommandRefs(request);
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") assert.equal(result.reason, "registry_json_invalid");
  }

  {
    const registry = new SecretStoreSignedCommandRegistry(store(new Error("vault down")), "rpa/staging/api/signed_command/registry" as SecretRef);
    const result = await registry.listAllowedCommandRefs(request);
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") assert.equal(result.reason, "vault down");
  }

  console.log("signed-command-registry.unit: ALL PASS");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
