/**
 * 운영 알림 계산 소스 — 거버넌스/플랫폼 계열: bot_pool · scim_secret_rotation · audit_verifier ·
 * readiness_evidence. compute.ts 의 readComputedOpsAlerts/readComputedOpsAlertById 디스패처가 소비한다.
 */
import type { PoolClient } from "pg";

import { readBrowserBotPool, type BotPoolItem } from "../bot-pool-read";
import {
  SCIM_SECRET_ROTATION_DUE_SOON_DAYS,
  scimSecretRotationDueAt,
  scimSecretRotationStatus,
  type ScimSecretRotationPolicy,
} from "../scim-secret-rotation-policy";
import { workerStaleThresholdSeconds } from "../worker-heartbeat-policy";
import type { ComputedOpsAlert } from "./types";

type ProductionReadinessEvidenceAlertType =
  | "external_alert_delivery"
  | "managed_backup_restore_drill"
  | "slo_oncall_signoff"
  | "support_training_completion"
  | "observability_telemetry_wiring";
type ProductionReadinessEvidenceAlertStatus = "valid" | "failed";

interface BotPoolDetectedAtRow {
  detected_at: Date;
}

interface ScimSecretRotationAlertRow {
  provider_key: string;
  display_name: string;
  secret_rotation_policy: ScimSecretRotationPolicy;
  created_at: Date;
  last_secret_rotated_at: Date | null;
  decommissioned_at: Date | null;
}

interface AuditVerifierLatestRunRow {
  id: string;
  status: "valid" | "invalid" | "failed";
  rows_checked: string;
  violation_count: number;
  completed_at: Date;
}

interface AuditVerifierFreshnessRow {
  audit_count: string;
  latest_audit_at: Date | null;
  latest_run_id: string | null;
  latest_status: "valid" | "invalid" | "failed" | null;
  latest_completed_at: Date | null;
  stale: boolean;
}

interface ProductionReadinessEvidenceAlertRow {
  evidence_type: ProductionReadinessEvidenceAlertType;
  status: ProductionReadinessEvidenceAlertStatus;
  evidence_at: Date;
  expires_at: Date | null;
  recorded_at: Date;
}

const AUDIT_VERIFIER_STALE_AFTER_MS = 75 * 60 * 1000;
const READINESS_EVIDENCE_DUE_SOON_DAYS = 14;

export async function readBotPoolAlerts(client: PoolClient, tenantId: string): Promise<ComputedOpsAlert[]> {
  const pool = await readBrowserBotPool(client, tenantId);
  if (pool.health === "ok") return [];
  const detectedAt = await readBotPoolDetectedAt(client, tenantId, pool.capacity.live_capacity.pool_key);
  return [mapBotPoolAlert(pool, detectedAt)];
}

