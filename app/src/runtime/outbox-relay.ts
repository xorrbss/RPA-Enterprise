/**
 * Outbox relay (D2 — architecture.md §4 "outbox → event bus").
 *
 * 미발행(events_outbox.published_at IS NULL) 행을 발행 처리한다. v1은 외부 버스 브리지(P3) 전까지
 * `published_at` 마킹으로 at-least-once 경계를 확정한다(실 버스 중계는 P3 D11). publish는 CAS —
 * `WHERE event_id=? AND published_at IS NULL`(DDL 주석) — 0 row면 다른 relay가 이미 발행(재발행 안 함).
 *
 * RLS로 테넌트 스코프(호출측이 withTenantTx로 app.tenant_id 바인딩). 인프라-와이드 relay는
 * BYPASSRLS infra 역할로 별도 운영(ops 경계) — 여기서는 테넌트 단위 발행.
 */
import type { PoolClient } from "pg";

export interface RelayResult {
  readonly publishedEventIds: readonly string[];
}

export async function relayOutbox(client: PoolClient, opts?: { readonly limit?: number }): Promise<RelayResult> {
  const limit = opts?.limit ?? 100;
  const candidates = await client.query<{ event_id: string }>(
    `SELECT event_id FROM events_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
    [limit],
  );
  const published: string[] = [];
  for (const row of candidates.rows) {
    const cas = await client.query(
      `UPDATE events_outbox SET published_at = now()
        WHERE event_id = $1::uuid AND published_at IS NULL
      RETURNING event_id`,
      [row.event_id],
    );
    if (cas.rowCount === 1) published.push(row.event_id);
  }
  return { publishedEventIds: published };
}
