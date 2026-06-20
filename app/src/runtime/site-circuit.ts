/**
 * 사이트 서킷(ops-defaults §3 site.circuit) — block_rate 기반 circuit breaker 의 표본 기록 + 상태 전이.
 *
 * worker 서킷(per-worker 연속 카운터)과 달리 사이트는 **rolling window 내 block_rate**(blocks/total)로 트리거한다
 * (계약: site.circuit.block_rate_threshold + window + min_samples). 표본은 site_block_samples(drive 1회=1행)에
 * 적재되며, 분자(blocked=차단)는 challenge 자동감지(run-step-driver driveSuspend 의 s.kind<>'human_task' = 사이트가
 * 봇을 차단; reserved-handlers @challenge→SITE_CIRCUIT_OPEN), 분모는 모든 drive 시도다. SITE_PROFILE_BLOCKED
 * (승인게이트·403·security·영구)는 표본이 아니다 — transient 차단(SITE_CIRCUIT_OPEN·503·system·retryable)만 센다.
 *
 * 상태 전이는 전부 여기(record*)서 수행하고, 게이트(runtime-worker acquireBrowserLease)는 **read-only 판정**만
 * 한다 — worker 서킷과 동일한 규율(게이트가 전이하면 프로브 없는 경로가 limbo 를 남김). 회복=lazy auto-close(신규
 * 컬럼 없음): cooldown(open_duration) 경과 후 다음 drive 가 프로브이며, 비차단(성공)이면 open→closed(회복 확정),
 * 차단이면 재open+새 cooldown.
 *
 * 휴면-but-correct: live 환경에서 분자(challenge 자동감지)는 DOM/vision executor 의 challenge 인식이 성숙(後行)할
 * 수록 차오른다. 그 전까지 blocks=0 → rate=0 → closed 유지(올바른 휴면, dead code 아님 — 표본은 실제 시도를 기록).
 * site_profiles.circuit_state/circuit_until 이 상태 보유처(계약은 분모 미보유 — site_block_samples 가 보충).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { withTenantTx } from "../db/pool";
import { emitOutboxEvent, EVENTS_OUTBOX_RETENTION_POLICY } from "./outbox";

export interface SiteCircuitConfig {
  /** rolling window 내 차단율 임계(0..1). ops-defaults §3 site.circuit.block_rate_threshold(기본 30%). */
  readonly blockRateThreshold: number;
  /** rolling window 길이(ms). ops-defaults §3 site.circuit.window(기본 5m). */
  readonly windowMs: number;
  /** 표본 부족 시 미발동 하한. ops-defaults §3 site.circuit.window min_samples(기본 20). */
  readonly minSamples: number;
  /** open 진입 cooldown(ms). ops-defaults §3 site.circuit.open_duration(기본 15m). 경과 후 다음 drive=프로브. */
  readonly openMs: number;
}

export const DEFAULT_SITE_CIRCUIT: SiteCircuitConfig = Object.freeze({
  blockRateThreshold: 0.3,
  windowMs: 5 * 60 * 1000,
  minSamples: 20,
  openMs: 15 * 60 * 1000,
});

export interface SiteCircuitSampleInput {
  readonly tenantId: string;
  readonly siteProfileId: string;
  /** 이 표본을 만든 drive 의 run correlation_id — 전이 시 발행하는 site.circuit_* 이벤트의 correlation_id. */
  readonly correlationId: string;
  /** true=차단(challenge 자동감지), false=정상 시도. */
  readonly blocked: boolean;
}

type SiteCircuitEventType = "site.circuit_opened" | "site.circuit_closed";

/**
 * drive 1회 종료 후 표본 1행 적재 + 상태 전이(open/close). drive tx 와 분리된 best-effort 기록(호출측이 catch).
 * 단일 tenant tx: 표본 INSERT + window prune + CAS 전이 + (전이 시)이벤트 발행을 원자로 묶는다.
 */
