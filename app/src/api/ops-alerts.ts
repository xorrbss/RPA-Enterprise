import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { readBrowserBotPool, type BotPoolItem } from "./bot-pools";
import { runIdempotentCommand, isRecord } from "./command";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";

type OpsAlertSeverity = "critical" | "warning" | "info";
type OpsAlertSource = "run_sla" | "human_task_sla" | "trigger_fire" | "failure_spike" | "dlq" | "bot_pool";
type OpsAlertSubjectType = "run" | "human_task" | "run_trigger" | "dlq" | "bot_pool";
type OpsAlertStatus = "open" | "acknowledged";
type OpsAlertListStatus = OpsAlertStatus | "all";

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

interface OpsAlertItem {
  readonly alert_id: string;
  readonly severity: OpsAlertSeverity;
  readonly source: OpsAlertSource;
  readonly title: string;
  readonly detail: string;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly status: OpsAlertStatus;
  readonly delivery: OpsAlertDelivery;
  readonly ack: OpsAlertAck | null;
  readonly recommended_action: string;
  readonly route: string | null;
  readonly detected_at: string;
  readonly due_at?: string | null;
}

type ComputedOpsAlert = Omit<OpsAlertItem, "status" | "delivery" | "ack">;

interface RunSlaRow {
  id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  age_minutes: number;
}

interface HumanTaskSlaRow {
  id: string;
  run_id: string;
  kind: string;
  state: string;
  assignee: string | null;
  expires_at: Date;
  due_minutes: number;
}

interface TriggerFireRow {
  id: string;
  trigger_id: string;
  status: "failed" | "skipped";
  scheduled_for: Date;
  failure_reason: unknown;
  created_at: Date;
}

interface FailureSpikeRow {
  failure_count: string;
  latest_at: Date | null;
}

interface DlqCountRow {
  workitem_count: string;
  sink_count: string;
  latest_at: Date | null;
}

interface BotPoolDetectedAtRow {
  detected_at: Date;
}

interface OpsAlertAckRow {
  alert_id: string;
  detected_at: Date;
  acknowledged_by: string;
  acknowledged_at: Date;
  comment: string | null;
}

const SEVERITY_SET: Record<OpsAlertSeverity, true> = {
  critical: true,
  warning: true,
  info: true,
};

const SOURCE_SET: Record<OpsAlertSource, true> = {
  run_sla: true,
  human_task_sla: true,
  trigger_fire: true,
  failure_spike: true,
  dlq: true,
  bot_pool: true,
};

const STATUS_SET: Record<OpsAlertListStatus, true> = {
  open: true,
  acknowledged: true,
  all: true,
};

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

async function readComputedOpsAlerts(
  client: PoolClient,
  tenantId: string,
  source: OpsAlertSource | undefined,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const runRows = source === undefined || source === "run_sla"
    ? await client.query<RunSlaRow>(
        `SELECT id, status, created_at, updated_at,
                floor(extract(epoch FROM (now() - created_at)) / 60)::int AS age_minutes
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status IN ('queued','claimed','running','suspending','suspended','resume_requested','resuming','completing')
            AND created_at <= now() - interval '60 minutes'
          ORDER BY (created_at <= now() - interval '240 minutes') DESC, updated_at DESC, id ASC
          LIMIT $2`,
        [tenantId, sourceQueryLimit],
      )
    : { rows: [] as RunSlaRow[] };
  const humanRows = source === undefined || source === "human_task_sla"
    ? await client.query<HumanTaskSlaRow>(
        `SELECT id, run_id, kind, state, assignee, expires_at,
                floor(extract(epoch FROM (expires_at - now())) / 60)::int AS due_minutes
           FROM human_tasks
          WHERE tenant_id = $1::uuid
            AND state IN ('open','assigned','in_progress','escalated')
            AND expires_at IS NOT NULL
            AND expires_at <= now() + interval '15 minutes'
          ORDER BY (expires_at < now()) DESC, expires_at DESC, id ASC
          LIMIT $2`,
        [tenantId, sourceQueryLimit],
      )
    : { rows: [] as HumanTaskSlaRow[] };
  const triggerRows = source === undefined || source === "trigger_fire"
    ? await client.query<TriggerFireRow>(
        `SELECT id, trigger_id, status, scheduled_for, failure_reason, created_at
           FROM run_trigger_fires
          WHERE tenant_id = $1::uuid
            AND status IN ('failed','skipped')
          ORDER BY (status = 'failed') DESC, created_at DESC, id ASC
          LIMIT $2`,
        [tenantId, sourceQueryLimit],
      )
    : { rows: [] as TriggerFireRow[] };
  const failureSpikeRows = source === undefined || source === "failure_spike"
    ? await readFailureSpikeRows(client, tenantId)
    : { rows: [] as FailureSpikeRow[] };
  const dlqRows = source === undefined || source === "dlq"
    ? await readDlqRows(client, tenantId)
    : { rows: [] as DlqCountRow[] };
  const botPoolAlerts = source === undefined || source === "bot_pool"
    ? await readBotPoolAlerts(client, tenantId)
    : [];

  return [
    ...runRows.rows.map(mapRunSlaAlert),
    ...humanRows.rows.map(mapHumanTaskSlaAlert),
    ...triggerRows.rows.map(mapTriggerFireAlert),
    ...failureSpikeRows.rows.flatMap(mapFailureSpikeAlert),
    ...dlqRows.rows.flatMap(mapDlqAlert),
    ...botPoolAlerts,
  ];
}

