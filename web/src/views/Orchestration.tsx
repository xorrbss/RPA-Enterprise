import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import type { ApiClient } from "../api/client";
import { navigate, useHashParam } from "../router";
import { ApiError } from "../api/types";
import { useCan } from "../api/permissions";
import type {
  BotPoolItem,
  ConnectorCatalogItem,
  OpsAlertItem,
  OpsAlertSeverity,
  OpsAlertSource,
  OpsHealth,
  RunTriggerFireItem,
  RunTriggerItem,
  ScenarioItem,
  TemplateCatalogItem,
} from "../api/types";
import { errorCodeLabel, errorLabel } from "../components/badges";

type Cadence = "daily" | "weekly" | "monthly";
type TriggerMode = "cron" | "webhook";
type AlertSeverityFilter = OpsAlertSeverity | "all";
type AlertSourceFilter = OpsAlertSource | "all";
type ScenarioPickerPage = { readonly items: readonly ScenarioItem[]; readonly truncated: boolean };

function countLabel(count: number | undefined): string {
  return count === undefined ? "-" : String(count);
}

function scenarioLabel(scenario: ScenarioItem): string {
  return `${scenario.name} · 변경 ${scenario.version}`;
}

async function listScenarioPicker(api: ApiClient): Promise<ScenarioPickerPage> {
  let cursor: string | undefined;
  const items: ScenarioItem[] = [];
  for (let page = 0; page < 10; page += 1) {
    const result = await api.listScenarios({ limit: 50, ...(cursor !== undefined ? { cursor } : {}) });
    items.push(...result.items);
    if (result.next_cursor === null) return { items, truncated: false };
    cursor = result.next_cursor;
  }
  return { items, truncated: true };
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cronFrom(cadence: Cadence, time: string): string {
  const [hour = "9", minute = "0"] = time.split(":");
  if (cadence === "weekly") return `${Number(minute)} ${Number(hour)} * * 1`;
  if (cadence === "monthly") return `${Number(minute)} ${Number(hour)} 1 * *`;
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function detailValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

const ERROR_CODE_LABELS: Record<string, string> = {
  MAX_CONCURRENCY_REACHED: "동시 실행 한도에 도달했습니다.",
};

const DETAIL_KEY_LABELS: Record<string, string> = {
  detail: "설명",
  field: "항목",
  reason: "사유",
};

const DETAIL_VALUE_LABELS: Record<string, string> = {
  cron_expression: "예약식",
  invalid_cron_expression: "예약식을 다시 확인해야 합니다.",
  "expected five fields": "분 시 일 월 요일 형식이어야 합니다.",
};

function opsErrorCodeLabel(code: unknown): string {
  const normalized = detailValue(code);
  if (normalized === null) return "사유 코드 없음";
  return ERROR_CODE_LABELS[normalized] ?? errorCodeLabel(normalized);
}

function detailKeyLabel(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? key.replaceAll("_", " ");
}

function detailValueLabel(value: string): string {
  return DETAIL_VALUE_LABELS[value] ?? value;
}

function secretRefToDisplay(value: string | null): string {
  if (value === null) return "";
  return value.startsWith("secret://") ? value.slice("secret://".length) : value;
}

function displayToSecretRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("secret://")) return trimmed;
  return `secret://${trimmed}`;
}

function detailPart(key: string, value: unknown): string | null {
  const normalized = detailValue(value);
  if (normalized === null) return null;
  return `${detailKeyLabel(key)}: ${detailValueLabel(normalized)}`;
}