async function readBotPoolDetectedAt(client: PoolClient, tenantId: string, poolKey: string): Promise<string> {
  const staleThresholdSeconds = workerStaleThresholdSeconds();
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
           AND w.heartbeat_at <= now() - ($3::integer * interval '1 second')
           AND (($2 = 'default' AND m.worker_id IS NULL) OR m.pool_key = $2)),
       now()
     ) AS detected_at`,
    [tenantId, poolKey, staleThresholdSeconds],
  );
  return (result.rows[0]?.detected_at ?? new Date()).toISOString();
}

export async function readScimSecretRotationAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<ScimSecretRotationAlertRow>(
    `WITH provider_rotation AS (
       SELECT provider_key, display_name, secret_rotation_policy, created_at, last_secret_rotated_at, decommissioned_at,
              COALESCE(last_secret_rotated_at, created_at) +
              CASE secret_rotation_policy
                WHEN 'periodic_30d' THEN interval '30 days'
                WHEN 'periodic_60d' THEN interval '60 days'
                WHEN 'periodic_90d' THEN interval '90 days'
              END AS rotation_due_at
         FROM scim_providers
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND decommissioned_at IS NULL
          AND secret_rotation_policy <> 'manual'
     )
     SELECT provider_key, display_name, secret_rotation_policy, created_at, last_secret_rotated_at, decommissioned_at
       FROM provider_rotation
      WHERE rotation_due_at <= now() + ($2::int * interval '1 day')
      ORDER BY (rotation_due_at <= now()) DESC, rotation_due_at ASC, provider_key ASC
      LIMIT $3`,
    [tenantId, SCIM_SECRET_ROTATION_DUE_SOON_DAYS, sourceQueryLimit],
  );
  return result.rows.flatMap(mapScimSecretRotationAlert);
}

export async function readScimSecretRotationAlertByProvider(
  client: PoolClient,
  tenantId: string,
  providerKey: string,
): Promise<ComputedOpsAlert | null> {
  const result = await client.query<ScimSecretRotationAlertRow>(
    `SELECT provider_key, display_name, secret_rotation_policy, created_at, last_secret_rotated_at, decommissioned_at
       FROM scim_providers
      WHERE tenant_id = $1::uuid
        AND provider_key = $2::text
        AND status = 'active'
        AND decommissioned_at IS NULL
        AND secret_rotation_policy <> 'manual'`,
    [tenantId, providerKey],
  );
  return mapScimSecretRotationAlert(result.rows[0]).at(0) ?? null;
}

export async function readAuditVerifierAlerts(client: PoolClient, tenantId: string): Promise<ComputedOpsAlert[]> {
  const latestRun = await client.query<AuditVerifierLatestRunRow>(
    `SELECT id, status, rows_checked::text, violation_count, completed_at
       FROM audit_verifier_runs
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
      ORDER BY completed_at DESC, id DESC
      LIMIT 1`,
    [tenantId],
  );
  const freshness = await readAuditVerifierFreshness(client, tenantId);
  return [
    ...mapAuditVerifierStatusAlert(latestRun.rows[0]),
    ...mapAuditVerifierStaleAlert(freshness.rows[0]),
  ];
}

export async function readAuditVerifierAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  if (alertId === "audit_verifier:stale") {
    return (await readAuditVerifierAlerts(client, tenantId)).find((alert) => alert.alert_id === alertId) ?? null;
  }
  const verificationRunId = alertId.slice("audit_verifier:".length);
  const result = await client.query<AuditVerifierLatestRunRow>(
    `SELECT id, status, rows_checked::text, violation_count, completed_at
       FROM audit_verifier_runs r
      WHERE r.tenant_id = $1::uuid
        AND r.id::text = $2
        AND r.deleted_at IS NULL
        AND r.status IN ('invalid','failed')
        AND NOT EXISTS (
          SELECT 1
            FROM audit_verifier_runs newer
           WHERE newer.tenant_id = r.tenant_id
             AND newer.deleted_at IS NULL
             AND (newer.completed_at, newer.id) > (r.completed_at, r.id)
        )`,
    [tenantId, verificationRunId],
  );
  return mapAuditVerifierStatusAlert(result.rows[0]).at(0) ?? null;
}

async function readAuditVerifierFreshness(
  client: PoolClient,
  tenantId: string,
): Promise<{ rows: AuditVerifierFreshnessRow[] }> {
  return client.query<AuditVerifierFreshnessRow>(
    `WITH latest_run AS (
       SELECT id, status, completed_at
         FROM audit_verifier_runs
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
     )
     SELECT
       (SELECT count(*)::text
          FROM audit_log
         WHERE tenant_id = $1::uuid
           AND deleted_at IS NULL) AS audit_count,
       (SELECT max(occurred_at)
          FROM audit_log
         WHERE tenant_id = $1::uuid
           AND deleted_at IS NULL) AS latest_audit_at,
       latest_run.id::text AS latest_run_id,
       latest_run.status AS latest_status,
       latest_run.completed_at AS latest_completed_at,
       (latest_run.completed_at IS NULL
        OR latest_run.completed_at <= now() - ($2::bigint * interval '1 millisecond')) AS stale
      FROM (SELECT 1) seed
      LEFT JOIN latest_run ON true`,
    [tenantId, AUDIT_VERIFIER_STALE_AFTER_MS],
  );
}

export async function readReadinessEvidenceAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<ProductionReadinessEvidenceAlertRow>(
    `WITH ranked AS (
       SELECT evidence_type, status, evidence_at, expires_at, recorded_at,
              row_number() OVER (
                PARTITION BY evidence_type
                ORDER BY evidence_at DESC, recorded_at DESC, id DESC
              ) AS rn
         FROM production_readiness_evidence
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND evidence_type IN ('external_alert_delivery','managed_backup_restore_drill','slo_oncall_signoff','support_training_completion','observability_telemetry_wiring')
     )
     SELECT evidence_type, status, evidence_at, expires_at, recorded_at
       FROM ranked
      WHERE rn = 1
        AND (
          status = 'failed'
          OR expires_at IS NULL
          OR expires_at <= now() + ($2::int * interval '1 day')
        )
      ORDER BY (status = 'failed') DESC,
               (expires_at IS NULL OR expires_at <= now()) DESC,
               expires_at ASC NULLS FIRST,
               evidence_type ASC
      LIMIT $3`,
    [tenantId, READINESS_EVIDENCE_DUE_SOON_DAYS, sourceQueryLimit],
  );
  return result.rows.map(mapReadinessEvidenceAlert);
}

export async function readReadinessEvidenceAlertByType(
  client: PoolClient,
  tenantId: string,
  evidenceType: string,
): Promise<ComputedOpsAlert | null> {
  if (!isReadinessEvidenceAlertType(evidenceType)) return null;
  const result = await client.query<ProductionReadinessEvidenceAlertRow>(
    `WITH ranked AS (
       SELECT evidence_type, status, evidence_at, expires_at, recorded_at,
              row_number() OVER (
                PARTITION BY evidence_type
                ORDER BY evidence_at DESC, recorded_at DESC, id DESC
              ) AS rn
         FROM production_readiness_evidence
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND evidence_type = $2::text
     )
     SELECT evidence_type, status, evidence_at, expires_at, recorded_at
       FROM ranked
      WHERE rn = 1
        AND (
          status = 'failed'
          OR expires_at IS NULL
          OR expires_at <= now() + ($3::int * interval '1 day')
        )`,
    [tenantId, evidenceType, READINESS_EVIDENCE_DUE_SOON_DAYS],
  );
  return result.rows[0] === undefined ? null : mapReadinessEvidenceAlert(result.rows[0]);
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
    recommended_action: "봇 풀 용량, 만료된 점유(lease), 실행기 상태 신호(heartbeat)와 회로 차단(circuit) 상태를 확인하세요.",
    route: "#automationOps?section=queue", // 봇풀 패널이 큐 섹션에 렌더 — view key/section 은 라우터·Orchestration 이 실제 소비하는 값만 사용(dead link 금지)
    detected_at: detectedAt,
    due_at: null,
  };
}

function mapScimSecretRotationAlert(row: ScimSecretRotationAlertRow | undefined): ComputedOpsAlert[] {
  if (row === undefined) return [];
  const dueAt = scimSecretRotationDueAt(row.secret_rotation_policy, row.created_at, row.last_secret_rotated_at);
  if (dueAt === null) return [];
  const rotationStatus = scimSecretRotationStatus(
    row.secret_rotation_policy,
    row.created_at,
    row.last_secret_rotated_at,
    row.decommissioned_at,
  );
  if (rotationStatus !== "due_soon" && rotationStatus !== "overdue") return [];
  const overdue = rotationStatus === "overdue";
  const detectedAt = overdue
    ? dueAt
    : new Date(dueAt.getTime() - SCIM_SECRET_ROTATION_DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  return [{
    alert_id: `scim_secret_rotation:${row.provider_key}`,
    severity: overdue ? "critical" : "warning",
    source: "scim_secret_rotation",
    // F4 D5: 운영자 한국어 카피. 기한 시각은 detail 에서 빼고 기존 due_at 필드로 일원화(web 이 한국어 시각으로 렌더).
    title: overdue ? "SCIM 서명 비밀 교체 기한 경과" : "SCIM 서명 비밀 교체 기한 임박",
    detail: `${row.display_name}(${row.provider_key})의 교체 정책(${row.secret_rotation_policy}) 기한이 ${overdue ? "지났습니다" : "다가오고 있습니다"}.`,
    subject_type: "scim_provider",
    subject_id: row.provider_key,
    recommended_action: "새로 발급한 서명 비밀 참조로 제공자 설정을 갱신하세요.",
    route: `#security?section=access&provider=${encodeURIComponent(row.provider_key)}`,
    detected_at: detectedAt.toISOString(),
    due_at: dueAt.toISOString(),
  }];
}

