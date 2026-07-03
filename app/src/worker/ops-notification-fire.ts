/**
 * 무인 운영 알림 자동 발화 (S4a/S4b) — producer.
 *
 * 감사 alerts-console-pull-only(P1): 운영 알림이 콘솔 조회 시점에만 계산되고 외부 발송은 건별 수동 폼뿐이라,
 *   무인 시간대(야간·주말) 장애가 어디에도 통지되지 않았다. 전달 파이프라인(ops_notification_attempts → 워커
 *   ops_notification_send → deliverOpsNotificationAttempt)은 이미 완성돼 있으므로, 이 모듈이 빠져 있던 producer 를
 *   채운다: 계산된 알림을 라우팅 규칙에 매칭해 pending attempt 를 만들고 발송 잡을 인큐한다.
 *   라우팅 규칙은 두 출처의 합집합이다 — 배포-소유 env `OPS_ALERT_ROUTES`(S4a) + 테넌트 저장형
 *   `ops_alert_notification_routes`(S4b, fireForTenant 안에서 테넌트별로 읽음).
 *
 * 멱등: 같은 세대(tenant+alert_id+detected_at+provider)에 대해 non-deleted attempt 가 이미 있으면 건너뛴다.
 *   detected_at 은 행 타임스탬프(안정)라 같은 장애가 반복 틱마다 재발화되지 않는다(폭주 방지). 조건이 실제로 바뀌면
 *   detected_at 이 바뀌어 새 세대로 재발화된다. (자동 발화 대상은 detected_at 안정 소스로 제한 — ops-alert-routes.ts.)
 *
 * 휴면 함정: 라우트가 설정됐는데 대상 테넌트가 없으면(=조용한 무발화) onWarn 으로 loud 경고한다.
 */
import type { PoolClient } from "pg";

import {
  insertOpsNotificationAttempt,
  readComputedOpsAlerts,
  type ComputedOpsAlert,
  type OpsAlertSeverity,
  type OpsNotificationWebhookSendInput,
} from "../api/ops-alerts";
import { readActiveOpsAlertNotificationRoutes } from "../runtime/ops-alert-notification-store";
import type { OpsNotificationSendEnqueueInput } from "../runtime/run-queue";
import { withTenantTx, type PgPool } from "../db/pool";
import { OPS_ALERT_AUTO_FIRE_SOURCES, type OpsAlertRoute } from "../runtime/ops-alert-routes";

// 자동 발화 요청자(감사 귀속). 사람 명령이 아닌 시스템 발화임을 명시.
const AUTO_FIRE_REQUESTED_BY = "system:ops-alert-auto-fire";
// 틱당 테넌트별 알림 계산 상한(수동 조회 route 기본과 동형). 폭주 방지 + 성능.
const AUTO_FIRE_ALERT_LIMIT = 50;

export interface OpsNotificationFireEnqueuer {
  enqueueOpsNotificationSend?(client: PoolClient, input: OpsNotificationSendEnqueueInput, delayMs?: number): Promise<void>;
}

export interface OpsNotificationFireInput {
  readonly tenantIds: readonly string[];
  readonly routes: readonly OpsAlertRoute[];
  readonly enqueuer: OpsNotificationFireEnqueuer;
  readonly correlationId: () => string;
  /** 라우트 설정 + 대상 테넌트 없음(휴면) 경고 채널. 기본 console.error. */
  readonly onWarn?: (message: string) => void;
}

export interface OpsNotificationFireSummary {
  readonly created: number;
  readonly skipped: number;
  readonly tenantsProcessed: number;
}

const SEVERITY_RANK: Record<OpsAlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

function severityMeetsThreshold(severity: OpsAlertSeverity, min: OpsAlertRoute["minSeverity"]): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

function routeMatchesAlert(route: OpsAlertRoute, alert: ComputedOpsAlert): boolean {
  if (route.source !== undefined && route.source !== alert.source) return false;
  return severityMeetsThreshold(alert.severity, route.minSeverity);
}

function routeToSendInput(route: OpsAlertRoute, alert: ComputedOpsAlert): OpsNotificationWebhookSendInput {
  return {
    providerAlias: route.providerAlias,
    endpointSecretRef: route.endpointSecretRef,
    callbackSignatureSecretRef: route.callbackSignatureSecretRef ?? null,
    routePolicyRef: route.routePolicyRef,
    recipientGroupRef: route.recipientGroupRef ?? null,
    allowedHosts: route.allowedHosts,
    summary: null,
    metadata: {
      auto_fired: true,
      severity: alert.severity,
      source: alert.source,
    },
    legalHold: false,
  };
}