function errorWithDetails(error: unknown): string {
  const base = errorLabel(error);
  if (!(error instanceof ApiError)) return base;
  const details = error.body?.details;
  if (details === undefined) return base;
  const parts = [
    detailPart("field", details.field),
    detailPart("reason", details.reason),
    detailPart("detail", details.detail),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${base} (${parts.join(" · ")})` : base;
}

export function OrchestrationView(): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const can = useCan();
  const canManageTriggers = can("trigger.manage");
  const triggerParam = useHashParam("trigger");
  const scenarioParam = useHashParam("scenario");
  const scenarios = useQuery({ queryKey: ["scenarios", "orchestration-picker"], queryFn: () => listScenarioPicker(api), refetchInterval: 10_000 });
  const triggers = useQuery({ queryKey: ["run-triggers"], queryFn: () => api.listRunTriggers({ limit: 20 }), refetchInterval: 10_000 });
  const summary = useQuery({ queryKey: ["runs", "summary"], queryFn: () => api.getRunSummary(), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const workDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 10_000 });
  const opsHealth = useQuery({ queryKey: ["ops-health"], queryFn: () => api.getOpsHealth(), refetchInterval: 5_000 });
  const botPools = useQuery({ queryKey: ["bot-pools"], queryFn: () => api.listBotPools({ limit: 10 }), refetchInterval: 5_000 });
  const notificationConnectors = useQuery({ queryKey: ["connectors", "notification"], queryFn: () => api.listConnectors({ kind: "notification", limit: 10 }), refetchInterval: 60_000 });
  const notificationTemplates = useQuery({ queryKey: ["templates", "notification"], queryFn: () => api.listTemplates({ kind: "notification_workflow", limit: 10 }), refetchInterval: 60_000 });

  const scenarioItems = scenarios.data?.items ?? [];
  const scenarioPickerTruncated = scenarios.data?.truncated === true;
  const triggerItems = useMemo(() => triggers.data?.items ?? [], [triggers.data?.items]);
  const [scenarioId, setScenarioId] = useState("");
  const [appliedScenarioParam, setAppliedScenarioParam] = useState<string | null>(null);
  const [triggerMode, setTriggerMode] = useState<TriggerMode>("cron");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState("Asia/Seoul");
  const [webhookSecretRef, setWebhookSecretRef] = useState("prod/run-triggers/month-end");
  const [catchupPolicy, setCatchupPolicy] = useState<RunTriggerItem["catchup_policy"]>("skip_missed");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const [alertSeverity, setAlertSeverity] = useState<AlertSeverityFilter>("all");
  const [alertSource, setAlertSource] = useState<AlertSourceFilter>("all");
  const [alertCursor, setAlertCursor] = useState<string | null>(null);
  const [alertItems, setAlertItems] = useState<readonly OpsAlertItem[]>([]);
  const [lastSaved, setLastSaved] = useState<RunTriggerItem | null>(null);
  const [fireTriggerId, setFireTriggerId] = useState<string | null>(null);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [editCronExpression, setEditCronExpression] = useState("0 9 * * *");
  const [editTimezone, setEditTimezone] = useState("Asia/Seoul");
  const [editWebhookSecretRef, setEditWebhookSecretRef] = useState("");
  const [editCatchupPolicy, setEditCatchupPolicy] = useState<RunTriggerItem["catchup_policy"]>("skip_missed");
  const [editMaxConcurrentRuns, setEditMaxConcurrentRuns] = useState(1);
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

  const selectedScenario = useMemo(
    () => scenarioItems.find((item) => item.scenario_id === scenarioId) ?? scenarioItems[0] ?? null,
    [scenarioId, scenarioItems],
  );
  useEffect(() => {
    if (scenarioParam === null) {
      if (appliedScenarioParam !== null) setAppliedScenarioParam(null);
      return;
    }
    if (appliedScenarioParam === scenarioParam) return;
    if (scenarioItems.some((item) => item.scenario_id === scenarioParam)) {
      setScenarioId(scenarioParam);
      setAppliedScenarioParam(scenarioParam);
    }
  }, [appliedScenarioParam, scenarioItems, scenarioParam]);
  const triggerParamInList = useMemo(
    () => triggerParam !== null && triggerItems.some((trigger) => trigger.trigger_id === triggerParam),
    [triggerItems, triggerParam],
  );
  const linkedTrigger = useQuery({
    queryKey: ["run-trigger", triggerParam],
    queryFn: () => api.getRunTrigger(triggerParam as string),
    enabled: triggerParam !== null && !triggerParamInList,
    retry: false,
  });
  useEffect(() => {
    if (triggerParam !== null) {
      if (triggerParamInList || linkedTrigger.data !== undefined) {
        if (fireTriggerId !== triggerParam) setFireTriggerId(triggerParam);
        return;
      }
      if (linkedTrigger.isError) {
        if (triggerItems.length > 0 && (fireTriggerId === null || !triggerItems.some((trigger) => trigger.trigger_id === fireTriggerId))) {
          setFireTriggerId(triggerItems[0]?.trigger_id ?? null);
        } else if (triggerItems.length === 0 && fireTriggerId !== null) {
          setFireTriggerId(null);
        }
      }
      return;
    }
    if (triggerItems.length === 0) {
      if (fireTriggerId !== null) setFireTriggerId(null);
      return;
    }
    if (fireTriggerId === null || !triggerItems.some((trigger) => trigger.trigger_id === fireTriggerId)) {
      setFireTriggerId(triggerItems[0]?.trigger_id ?? null);
    }
  }, [fireTriggerId, linkedTrigger.data, linkedTrigger.isError, triggerItems, triggerParam, triggerParamInList]);

  const selectedFireTrigger = useMemo(
    () => triggerItems.find((trigger) => trigger.trigger_id === fireTriggerId) ?? (linkedTrigger.data?.trigger_id === fireTriggerId ? linkedTrigger.data : null),
    [fireTriggerId, linkedTrigger.data, triggerItems],
  );
  const editingTrigger = useMemo(
    () => triggerItems.find((trigger) => trigger.trigger_id === editingTriggerId) ?? null,
    [editingTriggerId, triggerItems],
  );
  const triggerFires = useQuery({
    queryKey: ["run-trigger-fires", fireTriggerId],
    queryFn: () => api.listRunTriggerFires(fireTriggerId as string, { limit: 10 }),
    enabled: fireTriggerId !== null,
    refetchInterval: 5_000,
  });
  const canCreateTrigger = selectedScenario !== null && (triggerMode === "cron" || webhookSecretRef.trim().length > 0);
  const schedulerQueueUnavailable = opsHealth.data?.queue.available === false;

  const createTrigger = useMutation({
    mutationFn: async () => {
      if (selectedScenario === null) throw new Error("scenario_required");
      if (triggerMode === "webhook") {
        return api.createRunTrigger(
          {
            trigger_type: "webhook",
            scenario_version_id: selectedScenario.latest_version_id,
            webhook_secret_ref: displayToSecretRef(webhookSecretRef),
            params: {},
            max_concurrent_runs: maxConcurrentRuns,
          },
          idempotencyKey("run-trigger"),
        );
      }
      return api.createRunTrigger(
        {
          trigger_type: "cron",
          scenario_version_id: selectedScenario.latest_version_id,
          cron_expression: cronFrom(cadence, time),
          timezone,
          params: {},
          catchup_policy: catchupPolicy,
          max_concurrent_runs: maxConcurrentRuns,
        },
        idempotencyKey("run-trigger"),
      );
    },
    onSuccess: async (trigger) => {
      setLastSaved(trigger);
      setFireTriggerId(trigger.trigger_id);
      setEditingTriggerId(null);
      await queryClient.invalidateQueries({ queryKey: ["run-triggers"] });
    },
  });

  const pauseTrigger = useMutation({
    mutationFn: (triggerId: string) => api.pauseRunTrigger(triggerId, idempotencyKey("pause-trigger")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run-triggers"] }),
  });

  const resumeTrigger = useMutation({
    mutationFn: (triggerId: string) => api.resumeRunTrigger(triggerId, idempotencyKey("resume-trigger")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run-triggers"] }),
  });

  const updateTrigger = useMutation({
    mutationFn: async () => {
      if (editingTrigger === null) throw new Error("trigger_required");
      if (editingTrigger.trigger_type === "webhook") {
        return api.updateRunTrigger(
          editingTrigger.trigger_id,
          {
            webhook_secret_ref: displayToSecretRef(editWebhookSecretRef),
            max_concurrent_runs: editMaxConcurrentRuns,
          },
          idempotencyKey("update-trigger"),
        );
      }
      return api.updateRunTrigger(
        editingTrigger.trigger_id,
        {
          cron_expression: editCronExpression.trim(),
          timezone: editTimezone.trim(),
          catchup_policy: editCatchupPolicy,
          max_concurrent_runs: editMaxConcurrentRuns,
        },
        idempotencyKey("update-trigger"),
      );
    },
    onSuccess: async (trigger) => {
      setLastSaved(trigger);
      setFireTriggerId(trigger.trigger_id);
      await queryClient.invalidateQueries({ queryKey: ["run-triggers"] });
    },
  });

  function startEditingTrigger(trigger: RunTriggerItem): void {
    setEditingTriggerId(trigger.trigger_id);
    setEditCronExpression(trigger.cron_expression ?? "0 9 * * *");
    setEditTimezone(trigger.timezone ?? "Asia/Seoul");
    setEditWebhookSecretRef(secretRefToDisplay(trigger.webhook_secret_ref));
    setEditCatchupPolicy(trigger.catchup_policy);
    setEditMaxConcurrentRuns(trigger.max_concurrent_runs);
  }

  function selectFireHistory(triggerId: string): void {
    setFireTriggerId(triggerId);
    navigate("automationOps", { trigger: triggerId });
  }

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

  const queueRows = [
    { label: "대기 실행", value: countLabel(summary.data?.by_status.queued), action: () => navigate("runTrace", { status: "queued" }) },
    { label: "실행 중", value: countLabel(summary.data?.by_status.running), action: () => navigate("runTrace", { status: "running" }) },
    { label: "사람 확인 대기", value: human.data === undefined ? "-" : String(human.data.items.length), action: () => navigate("humanTasks") },
    { label: "작업 항목 재처리 대기", value: workDlq.data === undefined ? "-" : String(workDlq.data.items.length), action: () => navigate("workitems") },
  ];

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

      <div className="orchestration-layout">
        <section className="panel orchestration-builder" aria-label="실행 예약 생성">
          <div className="panel-head">
            <h2>실행 예약</h2>
            <span className={`badge ${schedulerQueueUnavailable ? "amber" : "green"}`}>
              {schedulerQueueUnavailable ? "큐 연결 확인" : "저장 가능"}
            </span>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>자동화</span>
              <select value={selectedScenario?.scenario_id ?? ""} onChange={(event) => setScenarioId(event.target.value)} disabled={scenarioItems.length === 0}>
                {scenarioItems.length === 0 ? (
                  <option value="">자동화 없음</option>
                ) : (
                  scenarioItems.map((scenario) => (
                    <option key={scenario.scenario_id} value={scenario.scenario_id}>
                      {scenarioLabel(scenario)}
                    </option>
                  ))
                )}
              </select>
              {scenarioPickerTruncated && <small className="subtle">자동화 500건 기준입니다. 더 오래된 항목은 자동화 목록에서 먼저 확인하세요.</small>}
            </label>
            <label className="field">
              <span>트리거 방식</span>
              <select value={triggerMode} onChange={(event) => setTriggerMode(event.target.value as TriggerMode)}>
                <option value="cron">예약 실행</option>
                <option value="webhook">외부 이벤트</option>
              </select>
            </label>
            {triggerMode === "cron" ? (
              <>
                <label className="field">
                  <span>주기</span>
                  <select value={cadence} onChange={(event) => setCadence(event.target.value as Cadence)}>
                    <option value="daily">매일</option>
                    <option value="weekly">매주 월요일</option>
                    <option value="monthly">매월 1일</option>
                  </select>
                </label>
                <label className="field">
                  <span>시각</span>
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
                </label>
                <label className="field">
                  <span>시간대</span>
                  <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                    <option value="Asia/Seoul">Asia/Seoul</option>
                    <option value="UTC">UTC</option>
                    <option value="America/Los_Angeles">America/Los_Angeles</option>
                  </select>
                </label>
              </>
            ) : (
              <label className="field">
                <span>외부 이벤트 보안 연결</span>
                <input
                  aria-label="외부 이벤트 보안 연결"
                  type="text"
                  value={webhookSecretRef}
                  onChange={(event) => setWebhookSecretRef(event.target.value)}
                  placeholder="prod/run-triggers/month-end"
                />
                <small className="subtle">보안 저장소에 등록한 연결 이름을 사용합니다. 저장 시 보호된 참조로 전송됩니다.</small>
              </label>
            )}
            <label className="field">
              <span>동시 실행 제한</span>
              <input
                type="number"
                min={1}
                max={20}
                value={maxConcurrentRuns}
                onChange={(event) => setMaxConcurrentRuns(concurrencyFrom(event.currentTarget.valueAsNumber))}
              />
            </label>
            {triggerMode === "cron" && (
              <label className="field">
                <span>누락 실행 처리</span>
                <select value={catchupPolicy} onChange={(event) => setCatchupPolicy(event.target.value as RunTriggerItem["catchup_policy"])}>
                  <option value="skip_missed">누락분 건너뛰기</option>
                  <option value="fire_once">누락분 순차 보강</option>
                </select>
              </label>
            )}
          </div>
          <div className="inline-actions">
            <button className="btn primary" type="button" onClick={() => createTrigger.mutate()} disabled={!canManageTriggers || !canCreateTrigger || createTrigger.isPending}>
              {createTrigger.isPending ? "저장 중" : "예약 저장"}
            </button>
            <button className="btn" type="button" onClick={() => navigate("playground", selectedScenario !== null ? { scenario: selectedScenario.scenario_id } : undefined)} disabled={selectedScenario === null}>
              미리보기
            </button>
            {!canManageTriggers && <span className="badge amber">예약 변경 권한 없음</span>}
          </div>
          {schedulerQueueUnavailable && (
            <p className="form-alert amber" role="status">
              예약 정의는 저장할 수 있지만 발화 작업 큐가 미연결 상태입니다. worker Graphile queue와 MAINTENANCE_TENANT_IDS 배포 설정을 확인해야 실제 정기 실행이 시작됩니다.
            </p>
          )}
          {createTrigger.isError && <p className="error">{errorWithDetails(createTrigger.error)}</p>}
          {lastSaved !== null && (
            <div className="draft-summary" role="status">
              <span className="badge green">저장됨</span>
              <strong>{selectedScenario?.name ?? lastSaved.scenario_version_id}</strong>
              <span>{triggerSummary(lastSaved)}</span>
              <span>{triggerSecondary(lastSaved)}</span>
              {lastSaved.trigger_type === "webhook" && <span>외부 시스템 연결 주소 준비됨</span>}
            </div>
          )}
        </section>

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
      </div>

      <section className="panel" aria-label="등록된 실행 예약">
        <div className="panel-head">
          <h2>등록된 예약</h2>
          <button className="linklike" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["run-triggers"] })}>새로고침</button>
        </div>
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">예약</th>
                <th scope="col">상태</th>
                <th scope="col">다음 실행</th>
                <th scope="col">동시성</th>
                <th scope="col">누락 정책</th>
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {triggerItems.length === 0 ? (
                <tr>
                  <td colSpan={6}>등록된 예약이 없습니다.</td>
                </tr>
              ) : (
                triggerItems.map((trigger) => (
                  <tr key={trigger.trigger_id}>
                    <th scope="row">{triggerSummary(trigger)}</th>
                    <td><span className={`badge ${trigger.status === "enabled" ? "green" : "muted"}`}>{statusLabel(trigger.status)}</span></td>
                    <td>{nextFireLabel(trigger)}</td>
                    <td>{trigger.max_concurrent_runs}</td>
                    <td>{trigger.trigger_type === "cron" ? catchupPolicyLabel(trigger.catchup_policy) : "-"}</td>
                    <td>
                      {canManageTriggers && (
                        <>
                          {trigger.status === "enabled" ? (
                            <button className="linklike" type="button" onClick={() => pauseTrigger.mutate(trigger.trigger_id)}>일시정지</button>
                          ) : (
                            <button className="linklike" type="button" onClick={() => resumeTrigger.mutate(trigger.trigger_id)}>재개</button>
                          )}
                          <span className="subtle"> · </span>
                        </>
                      )}
                      <button className="linklike" type="button" onClick={() => selectFireHistory(trigger.trigger_id)}>이력</button>
                      {canManageTriggers ? (
                        <>
                          <span className="subtle"> · </span>
                          <button className="linklike" type="button" onClick={() => startEditingTrigger(trigger)}>수정</button>
                        </>
                      ) : (
                        <span className="subtle"> · 읽기 전용</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {editingTrigger !== null && (
          <div className="trigger-edit-panel" aria-label="예약 수정">
            <div>
              <h3>예약 수정</h3>
              <p className="subtle">{triggerSummary(editingTrigger)} · {triggerSecondary(editingTrigger)}</p>
            </div>
            <div className="form-grid">
              {editingTrigger.trigger_type === "cron" ? (
                <>
                  <label className="field">
                    <span>고급 예약식</span>
                    <input type="text" value={editCronExpression} onChange={(event) => setEditCronExpression(event.target.value)} />
                    <small className="subtle">일반 일정은 새 예약의 반복/시간 선택을 사용하고, 특수 일정만 이 값을 조정합니다.</small>
                  </label>
                  <label className="field">
                    <span>시간대</span>
                    <select value={editTimezone} onChange={(event) => setEditTimezone(event.target.value)}>
                      <option value="Asia/Seoul">Asia/Seoul</option>
                      <option value="UTC">UTC</option>
                      <option value="America/Los_Angeles">America/Los_Angeles</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>누락 실행 처리</span>
                    <select value={editCatchupPolicy} onChange={(event) => setEditCatchupPolicy(event.target.value as RunTriggerItem["catchup_policy"])}>
                      <option value="skip_missed">누락분 건너뛰기</option>
                      <option value="fire_once">누락분 순차 보강</option>
                    </select>
                  </label>
                </>
              ) : (
                <label className="field">
                  <span>외부 이벤트 보안 연결</span>
                  <input aria-label="외부 이벤트 보안 연결" type="text" value={editWebhookSecretRef} onChange={(event) => setEditWebhookSecretRef(event.target.value)} />
                  <small className="subtle">보안 저장소에 등록한 연결 이름을 사용합니다. 저장 시 보호된 참조로 전송됩니다.</small>
                </label>
              )}
              <label className="field">
                <span>동시 실행 제한</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={editMaxConcurrentRuns}
                  onChange={(event) => setEditMaxConcurrentRuns(concurrencyFrom(event.currentTarget.valueAsNumber))}
                />
              </label>
            </div>
            <div className="inline-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => updateTrigger.mutate()}
                disabled={!canSaveTriggerEdit(editingTrigger, editCronExpression, editTimezone, editWebhookSecretRef) || updateTrigger.isPending}
              >
                {updateTrigger.isPending ? "저장 중" : "변경 저장"}
              </button>
              <button className="btn" type="button" onClick={() => setEditingTriggerId(null)}>닫기</button>
            </div>
            {updateTrigger.isError && <p className="error">{errorWithDetails(updateTrigger.error)}</p>}
          </div>
        )}
      </section>

      <section className="panel" aria-label="최근 트리거 발화 이력">
        <div className="panel-head">
          <div>
            <h2>최근 발화 이력</h2>
            <p className="subtle">
              {selectedFireTrigger !== null ? `${triggerSummary(selectedFireTrigger)} · ${triggerSecondary(selectedFireTrigger)}` : "예약을 선택하면 최근 발화 결과를 확인할 수 있습니다."}
            </p>
          </div>
          <button className="linklike" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["run-trigger-fires", fireTriggerId] })} disabled={fireTriggerId === null}>
            새로고침
          </button>
        </div>
        <TriggerFireHistory fires={triggerFires.data?.items ?? []} isLoading={triggerFires.isFetching && triggerFires.data === undefined} isError={triggerFires.isError} />
      </section>

      <section className="panel" aria-label="트리거와 알림">
        <div className="panel-head">
          <h2>트리거·알림</h2>
        </div>
        <div className="orchestration-grid">
          <StatusColumn
            title="트리거"
            rows={[
              { name: "시간 예약", status: "저장 가능", tone: "green", action: "cron 기반" },
              { name: "외부 이벤트", status: "저장 가능", tone: "green", action: "서명 검증 + 이벤트 중복 방지" },
              { name: "파일 도착", status: "계약 필요", tone: "amber", action: "후속 설계" },
              { name: "큐 적재", status: "계약 필요", tone: "amber", action: "후속 설계" },
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

function concurrencyFrom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(20, Math.trunc(value)));
}

function canSaveTriggerEdit(trigger: RunTriggerItem, cronExpression: string, timezone: string, webhookSecretRef: string): boolean {
  if (trigger.trigger_type === "webhook") return webhookSecretRef.trim().length > 0;
  return cronExpression.trim().length > 0 && timezone.trim().length > 0;
}

function OpsHealthSummary({
  health,
  isLoading,
  isError,
}: {
  health: OpsHealth | undefined;
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <section className="panel ops-health-summary" aria-label="운영 헬스 요약">
        <div className="panel-head">
          <h2>운영 헬스</h2>
          <span className="badge red">조회 실패</span>
        </div>
        <p className="empty-state">운영 헬스 스냅샷을 불러오지 못했습니다.</p>
      </section>
    );
  }

  return (
    <section className="panel ops-health-summary" aria-label="운영 헬스 요약">
      <div className="panel-head">
        <div>
          <h2>운영 헬스</h2>
          <p className="subtle">{health?.detected_at !== undefined ? formatDateTime(health.detected_at) : (isLoading ? "동기화 중" : "스냅샷 없음")}</p>
        </div>
        <span className={`badge ${opsHealthTone(health?.status)}`}>{opsHealthLabel(health?.status, isLoading)}</span>
      </div>
      <div className="ops-health-grid">
        <HealthTile
          title="큐 대기"
          value={health === undefined ? "-" : health.queue.available ? String(health.queue.pending_jobs ?? 0) : "미연결"}
          detail={health?.queue.available === true ? "대기 작업" : "작업 큐 미연결"}
        />
        <HealthTile
          title="브라우저 세션"
          value={health === undefined ? "-" : String(health.browser_leases.active + health.browser_leases.reserved)}
          detail={health === undefined ? "사용 중/예약" : `만료 미회수 ${health.browser_leases.expired_open}건`}
          tone={health !== undefined && health.browser_leases.expired_open > 0 ? "red" : "green"}
        />
        <HealthTile
          title="지연 실행"
          value={health === undefined ? "-" : String(health.stale_runs.nonterminal_over_15m)}
          detail="15분 이상 진행 중"
          tone={health !== undefined && health.stale_runs.nonterminal_over_15m > 0 ? "amber" : "green"}
          action={health !== undefined && health.stale_runs.nonterminal_over_15m > 0 ? () => navigate("runTrace", { status: "running" }) : undefined}
        />
        <HealthTile
          title="예약 스케줄러"
          value={schedulerHealthValue(health)}
          detail={schedulerHealthDetail(health)}
          tone={schedulerHealthTone(health)}
        />
      </div>
    </section>
  );
}

function HealthTile({
  title,
  value,
  detail,
  tone = "blue",
  action,
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "green" | "blue" | "amber" | "red" | "muted";
  action?: () => void;
}): JSX.Element {
  return (
    <div className="ops-health-tile">
      <span className="subtle">{title}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{detail}</span>
      {action !== undefined && (
        <button className="linklike" type="button" onClick={action}>
          실행 보기
        </button>
      )}
    </div>
  );
}

function opsHealthTone(status: OpsHealth["status"] | undefined): "green" | "amber" | "red" | "muted" {
  if (status === "ok") return "green";
  if (status === "warning") return "amber";
  if (status === "critical") return "red";
  return "muted";
}

function opsHealthLabel(status: OpsHealth["status"] | undefined, isLoading: boolean): string {
  if (status === "ok") return "정상";
  if (status === "warning") return "주의";
  if (status === "critical") return "위험";
  return isLoading ? "동기화 중" : "미확인";
}

function schedulerHealthValue(health: OpsHealth | undefined): string {
  if (health === undefined) return "-";
  return health.queue.available ? "큐 연결" : "확인 필요";
}

function schedulerHealthDetail(health: OpsHealth | undefined): string {
  if (health === undefined) return "스케줄러 상태 확인 중";
  return health.queue.available ? "발화 작업 적재 가능" : "작업 큐 미연결";
}

function schedulerHealthTone(health: OpsHealth | undefined): "green" | "blue" | "amber" | "red" | "muted" {
  if (health === undefined) return "muted";
  return health.queue.available ? "green" : "amber";
}

function TriggerFireHistory({
  fires,
  isLoading,
  isError,
}: {
  fires: readonly RunTriggerFireItem[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return <p className="empty-state">발화 이력을 불러오지 못했습니다.</p>;
  }
  if (isLoading) {
    return <p className="empty-state">발화 이력을 불러오는 중입니다.</p>;
  }
  if (fires.length === 0) {
    return <p className="empty-state">최근 발화 이력이 없습니다.</p>;
  }

  return (
    <table className="ops-table trigger-fire-table">
      <thead>
        <tr>
          <th scope="col">예정 시각</th>
          <th scope="col">결과</th>
          <th scope="col">실행</th>
          <th scope="col">사유</th>
          <th scope="col">작업</th>
        </tr>
      </thead>
      <tbody>
        {fires.map((fire) => {
          const runId = fire.run_id;
          return (
            <tr key={fire.fire_id}>
              <th scope="row">{formatDateTime(fire.scheduled_for)}</th>
              <td>
                <span className={`badge ${triggerFireStatusTone(fire.status)}`}>{triggerFireStatusLabel(fire.status)}</span>
              </td>
              <td>{runId !== null ? <span title={runId}>실행 연결됨</span> : <span className="subtle">미생성</span>}</td>
              <td>{triggerFireFailureLabel(fire.failure_reason)}</td>
              <td>
                {runId !== null ? (
                  <button className="linklike" type="button" onClick={() => navigate("runTrace", { run: runId })}>
                    실행 보기
                  </button>
                ) : (
                  <span className="subtle">-</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function triggerFireStatusTone(status: RunTriggerFireItem["status"]): "green" | "amber" | "red" {
  if (status === "queued") return "green";
  if (status === "skipped") return "amber";
  return "red";
}

function triggerFireStatusLabel(status: RunTriggerFireItem["status"]): string {
  if (status === "queued") return "실행 생성";
  if (status === "skipped") return "건너뜀";
  return "실패";
}

function triggerFireFailureLabel(reason: RunTriggerFireItem["failure_reason"]): string {
  if (reason === null) return "-";
  const codeLabel = opsErrorCodeLabel(reason.code);
  const details = reason.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return codeLabel;
  const record = details as Record<string, unknown>;
  const parts = [
    detailPart("reason", record.reason),
    detailPart("field", record.field),
    detailPart("detail", record.detail),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${codeLabel} (${parts.join(" · ")})` : codeLabel;
}

interface NotificationRoutingRow {
  readonly key: string;
  readonly name: string;
  readonly kind: "커넥터" | "템플릿";
  readonly status: ConnectorCatalogItem["status"];
  readonly action: string;
  readonly secretRefCount: number;
}

function NotificationRoutingReadiness({
  connectors,
  templates,
  isLoading,
  isError,
}: {
  connectors: readonly ConnectorCatalogItem[];
  templates: readonly TemplateCatalogItem[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  const rows: NotificationRoutingRow[] = [
    ...connectors.map((connector) => ({
      key: `connector-${connector.connector_id}`,
      name: connector.name,
      kind: "커넥터" as const,
      status: connector.status,
      action: connectorActionLabel(connector),
      secretRefCount: connector.required_secret_refs.length,
    })),
    ...templates.map((template) => ({
      key: `template-${template.template_id}`,
      name: template.name,
      kind: "템플릿" as const,
      status: template.status,
      action: templateActionLabel(template),
      secretRefCount: template.required_secret_refs.length,
    })),
  ];

  return (
    <div className="ops-column ops-notification-readiness">
      <div className="ops-alert-center-head">
        <h3>알림 라우팅</h3>
        <span className={`badge ${notificationRoutingTone(rows)}`}>{notificationRoutingBadge(rows, isLoading, isError)}</span>
      </div>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>알림 라우팅 준비도를 불러오지 못했습니다.</strong>
          <span className="subtle">커넥터/템플릿 카탈로그 조회 권한과 네트워크 상태를 확인하세요.</span>
        </div>
      ) : isLoading ? (
        <div className="ops-alert-empty" role="status">
          <strong>알림 채널을 확인하는 중입니다.</strong>
          <span className="subtle">커넥터와 알림 템플릿 카탈로그를 동기화합니다.</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="ops-alert-empty" role="status">
          <strong>등록된 알림 채널이 없습니다.</strong>
          <span className="subtle">실행 실패, SLA 위험, 사람 작업 에스컬레이션 알림은 커넥터 계약이 필요합니다.</span>
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              <span>
                <strong>{row.name}</strong>
                <span className="subtle">{row.kind} · {row.action}</span>
                {row.secretRefCount > 0 && <span className="subtle">{secretRequirementLabel(row.secretRefCount)}</span>}
              </span>
              <span className={`badge ${catalogStatusTone(row.status)}`}>{catalogStatusLabel(row.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpsAlertCenter({
  alerts,
  isError,
  isLoading,
  isFetchingMore,
  nextCursor,
  severity,
  source,
  onLoadMore,
  onSeverityChange,
  onSourceChange,
}: {
  alerts: readonly OpsAlertItem[];
  isError: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  nextCursor: string | null;
  severity: AlertSeverityFilter;
  source: AlertSourceFilter;
  onLoadMore: (cursor: string) => void;
  onSeverityChange: (severity: AlertSeverityFilter) => void;
  onSourceChange: (source: AlertSourceFilter) => void;
}): JSX.Element {
  return (
    <div className="ops-column ops-alert-center">
      <div className="ops-alert-center-head">
        <h3>알림 센터</h3>
        <span className="badge muted">{isLoading ? "동기화 중" : `${alerts.length}건`}</span>
      </div>
      <div className="ops-alert-controls">
        <label className="select-compact">
          심각도
          <select aria-label="알림 심각도" value={severity} onChange={(event) => onSeverityChange(event.target.value as AlertSeverityFilter)}>
            <option value="all">전체</option>
            <option value="critical">{alertSeverityLabel("critical")}</option>
            <option value="warning">{alertSeverityLabel("warning")}</option>
            <option value="info">{alertSeverityLabel("info")}</option>
          </select>
        </label>
        <label className="select-compact">
          유형
          <select aria-label="알림 유형" value={source} onChange={(event) => onSourceChange(event.target.value as AlertSourceFilter)}>
            <option value="all">전체</option>
            <option value="run_sla">실행 SLA</option>
            <option value="human_task_sla">사람 작업 SLA</option>
            <option value="trigger_fire">트리거 발화</option>
            <option value="failure_spike">실패 급증</option>
            <option value="dlq">재처리 대기</option>
          </select>
        </label>
      </div>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>운영 알림을 불러오지 못했습니다.</strong>
          <span className="subtle">알림 API와 콘솔 네트워크 상태를 확인하세요.</span>
        </div>
      ) : alerts.length === 0 ? (
        <div className="ops-alert-empty" role="status">
          <strong>열린 운영 알림이 없습니다.</strong>
          <span className="subtle">SLA, 트리거, 재처리 대기 감시는 현재 정상 범위입니다.</span>
        </div>
      ) : (
        <>
        <ul className="ops-alert-list">
          {alerts.map((alert) => (
            <li key={alert.alert_id}>
              <div className="ops-alert-main">
                <div className="ops-alert-badges">
                  <span className={`badge ${alertSeverityTone(alert.severity)}`}>{alertSeverityLabel(alert.severity)}</span>
                  <span className="subtle">{opsAlertSourceLabel(alert.source)}</span>
                </div>
                <strong>{alert.title}</strong>
                <span className="subtle">{alert.detail}</span>
                <span className="ops-alert-action">권장 조치: {alert.recommended_action}</span>
                <span className="subtle">{opsAlertTiming(alert)}</span>
              </div>
              {alert.route !== null && (
                <button className="linklike" type="button" onClick={() => navigateAlertRoute(alert.route)}>
                  {opsAlertActionLabel(alert)}
                </button>
              )}
            </li>
          ))}
        </ul>
        {nextCursor !== null && (
          <div className="inline-actions">
            <button className="btn" type="button" disabled={isFetchingMore} onClick={() => onLoadMore(nextCursor)}>
              {isFetchingMore ? "불러오는 중" : "더 보기"}
            </button>
          </div>
        )}
        </>
      )}
    </div>
  );
}

function navigateAlertRoute(route: string | null): void {
  if (route === null) return;
  const trimmed = route.trim();
  if (trimmed.length === 0) return;
  location.hash = trimmed.startsWith("#") ? trimmed : `#${trimmed.replace(/^\/+/, "")}`;
}

function alertSeverityTone(severity: OpsAlertItem["severity"]): "red" | "amber" | "blue" {
  if (severity === "critical") return "red";
  if (severity === "warning") return "amber";
  return "blue";
}

function alertSeverityLabel(severity: OpsAlertItem["severity"]): string {
  if (severity === "critical") return "위험";
  if (severity === "warning") return "주의";
  return "정보";
}

function opsAlertSourceLabel(source: OpsAlertItem["source"]): string {
  if (source === "run_sla") return "실행 SLA";
  if (source === "human_task_sla") return "사람 작업 SLA";
  if (source === "trigger_fire") return "트리거 발화";
  if (source === "failure_spike") return "실패 급증";
  return "재처리 대기";
}

function catalogStatusTone(status: ConnectorCatalogItem["status"]): "green" | "blue" | "amber" | "red" {
  if (status === "available") return "green";
  if (status === "candidate") return "blue";
  if (status === "requires_admin") return "amber";
  return "red";
}

function catalogStatusLabel(status: ConnectorCatalogItem["status"]): string {
  if (status === "available") return "사용 가능";
  if (status === "candidate") return "검토 후보";
  if (status === "requires_admin") return "관리자 승인";
  return "차단";
}

function notificationRoutingTone(rows: readonly NotificationRoutingRow[]): "green" | "blue" | "amber" | "red" | "muted" {
  if (rows.length === 0) return "muted";
  if (rows.some((row) => row.status === "blocked")) return "red";
  if (rows.some((row) => row.status === "requires_admin")) return "amber";
  if (rows.some((row) => row.status === "candidate")) return "blue";
  return "green";
}

function notificationRoutingBadge(rows: readonly NotificationRoutingRow[], isLoading: boolean, isError: boolean): string {
  if (isError) return "조회 실패";
  if (isLoading) return "동기화 중";
  if (rows.length === 0) return "계약 필요";
  const adminRequired = rows.filter((row) => row.status === "requires_admin").length;
  if (adminRequired > 0) return `승인 필요 ${adminRequired}건`;
  return `${rows.length}개 경로`;
}

function connectorActionLabel(connector: ConnectorCatalogItem): string {
  if (connector.status === "available") return "알림 발송에 사용할 수 있습니다.";
  if (connector.status === "requires_admin") return "관리자 승인 후 알림 발송에 사용할 수 있습니다.";
  if (connector.status === "blocked") return "외부 발송은 아직 어댑터 계약이 필요합니다.";
  return "도입 후보로 검토 중입니다.";
}

function templateActionLabel(template: TemplateCatalogItem): string {
  if (template.status === "available") return "실패, SLA, 사람 작업 알림에 사용할 수 있습니다.";
  if (template.status === "requires_admin") return "관리자 승인 후 알림 워크플로로 사용할 수 있습니다.";
  if (template.status === "blocked") return "현재는 콘솔 알림 센터 기준으로만 확인합니다.";
  return "알림 워크플로 후보로 검토 중입니다.";
}

function secretRequirementLabel(count: number): string {
  return `보안 연결 ${count}개 필요`;
}

function BotPoolCapacityPanel({
  pools,
  isLoading,
  isError,
  retryQueueStatus,
  retryQueueTone,
}: {
  pools: readonly BotPoolItem[];
  isLoading: boolean;
  isError: boolean;
  retryQueueStatus: string;
  retryQueueTone: "green" | "red";
}): JSX.Element {
  return (
    <div className="ops-column bot-pool-capacity">
      <h3>용량</h3>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>봇 풀 상태를 불러오지 못했습니다.</strong>
          <span className="subtle">worker, lease, run queue 조회 권한과 API 상태를 확인하세요.</span>
        </div>
      ) : isLoading ? (
        <div className="ops-alert-empty" role="status">
          <strong>봇 풀 용량을 확인하는 중입니다.</strong>
          <span className="subtle">브라우저 worker와 lease 점유율을 동기화합니다.</span>
        </div>
      ) : pools.length === 0 ? (
        <div className="ops-alert-empty" role="status">
          <strong>표시할 봇 풀이 없습니다.</strong>
          <span className="subtle">브라우저 실행 worker가 등록되면 용량이 표시됩니다.</span>
        </div>
      ) : (
        <ul>
          {pools.map((pool) => (
            <li key={pool.bot_pool_id}>
              <span>
                <strong>{pool.name}</strong>
                <span className="subtle">{botPoolCapacityDetail(pool)}</span>
                <span className="subtle">{pool.health_reason}</span>
              </span>
              <span className={`badge ${botPoolTone(pool.health)}`}>{botPoolHealthLabel(pool.health)}</span>
            </li>
          ))}
          <li>
            <span>
              <strong>실행 흐름</strong>
              <span className="subtle">실행 기록에서 queued/running 상태를 추적합니다.</span>
            </span>
            <button className="linklike" type="button" onClick={() => navigate("runTrace", { status: "running" })}>
              실행 보기
            </button>
          </li>
          <li>
            <span>
              <strong>재시도 큐</strong>
              <span className="subtle">작업 항목 재처리 대기 상태</span>
            </span>
            <button className={`badge ${retryQueueTone}`} type="button" onClick={() => navigate("workitems")}>
              {retryQueueStatus}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function botPoolTone(health: BotPoolItem["health"]): "green" | "amber" | "red" {
  if (health === "ok") return "green";
  if (health === "warning") return "amber";
  return "red";
}

function botPoolHealthLabel(health: BotPoolItem["health"]): string {
  if (health === "ok") return "정상";
  if (health === "warning") return "주의";
  return "위험";
}

function botPoolCapacityDetail(pool: BotPoolItem): string {
  const occupied = pool.leases.active + pool.leases.reserved;
  const workers = `worker ${pool.workers.active}/${pool.workers.total}`;
  const leases = `사용 ${occupied}/${pool.capacity_slots}`;
  const pending = `대기 ${pool.queue.pending_runs}건`;
  const dueTriggers = pool.queue.due_triggers > 0 ? ` · 발화 예정 ${pool.queue.due_triggers}건` : "";
  return `${workers} · ${leases} · ${pending}${dueTriggers}`;
}

function catchupPolicyLabel(policy: RunTriggerItem["catchup_policy"]): string {
  if (policy === "fire_once") return "순차 보강";
  return "건너뛰기";
}

function opsAlertTiming(alert: OpsAlertItem): string {
  return alert.due_at !== undefined && alert.due_at !== null
    ? `감지 ${formatDateTime(alert.detected_at)} · 기한 ${formatDateTime(alert.due_at)}`
    : `감지 ${formatDateTime(alert.detected_at)}`;
}

function opsAlertActionLabel(alert: OpsAlertItem): string {
  if (alert.source === "failure_spike") return "실패 기록 보기";
  switch (alert.subject_type) {
    case "run":
      return "실행 보기";
    case "human_task":
      return "사람 작업 보기";
    case "run_trigger":
      return "예약 이력 보기";
    case "dlq":
      return "재처리 대기 보기";
  }
}

function StatusColumn({
  title,
  rows,
}: {
  title: string;
  rows: readonly { name: string; status: string; tone: "green" | "blue" | "amber" | "red" | "muted"; action: string }[];
}): JSX.Element {
  return (
    <div className="ops-column">
      <h3>{title}</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.name}>
            <span>
              <strong>{row.name}</strong>
              <span className="subtle">{row.action}</span>
            </span>
            <span className={`badge ${row.tone}`}>{row.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function triggerSummary(trigger: RunTriggerItem): string {
  if (trigger.trigger_type === "webhook") return "외부 이벤트";
  return humanCronSummary(trigger.cron_expression);
}

function triggerSecondary(trigger: RunTriggerItem): string {
  if (trigger.trigger_type === "webhook") return trigger.webhook_secret_ref !== null || trigger.webhook_secret_configured === true ? "보안 키 연결됨" : "보안 키 미설정";
  return trigger.timezone !== null ? `${trigger.timezone} 기준` : "시간대 미설정";
}

function nextFireLabel(trigger: RunTriggerItem): string {
  if (trigger.trigger_type === "webhook") return "이벤트 수신 시";
  if (trigger.status === "enabled" && trigger.next_fire_at === null) return "스케줄러 확인 필요";
  return formatDateTime(trigger.next_fire_at);
}

function humanCronSummary(cronExpression: string | null): string {
  if (cronExpression === null) return "예약 실행";
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return "고급 예약";
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return "고급 예약";
  const minuteNumber = Number(minute);
  const hourNumber = Number(hour);
  if (minuteNumber < 0 || minuteNumber > 59 || hourNumber < 0 || hourNumber > 23) return "고급 예약";
  const time = `${String(hourNumber).padStart(2, "0")}:${String(minuteNumber).padStart(2, "0")}`;
  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "*") return `매일 ${time}`;
  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "1-5") return `평일 ${time}`;
  if (month === "*" && dayOfMonth === "*" && /^\d+$/.test(dayOfWeek)) return `매주 ${weekdayLabel(Number(dayOfWeek))} ${time}`;
  if (month === "*" && /^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `매월 ${Number(dayOfMonth)}일 ${time}`;
  return "고급 예약";
}

function weekdayLabel(day: number): string {
  const labels = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  return labels[day] ?? "지정 요일";
}

function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function statusLabel(value: RunTriggerItem["status"]): string {
  if (value === "paused") return "일시정지";
  if (value === "archived") return "보관됨";
  return "사용 중";
}