function mapAuditVerifierStatusAlert(row: AuditVerifierLatestRunRow | undefined): ComputedOpsAlert[] {
  if (row === undefined || row.status === "valid") return [];
  return [{
    alert_id: `audit_verifier:${row.id}`,
    severity: "critical",
    source: "audit_verifier",
    title: row.status === "failed" ? "감사 체인 자동 검증 실패" : "감사 체인 무결성 위반",
    detail: row.status === "failed"
      ? "최신 감사 체인 검증 job이 실패했습니다. 실패 증적이 남아 있으며 운영자가 재검증해야 합니다."
      : `최신 감사 체인 검증에서 ${row.violation_count}건의 위반이 발견되었습니다. 검증 범위는 ${row.rows_checked}행입니다.`,
    subject_type: "audit_verifier",
    subject_id: row.id,
    recommended_action: "감사 이력 화면에서 검증 실행 증적을 확인하고 수동 재검증 또는 사고 대응 절차를 시작하세요.",
    route: "#auditExplorer",
    detected_at: row.completed_at.toISOString(),
    due_at: null,
  }];
}

function mapAuditVerifierStaleAlert(row: AuditVerifierFreshnessRow | undefined): ComputedOpsAlert[] {
  if (row === undefined || Number(row.audit_count) === 0 || !row.stale) return [];
  const dueAt = row.latest_completed_at === null
    ? null
    : new Date(row.latest_completed_at.getTime() + AUDIT_VERIFIER_STALE_AFTER_MS);
  const detectedAt = row.latest_completed_at ?? row.latest_audit_at ?? new Date();
  return [{
    alert_id: "audit_verifier:stale",
    severity: "warning",
    source: "audit_verifier",
    title: "감사 체인 검증 증적 지연",
    detail: row.latest_completed_at === null
      ? "감사 로그가 존재하지만 아직 자동 검증 실행 증적이 없습니다."
      : `마지막 감사 체인 검증이 ${row.latest_completed_at.toISOString()} 이후 갱신되지 않았습니다.`,
    subject_type: "audit_verifier",
    subject_id: row.latest_run_id,
    recommended_action: "자동 점검 일정(maintenance scheduler)과 감사 검증 작업의 처리 상태를 확인하고 필요하면 수동 검증을 실행하세요.",
    route: "#auditExplorer",
    detected_at: detectedAt.toISOString(),
    due_at: dueAt?.toISOString() ?? null,
  }];
}