// 세대 멱등 가드 — 같은 (tenant, alert_id, detected_at, provider) 에 대해 살아있는 attempt 가 이미 있으면 true.
async function generationAlreadyNotified(
  client: PoolClient,
  tenantId: string,
  alertId: string,
  detectedAt: string,
  providerAlias: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM ops_notification_attempts
      WHERE tenant_id = $1::uuid
        AND alert_id = $2
        AND detected_at = $3::timestamptz
        AND provider_alias = $4
        AND deleted_at IS NULL
      LIMIT 1`,
    [tenantId, alertId, detectedAt, providerAlias],
  );
  return result.rows.length > 0;
}

async function fireForTenant(
  pool: PgPool,
  tenantId: string,
  routes: readonly OpsAlertRoute[],
  input: OpsNotificationFireInput,
): Promise<{ created: number; skipped: number }> {
  const enqueue = input.enqueuer.enqueueOpsNotificationSend;
  if (enqueue === undefined) {
    throw new Error("ops-notification-fire requires an enqueuer with enqueueOpsNotificationSend (fail-closed)");
  }
  const enqueueBound = enqueue.bind(input.enqueuer);

  return withTenantTx(pool, tenantId, async (client) => {
    const tenantRoutes = [
      ...routes,
      ...(await readActiveOpsAlertNotificationRoutes(client, tenantId)),
    ];
    if (tenantRoutes.length === 0) {
      return { created: 0, skipped: 0 };
    }

    // 자동 발화 대상 소스만 계산(detected_at 안정). source=undefined 로 전 소스 계산 후 allowlist 필터해도 되지만,
    // 소스별 계산 비용을 아끼려 대상 소스만 순회 계산한다.
    const alerts: ComputedOpsAlert[] = [];
    for (const source of OPS_ALERT_AUTO_FIRE_SOURCES) {
      const computed = await readComputedOpsAlerts(client, tenantId, source, AUTO_FIRE_ALERT_LIMIT);
      alerts.push(...computed);
    }

    let created = 0;
    let skipped = 0;
    for (const alert of alerts) {
      for (const route of tenantRoutes) {
        if (!routeMatchesAlert(route, alert)) continue;
        const already = await generationAlreadyNotified(
          client,
          tenantId,
          alert.alert_id,
          alert.detected_at,
          route.providerAlias,
        );
        if (already) {
          skipped += 1;
          continue;
        }
        const attempt = await insertOpsNotificationAttempt(
          client,
          tenantId,
          alert,
          AUTO_FIRE_REQUESTED_BY,
          routeToSendInput(route, alert),
        );
        await enqueueBound(client, {
          tenantId,
          attemptId: attempt.attempt_id,
          correlationId: input.correlationId(),
        });
        created += 1;
      }
    }
    return { created, skipped };
  });
}

/**
 * 라우트 규칙(env + 테넌트 저장형)에 따라 대상 테넌트의 계산 알림을 자동 발화한다.
 * env·저장 라우트가 모두 없으면 no-op(자동 통지 미설정). env 라우트가 있는데 대상 테넌트가 없으면
 * loud 경고(휴면 방지) 후 no-op — 저장형 라우트 테넌트는 maintenance 테넌트 발견에 포함되므로 이 분기에 오지 않는다.
 */
export async function runOpsNotificationFire(
  pool: PgPool,
  input: OpsNotificationFireInput,
): Promise<OpsNotificationFireSummary> {
  const warn = input.onWarn ?? ((message: string) => console.error(JSON.stringify({ at: "ops_notification_fire", warn: message })));
  if (input.tenantIds.length === 0) {
    if (input.routes.length === 0) {
      return { created: 0, skipped: 0, tenantsProcessed: 0 };
    }
    warn(
      "OPS_ALERT_ROUTES is configured but no maintenance tenants are set (MAINTENANCE_TENANT_IDS empty): " +
        "automatic ops notifications will NOT fire. Set MAINTENANCE_TENANT_IDS to the tenant(s) to notify.",
    );
    return { created: 0, skipped: 0, tenantsProcessed: 0 };
  }

  let created = 0;
  let skipped = 0;
  let tenantsProcessed = 0;
  for (const tenantId of input.tenantIds) {
    const result = await fireForTenant(pool, tenantId, input.routes, input);
    created += result.created;
    skipped += result.skipped;
    tenantsProcessed += 1;
  }
  return { created, skipped, tenantsProcessed };
}
