/**
 * browser_leases 행 SQL 조작 (runtime-worker.ts 분해 — 동작 무변경 이동).
 *
 * renew(heartbeat/expires 연장)·drain(draining/expired 전이)·INIT실패 예약행 DELETE. 순수 SQL leaf —
 * runtime-worker 내부 비-export 타입 의존 0(입력 인터페이스는 함께 이동). 클래스는 deleteInitReservedBrowserLease를,
 * claim int 테스트는 renew/drain을 직접 import한다(단방향, back-cycle 없음).
 */
import type pg from "pg";

import type { IsoDateTime, LeaseRenewResult } from "../../../ts/runtime-contract";

export interface BrowserLeaseRenewInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly ttlMs: number;
}

export interface BrowserLeaseDrainInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly reason: "run_cancelled" | "run_completed" | "run_suspended" | "sweeper";
}

export async function renewBrowserLease(
  client: pg.PoolClient,
  input: BrowserLeaseRenewInput,
): Promise<LeaseRenewResult> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("renewBrowserLease: ttlMs must be a positive integer");
  }
  const renewed = await client.query<{ expires_at: string }>(
    `UPDATE browser_leases
        SET heartbeat_at = now(),
            expires_at = now() + ($4::int * interval '1 millisecond')
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')
        AND expires_at >= now()
      RETURNING expires_at::text`,
    [input.tenantId, input.leaseId, input.workerId, input.ttlMs],
  );
  const row = renewed.rows[0];
  if (row !== undefined) return { kind: "renewed", expiresAt: row.expires_at as IsoDateTime };
  return {
    kind: "lost",
    code: "BROWSER_LEASE_EXPIRED",
    reason: "lease missing, owned by another worker, drained, cross-tenant, or expired",
  };
}

export async function drainBrowserLease(
  client: pg.PoolClient,
  input: BrowserLeaseDrainInput,
): Promise<void> {
  await client.query(
    `UPDATE browser_leases
        SET state = CASE WHEN $4 = 'sweeper' THEN 'expired' ELSE 'draining' END,
            expires_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')`,
    [input.tenantId, input.leaseId, input.workerId, input.reason],
  );
}

/**
 * INIT 실패(R3a/R3b) 시 Phase A 에서 예약(active)만 된 browser lease 행을 **삭제**한다. INIT 실패는 bind 가 throw 한
 * 경우라 라이브 세션이 열린 적이 없어 teardown 이 불요하고, drain('draining' 잔류)은 종결자가 없어 누적된다(행 누수).
 * 더 중요한 건 재-claim 이 신규 lease 를 INSERT 해 run 당 lease 가 2행이 되면 abort 의 claimAbortBrowserLeaseForRun
 * (run_id 별 LIMIT 2)이 'multiple'→CONTROL_PLANE_INTERNAL_ERROR 로 wedge 되는 것(적대리뷰 B1) — 행을 삭제해
 * 'run 당 활성 lease ≤1' 불변식을 복원한다. owner 가드(다른 워커 lease 미삭제).
 */
export async function deleteInitReservedBrowserLease(
  client: pg.PoolClient,
  input: { readonly tenantId: string; readonly leaseId: string; readonly workerId: string },
): Promise<void> {
  await client.query(
    `DELETE FROM browser_leases
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND owner_worker_id = $3::uuid`,
    [input.tenantId, input.leaseId, input.workerId],
  );
}
