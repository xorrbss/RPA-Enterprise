import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { DashboardEnvironmentState, type DashboardEnvironmentError } from "../components/DashboardEnvironmentState";
import { mergeParams, navigate, useHashParam } from "../router";
import type {
  IntegrationHandoff,
  RunItem,
  RunResumeRequest,
  WebAttendedRunRequest,
} from "../api/types";
import { OpsHealthSummary } from "./orchestration/OpsHealthSummary";
import { TriggerScheduler } from "./orchestration/TriggerScheduler";
import { StatusColumn } from "./orchestration/StatusColumn";
import { NotificationRoutingReadiness } from "./orchestration/NotificationRoutingReadiness";
import { BotPoolCapacityPanel } from "./orchestration/BotPoolCapacityPanel";
import {
  IntegrationHandoffPanel,
  type IntegrationHandoffCreateDraft,
  type IntegrationHandoffDispatchDraft,
  type IntegrationHandoffReceiptDraft,
} from "./orchestration/IntegrationHandoffPanel";
import { WebAttendedPanel, type WebAttendedRunCreateDraft } from "./orchestration/WebAttendedPanel";
import { countLabel } from "./orchestration/trigger-helpers";
import { useOpsAlertSection } from "./orchestration/useOpsAlertSection";
import { useReadinessSection } from "./orchestration/useReadinessSection";
import {
  integrationHandoffDispatchIdempotencyKey,
  integrationHandoffIdempotencyKey,
  runResumeIdempotencyKey,
  webAttendedIdempotencyKey,
  webAttendedRequestBody,
} from "./orchestration/ops-request-helpers";

type OpsSectionKey = "today" | "schedule" | "queue" | "alerts" | "readiness" | "external";

const OPS_SECTIONS: readonly { readonly key: OpsSectionKey; readonly label: string; readonly purpose: string }[] = [
  { key: "today", label: "오늘 필요한 조치", purpose: "헬스, 대기열, 긴급 알림" },
  { key: "schedule", label: "예약", purpose: "시간·이벤트 트리거" },
  { key: "queue", label: "큐", purpose: "대기, 사람 개입, 브라우저 실행" },
  { key: "alerts", label: "알림", purpose: "라우팅, 발송, 확인" },
  { key: "readiness", label: "운영 전환 증빙", purpose: "전환 증빙·리허설" },
  { key: "external", label: "외부 전달", purpose: "외부 RPA/IDP handoff" },
];

function isOpsSection(value: string | null): value is OpsSectionKey {
  return value === "today" || value === "schedule" || value === "queue" || value === "alerts" || value === "readiness" || value === "external";
}

function resolveOpsSection(section: string | null, scenario: string | null, trigger: string | null): OpsSectionKey {
  if (isOpsSection(section)) return section;
  if (scenario !== null || trigger !== null) return "schedule";
  return "today";
}

type QueryValueState<T> = {
  readonly data: T | undefined;
  readonly isFetching: boolean;
  readonly isError: boolean;
};

function queryValueLabel<T>(query: QueryValueState<T>, renderValue: (data: T) => string): string {
  if (query.isError) return "연결 필요";
  if (query.data === undefined) return query.isFetching ? "확인 중" : "확인 필요";
  return renderValue(query.data);
}

