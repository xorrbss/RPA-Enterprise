// 오프보딩 잠금(설계 rpa-offboarding-data-export-deletion-design O3) — soft 단계의 의미.
// approved/purging 원장이 있는 테넌트는 신규 활동(쓰기 명령·트리거 발화)을 만들 수 없다.
// 읽기·반출은 허용(유예 창의 존재 이유 = 반출 완료 + 오조작 복구), 복구 방향 명령(취소·결정·run 중지)도 허용.
import type { Pool, PoolClient } from "pg";

import type { RbacAction } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";

/** 잠금 중에도 허용하는 쓰기 명령 — 전부 "활동을 만드는" 방향이 아니라 "멈추거나 복구하는" 방향이다. */
export const OFFBOARDING_LOCK_EXEMPT_ACTIONS: ReadonlySet<RbacAction> = new Set<RbacAction>([
  "tenant_data.purge.request", // 취소(복구 창의 목적) — 요청 생성은 활성 UNIQUE 가 어차피 409
  "tenant_data.purge.approve", // pending 반려 등 원장 결정
  "run.abort",                 // 진행 중 활동 중지는 오프보딩과 같은 방향(안전)
]);

export interface ActiveOffboardingLock {
  readonly request_id: string;
  readonly status: "pending" | "approved" | "purging";
  readonly purge_after: Date | null;
}

/**
 * 활성 원장 행(pending/approved/purging) 단건 조회 — 배너/capabilities 용.
 * 잠금 판정은 approved/purging 만(pending 은 아직 승인 전 — 차단하지 않는다).
 */
export async function readActiveOffboardingRequest(client: PoolClient): Promise<ActiveOffboardingLock | null> {
  const result = await client.query<ActiveOffboardingLock>(
    `SELECT id AS request_id, status, purge_after
       FROM tenant_offboarding_requests
      WHERE status IN ('pending','approved','purging')
      LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

/** 쓰기 명령 preHandler 게이트용 — approved/purging 이면 잠금(인덱스 단건 조회, 요청당 1회). */
export async function isTenantOffboardingLocked(pool: Pool, tenantId: string): Promise<boolean> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM tenant_offboarding_requests WHERE status IN ('approved','purging') LIMIT 1`,
    );
    return result.rows.length > 0;
  });
}
