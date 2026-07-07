/**
 * /v1/ops-alerts HTTP 표면 — 목록 조회(필터·정렬)와 확인(ack) 처리.
 * 알림 계산은 runtime/ops-alerts/compute(worker 자동 발화와 공용), 입력 검증은 ops-alerts-parse,
 * 외부 전달(deliveries·send-webhook·provider 콜백)은 ops-alerts-deliveries 가 맡는다.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { readComputedOpsAlertById, readComputedOpsAlerts } from "../runtime/ops-alerts/compute";
import type { ComputedOpsAlert, OpsAlertSeverity, OpsAlertSource } from "../runtime/ops-alerts/types";
import { runIdempotentCommand } from "./command";
import { parseLimit } from "./list-query";
import { registerOpsAlertDeliveryRoutes } from "./ops-alerts-deliveries";
import {
  assertNoCursor,
  parseAckRequest,
  parseAlertId,
  severityFilter,
  sourceFilter,
  statusFilter,
  type OpsAlertStatus,
} from "./ops-alerts-parse";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

interface OpsAlertDelivery {
  readonly channel: "console";
  readonly status: "delivered";
  readonly delivered_at: string;
  readonly external_delivery: false;
}

interface OpsAlertAck {
  readonly acknowledged_by: string;
  readonly acknowledged_at: string;
  readonly comment: string | null;
}

interface OpsAlertItem extends ComputedOpsAlert {
  readonly status: OpsAlertStatus;
  readonly delivery: OpsAlertDelivery;
  readonly ack: OpsAlertAck | null;
}

interface OpsAlertAckRow {
  alert_id: string;
  detected_at: Date;
  acknowledged_by: string;
  acknowledged_at: Date;
  comment: string | null;
}

const SEVERITY_RANK: Record<OpsAlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function registerOpsAlertRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/ops-alerts", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    assertNoCursor(query.cursor);
    const limit = parseLimit(query.limit);
    const sourceQueryLimit = limit;
    const severity = severityFilter(query.severity);
    const source = sourceFilter(query.source);
    const status = statusFilter(query.status);

    const alerts = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readOpsAlerts(client, principal.tenantId, source, sourceQueryLimit),
    );

    const filtered = alerts
      .filter((alert) => severity === undefined || alert.severity === severity)
      .filter((alert) => status === "all" || alert.status === status)
      .sort(compareAlerts);
    const page = filtered.slice(0, limit);

    reply.code(200).send({ items: page, next_cursor: null });
  });

  app.post("/v1/ops-alerts/:alert_id/ack", { config: { rbacAction: "ops_alert.ack" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const alertId = parseAlertId((request.params as Record<string, unknown>).alert_id);
    const body = parseAckRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "ackOpsAlert",
      `/v1/ops-alerts/${alertId}/ack`,
      async (client, tenantId) => {
        const alert = await readComputedOpsAlertById(client, tenantId, alertId);
        if (alert === null) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_not_current", alert_id: alertId });
        }
        const item = await acknowledgeAlert(client, tenantId, alert, principal.subjectId, body.comment);
        return { status: 200, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  registerOpsAlertDeliveryRoutes(app, deps);
}

async function readOpsAlerts(
  client: PoolClient,
  tenantId: string,
  source: OpsAlertSource | undefined,
  sourceQueryLimit: number,
): Promise<OpsAlertItem[]> {
  const alerts = await readComputedOpsAlerts(client, tenantId, source, sourceQueryLimit);
  return hydrateAlerts(client, tenantId, alerts);
}

async function hydrateAlerts(
  client: PoolClient,
  tenantId: string,
  alerts: readonly ComputedOpsAlert[],
): Promise<OpsAlertItem[]> {
  if (alerts.length === 0) return [];
  const alertIds = [...new Set(alerts.map((alert) => alert.alert_id))];
  const rows = await client.query<OpsAlertAckRow>(
    `SELECT alert_id, detected_at, acknowledged_by, acknowledged_at, comment
       FROM ops_alert_acknowledgements
      WHERE tenant_id = $1::uuid
        AND alert_id = ANY($2::text[])`,
    [tenantId, alertIds],
  );
  const ackByGeneration = new Map(rows.rows.map((row) => [alertGenerationKey(row.alert_id, row.detected_at), row]));
  return alerts.map((alert) => hydrateAlert(alert, ackByGeneration.get(alertGenerationKey(alert.alert_id, alert.detected_at))));
}

function hydrateAlert(alert: ComputedOpsAlert, ackRow: OpsAlertAckRow | undefined): OpsAlertItem {
  return {
    ...alert,
    status: ackRow === undefined ? "open" : "acknowledged",
    delivery: consoleDelivery(alert.detected_at),
    ack: ackRow === undefined
      ? null
      : {
          acknowledged_by: ackRow.acknowledged_by,
          acknowledged_at: ackRow.acknowledged_at.toISOString(),
          comment: ackRow.comment,
        },
  };
}

async function acknowledgeAlert(
  client: PoolClient,
  tenantId: string,
  alert: ComputedOpsAlert,
  acknowledgedBy: string,
  comment: string | null,
): Promise<OpsAlertItem> {
  const result = await client.query<OpsAlertAckRow>(
    `INSERT INTO ops_alert_acknowledgements (
       id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
       acknowledged_by, comment
     )
     VALUES ($1,$2::uuid,$3,$4::timestamptz,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, alert_id, detected_at) DO UPDATE
       SET alert_id = ops_alert_acknowledgements.alert_id
     RETURNING alert_id, detected_at, acknowledged_by, acknowledged_at, comment`,
    [
      randomUUID(),
      tenantId,
      alert.alert_id,
      alert.detected_at,
      alert.source,
      alert.subject_type,
      alert.subject_id,
      acknowledgedBy,
      comment,
    ],
  );
  return hydrateAlert(alert, result.rows[0]);
}

function consoleDelivery(detectedAt: string): OpsAlertDelivery {
  return {
    channel: "console",
    status: "delivered",
    delivered_at: detectedAt,
    external_delivery: false,
  };
}

function alertGenerationKey(alertId: string, detectedAt: string | Date): string {
  const iso = detectedAt instanceof Date ? detectedAt.toISOString() : new Date(detectedAt).toISOString();
  return `${alertId}\u0000${iso}`;
}

function compareAlerts(a: OpsAlertItem, b: OpsAlertItem): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank;
  const detected = Date.parse(b.detected_at) - Date.parse(a.detected_at);
  if (detected !== 0) return detected;
  return a.alert_id.localeCompare(b.alert_id);
}