function OpsSectionSelector({ active }: { active: OpsSectionKey }): JSX.Element {
  return (
    <section className="panel ops-section-selector" aria-label="Automation Ops 섹션">
      <div className="section-tabs" role="list" aria-label="Automation Ops 로컬 섹션">
        {OPS_SECTIONS.map((section) => (
          <button
            key={section.key}
            type="button"
            className={`section-tab${section.key === active ? " active" : ""}`}
            aria-pressed={section.key === active}
            aria-current={section.key === active ? "true" : undefined}
            onClick={() => mergeParams({ section: section.key })}
          >
            <strong>{section.label}</strong>
            <span>{section.purpose}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function OrchestrationView(): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const can = useCan();
  const sectionParam = useHashParam("section");
  const scenarioParam = useHashParam("scenario");
  const triggerParam = useHashParam("trigger");
  const activeSection = resolveOpsSection(sectionParam, scenarioParam, triggerParam);
  const summary = useQuery({ queryKey: ["runs", "summary"], queryFn: () => api.getRunSummary(), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const workDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 10_000 });
  const opsHealth = useQuery({ queryKey: ["ops-health"], queryFn: () => api.getOpsHealth(), refetchInterval: 5_000 });
  const botPools = useQuery({ queryKey: ["bot-pools"], queryFn: () => api.listBotPools({ limit: 10 }), refetchInterval: 5_000 });
  const notificationConnectors = useQuery({ queryKey: ["connectors", "notification"], queryFn: () => api.listConnectors({ kind: "notification", limit: 10 }), refetchInterval: 60_000 });
  const notificationTemplates = useQuery({ queryKey: ["templates", "notification"], queryFn: () => api.listTemplates({ kind: "notification_workflow", limit: 10 }), refetchInterval: 60_000 });
  const integrationHandoffs = useQuery({
    queryKey: ["integration-handoffs"],
    queryFn: () => api.listIntegrationHandoffs({ limit: 5 }),
    refetchInterval: 30_000,
  });
  const webAttendedRunRequests = useQuery({
    queryKey: ["web-attended-run-requests"],
    queryFn: () => api.listWebAttendedRunRequests({ limit: 5 }),
    refetchInterval: 30_000,
  });
  const runResumeRequests = useQuery({
    queryKey: ["run-resume-requests"],
    queryFn: () => api.listRunResumeRequests({ limit: 5 }),
    refetchInterval: 30_000,
  });
  const suspendedRuns = useQuery({
    queryKey: ["runs", "suspended"],
    queryFn: () => api.listRuns({ status: "suspended", limit: 5 }),
    refetchInterval: 10_000,
  });

  const [dispatchErrorHandoffId, setDispatchErrorHandoffId] = useState<string | null>(null);
  const [receiptErrorHandoffId, setReceiptErrorHandoffId] = useState<string | null>(null);
  const [resumeErrorRunId, setResumeErrorRunId] = useState<string | null>(null);
  const { opsAlertCenter, opsAlertRoutePanel } = useOpsAlertSection();
  const productionReadinessPanel = useReadinessSection();
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
  const createWebAttendedRunRequestMutation = useMutation({
    mutationFn: (draft: WebAttendedRunCreateDraft) =>
      api.createWebAttendedRunRequest(webAttendedRequestBody(draft), webAttendedIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["web-attended-run-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const resumeSuspendedRunMutation = useMutation({
    mutationFn: (run: RunItem) => api.resumeRun(run.run_id, runResumeIdempotencyKey(run), "web attended resume from operations console"),
    onMutate: () => {
      setResumeErrorRunId(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["run-resume-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (_error, run) => {
      setResumeErrorRunId(run.run_id);
    },
  });

  const schedulerQueueUnavailable = opsHealth.data?.queue.available === false;
  const queueRows = [
    { label: "대기 실행", value: queryValueLabel(summary, (data) => countLabel(data.by_status.queued)), action: () => navigate("runTrace", { status: "queued" }) },
    { label: "실행 중", value: queryValueLabel(summary, (data) => countLabel(data.by_status.running)), action: () => navigate("runTrace", { status: "running" }) },
    { label: "사람 확인 대기", value: queryValueLabel(human, (data) => String(data.items.length)), action: () => navigate("humanTasks") },
    { label: "작업 항목 재처리 대기", value: queryValueLabel(workDlq, (data) => String(data.items.length)), action: () => navigate("workitems") },
  ];

  const opsPageErrors: DashboardEnvironmentError[] = [];
  if (activeSection === "today" || activeSection === "queue") {
    if (summary.isError) opsPageErrors.push({ label: "실행 요약", error: summary.error, onRetry: () => void summary.refetch() });
    if (human.isError) opsPageErrors.push({ label: "사람 확인 대기", error: human.error, onRetry: () => void human.refetch() });
    if (workDlq.isError) opsPageErrors.push({ label: "작업 항목 재처리", error: workDlq.error, onRetry: () => void workDlq.refetch() });
    if (opsHealth.isError) opsPageErrors.push({ label: "운영 헬스", error: opsHealth.error, onRetry: () => void opsHealth.refetch() });
  }
  if (activeSection === "queue") {
    if (botPools.isError) opsPageErrors.push({ label: "봇 풀 용량", error: botPools.error, onRetry: () => void botPools.refetch() });
    if (webAttendedRunRequests.isError) opsPageErrors.push({ label: "브라우저 실행 요청", error: webAttendedRunRequests.error, onRetry: () => void webAttendedRunRequests.refetch() });
    if (runResumeRequests.isError) opsPageErrors.push({ label: "재개 요청", error: runResumeRequests.error, onRetry: () => void runResumeRequests.refetch() });
    if (suspendedRuns.isError) opsPageErrors.push({ label: "일시 중단 실행", error: suspendedRuns.error, onRetry: () => void suspendedRuns.refetch() });
  }
  if (activeSection === "alerts") {
    if (notificationConnectors.isError) opsPageErrors.push({ label: "알림 커넥터", error: notificationConnectors.error, onRetry: () => void notificationConnectors.refetch() });
    if (notificationTemplates.isError) opsPageErrors.push({ label: "알림 템플릿", error: notificationTemplates.error, onRetry: () => void notificationTemplates.refetch() });
  }
  if (activeSection === "external" && integrationHandoffs.isError) {
    opsPageErrors.push({ label: "외부 RPA 전달", error: integrationHandoffs.error, onRetry: () => void integrationHandoffs.refetch() });
  }

  const suspendedRunItems = (suspendedRuns.data?.items ?? []).filter((run) => run.status === "suspended");

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

  const opsHealthSummary = (
    <OpsHealthSummary
      health={opsHealth.data}
      isLoading={opsHealth.data === undefined && opsHealth.isFetching}
      isError={opsHealth.isError}
    />
  );

  const triggerScheduler = <TriggerScheduler schedulerQueueUnavailable={schedulerQueueUnavailable} queuePanel={queuePanel} />;

  const notificationRouting = (
    <NotificationRoutingReadiness
      connectors={notificationConnectors.data?.items ?? []}
      templates={notificationTemplates.data?.items ?? []}
      isLoading={(notificationConnectors.data === undefined && notificationConnectors.isFetching) || (notificationTemplates.data === undefined && notificationTemplates.isFetching)}
      isError={notificationConnectors.isError || notificationTemplates.isError}
    />
  );

  const integrationHandoffPanel = (
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
  );

  const webAttendedPanel = (
    <WebAttendedPanel
      runRequests={webAttendedRunRequests.data?.items ?? ([] as WebAttendedRunRequest[])}
      resumeRequests={runResumeRequests.data?.items ?? ([] as RunResumeRequest[])}
      suspendedRuns={suspendedRunItems}
      isLoading={
        (webAttendedRunRequests.data === undefined && webAttendedRunRequests.isFetching) ||
        (runResumeRequests.data === undefined && runResumeRequests.isFetching) ||
        (suspendedRuns.data === undefined && suspendedRuns.isFetching)
      }
      isError={webAttendedRunRequests.isError || runResumeRequests.isError}
      canCreate={can("run.create")}
      isCreating={createWebAttendedRunRequestMutation.isPending}
      createError={createWebAttendedRunRequestMutation.isError}
      onCreate={(draft) => createWebAttendedRunRequestMutation.mutate(draft)}
      canResume={can("run.resume")}
      resumingRunId={resumeSuspendedRunMutation.isPending ? resumeSuspendedRunMutation.variables?.run_id ?? null : null}
      resumeErrorRunId={resumeErrorRunId}
      onResume={(run) => resumeSuspendedRunMutation.mutate(run)}
    />
  );

  const botPoolCapacityPanel = (
    <BotPoolCapacityPanel
      pools={botPools.data?.items ?? []}
      isLoading={botPools.data === undefined && botPools.isFetching}
      isError={botPools.isError}
      retryQueueStatus={workDlq.data !== undefined && workDlq.data.items.length > 0 ? "확인 필요" : "정상"}
      retryQueueTone={workDlq.data !== undefined && workDlq.data.items.length > 0 ? "red" : "green"}
    />
  );

  return (
    <div className="orchestration-view">
      <section className="panel orchestration-toolbar" aria-label="실행 예약·알림 빠른 이동">
        <div>
          <h2>예약·큐 운영</h2>
          <p className="subtle">예약 실행, 큐 상태, 사람 개입, 실패 복구를 한 화면에서 관리합니다.</p>
        </div>
        <div className="quick-actions">
          <button className="btn" type="button" onClick={() => navigate("scenarioStudio")}>자동화 만들기</button>
          <button className="btn" type="button" onClick={() => navigate("runTrace")}>실행 기록</button>
          <button className="btn" type="button" onClick={() => navigate("workitems")}>작업 큐</button>
        </div>
      </section>

      <OpsSectionSelector active={activeSection} />
      <DashboardEnvironmentState errors={opsPageErrors} />

      {activeSection === "today" && (
        <>
          {opsHealthSummary}
          {queuePanel}
          {opsAlertCenter}
        </>
      )}

      {activeSection === "schedule" && triggerScheduler}

      {activeSection === "queue" && (
        <section className="panel" aria-label="큐와 브라우저 실행">
          <div className="panel-head">
            <h2>큐</h2>
          </div>
          <div className="orchestration-grid">
            {queuePanel}
            {webAttendedPanel}
            {botPoolCapacityPanel}
          </div>
        </section>
      )}

      {activeSection === "alerts" && (
        <section className="panel" aria-label="알림 운영">
          <div className="panel-head">
            <h2>알림</h2>
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
            {notificationRouting}
            {opsAlertRoutePanel}
            {opsAlertCenter}
          </div>
        </section>
      )}

      {activeSection === "readiness" && productionReadinessPanel}

      {activeSection === "external" && (
        <section className="panel" aria-label="외부 전달">
          <div className="panel-head">
            <h2>외부 전달</h2>
          </div>
          <div className="orchestration-grid">{integrationHandoffPanel}</div>
        </section>
      )}
    </div>
  );
}
