/**
 * 운영 알림 계산 — run_sla · human_task_sla · trigger_fire · failure_spike · dlq · session_expiry 소스와
 * 전 소스를 합치는 readComputedOpsAlerts / readComputedOpsAlertById 디스패처.
 * 거버넌스 계열(bot_pool·scim_secret_rotation·audit_verifier·readiness_evidence)은 compute-governance,
 * artifact_redaction·security_abort 는 전용 모듈이 읽는다. api 콘솔 조회와 worker 무인 자동 발화가 공용한다.
 */
import type { PoolClient } from "pg";

import { ERROR_CATALOG, type ErrorCode } from "../../../../ts/error-catalog";
import { readArtifactRedactionAlertById, readArtifactRedactionAlerts } from "./artifact-redaction";
import {
  readAuditVerifierAlertById,
  readAuditVerifierAlerts,
  readBotPoolAlerts,
  readReadinessEvidenceAlertByType,
  readReadinessEvidenceAlerts,
  readScimSecretRotationAlertByProvider,
  readScimSecretRotationAlerts,
} from "./compute-governance";
import { readSecurityAbortAlertById, readSecurityAbortAlerts } from "./security-abort";
import { UUID_RE, type ComputedOpsAlert, type OpsAlertSource } from "./types";

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

interface BrowserSessionExpiryRow {
  site_profile_id: string;
  site_name: string;
  url_pattern: string;
  browser_identity_id: string;
  identity_hash: string;
  expires_at: Date;
  due_minutes: number;
}

const SESSION_EXPIRY_DUE_SOON_HOURS = 24;

export async function readComputedOpsAlerts(
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
  const scimSecretRotationAlerts = source === undefined || source === "scim_secret_rotation"
    ? await readScimSecretRotationAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const auditVerifierAlerts = source === undefined || source === "audit_verifier"
    ? await readAuditVerifierAlerts(client, tenantId)
    : [];
  const readinessEvidenceAlerts = source === undefined || source === "readiness_evidence"
    ? await readReadinessEvidenceAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const sessionExpiryAlerts = source === undefined || source === "session_expiry"
    ? await readSessionExpiryAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const artifactRedactionAlerts = source === undefined || source === "artifact_redaction"
    ? await readArtifactRedactionAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const securityAbortAlerts = source === undefined || source === "security_abort"
    ? await readSecurityAbortAlerts(client, tenantId, sourceQueryLimit)
    : [];

  return [
    ...runRows.rows.map(mapRunSlaAlert),
    ...humanRows.rows.map(mapHumanTaskSlaAlert),
    ...triggerRows.rows.map(mapTriggerFireAlert),
    ...failureSpikeRows.rows.flatMap(mapFailureSpikeAlert),
    ...dlqRows.rows.flatMap(mapDlqAlert),
    ...botPoolAlerts,
    ...scimSecretRotationAlerts,
    ...auditVerifierAlerts,
    ...readinessEvidenceAlerts,
    ...sessionExpiryAlerts,
    ...artifactRedactionAlerts,
    ...securityAbortAlerts,
  ];
}

