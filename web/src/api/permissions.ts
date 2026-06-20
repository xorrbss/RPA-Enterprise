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

// principal sub가 assignee(human_tasks.assignee = uuid 컬럼)로 쓸 수 있는 UUID 형식인지. 백엔드 UUID_RE(auth.ts·dlq.ts) 미러.
// sub는 비-UUID OIDC 식별자(auth0|…·이메일)일 수 있고(auth.ts가 sub를 UUID로 강제하지 않음) 백엔드 assignee는 uuid만 허용하므로,
// self-assign/self-filter 같은 'sub==assignee' 가정 동선은 이 가드를 통과할 때만 노출해야 한다(가정 금지).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string | null): value is string {
  return value !== null && UUID_RE.test(value);
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