async function readComputedOpsAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  if (alertId.startsWith("run_sla:")) {
    const subjectId = alertId.slice("run_sla:".length);
    const result = await client.query<RunSlaRow>(
      `SELECT id, status, created_at, updated_at,
              floor(extract(epoch FROM (now() - created_at)) / 60)::int AS age_minutes
         FROM runs
        WHERE tenant_id = $1::uuid
          AND id::text = $2
          AND status IN ('queued','claimed','running','suspending','suspended','resume_requested','resuming','completing')
          AND created_at <= now() - interval '60 minutes'`,
      [tenantId, subjectId],
    );
    return result.rows[0] === undefined ? null : mapRunSlaAlert(result.rows[0]);
  }
  if (alertId.startsWith("human_task_sla:")) {
    const subjectId = alertId.slice("human_task_sla:".length);
    const result = await client.query<HumanTaskSlaRow>(
      `SELECT id, run_id, kind, state, assignee, expires_at,
              floor(extract(epoch FROM (expires_at - now())) / 60)::int AS due_minutes
         FROM human_tasks
        WHERE tenant_id = $1::uuid
          AND id::text = $2
          AND state IN ('open','assigned','in_progress','escalated')
          AND expires_at IS NOT NULL
          AND expires_at <= now() + interval '15 minutes'`,
      [tenantId, subjectId],
    );
    return result.rows[0] === undefined ? null : mapHumanTaskSlaAlert(result.rows[0]);
  }
  if (alertId.startsWith("trigger_fire:")) {
    const subjectId = alertId.slice("trigger_fire:".length);
    const result = await client.query<TriggerFireRow>(
      `SELECT id, trigger_id, status, scheduled_for, failure_reason, created_at
         FROM run_trigger_fires
        WHERE tenant_id = $1::uuid
          AND id::text = $2
          AND status IN ('failed','skipped')`,
      [tenantId, subjectId],
    );
    return result.rows[0] === undefined ? null : mapTriggerFireAlert(result.rows[0]);
  }
  if (alertId === "failure_spike:15m") {
    const result = await readFailureSpikeRows(client, tenantId);
    return mapFailureSpikeAlert(result.rows[0] ?? { failure_count: "0", latest_at: null })[0] ?? null;
  }
  if (alertId === "dlq:unreplayed") {
    const result = await readDlqRows(client, tenantId);
    return mapDlqAlert(result.rows[0] ?? { workitem_count: "0", sink_count: "0", latest_at: null })[0] ?? null;
  }
  if (alertId.startsWith("bot_pool:")) {
    const alerts = await readBotPoolAlerts(client, tenantId);
    return alerts.find((alert) => alert.alert_id === alertId) ?? null;
  }
  return null;
}

async function readFailureSpikeRows(client: PoolClient, tenantId: string): Promise<{ rows: FailureSpikeRow[] }> {
  return client.query<FailureSpikeRow>(
    `SELECT count(*)::text AS failure_count, max(updated_at) AS latest_at
       FROM runs
      WHERE tenant_id = $1::uuid
        AND status IN ('failed_business','failed_system')
        AND updated_at >= now() - interval '15 minutes'`,
    [tenantId],
  );
}

