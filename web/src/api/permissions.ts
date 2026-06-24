import { useMemo } from "react";
import { RBAC_ROLE_ACTIONS, RBAC_ROLE_LABELS } from "../../../ts/rbac-policy";

// UI gating is a convenience layer only. The backend RoleMatrixRbacMiddleware
// is still authoritative, but the console now reads the same RBAC matrix source.
export const ROLE_LABELS: Readonly<Record<string, string>> = RBAC_ROLE_LABELS;

const DEFAULT_ROLES_CLAIM = "roles";

export function decodeRoles(token: string | null): string[] {
  if (token === null || token === "") return [];
  const payloadPart = token.split(".")[1];
  if (payloadPart === undefined) return [];
  try {
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const rawRoles = readClaim(payload, rolesClaimPath());
    const values = Array.isArray(rawRoles)
      ? rawRoles
      : typeof rawRoles === "string" && rawRoles.length > 0
        ? [rawRoles]
        : [];
    const roleMap = parseRoleMap();
    const roles: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      const mapped = roleMap[value] ?? value;
      if (!seen.has(mapped)) {
        seen.add(mapped);
        roles.push(mapped);
      }
    }
    return roles;
  } catch {
    return [];
  }
}

function rolesClaimPath(): string {
  const configured = import.meta.env.VITE_JWT_ROLES_CLAIM;
  return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : DEFAULT_ROLES_CLAIM;
}

function parseRoleMap(): Readonly<Record<string, string>> {
  const raw = import.meta.env.VITE_JWT_ROLE_MAP;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function readClaim(payload: Readonly<Record<string, unknown>>, claimPath: string): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, claimPath)) return payload[claimPath];
  const parts = claimPath.split(".");
  if (parts.length <= 1 || parts.some((part) => part.length === 0)) return undefined;
  let current: unknown = payload;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    const record = current as Readonly<Record<string, unknown>>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) return undefined;
    current = record[part];
  }
  return current;
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
