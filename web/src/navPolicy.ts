import type { ViewKey } from "./router";

export type NavMode = "standard" | "advanced";

export const NAV_MODE_STORAGE_KEY = "rpa.nav.mode";

export interface NavPolicyFlags {
  readonly showInternalOpenGate: boolean;
}

export interface NavPolicyContext {
  readonly roles: readonly string[];
  readonly mode: NavMode;
  readonly flags: NavPolicyFlags;
}

export interface VisibleNavGroup {
  readonly label: string;
  readonly keys: readonly ViewKey[];
}

type ConsoleRole = "viewer" | "operator" | "reviewer" | "approver" | "admin";

interface ViewVisibilityPolicy {
  readonly standardRoles: readonly ConsoleRole[];
  readonly advancedRoles?: readonly ConsoleRole[];
  readonly internalOnly?: boolean;
}

const KNOWN_ROLES: readonly ConsoleRole[] = ["viewer", "operator", "reviewer", "approver", "admin"];
const ALL_ROLES: readonly ConsoleRole[] = KNOWN_ROLES;
const CREATOR_ROLES: readonly ConsoleRole[] = ["operator", "reviewer", "approver", "admin"];
const ADVANCED_NON_VIEWER_ROLES: readonly ConsoleRole[] = ["operator", "reviewer", "approver", "admin"];

const VIEW_VISIBILITY: Record<ViewKey, ViewVisibilityPolicy> = {
  myWork: { standardRoles: ALL_ROLES },
  dashboard: { standardRoles: ALL_ROLES },
  runTrace: { standardRoles: ALL_ROLES },
  workitems: { standardRoles: ALL_ROLES },
  humanTasks: { standardRoles: ALL_ROLES },

  scenarioStudio: { standardRoles: CREATOR_ROLES },
  playground: { standardRoles: CREATOR_ROLES },
  automationOps: { standardRoles: ["operator", "admin"] },
  documentIdp: { standardRoles: ["operator", "admin"] },

  auditExplorer: { standardRoles: ["approver", "admin"], advancedRoles: ADVANCED_NON_VIEWER_ROLES },

  coePipeline: { standardRoles: ["admin"], advancedRoles: ADVANCED_NON_VIEWER_ROLES },
  connectorCatalog: { standardRoles: ["admin"], advancedRoles: ADVANCED_NON_VIEWER_ROLES },
  objectRepository: { standardRoles: ["admin"], advancedRoles: ADVANCED_NON_VIEWER_ROLES },
  irValidation: { standardRoles: ["admin"], advancedRoles: ADVANCED_NON_VIEWER_ROLES },

  llmGateway: { standardRoles: ["admin"] },
  security: { standardRoles: ["admin"] },
  idempotency: { standardRoles: ["admin"], advancedRoles: ADVANCED_NON_VIEWER_ROLES },
  openGate: { standardRoles: ["admin"], advancedRoles: ["admin"], internalOnly: true },
};

// 자동화 생명주기 순의 4그룹(내 업무→자동화→현황→설정·점검) — "등록하면 알아서 돌고, 확인할 때만 내 인박스" 멘탈모델을
// 메뉴 구조로. 결재 인박스는 '사람 확인'의 결재 목록 탭으로 흡수(별도 메뉴 은퇴). 가시성 정책(VIEW_VISIBILITY)은 불변 — 묶음만 재편.
const NAV_POLICY_GROUPS: readonly VisibleNavGroup[] = [
  { label: "내 업무", keys: ["myWork", "humanTasks", "workitems"] },
  { label: "자동화", keys: ["scenarioStudio", "playground", "runTrace", "automationOps", "documentIdp"] },
  { label: "현황", keys: ["dashboard"] },
  { label: "설정·점검", keys: ["coePipeline", "connectorCatalog", "objectRepository", "irValidation", "auditExplorer", "llmGateway", "security", "idempotency", "openGate"] },
];

function isConsoleRole(role: string): role is ConsoleRole {
  return (KNOWN_ROLES as readonly string[]).includes(role);
}

function effectiveRoles(roles: readonly string[]): readonly ConsoleRole[] {
  const known = roles.filter(isConsoleRole);
  return known.length > 0 ? known : ["viewer"];
}

function hasAllowedRole(roles: readonly ConsoleRole[], allowed: readonly ConsoleRole[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

function allowedRolesFor(policy: ViewVisibilityPolicy, mode: NavMode): readonly ConsoleRole[] {
  if (mode === "standard" || policy.advancedRoles === undefined) return policy.standardRoles;
  return [...new Set([...policy.standardRoles, ...policy.advancedRoles])];
}

export function normalizeNavMode(value: string | null | undefined): NavMode {
  return value === "advanced" ? "advanced" : "standard";
}

export function readStoredNavMode(): NavMode {
  try {
    return normalizeNavMode(localStorage.getItem(NAV_MODE_STORAGE_KEY));
  } catch {
    return "standard";
  }
}

export function writeStoredNavMode(mode: NavMode): void {
  try {
    localStorage.setItem(NAV_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in hardened browser contexts. The in-memory UI state still works.
  }
}

function envFlag(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getInternalNavFlags(): NavPolicyFlags {
  return {
    showInternalOpenGate: envFlag(import.meta.env.VITE_SHOW_INTERNAL_OPEN_GATE),
  };
}

export function isViewVisible(view: ViewKey, context: NavPolicyContext): boolean {
  const policy = VIEW_VISIBILITY[view];
  if (policy.internalOnly === true && !context.flags.showInternalOpenGate) return false;
  return hasAllowedRole(effectiveRoles(context.roles), allowedRolesFor(policy, context.mode));
}

export function getVisibleNavGroups(context: NavPolicyContext): readonly VisibleNavGroup[] {
  return NAV_POLICY_GROUPS.map((group) => ({
    label: group.label,
    keys: group.keys.filter((key) => isViewVisible(key, context)),
  })).filter((group) => group.keys.length > 0);
}

export function getVisibleViews(context: NavPolicyContext): readonly ViewKey[] {
  return getVisibleNavGroups(context).flatMap((group) => group.keys);
}

export function hasAdvancedNav(context: Omit<NavPolicyContext, "mode">): boolean {
  const standard = getVisibleViews({ ...context, mode: "standard" });
  const advanced = getVisibleViews({ ...context, mode: "advanced" });
  return advanced.some((view) => !standard.includes(view));
}
