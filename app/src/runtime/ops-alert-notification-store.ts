/**
 * 저장된 알림 라우트의 발화-소비 reader(R2-3 거처 이동).
 *
 * 워커(ops-notification-fire)가 소비하는 활성 라우트 조회를 api 라우트 파일에서 분리한 단방향 leaf —
 * worker→api 역-import 를 끊는다(동작 무변경). CRUD/HTTP 표면은 api/ops-alert-notification-routes 에 남는다.
 */
import type { PoolClient } from "pg";

import type { OpsAlertRoute, OpsAlertAutoFireSource, OpsAlertRouteSeverity } from "./ops-alert-routes";

interface ActiveOpsAlertNotificationRouteRow {
  readonly id: string;
  readonly source: OpsAlertAutoFireSource | null;
  readonly min_severity: OpsAlertRouteSeverity;
  readonly provider_alias: string;
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
}

export async function readActiveOpsAlertNotificationRoutes(
  client: PoolClient,
  tenantId: string,
): Promise<OpsAlertRoute[]> {
  const result = await client.query<ActiveOpsAlertNotificationRouteRow>(
    `SELECT id::text, source, min_severity, provider_alias, endpoint_secret_ref,
            callback_signature_secret_ref, route_policy_ref, recipient_group_ref,
            allowed_hosts, enabled, created_by, created_at, updated_by, updated_at
       FROM ops_alert_notification_routes
      WHERE tenant_id = $1::uuid
        AND enabled = true
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    ...(row.source !== null ? { source: row.source } : {}),
    minSeverity: row.min_severity,
    providerAlias: row.provider_alias,
    endpointSecretRef: row.endpoint_secret_ref,
    allowedHosts: row.allowed_hosts,
    routePolicyRef: row.route_policy_ref,
    ...(row.recipient_group_ref !== null ? { recipientGroupRef: row.recipient_group_ref } : {}),
    ...(row.callback_signature_secret_ref !== null ? { callbackSignatureSecretRef: row.callback_signature_secret_ref } : {}),
  }));
}
