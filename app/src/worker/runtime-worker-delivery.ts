// runtime-worker.ts 에서 추출 — 외부 전달 잡(sink_deliver/ops_notification_send/integration_handoff_dispatch)
// 서브핸들러(동작 무변경). 주입형 포트 + ops-defaults 상한 규약(test_fake fail-closed)을 공유하는 클러스터.
import type pg from "pg";

import { requireString } from "./runtime-worker-parse";
import {
  INTEGRATION_HANDOFF_DISPATCH_MAX_ATTEMPTS_DEFAULT,
  INTEGRATION_HANDOFF_DISPATCH_RETRY_AFTER_MS_DEFAULT,
  OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT,
  OPS_NOTIFICATION_DELIVERY_RETRY_AFTER_MS_DEFAULT,
} from "../../../ts/runtime-contract";
import type { EventId, RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import { deliverNormalizedRecord } from "../runtime/pipeline/sink-delivery";
import { deliverOpsNotificationAttempt } from "../runtime/ops-notification-delivery";
import { dispatchIntegrationHandoffAttempt } from "../runtime/integration-handoff-dispatch";
import type { PgRuntimeWorkerOptions } from "./runtime-worker";

// sink failed(상한 미달) 재전달 backoff 기본(ops-defaults #sink.delivery.retry_backoff base 5s).
const DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS = 5_000;

/**
 * D6 sink_deliver: 데이터평면 외부 전달. 주입형 SinkDeliveryPort(real|test_fake) + ops-defaults 상한 필수.
 * failed(상한 미달) → deferred(SINK_DELIVERY_FAILED 재전달), delivered/already_delivered/dead_letter → completed.
 * test_fake 포트는 명시 opt-in 없이는 거부(실 전달 증거 위조 방지 — artifact 포트와 동형 fail-closed).
 */
export async function handleSinkDeliver(
  pool: pg.Pool,
  options: PgRuntimeWorkerOptions,
  job: RuntimeWorkerJob,
): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "sink_deliver.tenantId");
  const correlationId = requireString(job.correlationId, "sink_deliver.correlationId");
  const target = job.sinkDelivery;
  if (target === undefined) {
    throw new Error("RuntimeWorker: sink_deliver requires sinkDelivery payload (closed job input)");
  }
  const port = options.sinkDeliveryPort;
  if (port === undefined) {
    return {
      kind: "deferred",
      retryAfterMs: options.sinkDeliveryRetryAfterMs ?? DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS,
      code: "SINK_DELIVERY_FAILED",
    };
  }
  if (port.binding.kind === "test_fake" && options.allowTestSinkDeliveryPort !== true) {
    throw new Error("RuntimeWorker: test_fake sink port requires explicit allowTestSinkDeliveryPort opt-in");
  }
  const maxAttempts = options.sinkDeliveryMaxAttempts;
  if (maxAttempts === undefined || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("RuntimeWorker: sink_deliver requires sinkDeliveryMaxAttempts (ops-defaults #sink.delivery)");
  }
  const outcome = await deliverNormalizedRecord(
    { pool, port, policy: { source: "ops-defaults.md#sink.delivery", maxAttempts } },
    {
      tenantId,
      normalizedRecordId: target.normalizedRecordId,
      sinkConfigId: target.sinkConfigId,
      correlationId,
    },
  );
  if (outcome.status === "failed") {
    // 상한 미달 일시 실패 → 재전달. 조용한 성공 금지: 실패를 deferred로 표면화.
    return {
      kind: "deferred",
      retryAfterMs: options.sinkDeliveryRetryAfterMs ?? DEFAULT_SINK_DELIVERY_RETRY_AFTER_MS,
      code: "SINK_DELIVERY_FAILED",
    };
  }
  // delivered / already_delivered / dead_letter → 처리 완료(DLQ도 종결 처리). emitted 이벤트 전달.
  return {
    kind: "completed",
    emittedEvents: outcome.emitted ? [outcome.emitted.eventId as EventId] : [],
  };
}

export async function handleOpsNotificationSend(
  pool: pg.Pool,
  options: PgRuntimeWorkerOptions,
  job: RuntimeWorkerJob,
): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "ops_notification_send.tenantId");
  const correlationId = requireString(job.correlationId, "ops_notification_send.correlationId");
  const attemptId = requireString(job.opsNotification?.attemptId, "ops_notification_send.opsNotification.attemptId");
  const port = options.opsNotificationDeliveryPort;
  if (port === undefined) {
    throw new Error("RuntimeWorker: ops_notification_send requires an injected OpsNotificationDeliveryPort (fail-closed)");
  }
  if (port.binding.kind === "test_fake" && options.allowTestOpsNotificationDeliveryPort !== true) {
    throw new Error("RuntimeWorker: test_fake ops notification port requires explicit allowTestOpsNotificationDeliveryPort opt-in");
  }
  const enqueuer = options.runtimeJobEnqueuer;
  if (enqueuer === undefined) {
    throw new Error("RuntimeWorker: ops_notification_send requires runtimeJobEnqueuer for retry scheduling");
  }
  const maxAttempts = options.opsNotificationDeliveryMaxAttempts ?? OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT;
  const retryAfterMs =
    options.opsNotificationDeliveryRetryAfterMs ?? OPS_NOTIFICATION_DELIVERY_RETRY_AFTER_MS_DEFAULT;
  const outcome = await deliverOpsNotificationAttempt(
    {
      pool,
      port,
      enqueuer,
      retryAfterMs,
      policy: { source: "ops-defaults.md#ops.notification.delivery", maxAttempts },
    },
    { tenantId, attemptId, correlationId },
  );
  return { kind: "completed", emittedEvents: [] };
}

export async function handleIntegrationHandoffDispatch(
  pool: pg.Pool,
  options: PgRuntimeWorkerOptions,
  job: RuntimeWorkerJob,
): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "integration_handoff_dispatch.tenantId");
  const correlationId = requireString(job.correlationId, "integration_handoff_dispatch.correlationId");
  const attemptId = requireString(job.integrationHandoff?.attemptId, "integration_handoff_dispatch.integrationHandoff.attemptId");
  const port = options.integrationHandoffDispatchPort;
  if (port === undefined) {
    throw new Error("RuntimeWorker: integration_handoff_dispatch requires an injected IntegrationHandoffDispatchPort (fail-closed)");
  }
  if (port.binding.kind === "test_fake" && options.allowTestIntegrationHandoffDispatchPort !== true) {
    throw new Error("RuntimeWorker: test_fake integration handoff dispatch port requires explicit allowTestIntegrationHandoffDispatchPort opt-in");
  }
  const enqueuer = options.runtimeJobEnqueuer;
  if (enqueuer === undefined) {
    throw new Error("RuntimeWorker: integration_handoff_dispatch requires runtimeJobEnqueuer for retry scheduling");
  }
  const maxAttempts =
    options.integrationHandoffDispatchMaxAttempts ?? INTEGRATION_HANDOFF_DISPATCH_MAX_ATTEMPTS_DEFAULT;
  const retryAfterMs =
    options.integrationHandoffDispatchRetryAfterMs ?? INTEGRATION_HANDOFF_DISPATCH_RETRY_AFTER_MS_DEFAULT;
  await dispatchIntegrationHandoffAttempt(
    {
      pool,
      port,
      enqueuer,
      retryAfterMs,
      policy: { source: "ops-defaults.md#integration.handoff.dispatch", maxAttempts },
    },
    { tenantId, attemptId, correlationId },
  );
  return { kind: "completed", emittedEvents: [] };
}