async function readDlqRows(client: PoolClient, tenantId: string): Promise<{ rows: DlqCountRow[] }> {
  return client.query<DlqCountRow>(
    `SELECT
       (SELECT count(*)::text
          FROM dead_letter
         WHERE tenant_id = $1::uuid AND replayed_at IS NULL) AS workitem_count,
       (SELECT count(*)::text
          FROM sink_deliveries
         WHERE tenant_id = $1::uuid AND status = 'dead_letter' AND requeued_at IS NULL) AS sink_count,
       GREATEST(
         (SELECT max(created_at)
            FROM dead_letter
           WHERE tenant_id = $1::uuid AND replayed_at IS NULL),
         (SELECT max(attempted_at)
            FROM sink_deliveries
           WHERE tenant_id = $1::uuid AND status = 'dead_letter' AND requeued_at IS NULL)
       ) AS latest_at`,
    [tenantId],
  );
}

async function readBotPoolAlerts(client: PoolClient, tenantId: string): Promise<ComputedOpsAlert[]> {
  const pool = await readBrowserBotPool(client, tenantId);
  if (pool.health === "ok") return [];
  const detectedAt = await readBotPoolDetectedAt(client, tenantId, pool.capacity.live_capacity.pool_key);
  return [mapBotPoolAlert(pool, detectedAt)];
}

async function readBotPoolDetectedAt(client: PoolClient, tenantId: string, poolKey: string): Promise<string> {
  const result = await client.query<BotPoolDetectedAtRow>(
    `SELECT COALESCE(
       (SELECT min(expires_at)
          FROM browser_leases
         WHERE tenant_id = $1::uuid
           AND state IN ('reserved','active')
           AND expires_at < now()),
       (SELECT min(created_at)
          FROM runs
         WHERE tenant_id = $1::uuid
           AND status = 'queued'),
       (SELECT min(circuit_until)
          FROM workers w
          LEFT JOIN worker_pool_memberships m ON m.worker_id = w.id
         WHERE w.kind = 'browser'
           AND w.circuit_state IN ('open','half_open')
           AND w.circuit_until IS NOT NULL
           AND (($2 = 'default' AND m.worker_id IS NULL) OR m.pool_key = $2)),
       (SELECT min(heartbeat_at)
          FROM workers w
          LEFT JOIN worker_pool_memberships m ON m.worker_id = w.id
         WHERE w.kind = 'browser'
           AND w.status = 'active'
           AND w.heartbeat_at <= now() - interval '2 minutes'
           AND (($2 = 'default' AND m.worker_id IS NULL) OR m.pool_key = $2)),
       now()
     ) AS detected_at`,
    [tenantId, poolKey],
  );
  return (result.rows[0]?.detected_at ?? new Date()).toISOString();
}

function mapRunSlaAlert(row: RunSlaRow): ComputedOpsAlert {
  const critical = row.age_minutes >= 240;
  return {
    alert_id: `run_sla:${row.id}`,
    severity: critical ? "critical" : "warning",
    source: "run_sla",
    title: critical ? "장시간 실행 위험" : "실행 SLA 주의",
    detail: `${row.status} 상태가 ${row.age_minutes}분 동안 지속되었습니다.`,
    subject_type: "run",
    subject_id: row.id,
    recommended_action: "실행 기록에서 단계 지연과 마지막 업데이트를 확인하세요.",
    route: `#runTrace?run=${encodeURIComponent(row.id)}`,
    detected_at: row.updated_at.toISOString(),
    due_at: null,
  };
}

function mapHumanTaskSlaAlert(row: HumanTaskSlaRow): ComputedOpsAlert {
  const overdue = row.due_minutes < 0;
  const assignee = row.assignee !== null ? ` 담당자 ${row.assignee}` : " 미배정";
  return {
    alert_id: `human_task_sla:${row.id}`,
    severity: overdue ? "critical" : "warning",
    source: "human_task_sla",
    title: overdue ? "사람 확인 기한 초과" : "사람 확인 기한 임박",
    detail: `${row.kind}/${row.state}${assignee}. ${overdue ? `${Math.abs(row.due_minutes)}분 초과` : `${row.due_minutes}분 남음`}.`,
    subject_type: "human_task",
    subject_id: row.id,
    recommended_action: "담당자를 배정하거나 검증 워크벤치에서 판정하세요.",
    route: `#humanTasks?ht=${encodeURIComponent(row.id)}`,
    detected_at: row.expires_at.toISOString(),
    due_at: row.expires_at.toISOString(),
  };
}

