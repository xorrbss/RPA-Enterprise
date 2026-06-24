import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { navigate } from "../router";
import type { OpsAlertItem } from "../api/types";
import { OpsHealthSummary } from "./orchestration/OpsHealthSummary";
import { TriggerScheduler } from "./orchestration/TriggerScheduler";
import { StatusColumn } from "./orchestration/StatusColumn";
import { NotificationRoutingReadiness } from "./orchestration/NotificationRoutingReadiness";
import { OpsAlertCenter } from "./orchestration/OpsAlertCenter";
import { BotPoolCapacityPanel } from "./orchestration/BotPoolCapacityPanel";
import { countLabel, type AlertSeverityFilter, type AlertSourceFilter } from "./orchestration/trigger-helpers";

export function OrchestrationView(): JSX.Element {
  const api = useApiClient();
  const summary = useQuery({ queryKey: ["runs", "summary"], queryFn: () => api.getRunSummary(), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const workDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 10_000 });
  const opsHealth = useQuery({ queryKey: ["ops-health"], queryFn: () => api.getOpsHealth(), refetchInterval: 5_000 });
  const botPools = useQuery({ queryKey: ["bot-pools"], queryFn: () => api.listBotPools({ limit: 10 }), refetchInterval: 5_000 });
  const notificationConnectors = useQuery({ queryKey: ["connectors", "notification"], queryFn: () => api.listConnectors({ kind: "notification", limit: 10 }), refetchInterval: 60_000 });
  const notificationTemplates = useQuery({ queryKey: ["templates", "notification"], queryFn: () => api.listTemplates({ kind: "notification_workflow", limit: 10 }), refetchInterval: 60_000 });

  const [alertSeverity, setAlertSeverity] = useState<AlertSeverityFilter>("all");
  const [alertSource, setAlertSource] = useState<AlertSourceFilter>("all");
  const [alertCursor, setAlertCursor] = useState<string | null>(null);
  const [alertItems, setAlertItems] = useState<readonly OpsAlertItem[]>([]);
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
  useEffect(() => {
    if (opsAlerts.data === undefined) return;
    setAlertItems((current) => {
      if (alertCursor === null) return opsAlerts.data.items;
      const seen = new Set(current.map((alert) => alert.alert_id));
      return [...current, ...opsAlerts.data.items.filter((alert) => !seen.has(alert.alert_id))];
    });
  }, [alertCursor, opsAlerts.data]);

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
