import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";

type OpsAlertSeverity = "critical" | "warning" | "info";
type OpsAlertSource = "run_sla" | "human_task_sla" | "trigger_fire" | "failure_spike" | "dlq";
type OpsAlertSubjectType = "run" | "human_task" | "run_trigger" | "dlq";

interface OpsAlertItem {
  readonly alert_id: string;
  readonly severity: OpsAlertSeverity;
  readonly source: OpsAlertSource;
  readonly title: string;
  readonly detail: string;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly status: "open";
  readonly recommended_action: string;
  readonly route: string | null;
  readonly detected_at: string;
  readonly due_at?: string | null;
}

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

    const alerts = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
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
            [principal.tenantId, sourceQueryLimit],
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
            [principal.tenantId, sourceQueryLimit],
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
            [principal.tenantId, sourceQueryLimit],
          )
        : { rows: [] as TriggerFireRow[] };
      const failureSpikeRows = source === undefined || source === "failure_spike"
        ? await client.query<FailureSpikeRow>(
            `SELECT count(*)::text AS failure_count, max(updated_at) AS latest_at
               FROM runs
              WHERE tenant_id = $1::uuid
                AND status IN ('failed_business','failed_system')
                AND updated_at >= now() - interval '15 minutes'`,
            [principal.tenantId],
          )
        : { rows: [] as FailureSpikeRow[] };
      const dlqRows = source === undefined || source === "dlq"
        ? await client.query<DlqCountRow>(
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
            [principal.tenantId],
          )
        : { rows: [] as DlqCountRow[] };

      return [
        ...runRows.rows.map(mapRunSlaAlert),
        ...humanRows.rows.map(mapHumanTaskSlaAlert),
        ...triggerRows.rows.map(mapTriggerFireAlert),
        ...failureSpikeRows.rows.flatMap(mapFailureSpikeAlert),
        ...dlqRows.rows.flatMap(mapDlqAlert),
      ];
    });

    const filtered = alerts
      .filter((alert) => severity === undefined || alert.severity === severity)
      .sort(compareAlerts);
    const page = filtered.slice(0, limit);

    reply.code(200).send({ items: page, next_cursor: null });
  });
}

function mapRunSlaAlert(row: RunSlaRow): OpsAlertItem {
  const critical = row.age_minutes >= 240;
  return {
    alert_id: `run_sla:${row.id}`,
    severity: critical ? "critical" : "warning",
    source: "run_sla",
    title: critical ? "장시간 실행 위험" : "실행 SLA 주의",
    detail: `${row.status} 상태가 ${row.age_minutes}분 동안 지속되었습니다.`,
    subject_type: "run",
    subject_id: row.id,
    status: "open",
    recommended_action: "실행 기록에서 단계 지연과 마지막 업데이트를 확인하세요.",
    route: `#runTrace?run=${encodeURIComponent(row.id)}`,
    detected_at: row.updated_at.toISOString(),
    due_at: null,
  };
}

function mapHumanTaskSlaAlert(row: HumanTaskSlaRow): OpsAlertItem {
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
    status: "open",
    recommended_action: "담당자를 배정하거나 검증 워크벤치에서 판정하세요.",
    route: `#humanTasks?ht=${encodeURIComponent(row.id)}`,
    detected_at: row.expires_at.toISOString(),
    due_at: row.expires_at.toISOString(),
  };
}

function mapTriggerFireAlert(row: TriggerFireRow): OpsAlertItem {
  const code = failureCode(row.failure_reason);
  return {
    alert_id: `trigger_fire:${row.id}`,
    severity: row.status === "failed" ? "critical" : "warning",
    source: "trigger_fire",
    title: row.status === "failed" ? "예약 실행 실패" : "예약 실행 건너뜀",
    detail: `${row.scheduled_for.toISOString()} 예약 fire가 ${row.status} 상태입니다.${code !== null ? ` 사유: ${code}` : ""}`,
    subject_type: "run_trigger",
    subject_id: row.trigger_id,
    status: "open",
    recommended_action: "예약 설정과 최대 동시 실행 수, 실패 사유를 확인하세요.",
    route: `#automationOps?trigger=${encodeURIComponent(row.trigger_id)}`,
    detected_at: row.created_at.toISOString(),
    due_at: row.scheduled_for.toISOString(),
  };
}

function mapFailureSpikeAlert(row: FailureSpikeRow): OpsAlertItem[] {
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
    status: "open",
    recommended_action: "실행 기록에서 failed_system/failed_business 원인을 확인하고 공통 장애 여부를 점검하세요.",
    route: "#runTrace?status=failed_system",
    detected_at: (row.latest_at ?? new Date()).toISOString(),
    due_at: null,
  }];
}

function mapDlqAlert(row: DlqCountRow): OpsAlertItem[] {
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
    status: "open",
    recommended_action: "DLQ 목록에서 재처리 가능 여부와 실패 코드를 확인하세요.",
    route: "#workitems",
    detected_at: (row.latest_at ?? new Date()).toISOString(),
    due_at: null,
  }];
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

function failureCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}
