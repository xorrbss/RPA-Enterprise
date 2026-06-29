import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { navigate } from "../router";
import type {
  IntegrationHandoff,
  OpsAlertItem,
  OpsNotificationAttempt,
  OpsNotificationDelivery,
  OpsNotificationWebhookSendRequest,
  ProductionReadinessEvidence,
} from "../api/types";
import { OpsHealthSummary } from "./orchestration/OpsHealthSummary";
import { TriggerScheduler } from "./orchestration/TriggerScheduler";
import { StatusColumn } from "./orchestration/StatusColumn";
import { NotificationRoutingReadiness } from "./orchestration/NotificationRoutingReadiness";
import { OpsAlertCenter, type OpsWebhookSendDraft } from "./orchestration/OpsAlertCenter";
import { BotPoolCapacityPanel } from "./orchestration/BotPoolCapacityPanel";
import {
  IntegrationHandoffPanel,
  type IntegrationHandoffCreateDraft,
  type IntegrationHandoffDispatchDraft,
  type IntegrationHandoffReceiptDraft,
} from "./orchestration/IntegrationHandoffPanel";
import {
  ProductionReadinessPanel,
  type BackupEvidenceRecordDraft,
  type ExternalAlertEvidenceRecordDraft,
  type ObservabilityEvidenceRecordDraft,
  type SloEvidenceRecordDraft,
} from "./orchestration/ProductionReadinessPanel";
import { countLabel, type AlertSeverityFilter, type AlertSourceFilter } from "./orchestration/trigger-helpers";

