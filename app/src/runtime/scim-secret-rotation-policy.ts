/**
 * SCIM signing secret rotation 정책 계산 — due_at·상태 판정 순수 함수.
 * api/scim-providers(제공자 CRUD 표면)와 운영 알림 scim_secret_rotation 소스(runtime/ops-alerts)가 공용한다.
 */
export type ScimSecretRotationPolicy = "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
export type ScimSecretRotationStatus = "manual" | "current" | "due_soon" | "overdue" | "decommissioned";
export const SCIM_SECRET_ROTATION_DUE_SOON_DAYS = 7;
const SCIM_SECRET_ROTATION_INTERVAL_DAYS: Record<ScimSecretRotationPolicy, number | null> = {
  manual: null,
  periodic_30d: 30,
  periodic_60d: 60,
  periodic_90d: 90,
};

export function scimSecretRotationDueAt(
  policy: ScimSecretRotationPolicy,
  createdAt: Date,
  lastSecretRotatedAt: Date | null,
): Date | null {
  const intervalDays = SCIM_SECRET_ROTATION_INTERVAL_DAYS[policy];
  if (intervalDays === null) return null;
  const baseline = lastSecretRotatedAt ?? createdAt;
  return new Date(baseline.getTime() + intervalDays * 24 * 60 * 60 * 1000);
}

export function scimSecretRotationStatus(
  policy: ScimSecretRotationPolicy,
  createdAt: Date,
  lastSecretRotatedAt: Date | null,
  decommissionedAt: Date | null,
  now = new Date(),
): ScimSecretRotationStatus {
  if (decommissionedAt !== null) return "decommissioned";
  const dueAt = scimSecretRotationDueAt(policy, createdAt, lastSecretRotatedAt);
  if (dueAt === null) return "manual";
  if (dueAt.getTime() <= now.getTime()) return "overdue";
  const dueSoonAt = new Date(now.getTime() + SCIM_SECRET_ROTATION_DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  return dueAt.getTime() <= dueSoonAt.getTime() ? "due_soon" : "current";
}
