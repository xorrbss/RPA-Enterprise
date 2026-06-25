import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { navigate, useHashIdParam, useHashParam } from "../../router";
import type { RunTriggerItem } from "../../api/types";
import { errorWithDetails } from "./format";
import { TriggerFireHistory } from "./TriggerFireHistory";
import {
  canSaveTriggerEdit,
  catchupPolicyLabel,
  concurrencyFrom,
  cronFrom,
  displayToSecretRef,
  idempotencyKey,
  listScenarioPicker,
  nextFireLabel,
  scenarioLabel,
  secretRefToDisplay,
  statusLabel,
  triggerSecondary,
  triggerSummary,
  type Cadence,
  type TriggerMode,
} from "./trigger-helpers";

// 트리거 스케줄링 기능(빌더 + 등록된 예약 + 수정 + 발화 이력) — fireTriggerId/edit 상태로 묶인 응집 단위를 OrchestrationView 에서 분리.
//   큐 상태 패널은 빌더와 같은 레이아웃 행을 공유하므로 부모가 queuePanel 로 주입한다(summary/human/workDlq 의존을 부모에 유지).
export function TriggerScheduler({
  schedulerQueueUnavailable,
  queuePanel,
}: {
  schedulerQueueUnavailable: boolean;
  queuePanel: JSX.Element;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const can = useCan();
  const canManageTriggers = can("trigger.manage");
  // trigger 는 api.getRunTrigger(triggerParam) path 보간으로 흐르므로 path-traversal 가드(적대감사 #C3).
  const triggerParam = useHashIdParam("trigger");
  const scenarioParam = useHashParam("scenario");
  const scenarios = useQuery({ queryKey: ["scenarios", "orchestration-picker"], queryFn: () => listScenarioPicker(api), refetchInterval: 10_000 });
  const triggers = useQuery({ queryKey: ["run-triggers"], queryFn: () => api.listRunTriggers({ limit: 20 }), refetchInterval: 10_000 });

  const scenarioItems = scenarios.data?.items ?? [];
  const scenarioPickerTruncated = scenarios.data?.truncated === true;
  const triggerItems = useMemo(() => triggers.data?.items ?? [], [triggers.data?.items]);
  const [scenarioId, setScenarioId] = useState("");
  const [appliedScenarioParam, setAppliedScenarioParam] = useState<string | null>(null);
  const [triggerMode, setTriggerMode] = useState<TriggerMode>("cron");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState("Asia/Seoul");
  const [webhookSecretRef, setWebhookSecretRef] = useState("");
  const [catchupPolicy, setCatchupPolicy] = useState<RunTriggerItem["catchup_policy"]>("skip_missed");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const [lastSaved, setLastSaved] = useState<RunTriggerItem | null>(null);
  const [fireTriggerId, setFireTriggerId] = useState<string | null>(null);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [editCronExpression, setEditCronExpression] = useState("0 9 * * *");
  const [editTimezone, setEditTimezone] = useState("Asia/Seoul");
  const [editWebhookSecretRef, setEditWebhookSecretRef] = useState("");
  const [editCatchupPolicy, setEditCatchupPolicy] = useState<RunTriggerItem["catchup_policy"]>("skip_missed");
  const [editMaxConcurrentRuns, setEditMaxConcurrentRuns] = useState(1);

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

  return (
    <>
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
            <div className="form-alert amber" role="status">
              <p>예약 정의는 저장할 수 있지만, 실제 정기 실행은 아직 시작되지 않습니다. 운영 담당자에게 정기 실행 연결을 요청하세요.</p>
              <details className="developer-details">
                <summary>기술 세부 정보</summary>
                <p>발화 작업 큐(worker Graphile queue)와 <code>MAINTENANCE_TENANT_IDS</code> 배포 설정이 연결돼야 정기 실행이 시작됩니다.</p>
              </details>
            </div>
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

        {queuePanel}
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
    </>
  );
}
