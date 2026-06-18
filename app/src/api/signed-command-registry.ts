import type { PlainSecret, SecretRef, SecretStore } from "../../../ts/core-types";
import type {
  SignedCommandRegistry,
  SignedCommandRegistryEntry,
  SignedCommandRegistryReadRequest,
  SignedCommandRegistryReadResult,
} from "../../../ts/security-middleware-contract";

export class DenyAllSignedCommandRegistry implements SignedCommandRegistry {
  async listAllowedCommandRefs(_request: SignedCommandRegistryReadRequest): Promise<SignedCommandRegistryReadResult> {
    return {
      kind: "available",
      snapshot: { sourceRef: "secret://unconfigured/signed-command-registry" as SecretRef, commands: [] },
    };
  }
}

export class SecretStoreSignedCommandRegistry implements SignedCommandRegistry {
  constructor(
    private readonly store: SecretStore,
    private readonly sourceRef: SecretRef,
  ) {}

  async listAllowedCommandRefs(_request: SignedCommandRegistryReadRequest): Promise<SignedCommandRegistryReadResult> {
    let raw: PlainSecret;
    try {
      raw = await this.store.resolve(this.sourceRef);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { kind: "unavailable", reason, sourceRef: this.sourceRef };
    }
    const parsed = parseRegistryDocument(String(raw));
    if (parsed.kind === "error") {
      return { kind: "unavailable", reason: parsed.reason, sourceRef: this.sourceRef };
    }
    return { kind: "available", snapshot: { sourceRef: this.sourceRef, commands: parsed.commands } };
  }
}

function parseRegistryDocument(raw: string): { kind: "ok"; commands: readonly SignedCommandRegistryEntry[] } | { kind: "error"; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "error", reason: "registry_json_invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "error", reason: "registry_document_object_required" };
  }
  const commands = (parsed as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return { kind: "error", reason: "registry_commands_array_required" };
  const out: SignedCommandRegistryEntry[] = [];
  for (const command of commands) {
    if (typeof command !== "object" || command === null || Array.isArray(command)) {
      return { kind: "error", reason: "registry_command_object_required" };
    }
    const r = command as Readonly<Record<string, unknown>>;
    const cmdRef = stringField(r, "cmd_ref") ?? stringField(r, "cmdRef");
    const kid = stringField(r, "kid");
    const signature = stringField(r, "signature");
    const sideEffectKind = stringField(r, "side_effect_kind") ?? stringField(r, "sideEffectKind");
    const verificationKeyRef = stringField(r, "verification_key_ref") ?? stringField(r, "verificationKeyRef");
    if (
      cmdRef === undefined ||
      kid === undefined ||
      signature === undefined ||
      (sideEffectKind !== "read_only" && sideEffectKind !== "create" && sideEffectKind !== "update" && sideEffectKind !== "delete" && sideEffectKind !== "upload") ||
      verificationKeyRef === undefined
    ) {
      return { kind: "error", reason: "registry_command_invalid" };
    }
    out.push({
      cmdRef,
      kid,
      signature,
      sideEffectKind,
      verificationKeyRef: verificationKeyRef as SecretRef,
    });
  }
  return { kind: "ok", commands: out };
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
