import { describe, expect, test } from "vitest";

import { createHttpApiClient } from "../src/api/client";
import { ApiError, type AutomationPerformanceRoiSourceLineage } from "../src/api/types";

// 실 HttpApiClient의 요청 구성(경로·헤더·body)이 제어평면 계약(api-surface)과 일치하는지 검증.
// fetchImpl 주입으로 라이브 서버 없이 결정적으로 캡처. smoke/a11y는 fake 포트라 이 경로를 안 탄다.

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function harness(response: { status?: number; body?: unknown; headers?: Record<string, string> } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined && init.body !== null ? JSON.parse(String(init.body)) : undefined,
    });
    const body = typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {});
    return new Response(body, {
      status: response.status ?? 200,
      headers: { "content-type": typeof response.body === "string" ? "text/plain" : "application/json", ...(response.headers ?? {}) },
    });
  }) as typeof fetch;
  const client = createHttpApiClient({ baseUrl: "http://api.test", getToken: () => "jwt-123", fetchImpl });
  return { calls, client };
}

const automationPerformanceRoiSourceLineage: AutomationPerformanceRoiSourceLineage = {
  idea_count: 1,
  source_counts: { manual: 0, process_mining: 1, task_mining: 0, imported: 0 },
  stage_counts: { approved: 1, build: 0, operate: 0 },
  departments: ["Finance"],
  business_owners: ["Mina Kim"],
  sample_ideas: [
    {
      idea_id: "61000000-0000-4000-8000-000000000001",
      title: "Invoice lookup ROI",
      source: "process_mining",
      stage: "approved",
      department: "Finance",
      business_owner: "Mina Kim",
    },
  ],
};