export async function recordSiteCircuitOutcome(
  pool: pg.Pool,
  config: SiteCircuitConfig,
  input: SiteCircuitSampleInput,
): Promise<void> {
  await withTenantTx(pool, input.tenantId, async (client) => {
    // 1) 표본 적재 + window 밖 행 lazy prune(무한 성장 방지 — 사이트당 ~window 분량만 보존).
    await client.query(
      `INSERT INTO site_block_samples (id, tenant_id, site_profile_id, blocked)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [randomUUID(), input.tenantId, input.siteProfileId, input.blocked],
    );
    await client.query(
      `DELETE FROM site_block_samples
        WHERE tenant_id = $1::uuid AND site_profile_id = $2::uuid
          AND occurred_at < now() - ($3::bigint * interval '1 millisecond')`,
      [input.tenantId, input.siteProfileId, config.windowMs],
    );

    if (input.blocked) {
      // (a) 프로브 재open: open/half_open + cooldown 경과(또는 NULL=레거시/수동 open) 상태에서 차단 = 프로브 실패
      //     → 재open + 새 cooldown. circuit_state 는 'open' 유지이므로 site.circuit_opened 재발행 불필요.
      const reopen = await client.query(
        `UPDATE site_profiles
            SET circuit_state = 'open',
                circuit_until = now() + ($3::bigint * interval '1 millisecond')
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND circuit_state IN ('open','half_open')
            AND (circuit_until IS NULL OR circuit_until <= now())`,
        [input.tenantId, input.siteProfileId, config.openMs],
      );
      if ((reopen.rowCount ?? 0) > 0) return;

      // (b) closed→open: window 내 block_rate(blocks/total) 평가. min_samples 충족 + threshold 이상이면 open.
      //     blocks >= total*threshold 로 정수나눗셈 회피(numeric). CAS WHERE circuit_state='closed' 가 전이를 1회로 한정.
      const opened = await client.query<{ circuit_until: Date }>(
        `WITH w AS (
           SELECT count(*)::int AS total, count(*) FILTER (WHERE blocked)::int AS blocks
             FROM site_block_samples
            WHERE tenant_id = $1::uuid AND site_profile_id = $2::uuid
              AND occurred_at > now() - ($4::bigint * interval '1 millisecond')
         )
         UPDATE site_profiles sp
            SET circuit_state = 'open',
                circuit_until = now() + ($5::bigint * interval '1 millisecond')
           FROM w
          WHERE sp.tenant_id = $1::uuid AND sp.id = $2::uuid AND sp.circuit_state = 'closed'
            AND w.total >= $3::int
            AND w.blocks::numeric >= w.total::numeric * $6::numeric
          RETURNING sp.circuit_until`,
        [input.tenantId, input.siteProfileId, config.minSamples, config.windowMs, config.openMs, config.blockRateThreshold],
      );
      const row = opened.rows[0];
      if (row !== undefined) {
        await emitSiteCircuitEvent(
          client,
          input,
          "site.circuit_opened",
          `site-circuit-opened:${input.siteProfileId}:${row.circuit_until.toISOString()}`,
        );
      }
    } else {
      // ok 표본 = lazy auto-close 프로브 성공: cooldown 경과한 open/half_open 이면 closed(회복 확정).
      //   circuit_until > now()(cooldown 진행 중) 인 정상 표본은 프로브가 아니라 게이트 통과 직후의 잔여 drive → 닫지 않음.
      const closed = await client.query(
        `UPDATE site_profiles
            SET circuit_state = 'closed', circuit_until = NULL
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND circuit_state IN ('open','half_open')
            AND (circuit_until IS NULL OR circuit_until <= now())`,
        [input.tenantId, input.siteProfileId],
      );
      if ((closed.rowCount ?? 0) > 0) {
        await emitSiteCircuitEvent(
          client,
          input,
          "site.circuit_closed",
          `site-circuit-closed:${input.siteProfileId}:${input.correlationId}`,
        );
      }
    }
  });
}

/** site.circuit_opened/closed 발행(run-less tenant 이벤트, closed-empty payload). correlation_id=트리거 run. */
async function emitSiteCircuitEvent(
  client: pg.PoolClient,
  input: SiteCircuitSampleInput,
  eventType: SiteCircuitEventType,
  idempotencyKey: string,
): Promise<void> {
  await emitOutboxEvent(client, {
    tenantId: input.tenantId,
    eventType,
    correlationId: input.correlationId,
    idempotencyKey,
    retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
  });
}
