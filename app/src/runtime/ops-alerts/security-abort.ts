/**
 * 운영 알림 소스 security_abort — 보안 예외로 즉시 중단된 실행(감사 R3-1, state-machine.md R10).
 *
 * 원천: runs(status='cancelled', failure_reason.code 가 ERROR_CATALOG exceptionClass='security').
 *   R10(running→aborting)→R23(→cancelled)은 드라이버가 완결하며 failure_reason 에 보안 코드를 남긴다 —
 *   이 소스가 runtime-contract securityFailure 의 "알림"(requiresNotificationPort) 절반을 이행한다.
 * detected_at 은 runs.ended_at(행 타임스탬프)라 세대(generation)가 안정 — 자동 발화 적격.
 * severity=critical: 보안 정책 차단은 재시도 대상이 아니라 관리자 개입 대상이다.
 */
import type { PoolClient } from "pg";

import { ERROR_CATALOG, type ErrorCode } from "../../../../ts/error-catalog";
import { UUID_RE, type ComputedOpsAlert } from "./types";

// 카탈로그가 단일 진실원천(error-catalog.ts) — 보안 분류 코드 집합을 여기서 파생(하드코딩 금지).
const SECURITY_ERROR_CODES = Object.entries(ERROR_CATALOG)
  .filter(([, meta]) => meta.exceptionClass === "security")
  .map(([code]) => code);

interface SecurityAbortRow {
  run_id: string;
  failure_code: string;
  ended_at: Date;
}

function mapSecurityAbortAlert(row: SecurityAbortRow): ComputedOpsAlert {
  const meta = ERROR_CATALOG[row.failure_code as ErrorCode];
  return {
    alert_id: `security_abort:${row.run_id}`,
    severity: "critical",
    source: "security_abort",
    title: "보안 차단으로 자동화 중단",
    detail: `실행이 보안 정책에 의해 즉시 중단되었습니다: ${meta?.userMessage ?? row.failure_code}`,
    subject_type: "run",
    subject_id: row.run_id,
    recommended_action: meta?.operatorAction ?? "보안 담당자에게 차단 사유 확인을 요청하세요.",
    route: `#runTrace?run=${encodeURIComponent(row.run_id)}`,
    detected_at: row.ended_at.toISOString(),
    due_at: null,
  };
}

export async function readSecurityAbortAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<SecurityAbortRow>(
    `SELECT id::text AS run_id, failure_reason->>'code' AS failure_code, ended_at
       FROM runs
      WHERE tenant_id = $1::uuid
        AND status = 'cancelled'
        AND ended_at IS NOT NULL
        AND failure_reason->>'code' = ANY($2::text[])
      ORDER BY ended_at DESC, id ASC
      LIMIT $3`,
    [tenantId, SECURITY_ERROR_CODES, sourceQueryLimit],
  );
  return result.rows.map(mapSecurityAbortAlert);
}

export async function readSecurityAbortAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  const runId = alertId.slice("security_abort:".length);
  if (!UUID_RE.test(runId)) return null;
  const result = await client.query<SecurityAbortRow>(
    `SELECT id::text AS run_id, failure_reason->>'code' AS failure_code, ended_at
       FROM runs
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND status = 'cancelled'
        AND ended_at IS NOT NULL
        AND failure_reason->>'code' = ANY($3::text[])`,
    [tenantId, runId, SECURITY_ERROR_CODES],
  );
  return result.rows[0] === undefined ? null : mapSecurityAbortAlert(result.rows[0]);
}