describe("HttpApiClient 계약", () => {
  test("ops alert ack route uses encoded alert id and idempotency key", async () => {
    const { calls, client } = harness({
      body: {
        alert_id: "bot_pool:browser-default",
        severity: "warning",
        source: "bot_pool",
        title: "Bot pool capacity",
        detail: "Worker lease needs attention.",
        subject_type: "bot_pool",
        subject_id: "browser-default",
        status: "acknowledged",
        delivery: { channel: "console", status: "delivered", delivered_at: "2026-06-23T09:00:00.000Z", external_delivery: false },
        ack: { acknowledged_by: "operator-a", acknowledged_at: "2026-06-23T09:05:00.000Z", comment: "checking" },
        recommended_action: "Review bot pool.",
        route: "#automationOps",
        detected_at: "2026-06-23T09:00:00.000Z",
        due_at: null,
      },
    });

    const ack = await client.ackOpsAlert("bot_pool:browser-default", "idem-ack", "checking");
    expect(ack.status).toBe("acknowledged");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/ops-alerts/bot_pool%3Abrowser-default/ack");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-ack");
    expect(calls[0]?.body).toEqual({ comment: "checking" });
  });

  test("ops alert delivery receipt routes use encoded alert id and idempotency key", async () => {
    const listHarness = harness({ body: { items: [], next_cursor: null } });
    await listHarness.client.listOpsAlertDeliveries("bot_pool:browser-default", { limit: 5 });
    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/ops-alerts/bot_pool%3Abrowser-default/deliveries?limit=5");

    const postHarness = harness({
      body: {
        delivery_id: "delivery-1",
        alert_id: "bot_pool:browser-default",
        detected_at: "2026-06-23T09:00:00.000Z",
        source: "bot_pool",
        subject_type: "bot_pool",
        subject_id: "browser-default",
        channel: "teams",
        provider_alias: "teams-primary",
        status: "delivered",
        receipt_id: "teams-receipt-1",
        receipt_at: "2026-06-23T09:01:00.000Z",
        endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
        credential_secret_ref: "secret://tenant-a/notification/teams/credential",
        callback_signature_secret_ref: null,
        route_policy_ref: "ops-alerts-primary",
        recipient_group_ref: "ops-primary-oncall",
        attempt_no: 1,
        summary: "Provider accepted and delivered test alert.",
        error_code: null,
        metadata: { provider_region: "ap-northeast-2" },
        recorded_by: "admin-a",
        recorded_at: "2026-06-23T09:02:00.000Z",
        legal_hold: false,
      },
    });
    await postHarness.client.recordOpsAlertDelivery("bot_pool:browser-default", {
      channel: "teams",
      provider_alias: "teams-primary",
      status: "delivered",
      receipt_id: "teams-receipt-1",
      receipt_at: "2026-06-23T09:01:00.000Z",
      endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
      credential_secret_ref: "secret://tenant-a/notification/teams/credential",
      callback_signature_secret_ref: null,
      route_policy_ref: "ops-alerts-primary",
      recipient_group_ref: "ops-primary-oncall",
      attempt_no: 1,
      summary: "Provider accepted and delivered test alert.",
      metadata: { provider_region: "ap-northeast-2" },
    }, "delivery-receipt-1");
    expect(postHarness.calls[0]?.method).toBe("POST");
    expect(postHarness.calls[0]?.url).toBe("http://api.test/v1/ops-alerts/bot_pool%3Abrowser-default/deliveries");
    expect(postHarness.calls[0]?.headers.get("idempotency-key")).toBe("delivery-receipt-1");
    expect(postHarness.calls[0]?.body).toMatchObject({
      endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
      credential_secret_ref: "secret://tenant-a/notification/teams/credential",
    });
  });

  test("ops alert webhook send route queues SecretRef-backed delivery attempts", async () => {
    const { calls, client } = harness({
      status: 202,
      body: {
        attempt_id: "attempt-1",
        alert_id: "bot_pool:browser-default",
        detected_at: "2026-06-23T09:00:00.000Z",
        source: "bot_pool",
        subject_type: "bot_pool",
        subject_id: "browser-default",
        channel: "webhook",
        provider_alias: "webhook-primary",
        status: "pending",
        endpoint_secret_ref: "secret://rpa/staging/notification-sender/notification/webhook/ops-primary",
        callback_signature_secret_ref: "secret://rpa/staging/notification-sender/signing/webhook-callback",
        route_policy_ref: "ops-alerts-primary",
        recipient_group_ref: "ops-primary-oncall",
        allowed_hosts: ["hooks.slack.com"],
        attempt_no: 1,
        max_attempts: 3,
        next_attempt_at: "2026-06-23T09:01:00.000Z",
        summary: "Queue test webhook.",
        error_code: null,
        receipt_id: null,
        receipt_at: null,
        metadata: { requested_from: "admin_console" },
        requested_by: "admin-a",
        requested_at: "2026-06-23T09:00:01.000Z",
        legal_hold: false,
      },
    });

    const attempt = await client.sendOpsAlertWebhookDelivery("bot_pool:browser-default", {
      endpoint_secret_ref: "secret://rpa/staging/notification-sender/notification/webhook/ops-primary",
      callback_signature_secret_ref: "secret://rpa/staging/notification-sender/signing/webhook-callback",
      route_policy_ref: "ops-alerts-primary",
      recipient_group_ref: "ops-primary-oncall",
      allowed_hosts: ["hooks.slack.com"],
      provider_alias: "webhook-primary",
      summary: "Queue test webhook.",
      metadata: { requested_from: "admin_console" },
      legal_hold: false,
    }, "webhook-send-1");

    expect(attempt.status).toBe("pending");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/ops-alerts/bot_pool%3Abrowser-default/deliveries/send-webhook");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("webhook-send-1");
    expect(calls[0]?.body).toEqual({
      endpoint_secret_ref: "secret://rpa/staging/notification-sender/notification/webhook/ops-primary",
      callback_signature_secret_ref: "secret://rpa/staging/notification-sender/signing/webhook-callback",
      route_policy_ref: "ops-alerts-primary",
      recipient_group_ref: "ops-primary-oncall",
      allowed_hosts: ["hooks.slack.com"],
      provider_alias: "webhook-primary",
      summary: "Queue test webhook.",
      metadata: { requested_from: "admin_console" },
      legal_hold: false,
    });
  });

  test("ops alert notification route CRUD uses /v1/ops-alert-routes with idempotency keys", async () => {
    const routeBody = {
      route_id: "9a300000-0000-4000-8000-000000000001",
      source: "session_expiry",
      min_severity: "warning",
      provider_alias: "webhook-primary",
      endpoint_secret_ref: "secret://tenant-a/notification/webhook/ops-primary",
      callback_signature_secret_ref: null,
      route_policy_ref: "ops-alerts-primary",
      recipient_group_ref: "ops-primary-oncall",
      allowed_hosts: ["hooks.example.com"],
      enabled: true,
      created_by: "admin-a",
      created_at: "2026-07-02T00:00:00.000Z",
      updated_by: "admin-a",
      updated_at: "2026-07-02T00:00:00.000Z",
    };

    const listHarness = harness({ body: { items: [routeBody], next_cursor: null } });
    await listHarness.client.listOpsAlertNotificationRoutes({ limit: 50 });
    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/ops-alert-routes?limit=50");

    const createHarness = harness({ body: routeBody });
    const created = await createHarness.client.createOpsAlertNotificationRoute({
      source: "session_expiry",
      min_severity: "warning",
      provider_alias: "webhook-primary",
      endpoint_secret_ref: "secret://tenant-a/notification/webhook/ops-primary",
      route_policy_ref: "ops-alerts-primary",
      recipient_group_ref: "ops-primary-oncall",
      allowed_hosts: ["hooks.example.com"],
    }, "route-create-1");
    expect(created.route_id).toBe(routeBody.route_id);
    expect(createHarness.calls[0]?.method).toBe("POST");
    expect(createHarness.calls[0]?.url).toBe("http://api.test/v1/ops-alert-routes");
    expect(createHarness.calls[0]?.headers.get("idempotency-key")).toBe("route-create-1");
    expect(createHarness.calls[0]?.body).toEqual({
      source: "session_expiry",
      min_severity: "warning",
      provider_alias: "webhook-primary",
      endpoint_secret_ref: "secret://tenant-a/notification/webhook/ops-primary",
      route_policy_ref: "ops-alerts-primary",
      recipient_group_ref: "ops-primary-oncall",
      allowed_hosts: ["hooks.example.com"],
    });

    const patchHarness = harness({ body: { ...routeBody, enabled: false } });
    await patchHarness.client.updateOpsAlertNotificationRoute(routeBody.route_id, { enabled: false }, "route-toggle-1");
    expect(patchHarness.calls[0]?.method).toBe("PATCH");
    expect(patchHarness.calls[0]?.url).toBe(`http://api.test/v1/ops-alert-routes/${routeBody.route_id}`);
    expect(patchHarness.calls[0]?.headers.get("idempotency-key")).toBe("route-toggle-1");
    expect(patchHarness.calls[0]?.body).toEqual({ enabled: false });

    const deleteHarness = harness({ body: { deleted: true, route: { ...routeBody, enabled: false } } });
    const deleted = await deleteHarness.client.deleteOpsAlertNotificationRoute(routeBody.route_id, "route-delete-1");
    expect(deleted.deleted).toBe(true);
    expect(deleteHarness.calls[0]?.method).toBe("DELETE");
    expect(deleteHarness.calls[0]?.url).toBe(`http://api.test/v1/ops-alert-routes/${routeBody.route_id}`);
    expect(deleteHarness.calls[0]?.headers.get("idempotency-key")).toBe("route-delete-1");
  });

  test("integration handoff routes use SecretRef-only request and receipt metadata", async () => {
    const listHarness = harness({ body: { items: [], next_cursor: null } });
    await listHarness.client.listIntegrationHandoffs({ provider_alias: "uipath-primary", status: "deferred", limit: 5 });
    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/integration-handoffs?provider_alias=uipath-primary&status=deferred&limit=5");

    const handoffId = "00000000-0000-4000-8000-0000000000a1";
    const createHarness = harness({
      status: 202,
      body: {
        handoff_id: handoffId,
        provider_alias: "uipath-primary",
        job_ref: "queue:invoice-posting",
        payload_ref: "artifact://handoff/invoice-posting-001",
        callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
        callback_signature_secret_ref: "secret://tenant-a/integration/uipath/callback-signing",
        external_job_id: null,
        status: "deferred",
        latest_receipt_id: null,
        error_code: null,
        requested_by: "operator-a",
        request_idempotency_key: "handoff-create-1",
        requested_at: "2026-06-29T00:00:00.000Z",
        updated_at: "2026-06-29T00:00:00.000Z",
        callback_received_at: null,
        legal_hold: false,
      },
    });
    await createHarness.client.createIntegrationHandoff({
      provider_alias: "uipath-primary",
      job_ref: "queue:invoice-posting",
      payload_ref: "artifact://handoff/invoice-posting-001",
      callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
      callback_signature_secret_ref: "secret://tenant-a/integration/uipath/callback-signing",
    }, "handoff-create-1");
    expect(createHarness.calls[0]?.method).toBe("POST");
    expect(createHarness.calls[0]?.url).toBe("http://api.test/v1/integration-handoffs");
    expect(createHarness.calls[0]?.headers.get("idempotency-key")).toBe("handoff-create-1");
    expect(createHarness.calls[0]?.body).toMatchObject({
      provider_alias: "uipath-primary",
      callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
      callback_signature_secret_ref: "secret://tenant-a/integration/uipath/callback-signing",
    });

    const dispatchHarness = harness({
      status: 202,
      body: {
        attempt_id: "10000000-0000-4000-8000-0000000000d1",
        handoff_id: handoffId,
        provider_alias: "uipath-primary",
        status: "pending",
        endpoint_secret_ref: "secret://tenant-a/integration/uipath/dispatch-endpoint",
        allowed_hosts: ["uipath.example.com"],
        request_idempotency_key: "handoff-dispatch-1",
        attempt_no: 1,
        max_attempts: 3,
        external_job_id: null,
        receipt_id: null,
        error_code: null,
        requested_by: "operator-a",
        requested_at: "2026-06-29T00:00:10.000Z",
        updated_at: "2026-06-29T00:00:10.000Z",
        legal_hold: false,
      },
    });
    await dispatchHarness.client.dispatchIntegrationHandoff(handoffId, {
      endpoint_secret_ref: "secret://tenant-a/integration/uipath/dispatch-endpoint",
      allowed_hosts: ["uipath.example.com"],
      max_attempts: 3,
      metadata: { requested_from: "admin_console" },
    }, "handoff-dispatch-1");
    expect(dispatchHarness.calls[0]?.method).toBe("POST");
    expect(dispatchHarness.calls[0]?.url).toBe(`http://api.test/v1/integration-handoffs/${handoffId}/dispatch`);
    expect(dispatchHarness.calls[0]?.headers.get("idempotency-key")).toBe("handoff-dispatch-1");
    expect(dispatchHarness.calls[0]?.body).toEqual({
      endpoint_secret_ref: "secret://tenant-a/integration/uipath/dispatch-endpoint",
      allowed_hosts: ["uipath.example.com"],
      max_attempts: 3,
      metadata: { requested_from: "admin_console" },
    });

    const callbackHarness = harness({
      body: {
        handoff_id: handoffId,
        provider_alias: "uipath-primary",
        job_ref: "queue:invoice-posting",
        payload_ref: "artifact://handoff/invoice-posting-001",
        callback_url_secret_ref: "secret://tenant-a/integration/uipath/callback-url",
        callback_signature_secret_ref: "secret://tenant-a/integration/uipath/callback-signing",
        external_job_id: "job-123",
        status: "completed",
        latest_receipt_id: "receipt-123",
        error_code: null,
        requested_by: "operator-a",
        request_idempotency_key: "handoff-create-1",
        requested_at: "2026-06-29T00:00:00.000Z",
        updated_at: "2026-06-29T00:01:00.000Z",
        callback_received_at: "2026-06-29T00:01:00.000Z",
        legal_hold: false,
      },
    });
    await callbackHarness.client.recordIntegrationHandoffCallback(handoffId, {
      external_job_id: "job-123",
      status: "completed",
      receipt_id: "receipt-123",
    });
    expect(callbackHarness.calls[0]?.method).toBe("POST");
    expect(callbackHarness.calls[0]?.url).toBe(`http://api.test/v1/integration-handoffs/${handoffId}/callback`);
    expect(callbackHarness.calls[0]?.headers.get("idempotency-key")).toBeNull();
    expect(callbackHarness.calls[0]?.body).toEqual({ external_job_id: "job-123", status: "completed", receipt_id: "receipt-123" });
  });

  test("production readiness route uses controlled-prod evidence endpoint", async () => {
    const { calls, client } = harness({
      body: {
        status: "warning",
        evaluated_at: "2026-06-23T09:04:00.000Z",
        environment: { target: "controlled_prod", tenant_id: "tenant-a" },
        summary: { controlled_prod_ready: false, status: "warning", blocker_count: 0, warning_count: 0, deferred_count: 3 },
        gates: [],
        signals: {
          ops_health: {
            status: "ok",
            detected_at: "2026-06-23T09:04:00.000Z",
            queue: { available: true, pending_jobs: 0 },
            browser_leases: { reserved: 0, active: 0, draining: 0, expired: 0, expired_open: 0, next_expiry_at: null },
            stale_runs: { nonterminal_over_15m: 0, oldest_updated_at: null },
          },
          bot_pool: {
            bot_pool_id: "browser-finance-prod",
            capacity_slots: 2,
            workers: { total: 2, active: 2, draining: 0, dead: 0, stale: 0, open_circuit: 0 },
            leases: { reserved: 0, active: 0, draining: 0, expired_open: 0, next_expiry_at: null },
            queue: { pending_runs: 0, queued_runs: 0, claimed_runs: 0, oldest_queued_at: null, due_triggers: 0 },
            health: "ok",
          },
          audit_verifier: {
            audit_count: 8,
            latest_run_id: "verifier-1",
            latest_status: "valid",
            latest_completed_at: "2026-06-23T09:03:00.000Z",
            rows_checked: 8,
            violation_count: 0,
            stale: false,
          },
        },
      },
    });

    const readiness = await client.getProductionReadiness();
    expect(readiness.summary.deferred_count).toBe(3);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/ops/production-readiness");
  });

  test("production readiness evidence list and record routes", async () => {
    const listHarness = harness({ body: { items: [], next_cursor: null } });
    await listHarness.client.listProductionReadinessEvidence({ evidence_type: "external_alert_delivery", limit: 10 });
    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/ops/production-readiness/evidence?evidence_type=external_alert_delivery&limit=10");

    const postHarness = harness({
      body: {
        evidence_id: "evidence-1",
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-23T09:00:00.000Z",
        expires_at: "2026-09-23T09:00:00.000Z",
        summary: "External delivery drill receipt verified.",
        evidence_ref: "ticket:OPS-123",
        metadata: {
          channel: "teams",
          provider_alias: "teams-primary",
          receipt_id: "receipt-1",
          receipt_at: "2026-06-23T09:01:00.000Z",
          delivery_status: "delivered",
        },
        recorded_by: "admin-a",
        recorded_at: "2026-06-23T09:05:00.000Z",
        legal_hold: false,
      },
    });
    await postHarness.client.recordProductionReadinessEvidence({
      evidence_type: "external_alert_delivery",
      status: "valid",
      evidence_at: "2026-06-23T09:00:00.000Z",
      expires_at: "2026-09-23T09:00:00.000Z",
      summary: "External delivery drill receipt verified.",
      evidence_ref: "ticket:OPS-123",
      metadata: {
        channel: "teams",
        provider_alias: "teams-primary",
        receipt_id: "receipt-1",
        receipt_at: "2026-06-23T09:01:00.000Z",
        delivery_status: "delivered",
      },
    }, "readiness-evidence-1");
    expect(postHarness.calls[0]?.method).toBe("POST");
    expect(postHarness.calls[0]?.url).toBe("http://api.test/v1/ops/production-readiness/evidence");
    expect(postHarness.calls[0]?.headers.get("idempotency-key")).toBe("readiness-evidence-1");
  });

  test("AI governance runtime policy get and upsert routes", async () => {
    const getHarness = harness({
      body: {
        configured: true,
        policy: {
          policy_id: "ai-runtime-policy-prod",
          mode: "warn",
          subject_mapping_ref: "subject-map:ai-runtime/prod",
          grace_until: null,
          emergency_override_owner_ref: "team:ai-governance-oncall",
          audit_action: "ai_governance.enforce",
          policy_decision_ref: "policy-decision:ai-governance/runtime-enforcement",
          evidence_ref: "artifact:ai-governance/runtime-policy-prod",
          updated_by: "admin-a",
          created_at: "2026-06-29T00:00:00.000Z",
          updated_at: "2026-06-29T00:01:00.000Z",
        },
      },
    });
    const envelope = await getHarness.client.getAiGovernanceRuntimePolicy();
    expect(envelope.configured).toBe(true);
    expect(getHarness.calls[0]?.method).toBe("GET");
    expect(getHarness.calls[0]?.url).toBe("http://api.test/v1/ai-governance/runtime-policy");

    const putHarness = harness({
      body: {
        policy_id: "ai-runtime-policy-prod",
        mode: "block",
        subject_mapping_ref: "subject-map:ai-runtime/prod",
        grace_until: null,
        emergency_override_owner_ref: "team:ai-governance-oncall",
        audit_action: "ai_governance.enforce",
        policy_decision_ref: "policy-decision:ai-governance/runtime-enforcement",
        evidence_ref: "artifact:ai-governance/runtime-policy-prod",
        updated_by: "admin-a",
        created_at: "2026-06-29T00:00:00.000Z",
        updated_at: "2026-06-29T00:10:00.000Z",
      },
    });
    await putHarness.client.upsertAiGovernanceRuntimePolicy({
      mode: "block",
      subject_mapping_ref: "subject-map:ai-runtime/prod",
      grace_until: null,
      emergency_override_owner_ref: "team:ai-governance-oncall",
      policy_decision_ref: "policy-decision:ai-governance/runtime-enforcement",
      evidence_ref: "artifact:ai-governance/runtime-policy-prod",
    }, "ai-runtime-policy-upsert-1");
    expect(putHarness.calls[0]?.method).toBe("PUT");
    expect(putHarness.calls[0]?.url).toBe("http://api.test/v1/ai-governance/runtime-policy");
    expect(putHarness.calls[0]?.headers.get("idempotency-key")).toBe("ai-runtime-policy-upsert-1");
    expect(putHarness.calls[0]?.body).toEqual({
      mode: "block",
      subject_mapping_ref: "subject-map:ai-runtime/prod",
      grace_until: null,
      emergency_override_owner_ref: "team:ai-governance-oncall",
      policy_decision_ref: "policy-decision:ai-governance/runtime-enforcement",
      evidence_ref: "artifact:ai-governance/runtime-policy-prod",
    });
  });

  test("AI governance evidence summary → GET /v1/ai-governance/evidence/summary + filters", async () => {
    const { calls, client } = harness({
      body: {
        total_count: 1,
        status_counts: { valid: 1, deferred: 0, failed: 0 },
        expired_valid_count: 0,
        latest: null,
        type_status_counts: [],
        filters: { evidence_type: "model_registry", status: "valid", subject_ref: "model:codex-prod-primary" },
      },
    });
    await client.getAiGovernanceEvidenceSummary({
      evidence_type: "model_registry",
      status: "valid",
      subject_ref: "model:codex-prod-primary",
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/ai-governance/evidence/summary?evidence_type=model_registry&status=valid&subject_ref=model%3Acodex-prod-primary");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("automation adoption evidence list and record routes", async () => {
    const listHarness = harness({ body: { items: [], next_cursor: null } });
    await listHarness.client.listAutomationAdoptionEvidence("idea-123", {
      evidence_type: "pilot_charter_signoff",
      status: "valid",
      limit: 5,
    });
    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/automation-ideas/idea-123/adoption-evidence?evidence_type=pilot_charter_signoff&status=valid&limit=5");

    const postHarness = harness({
      body: {
        evidence_id: "adoption-evidence-1",
        idea_id: "idea-123",
        evidence_type: "support_model_signoff",
        status: "deferred",
        evidence_at: "2026-06-29T00:00:00.000Z",
        expires_at: null,
        summary: "Support model owner review is scheduled.",
        evidence_ref: "ticket:PILOT-123",
        metadata: { source: "coe_pipeline" },
        recorded_by: "operator-a",
        recorded_at: "2026-06-29T00:01:00.000Z",
        legal_hold: false,
      },
    });
    await postHarness.client.recordAutomationAdoptionEvidence("idea-123", {
      evidence_type: "support_model_signoff",
      status: "deferred",
      evidence_at: "2026-06-29T00:00:00.000Z",
      summary: "Support model owner review is scheduled.",
      evidence_ref: "ticket:PILOT-123",
      metadata: { source: "coe_pipeline" },
    }, "adoption-evidence-1");
    expect(postHarness.calls[0]?.method).toBe("POST");
    expect(postHarness.calls[0]?.url).toBe("http://api.test/v1/automation-ideas/idea-123/adoption-evidence");
    expect(postHarness.calls[0]?.headers.get("idempotency-key")).toBe("adoption-evidence-1");
    expect(postHarness.calls[0]?.body).toEqual({
      evidence_type: "support_model_signoff",
      status: "deferred",
      evidence_at: "2026-06-29T00:00:00.000Z",
      summary: "Support model owner review is scheduled.",
      evidence_ref: "ticket:PILOT-123",
      metadata: { source: "coe_pipeline" },
    });
  });

  test("process mining import list and create routes", async () => {
    const listHarness = harness({ body: { items: [], next_cursor: null } });
    await listHarness.client.listProcessMiningImports({
      source_type: "process_mining",
      status: "processed",
      limit: 10,
    });
    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/process-mining/imports?source_type=process_mining&status=processed&limit=10");

    const postHarness = harness({
      body: {
        import_id: "63000000-0000-4000-8000-000000000001",
        source_type: "process_mining",
        source_system: "celonis-export",
        source_owner_ref: "group:process-owner",
        schema_version: "2026-06",
        import_evidence_ref: "artifact:pm-import-1",
        lineage_ref: "lineage:pm-import-1",
        row_count: 120,
        candidate_count: 4,
        anonymization_mode: "aggregated_alias",
        schema_mapping: { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" },
        import_summary: "Aggregated process mining export.",
        status: "received",
        blocked_reason: null,
        created_by: "operator-a",
        created_at: "2026-06-30T00:00:00.000Z",
        updated_at: "2026-06-30T00:00:00.000Z",
      },
    });
    await postHarness.client.createProcessMiningImport({
      source_type: "process_mining",
      source_system: "celonis-export",
      source_owner_ref: "group:process-owner",
      schema_version: "2026-06",
      import_evidence_ref: "artifact:pm-import-1",
      lineage_ref: "lineage:pm-import-1",
      row_count: 120,
      candidate_count: 4,
      schema_mapping: { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" },
      import_summary: "Aggregated process mining export.",
    }, "process-import-1");
    expect(postHarness.calls[0]?.method).toBe("POST");
    expect(postHarness.calls[0]?.url).toBe("http://api.test/v1/process-mining/imports");
    expect(postHarness.calls[0]?.headers.get("idempotency-key")).toBe("process-import-1");
    expect(postHarness.calls[0]?.body).toMatchObject({
      source_type: "process_mining",
      import_evidence_ref: "artifact:pm-import-1",
      lineage_ref: "lineage:pm-import-1",
    });
  });

  test("automation performance report JSON/CSV/XLSX/PoC Markdown routes", async () => {
    const jsonHarness = harness({
      body: {
        month: "2026-06",
        run_mode: "prod",
        timezone: "Asia/Seoul",
        period_start: "2026-05-31T15:00:00.000Z",
        period_end: "2026-06-30T15:00:00.000Z",
        summary: {
          total_runs: 1,
          completed: 1,
          failed_business: 0,
          failed_system: 0,
          success_rate: 1,
          rerun_count: 0,
          reprocessing_rate: 0,
          estimated_hours_saved: 1,
          estimated_value: 50000,
          implementation_effort: 0,
          net_value: 49998.75,
          value_to_cost_ratio: 40000,
          payback_months: 0,
          gateway_cost: 1.25,
          cost_by_status: { completed: 1.25, failed_business: 0, failed_system: 0, other: 0 },
          failed_cost: 0,
          rerun_cost: 0,
          avg_cost_per_run: 1.25,
          cost_per_completed_run: 1.25,
          llm_call_cost: 1,
          run_vs_call_cost_delta: 0.25,
          roi_idea_count: 1,
          roi_confidence: { low: 0, medium: 1, high: 0 },
          roi_source_lineage: automationPerformanceRoiSourceLineage,
          roi_actuals: {
            evidence_count: 1,
            estimated_transaction_count: 10,
            actual_transaction_count: 9,
            comparable_actual_transaction_count: 9,
            transaction_attainment_rate: 0.9,
            estimated_exception_rate: 0,
            actual_failure_rate: 0.1,
            comparable_actual_failure_rate: 0.1,
            failure_rate_delta: 0.1,
            human_intervention_minutes: 30,
            reprocessing_minutes: 5,
            latest_period_end: "2026-06-28",
          },
          decision_signal: { status: "expand", reason: "PoC evidence supports scaling" },
        },
        cost_by_model: [{ model: "gpt-4o-mini", calls: 1, input_tokens: 100, output_tokens: 20, cost: 1, cost_share: 1 }],
        model_cost_trends: [
          {
            day: "2026-06-02",
            model: "gpt-4o-mini",
            calls: 1,
            input_tokens: 100,
            output_tokens: 20,
            cost: 1,
            cost_share_of_day: 1,
            cost_delta_from_previous_day_for_model: null,
          },
        ],
        failure_top: [],
        trends: [
          {
            day: "2026-06-02",
            total_runs: 1,
            completed: 1,
            failed_business: 0,
            failed_system: 0,
            success_rate: 1,
            rerun_count: 0,
            reprocessing_rate: 0,
            gateway_cost: 1.25,
            cost_by_status: { completed: 1.25, failed_business: 0, failed_system: 0, other: 0 },
            rerun_cost: 0,
            avg_cost_per_run: 1.25,
            cost_per_completed_run: 1.25,
            cost_delta_from_previous_day: null,
          },
        ],
        by_workflow: [],
      },
    });
    const report = await jsonHarness.client.getAutomationPerformanceReport("2026-06");
    expect(report.summary.total_runs).toBe(1);
    expect(report.summary.roi_source_lineage.source_counts.process_mining).toBe(1);
    expect(report.model_cost_trends[0]?.model).toBe("gpt-4o-mini");
    expect(jsonHarness.calls[0]?.url).toBe("http://api.test/v1/reports/automation-performance?month=2026-06&run_mode=prod");
    expect(jsonHarness.calls[0]?.headers.get("accept")).toBe("application/json");

    const csvHarness = harness({ body: "Summary\nmetric,value\n", headers: { "content-type": "text/csv" } });
    const csv = await csvHarness.client.exportAutomationPerformanceReportCsv("2026-06");
    expect(csv).toContain("Summary");
    expect(csvHarness.calls[0]?.url).toBe("http://api.test/v1/reports/automation-performance/export?month=2026-06&run_mode=prod&format=csv");
    expect(csvHarness.calls[0]?.headers.get("accept")).toBe("text/csv");

    const xlsxHarness = harness({
      body: "PK\u0003\u0004",
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    });
    const xlsx = await xlsxHarness.client.exportAutomationPerformanceReportXlsx?.("2026-06");
    expect(xlsx).toBeInstanceOf(Blob);
    expect(xlsxHarness.calls[0]?.url).toBe("http://api.test/v1/reports/automation-performance/export?month=2026-06&run_mode=prod&format=xlsx");
    expect(xlsxHarness.calls[0]?.headers.get("accept")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const pocHarness = harness({ body: "# Automation Performance PoC Report\n", headers: { "content-type": "text/markdown" } });
    const poc = await pocHarness.client.exportAutomationPerformanceReportPocMarkdown?.("2026-06");
    expect(poc).toContain("PoC Report");
    expect(pocHarness.calls[0]?.url).toBe("http://api.test/v1/reports/automation-performance/export?month=2026-06&run_mode=prod&format=poc_markdown");
    expect(pocHarness.calls[0]?.headers.get("accept")).toBe("text/markdown");
  });

  test("listRuns → GET /v1/runs?limit=50 + Bearer", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listRuns({ limit: 50 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs?limit=50");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listDlq(sink) → kind=sink 쿼리", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listDlq("sink", { limit: 10 });
    expect(calls[0]?.url).toBe("http://api.test/v1/dlq?limit=10&kind=sink");
  });

  test("listAuditLog → GET /v1/audit-log + 필터 쿼리", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listAuditLog({
      action: "artifact.read",
      outcome: "allow",
      actor: "viewer-a",
      occurred_at_from: "2026-06-01T00:00:00.000Z",
      occurred_at_to: "2026-06-30T23:59:59.999Z",
      limit: 25,
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/audit-log?action=artifact.read&outcome=allow&actor=viewer-a&occurred_at_from=2026-06-01T00%3A00%3A00.000Z&occurred_at_to=2026-06-30T23%3A59%3A59.999Z&limit=25");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("getAuditLogSummary → GET /v1/audit-log/summary + 필터 쿼리", async () => {
    const { calls, client } = harness({
      body: {
        total_count: 1,
        outcome_counts: { allow: 1, deny: 0, blocked: 0, error: 0 },
        hash_linked_count: 1,
        legal_hold_count: 0,
        latest: null,
        filters: { action: "secret.resolve", outcome: "allow", actor: "admin-a", correlation_id: null, occurred_at_from: null, occurred_at_to: null },
      },
    });
    await client.getAuditLogSummary({ action: "secret.resolve", outcome: "allow", actor: "admin-a" });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/audit-log/summary?action=secret.resolve&outcome=allow&actor=admin-a");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("exportAuditLogCsv → GET /v1/audit-log/export + text/csv", async () => {
    const { calls, client } = harness({ body: "audit_id,action\n81000000-0000-4000-8000-0000000000a1,artifact.read\n", headers: { "content-type": "text/csv" } });
    const csv = await client.exportAuditLogCsv({ action: "artifact.read", outcome: "allow", actor: "viewer-a", limit: 200 });
    expect(csv).toContain("audit_id");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/audit-log/export?action=artifact.read&outcome=allow&actor=viewer-a&limit=200&format=csv");
    expect(calls[0]?.headers.get("accept")).toBe("text/csv");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("audit verification runs use evidence endpoints", async () => {
    const fixture = {
      verification_run_id: "83000000-0000-4000-8000-000000000001",
      status: "valid",
      rows_checked: 2,
      violation_count: 0,
      violations: [],
      checked_from_sequence: 1,
      checked_to_sequence: 2,
      started_at: "2026-06-29T00:00:00.000Z",
      completed_at: "2026-06-29T00:00:01.000Z",
      correlation_id: "84000000-0000-4000-8000-000000000001",
      triggered_by: { subject_id: "admin-a", roles: ["admin"] },
      trigger_kind: "manual_api",
      retention_until: "2026-09-29T00:00:01.000Z",
      legal_hold: false,
    };
    const { calls, client } = harness({ body: { items: [fixture], next_cursor: null } });
    const list = await client.listAuditVerificationRuns({ status: "valid", limit: 5 });

    expect(list.items[0]?.verification_run_id).toBe(fixture.verification_run_id);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/audit-log/verification-runs?status=valid&limit=5");
  });

  test("runAuditVerification posts idempotent command", async () => {
    const { calls, client } = harness({
      body: {
        verification_run_id: "83000000-0000-4000-8000-000000000001",
        status: "invalid",
        rows_checked: 3,
        violation_count: 1,
        violations: [{ sequenceNo: 3, id: "audit-row-3", kind: "hash_mismatch", detail: "recomputed hash does not match stored hash" }],
        checked_from_sequence: 1,
        checked_to_sequence: 3,
        started_at: "2026-06-29T00:00:00.000Z",
        completed_at: "2026-06-29T00:00:01.000Z",
        correlation_id: "84000000-0000-4000-8000-000000000001",
        triggered_by: { subject_id: "admin-a", roles: ["admin"] },
        trigger_kind: "manual_api",
        retention_until: "2026-09-29T00:00:01.000Z",
        legal_hold: true,
      },
    });
    const run = await client.runAuditVerification("verify-1", { legal_hold: true });

    expect(run.status).toBe("invalid");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/audit-log/verification-runs/verify");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("verify-1");
    expect(calls[0]?.body).toEqual({ legal_hold: true });
  });

  test("getAuthReadiness → GET /v1/auth/readiness + Bearer", async () => {
    const { calls, client } = harness({
      body: {
        status: "ok",
        enterprise_sso_ready: true,
        provider: {
          mode: "jwks",
          configuration_source: "deployment_config",
          algorithm: "RS256",
          jwks_url_configured: true,
          jwks_host: "idp.example.com",
          issuer_configured: true,
          issuer: "https://idp.example.com/",
          audience_configured: true,
          audience: "rpa-console",
        },
        claim_mapping: {
          subject_claim: "sub",
          tenant_claim: "tenant_id",
          roles_claim: "roles",
          expiry_claim: "exp",
          display_name_claim: "name",
          email_claim: "email",
        },
        role_mapping: {
          configured: false,
          mapped_values: 0,
        },
        required_claims: [],
        current_principal: {
          subject_id: "viewer-a",
          tenant_id: "tenant-a",
          roles: ["viewer"],
          source: "jwt",
          display_name: null,
          email: null,
        },
        operational_gaps: [],
      },
    });
    const readiness = await client.getAuthReadiness();
    expect(readiness.enterprise_sso_ready).toBe(true);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/auth/readiness");
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listConnectors/listTemplates use catalog routes with filters", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listConnectors({ kind: "browser", status: "available", limit: 20 });
    await client.listTemplates({ connector_id: "sap-web", kind: "browser_workflow", status: "available", limit: 20 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/connectors?kind=browser&status=available&limit=20");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url).toBe("http://api.test/v1/templates?connector_id=sap-web&kind=browser_workflow&status=available&limit=20");
  });

  test("document IDP routes use document-jobs endpoints and idempotency", async () => {
    const { calls, client } = harness({
      body: {
        document_job_id: "job-1",
        document_extraction_id: "ext-1",
        human_task_id: "ht-1",
        items: [],
        next_cursor: null,
      },
    });

    await client.listDocumentJobs({ status: "validation_required", limit: 20 });
    await client.createDocumentJob(
      {
        source_artifact_id: "artifact-1",
        document_type: "invoice",
        field_schema: [{ key: "invoice_id", label: "송장 번호", type: "text", required: true }],
      },
      "idem-doc-create",
    );
    await client.getDocumentJob("job-1");
    await client.extractDocumentJob("job-1", "idem-doc-extract");
    await client.recordExternalDocumentExtraction(
      "job-1",
      {
        provider_alias: "external-idp",
        receipt_id: "receipt-1",
        normalized_schema_ref: "document-extraction/invoice@1",
        evidence_ref: "artifact://idp-receipt-1",
        fields: [
          { key: "invoice_id", value: "INV-7", confidence: 0.98 },
          { key: "total", value: 9900, confidence: 0.94 },
        ],
        metadata: { provider_region: "ap-northeast-2" },
      },
      "idem-doc-external",
    );
    await client.getDocumentExtraction("job-1");
    await client.createDocumentValidationTask("job-1", "idem-doc-validate");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/document-jobs?status=validation_required&limit=20");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("http://api.test/v1/document-jobs");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-doc-create");
    expect(calls[1]?.body).toEqual({
      source_artifact_id: "artifact-1",
      document_type: "invoice",
      field_schema: [{ key: "invoice_id", label: "송장 번호", type: "text", required: true }],
    });
    expect(calls[2]?.url).toBe("http://api.test/v1/document-jobs/job-1");
    expect(calls[3]?.method).toBe("POST");
    expect(calls[3]?.url).toBe("http://api.test/v1/document-jobs/job-1/extract");
    expect(calls[3]?.headers.get("idempotency-key")).toBe("idem-doc-extract");
    expect(calls[4]?.method).toBe("POST");
    expect(calls[4]?.url).toBe("http://api.test/v1/document-jobs/job-1/external-extractions");
    expect(calls[4]?.headers.get("idempotency-key")).toBe("idem-doc-external");
    expect(calls[4]?.body).toEqual({
      provider_alias: "external-idp",
      receipt_id: "receipt-1",
      normalized_schema_ref: "document-extraction/invoice@1",
      evidence_ref: "artifact://idp-receipt-1",
      fields: [
        { key: "invoice_id", value: "INV-7", confidence: 0.98 },
        { key: "total", value: 9900, confidence: 0.94 },
      ],
      metadata: { provider_region: "ap-northeast-2" },
    });
    expect(calls[5]?.url).toBe("http://api.test/v1/document-jobs/job-1/extraction");
    expect(calls[6]?.method).toBe("POST");
    expect(calls[6]?.url).toBe("http://api.test/v1/document-jobs/job-1/validation-task");
    expect(calls[6]?.headers.get("idempotency-key")).toBe("idem-doc-validate");
  });

  test("site element repository routes use site-scoped endpoints and idempotency", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listSiteElements("site-1", { stability: "stable", search: "submit", limit: 20 });
    await client.createSiteElement("site-1", { element_key: "SubmitButton", label: "Submit", selector: "button[type=submit]" }, "idem-create");
    await client.updateSiteElement("site-1", "element-1", { selector: "button.primary", stability: "review_needed" }, "idem-update");
    await client.deleteSiteElement("site-1", "element-1", "idem-delete");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/sites/site-1/elements?stability=stable&search=submit&limit=20");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-create");
    expect(calls[1]?.body).toEqual({ element_key: "SubmitButton", label: "Submit", selector: "button[type=submit]" });
    expect(calls[2]?.method).toBe("PATCH");
    expect(calls[2]?.headers.get("idempotency-key")).toBe("idem-update");
    expect(calls[2]?.body).toEqual({ selector: "button.primary", stability: "review_needed" });
    expect(calls[3]?.method).toBe("DELETE");
    expect(calls[3]?.headers.get("idempotency-key")).toBe("idem-delete");
  });

  test("browser recorder routes use site-scoped endpoints and idempotency", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listBrowserRecordings("site-1", { status: "recording", limit: 20 });
    await client.startBrowserRecording("site-1", { name: "Invoice portal", start_url: "https://portal.example.com" }, "idem-start");
    await client.listBrowserRecordingEvents("site-1", "recording-1", { limit: 100 });
    await client.appendBrowserRecordingEvents("site-1", "recording-1", { events: [{ event_type: "click", selector: "button[type=submit]" }] }, "idem-events");
    await client.completeBrowserRecording("site-1", "recording-1", "idem-complete");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/sites/site-1/recordings?status=recording&limit=20");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("http://api.test/v1/sites/site-1/recordings");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-start");
    expect(calls[1]?.body).toEqual({ name: "Invoice portal", start_url: "https://portal.example.com" });
    expect(calls[2]?.method).toBe("GET");
    expect(calls[2]?.url).toBe("http://api.test/v1/sites/site-1/recordings/recording-1/events?limit=100");
    expect(calls[3]?.method).toBe("POST");
    expect(calls[3]?.headers.get("idempotency-key")).toBe("idem-events");
    expect(calls[3]?.body).toEqual({ events: [{ event_type: "click", selector: "button[type=submit]" }] });
    expect(calls[4]?.method).toBe("POST");
    expect(calls[4]?.url).toBe("http://api.test/v1/sites/site-1/recordings/recording-1/complete");
    expect(calls[4]?.headers.get("idempotency-key")).toBe("idem-complete");
  });

  test("listRunSteps → GET /v1/runs/{id}/steps + Bearer (단계 트레이스 read 배선)", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listRunSteps("run-9", { limit: 100 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-9/steps?limit=100");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("watchRunSteps → GET /v1/runs/{id}/steps/stream + Bearer + SSE parse", async () => {
    const calls: Captured[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: run_steps_changed\n` +
            `data: {"run_id":"run-9","status":"running","step_count":2,"last_step_at":"2026-06-24T00:00:00Z","run_updated_at":"2026-06-24T00:00:01Z"}\n\n`,
        ));
        controller.close();
      },
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: undefined });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const client = createHttpApiClient({ baseUrl: "http://api.test", getToken: () => "jwt-123", fetchImpl });
    const event = await new Promise<{ step_count?: number; status: string | null }>((resolve) => {
      client.watchRunSteps("run-9", resolve);
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-9/steps/stream");
    expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(event.status).toBe("running");
    expect(event.step_count).toBe(2);
  });

  test("listRunArtifacts → GET /v1/runs/{id}/artifacts + Bearer (artifact 목록 read 배선)", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listRunArtifacts("run-9", { limit: 100 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-9/artifacts?limit=100");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listScenarioGenerationArtifacts → GET /v1/scenario-generations/{id}/artifacts + Bearer", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listScenarioGenerationArtifacts("gen-9", { limit: 50 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/gen-9/artifacts?limit=50");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listScenarioGenerationResultArtifacts → GET /v1/scenario-generations/{id}/result-artifacts + Bearer", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listScenarioGenerationResultArtifacts("gen-9", { limit: 50 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/gen-9/result-artifacts?limit=50");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("abortRun → POST .../abort + Idempotency-Key + 빈 body", async () => {
    const { calls, client } = harness({ body: { status: "cancelled" } });
    await client.abortRun("run-1", "idem-abc");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-1/abort");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-abc");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.body).toEqual({});
  });

  test("resumeRun → POST .../resume + Idempotency-Key + reason body", async () => {
    const { calls, client } = harness({ body: { run_id: "run-1", status: "resume_requested", previous_status: "suspended" } });
    await client.resumeRun("run-1", "idem-resume", "operator repair");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-1/resume");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-resume");
    expect(calls[0]?.body).toEqual({ reason: "operator repair" });
  });

  test("Web Attended and run-resume ledger routes use contract paths and idempotency", async () => {
    const listHarness = harness({ body: { items: [], next_cursor: null } });
    await listHarness.client.listRunResumeRequests({ status: "requested", run_id: "run-1", limit: 5 });
    await listHarness.client.listWebAttendedRunRequests({ status: "run_queued", human_task_id: "task-1", limit: 5 });

    expect(listHarness.calls[0]?.method).toBe("GET");
    expect(listHarness.calls[0]?.url).toBe("http://api.test/v1/run-resume-requests?status=requested&run_id=run-1&limit=5");
    expect(listHarness.calls[1]?.method).toBe("GET");
    expect(listHarness.calls[1]?.url).toBe("http://api.test/v1/web-attended/run-requests?status=run_queued&human_task_id=task-1&limit=5");

    const createHarness = harness({
      status: 201,
      body: {
        request_id: "web-attended-1",
        scenario_version_id: "00000000-0000-4000-8000-000000000101",
        run_id: "run-web-1",
        human_task_id: null,
        status: "run_queued",
        requested_by: "operator-a",
        request_idempotency_key: "idem-web-attended",
        consent_summary: "Approved launch.",
        consent_evidence_ref: "ticket:RPA-1",
        input_refs: ["artifact://input-1"],
        human_task_policy: {
          source: "ops-defaults.md#human_task.default_timeout",
          default_timeout_ms: 1800000,
          on_timeout: "fail",
          allowed_kinds: ["approval", "validation", "exception", "captcha", "mfa"],
        },
        metadata: { requested_from: "admin_console" },
        requested_at: "2026-06-30T00:00:00.000Z",
        updated_at: "2026-06-30T00:00:00.000Z",
        legal_hold: false,
      },
    });
    await createHarness.client.createWebAttendedRunRequest(
      {
        scenario_version_id: "00000000-0000-4000-8000-000000000101",
        params: { as_of: "2026-06-30T00:00:00.000Z" },
        priority: "medium",
        human_task_id: null,
        consent: {
          summary: "Approved launch.",
          evidence_ref: "ticket:RPA-1",
          input_refs: ["artifact://input-1"],
        },
        metadata: { requested_from: "admin_console" },
        legal_hold: false,
      },
      "idem-web-attended",
    );

    expect(createHarness.calls[0]?.method).toBe("POST");
    expect(createHarness.calls[0]?.url).toBe("http://api.test/v1/web-attended/run-requests");
    expect(createHarness.calls[0]?.headers.get("idempotency-key")).toBe("idem-web-attended");
    expect(createHarness.calls[0]?.body).toMatchObject({
      scenario_version_id: "00000000-0000-4000-8000-000000000101",
      consent: { evidence_ref: "ticket:RPA-1" },
    });
  });

  test("promoteScenario → POST .../promote + If-Match + body{target:prod}", async () => {
    const { calls, client } = harness({ body: { version: 3 } });
    await client.promoteScenario("scn-1", 3, "idem-xyz");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/promote");
    expect(calls[0]?.headers.get("if-match")).toBe("3");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-xyz");
    expect(calls[0]?.body).toEqual({ target: "prod" });
  });

  test("promoteScenarioFromRun → POST .../promote-from-run + Idempotency-Key + body{run_id}", async () => {
    const { calls, client } = harness({
      status: 201,
      body: {
        scenario_id: "scn-1",
        version: 4,
        scenario_version_id: "sv-4",
        promotion_status: "draft",
        promoted_node_ids: ["click_order"],
        skipped: [],
      },
    });
    await client.promoteScenarioFromRun("scn-1", "run-1", "idem-pbd");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/promote-from-run");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-pbd");
    expect(calls[0]?.body).toEqual({ run_id: "run-1" });
  });

  test("scenario lifecycle → 운영 해제·보관·버전 목록·롤백 경로", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.setScenarioPromotion("scn-1", 3, "draft", "idem-draft");
    await client.archiveScenario("scn-1", 3, "idem-archive");
    await client.listScenarioVersions("scn-1");
    await client.rollbackScenario("scn-1", 1, 3, "idem-rollback");
    await client.setScenarioVersionGovernanceStage(
      "scn-1",
      3,
      { stage: "pilot", reason: "SME pilot accepted", evidence_ref: "ticket:GOV-123", metadata: { lane: "finance" }, legal_hold: true },
      "idem-governance",
    );

    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/promote");
    expect(calls[0]?.headers.get("if-match")).toBe("3");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-draft");
    expect(calls[0]?.body).toEqual({ target: "draft" });
    expect(calls[1]?.url).toBe("http://api.test/v1/scenarios/scn-1/archive");
    expect(calls[1]?.headers.get("if-match")).toBe("3");
    expect(calls[2]?.method).toBe("GET");
    expect(calls[2]?.url).toBe("http://api.test/v1/scenarios/scn-1/versions");
    expect(calls[3]?.url).toBe("http://api.test/v1/scenarios/scn-1/versions/1/rollback");
    expect(calls[3]?.headers.get("if-match")).toBe("3");
    expect(calls[3]?.headers.get("idempotency-key")).toBe("idem-rollback");
    expect(calls[4]?.url).toBe("http://api.test/v1/scenarios/scn-1/versions/3/governance-stage");
    expect(calls[4]?.headers.get("idempotency-key")).toBe("idem-governance");
    expect(calls[4]?.body).toEqual({
      stage: "pilot",
      reason: "SME pilot accepted",
      evidence_ref: "ticket:GOV-123",
      metadata: { lane: "finance" },
      legal_hold: true,
    });
  });

  test("getGatewayPolicy → ETag(version) 헤더를 body.version으로 병합", async () => {
    const { calls, client } = harness({ body: { model: "gpt-4o", capabilities: {} }, headers: { ETag: "7" } });
    const policy = await client.getGatewayPolicy("gpt-4o");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/gateway/policy?model=gpt-4o");
    expect(policy.version).toBe(7);
    expect(policy.model).toBe("gpt-4o");
  });

  test("gateway policy CRUD 경로 → list/create/delete + 기본 정책 플래그", async () => {
    const { calls, client } = harness({ body: { items: [{ model: "gpt-4o", version: 1, is_default: true }], next_cursor: null } });
    await client.listGatewayPolicies();
    await client.createGatewayPolicy(
      {
        model: "gpt-4.1-mini",
        capabilities: { maxContextTokens: 8000 },
        budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 },
        fallback_config: null,
        is_default: true,
      },
      "idem-create-gw",
    );
    await client.deleteGatewayPolicy("gpt-4.1-mini", 3, "idem-delete-gw");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/gateway/policies");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("http://api.test/v1/gateway/policy");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-create-gw");
    expect(calls[1]?.body).toEqual({
      model: "gpt-4.1-mini",
      capabilities: { maxContextTokens: 8000 },
      budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 },
      fallback_config: null,
      is_default: true,
    });
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url).toBe("http://api.test/v1/gateway/policy?model=gpt-4.1-mini");
    expect(calls[2]?.headers.get("if-match")).toBe("3");
    expect(calls[2]?.headers.get("idempotency-key")).toBe("idem-delete-gw");
  });

  test("getGatewayPolicy → ETag 부재 시 version undefined(편집 차단 가드)", async () => {
    const { client } = harness({ body: { model: "gpt-4o" } });
    const policy = await client.getGatewayPolicy();
    expect(policy.version).toBeUndefined();
  });

  test("updateGatewayPolicy → PUT /v1/gateway/policy + If-Match + Idempotency-Key + body", async () => {
    const { calls, client } = harness({ body: { model: "gpt-4o", version: 3 } });
    await client.updateGatewayPolicy(2, { model: "gpt-4o", capabilities: { maxContextTokens: 8000 }, budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 } }, "idem-gw");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("http://api.test/v1/gateway/policy");
    expect(calls[0]?.headers.get("if-match")).toBe("2");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-gw");
    expect(calls[0]?.body).toEqual({ model: "gpt-4o", capabilities: { maxContextTokens: 8000 }, budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 } });
  });

  test("resolveHumanTask(result) → body{result}", async () => {
    const { calls, client } = harness();
    await client.resolveHumanTask("ht-1", "k1", { decision: "approve" });
    expect(calls[0]?.url).toBe("http://api.test/v1/human-tasks/ht-1/resolve");
    expect(calls[0]?.body).toEqual({ result: { decision: "approve" } });
  });

  test("assignHumanTask → body{assignee}", async () => {
    const { calls, client } = harness();
    await client.assignHumanTask("ht-2", "user-9", "k2");
    expect(calls[0]?.body).toEqual({ assignee: "user-9" });
  });

  test("listHumanTasks supports unassigned=true query param", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listHumanTasks({ unassigned: true, limit: 50 });
    expect(calls[0]?.url).toBe("http://api.test/v1/human-tasks?unassigned=true&limit=50");
  });

  test("listHumanTasks supports terminal=false query param", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listHumanTasks({ terminal: "false", limit: 50 });
    expect(calls[0]?.url).toBe("http://api.test/v1/human-tasks?terminal=false&limit=50");
  });

  test("detail GET-by-id 경로", async () => {
    const { calls, client } = harness({ body: { run_id: "r1", status: "running", run_mode: "prod", worker_id: null, attempts: 1, as_of: null } });
    await client.getRun("r1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/r1");
    const w = harness({ body: {} });
    await w.client.getHumanTask("ht-9");
    expect(w.calls[0]?.url).toBe("http://api.test/v1/human-tasks/ht-9");
  });

  test("getArtifact → GET /v1/artifacts/{id} + Bearer (산출물 조회 배선)", async () => {
    const { calls, client } = harness({ body: { artifact_id: "a1", type: "screenshot", sha256: "h", redaction_status: "redacted", retention_until: null, content: "redacted" } });
    const art = await client.getArtifact("a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/artifacts/a1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(art.content).toBe("redacted");
    expect(art.redaction_status).toBe("redacted");
  });

  test("getArtifactBlob → GET /v1/artifacts/{id}/blob + Bearer", async () => {
    const { calls, client } = harness({ body: "binary" });
    const blob = await client.getArtifactBlob("a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/artifacts/a1/blob");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(calls[0]?.headers.get("accept")).toBe("*/*");
    expect(blob).toBeInstanceOf(Blob);
  });

  test("getScenarioGenerationArtifact → scoped generation artifact body route + Bearer", async () => {
    const { calls, client } = harness({
      body: {
        artifact_id: "a1",
        generation_id: "g1",
        type: "scenario_generation_llm_output",
        sha256: "h",
        redaction_status: "redacted",
        retention_until: null,
        content: "redacted planner output",
      },
    });
    const artifact = await client.getScenarioGenerationArtifact("g1", "a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/g1/artifacts/a1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(artifact.generation_id).toBe("g1");
    expect(artifact.content).toBe("redacted planner output");
  });

  test("validateScenario → POST .../validate + body=IR", async () => {
    const { calls, client } = harness({ body: { valid: true, report: {} } });
    const ir = { nodes: [{ id: "n1" }] };
    await client.validateScenario("scn-1", ir, "k");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/validate");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(ir);
  });

  test("createRun → POST /v1/runs + body{scenario_version_id, params} + Idempotency-Key", async () => {
    const { calls, client } = harness({ body: { run_id: "x" } });
    await client.createRun({ scenario_version_id: "sv-1", params: {} }, "idem-run");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-run");
    expect(calls[0]?.body).toEqual({ scenario_version_id: "sv-1", params: {} });
  });

  test("generateScenario → POST /v1/scenario-generations + Idempotency-Key + evidence", async () => {
    const { calls, client } = harness({ body: { generation_id: "g1", status: "run_queued", blockers: [] } });
    await client.generateScenario(
      {
        prompt: "주문 목록 확인",
        mode: "save_and_run",
        start_url: "https://example.test/orders",
        evidence: { screenshot: "each_step", video: "always" },
      },
      "idem-generate",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-generate");
    expect(calls[0]?.body).toEqual({
      prompt: "주문 목록 확인",
      mode: "save_and_run",
      start_url: "https://example.test/orders",
      evidence: { screenshot: "each_step", video: "always" },
    });
  });

  test("runScenarioGeneration → POST /v1/scenario-generations/{id}/run + 보정 body + Idempotency-Key", async () => {
    const { calls, client } = harness({ status: 201, body: { generation_id: "g1", status: "run_queued", run_id: "r1", blockers: [] } });
    await client.runScenarioGeneration(
      "00000000-0000-0000-0000-0000000000a1",
      {
        target: {
          site_profile_id: "00000000-0000-0000-0000-000000000001",
          browser_identity_id: "00000000-0000-0000-0000-000000000002",
          network_policy_id: "00000000-0000-0000-0000-000000000003",
        },
        start_url: "https://example.test/orders",
        params: { page: 1 },
        model: null,
        evidence: { screenshot: "failure", video: "never" },
      },
      "idem-generation-run",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/00000000-0000-0000-0000-0000000000a1/run");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-generation-run");
    expect(calls[0]?.body).toEqual({
      target: {
        site_profile_id: "00000000-0000-0000-0000-000000000001",
        browser_identity_id: "00000000-0000-0000-0000-000000000002",
        network_policy_id: "00000000-0000-0000-0000-000000000003",
      },
      start_url: "https://example.test/orders",
      params: { page: 1 },
      model: null,
      evidence: { screenshot: "failure", video: "never" },
    });
  });

  test("getScenarioGenerationCapabilities → GET /v1/scenario-generations/capabilities", async () => {
    const { calls, client } = harness({
      body: {
        planner: { default_planner: "deterministic_mvp", available: ["deterministic_mvp"] },
        visual_evidence: {
          screenshot: { enabled: true, policies: ["never", "failure", "each_step"], default_policy: "each_step" },
          video: { enabled: false, policies: ["never"], default_policy: "never", artifact_type: "video_masked", media_type: "video/webm" },
        },
      },
    });
    await client.getScenarioGenerationCapabilities();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/capabilities");
  });

  test("getCapabilities → GET /v1/capabilities", async () => {
    const { calls, client } = harness({
      body: { session_capture: { server: { mode: "off", enabled: false } } },
    });
    await client.getCapabilities();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/capabilities");
  });

  test("getScenarioGeneration → GET /v1/scenario-generations/{id}", async () => {
    const { calls, client } = harness({ body: { generation_id: "g1", status: "saved", blockers: [] } });
    await client.getScenarioGeneration("00000000-0000-0000-0000-0000000000a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/00000000-0000-0000-0000-0000000000a1");
  });

  test("listScenarioGenerations → GET /v1/scenario-generations + query", async () => {
    const { calls: generationCalls, client: generationClient } = harness({ body: { items: [], next_cursor: null } });
    await generationClient.listScenarioGenerations({ limit: 10, cursor: "cursor-1", status: "blocked", run_id: "run-1" });
    expect(generationCalls[0]?.method).toBe("GET");
    expect(generationCalls[0]?.url).toBe("http://api.test/v1/scenario-generations?limit=10&cursor=cursor-1&status=blocked&run_id=run-1");
  });

  test("replayDeadLetter(sink) -> POST .../replay?kind=sink + Idempotency-Key", async () => {
    const { calls, client } = harness({ body: { status: "new" } });
    await client.replayDeadLetter("dl-1", "idem-sink", "sink");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/dlq/dl-1/replay?kind=sink");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-sink");
  });

  test("replayDeadLetter(workitem) → ?kind=workitem", async () => {
    const { calls, client } = harness({ body: { status: "new" } });
    await client.replayDeadLetter("dl-2", "idem-wi", "workitem");
    expect(calls[0]?.url).toBe("http://api.test/v1/dlq/dl-2/replay?kind=workitem");
  });

  test("createSite → POST /v1/sites + body + Idempotency-Key (사이트 온보딩 배선)", async () => {
    const { calls, client } = harness({ body: { site_profile_id: "s1" } });
    const selectors = {
      loginUrl: "https://login.office.hiworks.com",
      authenticatedWhen: { selector: ".user-menu" },
      flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } },
    };
    await client.createSite({ name: "하이웍스", url_pattern: "https://login.office.hiworks.com", risk: "green", page_state_selectors: selectors }, "idem-site");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/sites");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-site");
    expect(calls[0]?.body).toEqual({ name: "하이웍스", url_pattern: "https://login.office.hiworks.com", risk: "green", page_state_selectors: selectors });
  });

  test("listSessionCaptures → GET /v1/sites/{id}/session/capture", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listSessionCaptures("site-1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/sites/site-1/session/capture");
  });

  test("reviseScenarioGeneration → POST /v1/scenario-generations/{id}/revise + Idempotency-Key + body(instruction, base_version)", async () => {
    const { calls, client } = harness({ body: { generation_id: "gen-1" } });
    await client.reviseScenarioGeneration("gen-1", { instruction: "단계를 하나 더 넣어줘", base_version: 3 }, "idem-revise");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/gen-1/revise");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-revise");
    expect(calls[0]?.body).toEqual({ instruction: "단계를 하나 더 넣어줘", base_version: 3 });
  });

  test("listScenarioGenerations scenario_id 필터 → 쿼리스트링 직렬화", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listScenarioGenerations({ scenario_id: "sc-1", limit: 1 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations?scenario_id=sc-1&limit=1");
  });

  test("updateSitePageState → PATCH /v1/sites/{id}/page-state + Idempotency-Key", async () => {
    const { calls, client } = harness({ body: { site_profile_id: "site-1", page_state_selectors: { flags: {} } } });
    await client.updateSitePageState("site-1", { flags: {} }, "idem-page-state");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe("http://api.test/v1/sites/site-1/page-state");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-page-state");
    expect(calls[0]?.body).toEqual({ page_state_selectors: { flags: {} } });
  });

  test("4xx 응답 → ApiError(code, httpStatus) 표면화 (조용한 실패 금지)", async () => {
    const { client } = harness({ status: 409, body: { code: "RUN_ABORTED" } });
    await expect(client.abortRun("run-x", "k")).rejects.toMatchObject({ httpStatus: 409, code: "RUN_ABORTED" });
    await expect(client.abortRun("run-x", "k")).rejects.toBeInstanceOf(ApiError);
  });

  test("토큰 없으면 Authorization 미첨부", async () => {
    const calls: Captured[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = createHttpApiClient({ baseUrl: "http://api.test", getToken: () => null, fetchImpl });
    await client.listSites();
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });
});