function mapTriggerFireAlert(row: TriggerFireRow): ComputedOpsAlert {
  const code = failureCode(row.failure_reason);
  return {
    alert_id: `trigger_fire:${row.id}`,
    severity: row.status === "failed" ? "critical" : "warning",
    source: "trigger_fire",
    title: row.status === "failed" ? "예약 실행 실패" : "예약 실행 건너뜀",
    detail: `${row.scheduled_for.toISOString()} 예약 fire가 ${row.status} 상태입니다.${code !== null ? ` 사유: ${code}` : ""}`,
    subject_type: "run_trigger",
    subject_id: row.trigger_id,
    recommended_action: "예약 설정과 최대 동시 실행 수, 실패 사유를 확인하세요.",
    route: `#automationOps?trigger=${encodeURIComponent(row.trigger_id)}`,
    detected_at: row.created_at.toISOString(),
    due_at: row.scheduled_for.toISOString(),
  };
}

function mapFailureSpikeAlert(row: FailureSpikeRow): ComputedOpsAlert[] {
  const failureCount = Number(row.failure_count);
  if (failureCount < 3) return [];
  return [{
    alert_id: "failure_spike:15m",
    severity: failureCount >= 5 ? "critical" : "warning",
    source: "failure_spike",
    title: "실패 급증 감지",
    detail: `최근 15분 동안 실패한 실행이 ${failureCount}건 발생했습니다.`,
    subject_type: "run",
    subject_id: null,
    recommended_action: "실행 기록에서 failed_system/failed_business 원인을 확인하고 공통 장애 여부를 점검하세요.",
    route: "#runTrace?status=failed_system",
    detected_at: (row.latest_at ?? new Date()).toISOString(),
    due_at: null,
  }];
}

function mapDlqAlert(row: DlqCountRow): ComputedOpsAlert[] {
  const workitemCount = Number(row.workitem_count);
  const sinkCount = Number(row.sink_count);
  const total = workitemCount + sinkCount;
  if (total === 0) return [];
  return [{
    alert_id: "dlq:unreplayed",
    severity: total >= 10 ? "critical" : "warning",
    source: "dlq",
    title: "재처리 대기 DLQ",
    detail: `작업 항목 ${workitemCount}건, 외부 전달 ${sinkCount}건이 재처리를 기다립니다.`,
    subject_type: "dlq",
    subject_id: null,
    recommended_action: "DLQ 목록에서 재처리 가능 여부와 실패 코드를 확인하세요.",
    route: "#workitems",
    detected_at: (row.latest_at ?? new Date()).toISOString(),
    due_at: null,
  }];
}

function mapBotPoolAlert(pool: BotPoolItem, detectedAt: string): ComputedOpsAlert {
  const critical = pool.health === "critical";
  return {
    alert_id: `bot_pool:${pool.bot_pool_id}`,
    severity: critical ? "critical" : "warning",
    source: "bot_pool",
    title: critical ? "브라우저 풀 장애" : "브라우저 풀 주의",
    detail: pool.health_reason,
    subject_type: "bot_pool",
    subject_id: pool.bot_pool_id,
    recommended_action: "Bot Pool 용량, 만료 lease, worker heartbeat/circuit 상태를 확인하세요.",
    route: "#orchestration?panel=botPools",
    detected_at: detectedAt,
    due_at: null,
  };
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

function severityFilter(raw: unknown): OpsAlertSeverity | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(SEVERITY_SET, raw)) {
    return raw as OpsAlertSeverity;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_severity" });
}

function sourceFilter(raw: unknown): OpsAlertSource | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(SOURCE_SET, raw)) {
    return raw as OpsAlertSource;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source" });
}

function statusFilter(raw: unknown): OpsAlertListStatus {
  if (raw === undefined) return "open";
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(STATUS_SET, raw)) {
    return raw as OpsAlertListStatus;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status" });
}

function compareAlerts(a: OpsAlertItem, b: OpsAlertItem): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank;
  const detected = Date.parse(b.detected_at) - Date.parse(a.detected_at);
  if (detected !== 0) return detected;
  return a.alert_id.localeCompare(b.alert_id);
}

function assertNoCursor(raw: unknown): void {
  if (raw === undefined) return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_cursor_not_supported" });
}

function parseAlertId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300 || raw.includes("/")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_alert_id" });
  }
  return raw;
}

function parseAckRequest(raw: unknown): { comment: string | null } {
  if (raw === undefined || raw === null) return { comment: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_ack_body_expected_object" });
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "comment")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_ack_unknown_field" });
  }
  const comment = raw.comment;
  if (comment === undefined || comment === null || comment === "") return { comment: null };
  if (typeof comment !== "string" || comment.length > 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_comment" });
  }
  return { comment };
}

function failureCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}
