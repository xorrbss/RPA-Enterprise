import type { IntegrationHandoff } from "../../api/types";
import { statusLabel } from "../../components/badges";

export interface HandoffProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly alias: string;
  readonly callbackUrlSecretRef: string;
  readonly callbackSignatureSecretRef: string;
  readonly dispatchEndpointSecretRef: string;
  readonly allowedHosts: string;
}

export const HANDOFF_PROVIDER_PROFILES: readonly HandoffProviderProfile[] = [
  {
    id: "owner-defined",
    label: "직접 지정 기존 RPA",
    alias: "existing-rpa-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/existing-rpa/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/existing-rpa/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/existing-rpa/dispatch-endpoint",
    allowedHosts: "rpa-provider.example.com",
  },
  {
    id: "uipath",
    label: "UiPath 연동 프로필",
    alias: "uipath-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/uipath/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/uipath/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/uipath/dispatch-endpoint",
    allowedHosts: "uipath.example.com",
  },
  {
    id: "automation-anywhere",
    label: "Automation Anywhere 연동 프로필",
    alias: "automation-anywhere-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/automation-anywhere/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/automation-anywhere/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/automation-anywhere/dispatch-endpoint",
    allowedHosts: "automation-anywhere.example.com",
  },
  {
    id: "power-automate",
    label: "Power Automate 연동 프로필",
    alias: "power-automate-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/power-automate/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/power-automate/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/power-automate/dispatch-endpoint",
    allowedHosts: "power-automate.example.com",
  },
  {
    id: "blue-prism",
    label: "Blue Prism 연동 프로필",
    alias: "blue-prism-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/blue-prism/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/blue-prism/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/blue-prism/dispatch-endpoint",
    allowedHosts: "blue-prism.example.com",
  },
];

export const DEFAULT_HANDOFF_PROVIDER_PROFILE = HANDOFF_PROVIDER_PROFILES[0] as HandoffProviderProfile;

const HANDOFF_STATUS_LABELS: Record<string, string> = { accepted: "접수됨", deferred: "전달 대기" }; // 패널 고유값만 로컬
export function handoffStatusLabel(status: string): string { return HANDOFF_STATUS_LABELS[status] ?? statusLabel(status); } // 공유 enum(completed/failed/cancelled)은 badges statusLabel 재사용, 미매핑 raw 폴백(조용한 공백 금지)
export function handoffTone(status: IntegrationHandoff["status"]): "green" | "amber" | "red" | "blue" | "muted" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "muted"; // 취소됨=중립 — 실패와 분리(어휘 정합: badges.tsx tone)
  if (status === "deferred") return "amber";
  return "blue";
}

export function isDispatchable(handoff: IntegrationHandoff): boolean {
  return handoff.status === "deferred" || handoff.status === "failed";
}

export function profileForProviderAlias(providerAlias: string): HandoffProviderProfile {
  const normalized = providerAlias.trim().toLowerCase();
  return HANDOFF_PROVIDER_PROFILES.find((profile) =>
    normalized === profile.alias.toLowerCase() ||
    normalized === profile.id ||
    normalized.startsWith(`${profile.id}-`),
  ) ?? DEFAULT_HANDOFF_PROVIDER_PROFILE;
}
