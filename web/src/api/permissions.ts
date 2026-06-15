import { useMemo } from "react";

// 역할별 UI 게이팅. 권위는 백엔드(RoleMatrixRbacMiddleware가 최종 강제) — 여기는 viewer가 못 누를 명령 버튼을
// 숨겨 403 클릭을 줄이는 UX 보조다. auth-rbac.md §2 / app/src/api/rbac.ts ROLE_ACTIONS의 "콘솔이 노출하는
// 명령(쓰기) 액션" 부분집합을 그대로 미러링한다(읽기 액션은 전 역할 허용이라 게이팅하지 않는다).
// 미러이므로 매트릭스가 바뀌면 함께 갱신해야 한다(누락/과허용이 보안 결함은 아니나 UX 정합을 위해).
const ROLE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  viewer: [],
  operator: ["run.create", "run.abort", "dlq.replay", "sink_dlq.replay", "scenario.create", "scenario.update", "human_task.assign", "human_task.start"],
  reviewer: [
    "run.create", "run.abort", "dlq.replay", "sink_dlq.replay", "scenario.create", "scenario.update",
    "human_task.assign", "human_task.start", "human_task.escalate",
    "human_task.resolve.validation", "human_task.resolve.exception", "human_task.resolve.captcha", "human_task.resolve.mfa",
  ],
  approver: [
    "run.create", "run.abort", "dlq.replay", "sink_dlq.replay", "scenario.create", "scenario.update",
    "human_task.assign", "human_task.start", "human_task.escalate",
    "human_task.resolve.validation", "human_task.resolve.exception", "human_task.resolve.captcha", "human_task.resolve.mfa", "human_task.resolve.approval",
    "site.approve",
  ],
  admin: [
    "run.create", "run.abort", "dlq.replay", "sink_dlq.replay", "scenario.create", "scenario.update", "scenario.promote",
    "human_task.assign", "human_task.start", "human_task.escalate",
    "human_task.resolve.validation", "human_task.resolve.exception", "human_task.resolve.captcha", "human_task.resolve.mfa", "human_task.resolve.approval",
    "site.approve",
  ],
};

// JWT payload(base64url)에서 roles 클레임만 읽는다(서명 검증은 백엔드 책임 — 여기선 표시 판단용).
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
  return roles.some((r) => (ROLE_ACTIONS[r] ?? []).includes(action));
}

// 현재 토큰의 역할로 액션 허용 여부를 판단하는 함수를 반환. 로그아웃은 페이지를 reload하므로 mount 시 1회 읽기로 충분.
export function useCan(): (action: string) => boolean {
  const roles = useMemo(() => decodeRoles(localStorage.getItem("rpa.token")), []);
  return useMemo(() => (action: string) => rolesCan(roles, action), [roles]);
}
