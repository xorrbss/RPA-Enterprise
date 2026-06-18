import { useMemo } from "react";
import { RBAC_ROLE_ACTIONS, RBAC_ROLE_LABELS } from "../../../ts/rbac-policy";

// UI gating is a convenience layer only. The backend RoleMatrixRbacMiddleware
// is still authoritative, but the console now reads the same RBAC matrix source.
export const ROLE_LABELS: Readonly<Record<string, string>> = RBAC_ROLE_LABELS;

export function decodeRoles(token: string | null): string[] {
  if (token === null || token === "") return [];
  const payloadPart = token.split(".")[1];
  if (payloadPart === undefined) return [];
  try {
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(padded)) as { roles?: unknown };
    return Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

export function rolesCan(roles: readonly string[], action: string): boolean {
  const roleActions = RBAC_ROLE_ACTIONS as Readonly<Record<string, readonly string[]>>;
  return roles.some((r) => (roleActions[r] ?? []).includes(action));
}

export function decodeSubject(token: string | null): string | null {
  if (token === null || token === "") return null;
  const payloadPart = token.split(".")[1];
  if (payloadPart === undefined) return null;
  try {
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

export function useSubject(): string | null {
  return useMemo(() => decodeSubject(localStorage.getItem("rpa.token")), []);
}

export function useRoles(): readonly string[] {
  return useMemo(() => decodeRoles(localStorage.getItem("rpa.token")), []);
}

export function useCan(): (action: string) => boolean {
  const roles = useRoles();
  return useMemo(() => (action: string) => rolesCan(roles, action), [roles]);
}