export function OrchestrationView(): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const can = useCan();
  const summary = useQuery({ queryKey: ["runs", "summary"], queryFn: () => api.getRunSummary(), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const workDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 10_000 });
  const opsHealth = useQuery({ queryKey: ["ops-health"], queryFn: () => api.getOpsHealth(), refetchInterval: 5_000 });
  const productionReadiness = useQuery({ queryKey: ["production-readiness"], queryFn: () => api.getProductionReadiness(), refetchInterval: 15_000 });
  const externalAlertReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "external_alert_delivery"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "external_alert_delivery", limit: 3 }),
    refetchInterval: 60_000,
  });
  const backupReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "managed_backup_restore_drill"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "managed_backup_restore_drill", limit: 3 }),
    refetchInterval: 60_000,
  });
  const sloReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "slo_oncall_signoff"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "slo_oncall_signoff", limit: 3 }),
    refetchInterval: 60_000,
  });
  const observabilityReadinessEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "observability_telemetry_wiring"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "observability_telemetry_wiring", limit: 3 }),
    refetchInterval: 60_000,
  });
  const botPools = useQuery({ queryKey: ["bot-pools"], queryFn: () => api.listBotPools({ limit: 10 }), refetchInterval: 5_000 });
  const notificationConnectors = useQuery({ queryKey: ["connectors", "notification"], queryFn: () => api.listConnectors({ kind: "notification", limit: 10 }), refetchInterval: 60_000 });
  const notificationTemplates = useQuery({ queryKey: ["templates", "notification"], queryFn: () => api.listTemplates({ kind: "notification_workflow", limit: 10 }), refetchInterval: 60_000 });
  const integrationHandoffs = useQuery({
    queryKey: ["integration-handoffs"],
    queryFn: () => api.listIntegrationHandoffs({ limit: 5 }),
    refetchInterval: 30_000,
  });

  const [alertSeverity, setAlertSeverity] = useState<AlertSeverityFilter>("all");
  const [alertSource, setAlertSource] = useState<AlertSourceFilter>("all");
  const [alertCursor, setAlertCursor] = useState<string | null>(null);
  const [alertItems, setAlertItems] = useState<readonly OpsAlertItem[]>([]);
  const [deliveryAlertId, setDeliveryAlertId] = useState<string | null>(null);
  const [ackErrorAlertId, setAckErrorAlertId] = useState<string | null>(null);
  const [webhookSendErrorAlertId, setWebhookSendErrorAlertId] = useState<string | null>(null);
  const [queuedWebhookAttempt, setQueuedWebhookAttempt] = useState<OpsNotificationAttempt | null>(null);
  const [dispatchErrorHandoffId, setDispatchErrorHandoffId] = useState<string | null>(null);
  const [receiptErrorHandoffId, setReceiptErrorHandoffId] = useState<string | null>(null);
  const alertBaseParams = useMemo(
    () => ({
      limit: 20,
      severity: alertSeverity === "all" ? undefined : alertSeverity,
      source: alertSource === "all" ? undefined : alertSource,
    }),
    [alertSeverity, alertSource],
  );
  const alertParams = useMemo(
    () => ({
      ...alertBaseParams,
      cursor: alertCursor ?? undefined,
    }),
    [alertBaseParams, alertCursor],
  );
  const opsAlerts = useQuery({
    queryKey: ["ops-alerts", alertParams],
    queryFn: () => api.listOpsAlerts(alertParams),
    refetchInterval: 5_000,
  });
  const deliveryReceipts = useQuery({
    queryKey: ["ops-alert-deliveries", deliveryAlertId],
    queryFn: () => {
      if (deliveryAlertId === null) return Promise.resolve({ items: [] as OpsNotificationDelivery[], next_cursor: null });
      return api.listOpsAlertDeliveries(deliveryAlertId, { limit: 5 });
    },
    enabled: deliveryAlertId !== null,
    refetchInterval: deliveryAlertId === null ? false : 15_000,
  });
  const ackMutation = useMutation({
    mutationFn: (alert: OpsAlertItem) => api.ackOpsAlert(alert.alert_id, opsAlertAckIdempotencyKey(alert)),
    onMutate: () => {
      setAckErrorAlertId(null);
    },
    onSuccess: (acknowledged) => {
      setAlertItems((current) => current.map((alert) => (alert.alert_id === acknowledged.alert_id ? acknowledged : alert)));
      void queryClient.invalidateQueries({ queryKey: ["ops-alerts"] });
    },
    onError: (_error, alert) => {
      setAckErrorAlertId(alert.alert_id);
    },
  });
  const sendWebhookMutation = useMutation({
    mutationFn: ({ alert, draft }: { alert: OpsAlertItem; draft: OpsWebhookSendDraft }) =>
      api.sendOpsAlertWebhookDelivery(
        alert.alert_id,
        webhookSendRequestBody(draft),
        opsAlertWebhookIdempotencyKey(alert, draft),
      ),
    onMutate: () => {
      setWebhookSendErrorAlertId(null);
    },
    onSuccess: (attempt, { alert }) => {
      setQueuedWebhookAttempt(attempt);
      setDeliveryAlertId(alert.alert_id);
      void queryClient.invalidateQueries({ queryKey: ["ops-alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["ops-alert-deliveries", alert.alert_id] });
    },
    onError: (_error, { alert }) => {
      setWebhookSendErrorAlertId(alert.alert_id);
    },
  });
  const recordSloEvidenceMutation = useMutation({
    mutationFn: (draft: SloEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "slo_oncall_signoff",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        slo_dashboard: draft.sloDashboard,
        severity_model: draft.severityModel,
        oncall_rota: draft.oncallRota,
        raci_ref: draft.raciRef,
        support_hours: draft.supportHours,
      },
      legal_hold: false,
    }, sloEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "slo_oncall_signoff"] });
    },
  });
  const recordExternalAlertEvidenceMutation = useMutation({
    mutationFn: (draft: ExternalAlertEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "external_alert_delivery",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        channel: draft.channel,
        provider_alias: draft.providerAlias,
        receipt_id: draft.receiptId,
        receipt_at: draft.receiptAt,
        delivery_status: "delivered",
      },
      legal_hold: false,
    }, externalAlertEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "external_alert_delivery"] });
    },
  });
  const recordBackupEvidenceMutation = useMutation({
    mutationFn: (draft: BackupEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "managed_backup_restore_drill",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        backup_policy_ref: draft.backupPolicyRef,
        restore_scope: draft.restoreScope,
        restore_completed_at: draft.restoreCompletedAt,
        rto_minutes: draft.rtoMinutes,
        rpo_minutes: draft.rpoMinutes,
      },
      legal_hold: false,
    }, backupEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "managed_backup_restore_drill"] });
    },
  });
  const recordObservabilityEvidenceMutation = useMutation({
    mutationFn: (draft: ObservabilityEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "observability_telemetry_wiring",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        exporter: draft.exporter,
        collector_ref: draft.collectorRef,
        dashboard_ref: draft.dashboardRef,
        alert_route_ref: draft.alertRouteRef,
        sampled_at: draft.sampledAt,
      },
      legal_hold: false,
    }, observabilityEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "observability_telemetry_wiring"] });
    },
  });
  const createIntegrationHandoffMutation = useMutation({
    mutationFn: (draft: IntegrationHandoffCreateDraft) =>
      api.createIntegrationHandoff({
        provider_alias: draft.providerAlias,
        job_ref: draft.jobRef,
        payload_ref: draft.payloadRef,
        callback_url_secret_ref: draft.callbackUrlSecretRef,
        callback_signature_secret_ref: draft.callbackSignatureSecretRef,
        legal_hold: draft.legalHold,
      }, integrationHandoffIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integration-handoffs"] });
    },
  });
  const dispatchIntegrationHandoffMutation = useMutation({
    mutationFn: ({ handoff, draft }: { handoff: IntegrationHandoff; draft: IntegrationHandoffDispatchDraft }) =>
      api.dispatchIntegrationHandoff(
        handoff.handoff_id,
        {
          endpoint_secret_ref: draft.endpointSecretRef,
          allowed_hosts: draft.allowedHosts,
          max_attempts: draft.maxAttempts,
          metadata: { requested_from: "admin_console" },
          legal_hold: draft.legalHold,
        },
        integrationHandoffDispatchIdempotencyKey(handoff, draft),
      ),
    onMutate: () => {
      setDispatchErrorHandoffId(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integration-handoffs"] });
    },
    onError: (_error, variables) => {
      setDispatchErrorHandoffId(variables.handoff.handoff_id);
    },
  });
  const recordIntegrationHandoffReceiptMutation = useMutation({
    mutationFn: ({ handoff, draft }: { handoff: IntegrationHandoff; draft: IntegrationHandoffReceiptDraft }) =>
      api.recordIntegrationHandoffCallback(handoff.handoff_id, {
        external_job_id: draft.externalJobId,
        status: draft.status,
        receipt_id: draft.receiptId,
        error_code: draft.errorCode,
        legal_hold: draft.legalHold,
      }),
    onMutate: () => {
      setReceiptErrorHandoffId(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integration-handoffs"] });
    },
    onError: (_error, variables) => {
      setReceiptErrorHandoffId(variables.handoff.handoff_id);
    },
  });
  useEffect(() => {
    if (opsAlerts.data === undefined) return;
    setAlertItems((current) => {
      if (alertCursor === null) return opsAlerts.data.items;
      const seen = new Set(current.map((alert) => alert.alert_id));
      return [...current, ...opsAlerts.data.items.filter((alert) => !seen.has(alert.alert_id))];
    });
  }, [alertCursor, opsAlerts.data]);

  useEffect(() => {
    if (deliveryAlertId !== null && !alertItems.some((alert) => alert.alert_id === deliveryAlertId)) {
      setDeliveryAlertId(null);
    }
  }, [alertItems, deliveryAlertId]);

  function changeAlertSeverity(next: AlertSeverityFilter): void {
    setAlertCursor(null);
    setAlertItems([]);
    setAlertSeverity(next);
  }

  function changeAlertSource(next: AlertSourceFilter): void {
    setAlertCursor(null);
    setAlertItems([]);
    setAlertSource(next);
  }

  const schedulerQueueUnavailable = opsHealth.data?.queue.available === false;
  const queueRows = [
    { label: "대기 실행", value: countLabel(summary.data?.by_status.queued), action: () => navigate("runTrace", { status: "queued" }) },
    { label: "실행 중", value: countLabel(summary.data?.by_status.running), action: () => navigate("runTrace", { status: "running" }) },
    { label: "사람 확인 대기", value: human.data === undefined ? "-" : String(human.data.items.length), action: () => navigate("humanTasks") },
    { label: "작업 항목 재처리 대기", value: workDlq.data === undefined ? "-" : String(workDlq.data.items.length), action: () => navigate("workitems") },
  ];

  const queuePanel = (
    <section className="panel orchestration-status" aria-label="큐 운영 상태">
      <div className="panel-head">
        <h2>큐 상태</h2>
      </div>
      <table className="ops-table">
        <tbody>
          {queueRows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
              <td>
                <button className="linklike" type="button" onClick={row.action}>보기</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <div className="orchestration-view">
      <section className="panel orchestration-toolbar" aria-label="오케스트레이션 빠른 이동">
        <div>
          <h2>운영 오케스트레이션</h2>
          <p className="subtle">예약 실행, 큐 상태, 사람 개입, 실패 복구를 한 화면에서 관리합니다.</p>
        </div>
        <div className="quick-actions">
          <button className="btn" type="button" onClick={() => navigate("scenarioStudio")}>자동화 만들기</button>
          <button className="btn" type="button" onClick={() => navigate("runTrace")}>실행 기록</button>
          <button className="btn" type="button" onClick={() => navigate("workitems")}>작업 큐</button>
        </div>
      </section>

      <OpsHealthSummary
        health={opsHealth.data}
        isLoading={opsHealth.data === undefined && opsHealth.isFetching}
        isError={opsHealth.isError}
      />
      <ProductionReadinessPanel
        readiness={productionReadiness.data}
        isLoading={productionReadiness.data === undefined && productionReadiness.isFetching}
        isError={productionReadiness.isError}
        externalAlertEvidence={externalAlertReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
        isExternalAlertEvidenceLoading={externalAlertReadinessEvidence.data === undefined && externalAlertReadinessEvidence.isFetching}
        isExternalAlertEvidenceError={externalAlertReadinessEvidence.isError}
        backupEvidence={backupReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
        isBackupEvidenceLoading={backupReadinessEvidence.data === undefined && backupReadinessEvidence.isFetching}
        isBackupEvidenceError={backupReadinessEvidence.isError}
        sloEvidence={sloReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
        isSloEvidenceLoading={sloReadinessEvidence.data === undefined && sloReadinessEvidence.isFetching}
        isSloEvidenceError={sloReadinessEvidence.isError}
        observabilityEvidence={observabilityReadinessEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
        isObservabilityEvidenceLoading={observabilityReadinessEvidence.data === undefined && observabilityReadinessEvidence.isFetching}
        isObservabilityEvidenceError={observabilityReadinessEvidence.isError}
        canRecordBackupEvidence={can("ops_readiness.manage")}
        isRecordingBackupEvidence={recordBackupEvidenceMutation.isPending}
        recordBackupEvidenceError={recordBackupEvidenceMutation.isError}
        onRecordBackupEvidence={(draft) => recordBackupEvidenceMutation.mutate(draft)}
        canRecordExternalAlertEvidence={can("ops_readiness.manage")}
        isRecordingExternalAlertEvidence={recordExternalAlertEvidenceMutation.isPending}
        recordExternalAlertEvidenceError={recordExternalAlertEvidenceMutation.isError}
        onRecordExternalAlertEvidence={(draft) => recordExternalAlertEvidenceMutation.mutate(draft)}
        canRecordSloEvidence={can("ops_readiness.manage")}
        isRecordingSloEvidence={recordSloEvidenceMutation.isPending}
        recordSloEvidenceError={recordSloEvidenceMutation.isError}
        onRecordSloEvidence={(draft) => recordSloEvidenceMutation.mutate(draft)}
        canRecordObservabilityEvidence={can("ops_readiness.manage")}
        isRecordingObservabilityEvidence={recordObservabilityEvidenceMutation.isPending}
        recordObservabilityEvidenceError={recordObservabilityEvidenceMutation.isError}
        onRecordObservabilityEvidence={(draft) => recordObservabilityEvidenceMutation.mutate(draft)}
      />

      <TriggerScheduler schedulerQueueUnavailable={schedulerQueueUnavailable} queuePanel={queuePanel} />

      <section className="panel" aria-label="트리거와 알림">
        <div className="panel-head">
          <h2>트리거·알림</h2>
        </div>
        <div className="orchestration-grid">
          <StatusColumn
            title="트리거"
            caption="현재 지원 범위 안내 — 실시간 상태가 아닙니다."
            rows={[
              { name: "시간 예약", status: "저장 가능", tone: "green", action: "cron 기반" },
              { name: "외부 이벤트", status: "저장 가능", tone: "green", action: "서명 검증 + 이벤트 중복 방지" },
              { name: "파일 도착", status: "준비 중", tone: "amber", action: "후속 설계" },
              { name: "큐 적재", status: "준비 중", tone: "amber", action: "후속 설계" },
            ]}
          />
          <NotificationRoutingReadiness
            connectors={notificationConnectors.data?.items ?? []}
            templates={notificationTemplates.data?.items ?? []}
            isLoading={(notificationConnectors.data === undefined && notificationConnectors.isFetching) || (notificationTemplates.data === undefined && notificationTemplates.isFetching)}
            isError={notificationConnectors.isError || notificationTemplates.isError}
          />
          <IntegrationHandoffPanel
            handoffs={integrationHandoffs.data?.items ?? []}
            isLoading={integrationHandoffs.data === undefined && integrationHandoffs.isFetching}
            isError={integrationHandoffs.isError}
            canCreate={can("integration.handoff")}
            isCreating={createIntegrationHandoffMutation.isPending}
            createError={createIntegrationHandoffMutation.isError}
            onCreate={(draft) => createIntegrationHandoffMutation.mutate(draft)}
            canDispatch={can("integration.handoff")}
            dispatchingHandoffId={dispatchIntegrationHandoffMutation.isPending ? dispatchIntegrationHandoffMutation.variables?.handoff.handoff_id ?? null : null}
            dispatchErrorHandoffId={dispatchErrorHandoffId}
            onDispatch={(handoff, draft) => dispatchIntegrationHandoffMutation.mutate({ handoff, draft })}
            canRecordReceipt={can("integration.handoff")}
            recordingHandoffId={recordIntegrationHandoffReceiptMutation.isPending ? recordIntegrationHandoffReceiptMutation.variables?.handoff.handoff_id ?? null : null}
            receiptErrorHandoffId={receiptErrorHandoffId}
            onRecordReceipt={(handoff, draft) => recordIntegrationHandoffReceiptMutation.mutate({ handoff, draft })}
          />
          <OpsAlertCenter
            alerts={alertItems}
            isError={opsAlerts.isError}
            isLoading={opsAlerts.data === undefined && opsAlerts.isFetching}
            isFetchingMore={alertCursor !== null && opsAlerts.isFetching}
            nextCursor={opsAlerts.data?.next_cursor ?? null}
            severity={alertSeverity}
            source={alertSource}
            onLoadMore={(cursor) => setAlertCursor(cursor)}
            onSeverityChange={changeAlertSeverity}
            onSourceChange={changeAlertSource}
            canAck={can("ops_alert.ack")}
            ackingAlertId={ackMutation.isPending ? ackMutation.variables?.alert_id ?? null : null}
            ackErrorAlertId={ackErrorAlertId}
            onAck={(alert) => ackMutation.mutate(alert)}
            deliveryAlertId={deliveryAlertId}
            deliveryReceipts={deliveryReceipts.data?.items ?? []}
            isDeliveryLoading={deliveryAlertId !== null && deliveryReceipts.isFetching && deliveryReceipts.data === undefined}
            isDeliveryError={deliveryReceipts.isError}
            onToggleDeliveries={(alert) => setDeliveryAlertId((current) => (current === alert.alert_id ? null : alert.alert_id))}
            canSendWebhook={can("ops_alert.deliver")}
            sendingWebhookAlertId={sendWebhookMutation.isPending ? sendWebhookMutation.variables?.alert.alert_id ?? null : null}
            webhookSendErrorAlertId={webhookSendErrorAlertId}
            queuedWebhookAttempt={queuedWebhookAttempt}
            onSendWebhook={(alert, draft) => sendWebhookMutation.mutate({ alert, draft })}
          />
          <BotPoolCapacityPanel
            pools={botPools.data?.items ?? []}
            isLoading={botPools.data === undefined && botPools.isFetching}
            isError={botPools.isError}
            retryQueueStatus={workDlq.data !== undefined && workDlq.data.items.length > 0 ? "확인 필요" : "정상"}
            retryQueueTone={workDlq.data !== undefined && workDlq.data.items.length > 0 ? "red" : "green"}
          />
        </div>
      </section>
    </div>
  );
}

function opsAlertAckIdempotencyKey(alert: OpsAlertItem): string {
  const stableAlertId = alert.alert_id.replace(/[^a-zA-Z0-9._:-]/g, "_");
  const stableDetectedAt = alert.detected_at.replace(/[^a-zA-Z0-9._:-]/g, "_");
  return `ops-alert-ack-${stableAlertId}-${stableDetectedAt}-${Date.now()}`;
}

function externalAlertEvidenceIdempotencyKey(draft: ExternalAlertEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  const stableReceiptId = draft.receiptId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-alert-${stableEvidenceRef}-${stableReceiptId}-${Date.now()}`;
}

function webhookSendRequestBody(draft: OpsWebhookSendDraft): OpsNotificationWebhookSendRequest {
  const body: {
    endpoint_secret_ref: string;
    callback_signature_secret_ref?: string | null;
    route_policy_ref: string;
    recipient_group_ref?: string | null;
    allowed_hosts: readonly string[];
    metadata: Record<string, unknown>;
    legal_hold: boolean;
    provider_alias?: string;
    summary?: string;
  } = {
    endpoint_secret_ref: draft.endpointSecretRef,
    route_policy_ref: draft.routePolicyRef,
    recipient_group_ref: draft.recipientGroupRef,
    allowed_hosts: draft.allowedHosts,
    metadata: { requested_from: "admin_console" },
    legal_hold: draft.legalHold,
  };
  if (draft.callbackSignatureSecretRef !== null) body.callback_signature_secret_ref = draft.callbackSignatureSecretRef;
  if (draft.providerAlias !== null) body.provider_alias = draft.providerAlias;
  if (draft.summary !== null) body.summary = draft.summary;
  return body;
}

function opsAlertWebhookIdempotencyKey(alert: OpsAlertItem, draft: OpsWebhookSendDraft): string {
  return [
    "ops-alert-webhook",
    stableIdempotencyPart(alert.alert_id),
    stableIdempotencyPart(alert.detected_at),
    stableIdempotencyPart(draft.endpointSecretRef),
    Date.now(),
  ].join("-");
}

function stableIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}

function sloEvidenceIdempotencyKey(draft: SloEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-slo-${stableEvidenceRef}-${Date.now()}`;
}

function backupEvidenceIdempotencyKey(draft: BackupEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-backup-${stableEvidenceRef}-${Date.now()}`;
}

function observabilityEvidenceIdempotencyKey(draft: ObservabilityEvidenceRecordDraft): string {
  const stableEvidenceRef = draft.evidenceRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  const stableCollectorRef = draft.collectorRef.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  return `readiness-observability-${stableEvidenceRef}-${stableCollectorRef}-${Date.now()}`;
}

function integrationHandoffIdempotencyKey(draft: IntegrationHandoffCreateDraft): string {
  return [
    "integration-handoff",
    stableIdempotencyPart(draft.providerAlias),
    stableIdempotencyPart(draft.jobRef),
    stableIdempotencyPart(draft.payloadRef),
    Date.now(),
  ].join("-");
}

function integrationHandoffDispatchIdempotencyKey(
  handoff: IntegrationHandoff,
  draft: IntegrationHandoffDispatchDraft,
): string {
  return [
    "integration-handoff-dispatch",
    stableIdempotencyPart(handoff.handoff_id),
    stableIdempotencyPart(draft.endpointSecretRef),
    stableIdempotencyPart(draft.allowedHosts.join(".")),
    Date.now(),
  ].join("-");
}