export async function readComputedOpsAlertById(
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
  if (alertId.startsWith("scim_secret_rotation:")) {
    const providerKey = alertId.slice("scim_secret_rotation:".length);
    return readScimSecretRotationAlertByProvider(client, tenantId, providerKey);
  }
  if (alertId === "audit_verifier:stale" || alertId.startsWith("audit_verifier:")) {
    return readAuditVerifierAlertById(client, tenantId, alertId);
  }
  if (alertId.startsWith("readiness_evidence:")) {
    const evidenceType = alertId.slice("readiness_evidence:".length);
    return readReadinessEvidenceAlertByType(client, tenantId, evidenceType);
  }
  if (alertId.startsWith("session_expiry:")) {
    return readSessionExpiryAlertById(client, tenantId, alertId);
  }
  if (alertId.startsWith("artifact_redaction:")) {
    return readArtifactRedactionAlertById(client, tenantId, alertId);
  }
  if (alertId.startsWith("security_abort:")) {
    return readSecurityAbortAlertById(client, tenantId, alertId);
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

async function readSessionExpiryAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<BrowserSessionExpiryRow>(
    `SELECT bs.site_profile_id::text AS site_profile_id,
            s.name AS site_name,
            s.url_pattern,
            bs.browser_identity_id::text AS browser_identity_id,
            md5(bs.identity_key) AS identity_hash,
            bs.expires_at,
            floor(extract(epoch FROM (bs.expires_at - now())) / 60)::int AS due_minutes
       FROM browser_sessions bs
       JOIN site_profiles s
         ON s.tenant_id = bs.tenant_id
        AND s.id = bs.site_profile_id
      WHERE bs.tenant_id = $1::uuid
        AND bs.expires_at IS NOT NULL
        AND bs.expires_at <= now() + ($2::int * interval '1 hour')
      ORDER BY (bs.expires_at <= now()) DESC, bs.expires_at ASC, bs.site_profile_id ASC, bs.browser_identity_id ASC, bs.identity_key ASC
      LIMIT $3`,
    [tenantId, SESSION_EXPIRY_DUE_SOON_HOURS, sourceQueryLimit],
  );
  return result.rows.map(mapSessionExpiryAlert);
}

async function readSessionExpiryAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  const parts = alertId.split(":");
  if (parts.length !== 4) return null;
  const [, siteProfileId, browserIdentityId, identityHash] = parts;
  if (!UUID_RE.test(siteProfileId) || !UUID_RE.test(browserIdentityId) || !/^[a-f0-9]{32}$/.test(identityHash)) {
    return null;
  }
  const result = await client.query<BrowserSessionExpiryRow>(
    `SELECT bs.site_profile_id::text AS site_profile_id,
            s.name AS site_name,
            s.url_pattern,
            bs.browser_identity_id::text AS browser_identity_id,
            md5(bs.identity_key) AS identity_hash,
            bs.expires_at,
            floor(extract(epoch FROM (bs.expires_at - now())) / 60)::int AS due_minutes
       FROM browser_sessions bs
       JOIN site_profiles s
         ON s.tenant_id = bs.tenant_id
        AND s.id = bs.site_profile_id
      WHERE bs.tenant_id = $1::uuid
        AND bs.site_profile_id = $2::uuid
        AND bs.browser_identity_id = $3::uuid
        AND md5(bs.identity_key) = $4
        AND bs.expires_at IS NOT NULL
        AND bs.expires_at <= now() + ($5::int * interval '1 hour')`,
    [tenantId, siteProfileId, browserIdentityId, identityHash, SESSION_EXPIRY_DUE_SOON_HOURS],
  );
  return result.rows[0] === undefined ? null : mapSessionExpiryAlert(result.rows[0]);
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

function mapSessionExpiryAlert(row: BrowserSessionExpiryRow): ComputedOpsAlert {
  const overdue = row.due_minutes < 0;
  const siteLabel = `${row.site_name} (${row.url_pattern})`;
  return {
    alert_id: `session_expiry:${row.site_profile_id}:${row.browser_identity_id}:${row.identity_hash}`,
    severity: overdue ? "critical" : "warning",
    source: "session_expiry",
    title: overdue ? "로그인 세션 만료" : "로그인 세션 만료 임박",
    detail: overdue
      ? `${siteLabel} 세션이 ${Math.abs(row.due_minutes)}분 전에 만료되었습니다.`
      : `${siteLabel} 세션이 ${row.due_minutes}분 뒤 만료됩니다.`,
    subject_type: "browser_session",
    subject_id: row.site_profile_id,
    recommended_action: "보안 설정에서 해당 사이트의 세션을 다시 등록하세요.",
    route: `#security?section=sites&site=${encodeURIComponent(row.site_profile_id)}`,
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
    detail: `${row.scheduled_for.toISOString()} 예약 실행(fire)이 ${row.status} 상태입니다.${code !== null ? ` 사유: ${describeFailureCode(code)}` : ""}`,
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

function failureCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

// F4 D6: 카탈로그 코드는 userMessage 한국어 + 코드 병기로 표기(security-abort 관례).
//   미등록 코드는 raw 유지 — 정직 노출(조용한 은폐 금지).
function describeFailureCode(code: string): string {
  const meta = ERROR_CATALOG[code as ErrorCode];
  return meta !== undefined ? `${meta.userMessage.replace(/\.$/, "")}(오류 코드 ${code})` : code;
}