function mapReadinessEvidenceAlert(row: ProductionReadinessEvidenceAlertRow): ComputedOpsAlert {
  const label = readinessEvidenceLabel(row.evidence_type);
  const failed = row.status === "failed";
  const expired = row.expires_at === null || row.expires_at.getTime() <= Date.now();
  const detectedAt = failed
    ? row.evidence_at
    : row.expires_at === null
      ? row.evidence_at
      : new Date(row.expires_at.getTime() - READINESS_EVIDENCE_DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  return {
    alert_id: `readiness_evidence:${row.evidence_type}`,
    severity: failed || expired ? "critical" : "warning",
    source: "readiness_evidence",
    // F4 D5: 운영자 한국어 카피. 만료 시각은 detail 에서 빼고 기존 due_at 필드로 일원화(web 이 한국어 시각으로 렌더).
    title: failed
      ? `${label} 증빙 실패`
      : expired
        ? `${label} 증빙 만료`
        : `${label} 증빙 만료 임박`,
    detail: failed
      ? `${label}의 최신 운영 전환 증빙이 실패로 기록되어 있습니다.`
      : row.expires_at === null
        ? `${label}의 최신 운영 전환 증빙에 만료 시각이 없어 준비 완료로 볼 수 없습니다.`
        : `${label}의 최신 운영 전환 증빙이 곧 만료됩니다.`,
    subject_type: "readiness_evidence",
    subject_id: row.evidence_type,
    recommended_action: "운영 준비 화면에서 유효한 증빙을 다시 기록한 뒤 전환을 진행하세요.",
    route: "#automationOps?section=readiness",
    detected_at: detectedAt.toISOString(),
    due_at: row.expires_at?.toISOString() ?? null,
  };
}

function isReadinessEvidenceAlertType(value: string): value is ProductionReadinessEvidenceAlertType {
  return (
    value === "external_alert_delivery" ||
    value === "managed_backup_restore_drill" ||
    value === "slo_oncall_signoff" ||
    value === "support_training_completion" ||
    value === "observability_telemetry_wiring"
  );
}

// F4 D5: web 운영 준비 게이트 라벨(production-readiness-labels.ts)과 동일 어휘 — 화면 간 역어 불일치 방지.
function readinessEvidenceLabel(evidenceType: ProductionReadinessEvidenceAlertType): string {
  if (evidenceType === "external_alert_delivery") return "외부 알림 전달";
  if (evidenceType === "managed_backup_restore_drill") return "백업 복구 리허설";
  if (evidenceType === "slo_oncall_signoff") return "SLO·당직 승인";
  if (evidenceType === "support_training_completion") return "지원·교육 완료";
  return "관측성 연결";
}
