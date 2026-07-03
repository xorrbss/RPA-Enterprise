import type {
  RoleAssignmentRole,
  ScimGroupRoleMappingImportBody,
  ScimGroupRoleMappingItem,
  ScimProviderItem,
  ScimProviderSecretRotationPolicy,
} from "../../api/types";

export const PROVIDERS_KEY = ["scim-providers"];
export const ROLES = ["viewer", "operator", "reviewer", "approver", "admin"] as const;
export const DEFAULT_SECRET_ROTATION_POLICY: ScimProviderSecretRotationPolicy = "periodic_90d";
export const SECRET_ROTATION_POLICIES: readonly { readonly value: ScimProviderSecretRotationPolicy; readonly label: string }[] = [
  { value: "manual", label: "수동" },
  { value: "periodic_30d", label: "30일마다" },
  { value: "periodic_60d", label: "60일마다" },
  { value: "periodic_90d", label: "90일마다" },
];
export const IMPORT_MODES: readonly { readonly value: ScimGroupRoleMappingImportBody["mode"]; readonly label: string }[] = [
  { value: "upsert_only", label: "추가/갱신만" },
  { value: "replace_active", label: "현재 목록 교체" },
];
const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  viewer: "보기 전용",
  operator: "운영자",
  reviewer: "검토자",
  approver: "승인자",
  admin: "관리자",
};

type ParsedScimMappingCsv =
  | { readonly ok: true; readonly mappings: readonly ScimGroupRoleMappingImportBody["mappings"][number][] }
  | { readonly ok: false; readonly error: string };

export function parseScimMappingCsv(input: string): ParsedScimMappingCsv {
  const rows = input
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNo: index + 1 }))
    .filter((row) => row.line !== "");
  if (rows.length === 0) return { ok: false, error: "가져올 행이 1개 이상 필요합니다." };

  const mappings: ScimGroupRoleMappingImportBody["mappings"][number][] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const columns = row.line.split(",").map((column) => column.trim());
    if (
      row.lineNo === 1 &&
      columns[0]?.toLowerCase() === "external_group" &&
      columns[1]?.toLowerCase() === "role"
    ) {
      continue;
    }
    if (columns.length < 2 || columns.length > 3) {
      return { ok: false, error: `${row.lineNo}행: external_group,role,description 형식이어야 합니다.` };
    }
    const externalGroup = columns[0] ?? "";
    const role = (columns[1] ?? "").toLowerCase();
    const description = columns[2] ?? "";
    if (externalGroup === "") return { ok: false, error: `${row.lineNo}행: external_group 값이 필요합니다.` };
    if (!isScimRole(role)) return { ok: false, error: `${row.lineNo}행: 허용되지 않은 역할 ${columns[1] ?? ""}` };
    if (seen.has(externalGroup)) return { ok: false, error: `${row.lineNo}행: external_group ${externalGroup}가 중복되었습니다.` };
    seen.add(externalGroup);
    mappings.push({
      external_group: externalGroup,
      role,
      description: description === "" ? null : description,
    });
  }
  if (mappings.length === 0) return { ok: false, error: "가져올 행이 1개 이상 필요합니다." };
  if (mappings.length > 500) return { ok: false, error: "가져오기는 최대 500행까지 지원합니다." };
  return { ok: true, mappings };
}

function isScimRole(value: string): value is RoleAssignmentRole {
  return (ROLES as readonly string[]).includes(value);
}

export function isProviderDecommissioned(provider: ScimProviderItem): boolean {
  return provider.decommissioned_at !== null;
}

export function providerStatusLabel(provider: ScimProviderItem): string {
  if (isProviderDecommissioned(provider)) return "사용 중지됨";
  return provider.status === "active" ? "활성" : "비활성";
}

export function providerStatusTone(provider: ScimProviderItem): "green" | "amber" | "red" {
  if (isProviderDecommissioned(provider)) return "red";
  return provider.status === "active" ? "green" : "amber";
}

export function secretRotationPolicyLabel(policy: ScimProviderSecretRotationPolicy | undefined): string {
  const value = policy ?? DEFAULT_SECRET_ROTATION_POLICY;
  return SECRET_ROTATION_POLICIES.find((item) => item.value === value)?.label ?? value;
}

export function rotationStatusLabel(status: ScimProviderItem["rotation_status"] | undefined): string {
  if (status === "current") return "정상";
  if (status === "due_soon") return "곧 필요";
  if (status === "overdue") return "기한 초과";
  if (status === "decommissioned") return "사용 중지됨";
  return "수동";
}

export function rotationStatusTone(status: ScimProviderItem["rotation_status"] | undefined): "green" | "amber" | "red" | "blue" {
  if (status === "current") return "green";
  if (status === "due_soon") return "amber";
  if (status === "overdue" || status === "decommissioned") return "red";
  return "blue";
}

export function formatProviderTime(value: string | null): string {
  if (value === null || value === "") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function mappingKey(providerKey: string): readonly string[] {
  return ["scim-provider-mappings", providerKey];
}

export function roleLabel(role: RoleAssignmentRole): string {
  return `${ROLE_LABELS[role] ?? role} (${role})`;
}

export function mappingStatusLabel(status: ScimGroupRoleMappingItem["status"]): string {
  return status === "active" ? "활성" : "비활성";
}
