/**
 * 운영 알림 소스 artifact_redaction — 레다크션 terminal 실패(감사 A4-3).
 *
 * 원천: artifact_redaction_failures 원장(워커가 finalize tx 에서 push). artifacts 행 자체는
 *   RLS(artifacts_visible_isolation)가 failed 를 앱 롤에서 숨기므로(D8-A1) 원장이 유일한 앱-가시 표면이다.
 * detected_at 은 행 타임스탬프라 세대(generation)가 안정 — 자동 발화(OPS_ALERT_AUTO_FIRE_SOURCES) 적격.
 * severity=critical: 증빙이 영구 열람 불가(원본은 at-rest 보존, AUD-9 삭제는 redacted 결정에만 발생).
 */
import type { PoolClient } from "pg";

import type { ComputedOpsAlert } from "./ops-alerts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ArtifactRedactionFailureRow {
  artifact_id: string;
  run_id: string | null;
  failure_kind: string;
  attempts: number;
  detected_at: Date;
}

function mapArtifactRedactionAlert(row: ArtifactRedactionFailureRow): ComputedOpsAlert {
  return {
    alert_id: `artifact_redaction:${row.artifact_id}`,
    severity: "critical",
    source: "artifact_redaction",
    title: "증빙 보호 처리 실패",
    detail:
      row.failure_kind === "terminal"
        ? `실행 증빙의 민감정보 보호(레다크션) 처리가 복구 불가 오류로 실패해 해당 증빙 열람이 차단되었습니다.`
        : `실행 증빙의 민감정보 보호(레다크션) 처리가 ${row.attempts}회 모두 실패해 해당 증빙 열람이 차단되었습니다.`,
    subject_type: "artifact",
    subject_id: row.artifact_id,
    recommended_action:
      "원본은 안전하게 보존되어 있습니다. 보호 처리 실패 원인(저장소 연결·파일 형식)을 점검하고 담당 엔지니어에게 재처리를 요청하세요.",
    route: row.run_id !== null ? `#runTrace?run=${encodeURIComponent(row.run_id)}` : null,
    detected_at: row.detected_at.toISOString(),
    due_at: null,
  };
}

export async function readArtifactRedactionAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<ArtifactRedactionFailureRow>(
    `SELECT artifact_id::text AS artifact_id, run_id::text AS run_id, failure_kind, attempts, detected_at
       FROM artifact_redaction_failures
      WHERE tenant_id = $1::uuid
      ORDER BY detected_at DESC, artifact_id ASC
      LIMIT $2`,
    [tenantId, sourceQueryLimit],
  );
  return result.rows.map(mapArtifactRedactionAlert);
}

export async function readArtifactRedactionAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  const artifactId = alertId.slice("artifact_redaction:".length);
  if (!UUID_RE.test(artifactId)) return null;
  const result = await client.query<ArtifactRedactionFailureRow>(
    `SELECT artifact_id::text AS artifact_id, run_id::text AS run_id, failure_kind, attempts, detected_at
       FROM artifact_redaction_failures
      WHERE tenant_id = $1::uuid
        AND artifact_id = $2::uuid`,
    [tenantId, artifactId],
  );
  return result.rows[0] === undefined ? null : mapArtifactRedactionAlert(result.rows[0]);
}
