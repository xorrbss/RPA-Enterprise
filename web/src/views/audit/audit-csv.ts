import type { AuditLogItem, AuditLogListParams } from "../../api/types";

export async function exportAuditPeriodCsv(
  listAuditLog: (params?: AuditLogListParams) => Promise<{ readonly items: readonly AuditLogItem[]; readonly next_cursor: string | null }>,
  params: AuditLogListParams,
): Promise<string> {
  const rows: AuditLogItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAuditLog({ ...params, limit: 200, ...(cursor !== undefined ? { cursor } : {}) });
    rows.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return auditItemsToCsv(rows);
}

function auditItemsToCsv(rows: readonly AuditLogItem[]): string {
  const header = [
    "audit_id",
    "sequence_no",
    "actor_subject_id",
    "actor_roles",
    "action",
    "outcome",
    "reason",
    "correlation_id",
    "idempotency_key",
    "occurred_at",
    "payload_schema_ref",
    "retention_until",
    "legal_hold",
    "previous_hash",
    "hash",
    "created_at",
  ];
  const lines = rows.map((row) => [
    row.audit_id,
    String(row.sequence_no),
    row.actor.subject_id ?? "",
    row.actor.roles.join(";"),
    row.action,
    row.outcome,
    row.reason ?? "",
    row.correlation_id,
    row.idempotency_key,
    row.occurred_at,
    row.payload_schema_ref,
    row.retention_until ?? "",
    String(row.legal_hold),
    row.previous_hash ?? "",
    row.hash,
    row.created_at,
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, "\"\"")}"`;
}

export function downloadCsv(csv: string, filename: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  // BOM 없으면 Windows Excel 이 CP949 로 열어 한글이 깨진다. 서버 export 가 이미 붙였으면 중복 방지.
  const blob = new Blob([csv.startsWith("\uFEFF") ? csv : "\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
