import type { Role } from "../../../ts/security-middleware-contract";
import { ApiResponseError } from "../runtime/errors";
import { UUID_RE } from "./server-shared";

export const ROLES: readonly Role[] = ["viewer", "operator", "reviewer", "approver", "admin"];
export const SCIM_SCHEMA_REF = "scim-principal@1";
const SCIM_PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9._:-]{1,63}$/;

export function assertAllowedKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
}

export function parseProviderKey(value: string): string {
  const trimmed = value.trim();
  if (!SCIM_PROVIDER_KEY_RE.test(trimmed)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_provider_key", field: "provider_key" });
  }
  return trimmed;
}

export function parseUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return value;
}

export function parseStatus(value: unknown): "active" | "disabled" {
  if (value === "active" || value === "disabled") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status", field: "status" });
}

export function parseRole(value: unknown): Role {
  if (ROLES.includes(value as Role)) return value as Role;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_role", field: "role" });
}

export function parseOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_string", field });
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_string", field });
  }
  return value.trim();
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
