import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import type {
  OpsAlertItem,
  OpsAlertNotificationRoute,
  OpsNotificationAttempt,
  OpsNotificationDelivery,
} from "../../api/types";
import { OpsAlertCenter, type OpsWebhookSendDraft } from "./OpsAlertCenter";
import { OpsAlertRoutePanel, type OpsAlertRouteDraft } from "./OpsAlertRoutePanel";
import type { AlertSeverityFilter, AlertSourceFilter } from "./trigger-helpers";
import {
  alertRouteCreateIdempotencyKey,
  opsAlertAckIdempotencyKey,
  opsAlertWebhookIdempotencyKey,
  webhookSendRequestBody,
} from "./ops-request-helpers";

export function useOpsAlertSection(): { opsAlertCenter: JSX.Element; opsAlertRoutePanel: JSX.Element } {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const can = useCan();

  const [alertSeverity, setAlertSeverity] = useState<AlertSeverityFilter>("all");
  const [alertSource, setAlertSource] = useState<AlertSourceFilter>("all");
  const [alertCursor, setAlertCursor] = useState<string | null>(null);
  const [alertItems, setAlertItems] = useState<readonly OpsAlertItem[]>([]);
  const [deliveryAlertId, setDeliveryAlertId] = useState<string | null>(null);
  const [ackErrorAlertId, setAckErrorAlertId] = useState<string | null>(null);
  const [webhookSendErrorAlertId, setWebhookSendErrorAlertId] = useState<string | null>(null);
  const [toggleErrorRouteId, setToggleErrorRouteId] = useState<string | null>(null);
  const [deleteErrorRouteId, setDeleteErrorRouteId] = useState<string | null>(null);
  const [queuedWebhookAttempt, setQueuedWebhookAttempt] = useState<OpsNotificationAttempt | null>(null);
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
  const opsAlertRoutes = useQuery({
    queryKey: ["ops-alert-routes"],
    queryFn: () => api.listOpsAlertNotificationRoutes({ limit: 50 }),
    refetchInterval: 30_000,
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
  const createAlertRouteMutation = useMutation({
    mutationFn: (draft: OpsAlertRouteDraft) =>
      api.createOpsAlertNotificationRoute({
        source: draft.source,
        min_severity: draft.minSeverity,
        provider_alias: draft.providerAlias,
        endpoint_secret_ref: draft.endpointSecretRef,
        callback_signature_secret_ref: draft.callbackSignatureSecretRef,
        route_policy_ref: draft.routePolicyRef,
        recipient_group_ref: draft.recipientGroupRef,
        allowed_hosts: draft.allowedHosts,
      }, alertRouteCreateIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ops-alert-routes"] });
    },
  });
  const toggleAlertRouteMutation = useMutation({
    mutationFn: (route: OpsAlertNotificationRoute) =>
      api.updateOpsAlertNotificationRoute(
        route.route_id,
        { enabled: !route.enabled },
        `ops-alert-route-toggle-${route.route_id}-${!route.enabled}-${Date.now()}`,
      ),
    onMutate: () => {
      setToggleErrorRouteId(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ops-alert-routes"] });
    },
    onError: (_error, route) => {
      setToggleErrorRouteId(route.route_id);
    },
  });
  const deleteAlertRouteMutation = useMutation({
    mutationFn: (route: OpsAlertNotificationRoute) =>
      api.deleteOpsAlertNotificationRoute(route.route_id, `ops-alert-route-delete-${route.route_id}-${Date.now()}`),
    onMutate: () => {
      setDeleteErrorRouteId(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ops-alert-routes"] });
    },
    onError: (_error, route) => {
      setDeleteErrorRouteId(route.route_id);
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

  const opsAlertCenter = (
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
  );

  const opsAlertRoutePanel = (
    <OpsAlertRoutePanel
      routes={opsAlertRoutes.data?.items ?? []}
      isLoading={opsAlertRoutes.data === undefined && opsAlertRoutes.isFetching}
      isError={opsAlertRoutes.isError}
      canManage={can("ops_alert.deliver")}
      isCreating={createAlertRouteMutation.isPending}
      createError={createAlertRouteMutation.isError}
      onCreate={(draft) => createAlertRouteMutation.mutate(draft)}
      togglingRouteId={toggleAlertRouteMutation.isPending ? toggleAlertRouteMutation.variables?.route_id ?? null : null}
      toggleErrorRouteId={toggleErrorRouteId}
      onToggle={(route) => toggleAlertRouteMutation.mutate(route)}
      deletingRouteId={deleteAlertRouteMutation.isPending ? deleteAlertRouteMutation.variables?.route_id ?? null : null}
      deleteErrorRouteId={deleteErrorRouteId}
      onDelete={(route) => deleteAlertRouteMutation.mutate(route)}
    />
  );

  return { opsAlertCenter, opsAlertRoutePanel };
}
