import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AutomationIdeaItem, AutomationIdeaStage, RoiEstimate } from "../../api/types";
import { useApiClient } from "../../api/context";
import { navigate, useHashParam } from "../../router";
import {
  PRIORITY_LABEL,
  SOURCE_LABEL,
  STAGE_LABEL,
  nextStages,
  scenarioOptionLabel,
  stageTone,
  triggerLinkLabel,
} from "./labels";
import { idempotencyKey, type ApprovalDecision } from "./forms";
import { AdoptionEvidencePanel, useAdoptionEvidence } from "./AdoptionEvidencePanel";

export function DetailSection({
  selected,
  decision,
  roiData,
  canManageIdeas,
  canApproveIdeas,
  setSelectedId,
}: {
  selected: AutomationIdeaItem | null;
  decision: ApprovalDecision;
  roiData: RoiEstimate | null | undefined;
  canManageIdeas: boolean;
  canApproveIdeas: boolean;
  setSelectedId: (value: string) => void;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const scenarioParam = useHashParam("scenario");
  const [scenarioId, setScenarioId] = useState("");
  const [appliedScenarioParam, setAppliedScenarioParam] = useState<string | null>(null);
  const [triggerId, setTriggerId] = useState("");

  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }) });
  const triggers = useQuery({ queryKey: ["run-triggers"], queryFn: () => api.listRunTriggers({ limit: 50 }) });
  const scenarioItems = scenarios.data?.items ?? [];
  const triggerItems = triggers.data?.items ?? [];
  const scenarioByVersionId = useMemo(
    () => new Map(scenarioItems.map((scenario) => [scenario.latest_version_id, scenario])),
    [scenarioItems],
  );

  const linkedScenario = useMemo(
    () => scenarioItems.find((scenario) => scenario.scenario_id === scenarioId) ?? null,
    [scenarioId, scenarioItems],
  );
  const linkedTrigger = useMemo(
    () => triggerItems.find((trigger) => trigger.trigger_id === triggerId) ?? null,
    [triggerId, triggerItems],
  );
  const linkMismatch = linkedScenario !== null && linkedTrigger !== null && linkedScenario.latest_version_id !== linkedTrigger.scenario_version_id;

  useEffect(() => {
    if (selected !== null) {
      setScenarioId((current) => {
        if (appliedScenarioParam !== null && current === appliedScenarioParam) {
          return current;
        }
        return selected.scenario_id ?? "";
      });
      setTriggerId(selected.run_trigger_id ?? "");
    }
  }, [appliedScenarioParam, selected]);

  useEffect(() => {
    if (scenarioParam === null) {
      if (appliedScenarioParam !== null) setAppliedScenarioParam(null);
      return;
    }
    if (appliedScenarioParam === scenarioParam) return;
    if (scenarioItems.some((scenario) => scenario.scenario_id === scenarioParam)) {
      setScenarioId(scenarioParam);
      setAppliedScenarioParam(scenarioParam);
    }
  }, [appliedScenarioParam, scenarioItems, scenarioParam]);

  const transitionIdea = useMutation({
    mutationFn: ({ idea, stage }: { idea: AutomationIdeaItem; stage: AutomationIdeaStage }) =>
      api.transitionAutomationIdea(idea.idea_id, stage, idempotencyKey("automation-idea-stage")),
    onSuccess: async (idea) => {
      setSelectedId(idea.idea_id);
      await queryClient.invalidateQueries({ queryKey: ["automation-ideas"] });
    },
  });

  const updateLinks = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.updateAutomationIdea(
        idea.idea_id,
        { scenario_id: scenarioId.length > 0 ? scenarioId : null, run_trigger_id: triggerId.length > 0 ? triggerId : null },
        idempotencyKey("automation-idea-links"),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-ideas"] }),
  });

  const evidence = useAdoptionEvidence(selected, canManageIdeas);

  return (
    <section className="panel coe-detail" aria-label="자동화 후보 상세">
      <div className="panel-head">
        <h2>평가와 승인 진행</h2>
        {selected !== null && <span className={`badge ${stageTone(selected.stage)}`}>{STAGE_LABEL[selected.stage]}</span>}
      </div>
      {selected === null ? (
        <p className="empty-state">후보를 선택해 주세요.</p>
      ) : (
        <div className="coe-detail-body">
          <div>
            <h3>{selected.title}</h3>
            <p>{selected.description}</p>
            <div className="inline-facts">
              <span className="badge blue">{PRIORITY_LABEL[selected.priority]}</span>
              <span className="badge muted">{SOURCE_LABEL[selected.source]}</span>
              {selected.source_import_id !== null && <span className="badge green">가져오기 계보</span>}
              {selected.source_item_ref !== null && <span className="badge muted">{selected.source_item_ref}</span>}
              <span className="badge muted">우선순위 점수 {selected.score}</span>
              <span className="badge muted">{selected.department}</span>
            </div>
          </div>
          <div className="coe-readiness" aria-label="승인 준비 상태">
            <strong>승인 준비 상태</strong>
            <span className={`badge ${roiData !== null && roiData !== undefined ? "green" : "amber"}`}>
              {roiData !== null && roiData !== undefined ? "ROI 저장됨" : "ROI 필요"}
            </span>
            <span className={`badge ${selected.scenario_id !== null ? "green" : "amber"}`}>
              {selected.scenario_id !== null ? "자동화 설계안 연결됨" : "자동화 설계안 필요"}
            </span>
            <span className={`badge ${selected.run_trigger_id !== null ? "green" : "amber"}`}>
              {selected.run_trigger_id !== null ? "운영 예약 연결됨" : "운영 예약 필요"}
            </span>
          </div>
          <div className={`coe-decision ${decision.tone}`} aria-label="CoE 승인 판단">
            <div>
              <span className={`badge ${decision.tone}`}>{decision.label}</span>
              <h3>{decision.title}</h3>
              <p>{decision.summary}</p>
            </div>
            <ul>
              {decision.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
          <div className="stage-rail" aria-label="승인 단계 전환">
            {nextStages(selected.stage).length === 0 ? (
              <span className="subtle">다음 단계가 없습니다.</span>
            ) : (
              nextStages(selected.stage).map((stage) => {
                const requiresApproval = stage === "approved" || stage === "rejected";
                const allowed = requiresApproval ? canApproveIdeas : canManageIdeas;
                return (
                  <button
                    key={stage}
                    className="btn"
                    type="button"
                    onClick={() => transitionIdea.mutate({ idea: selected, stage })}
                    disabled={transitionIdea.isPending || !allowed}
                    title={!allowed && requiresApproval ? "승인자 권한이 필요합니다." : undefined}
                  >
                    {STAGE_LABEL[stage]}로 이동
                  </button>
                );
              })
            )}
            {!canApproveIdeas && selected.stage === "assess" && (
              <span className="badge amber">승인·반려는 승인자 권한 필요</span>
            )}
          </div>
          <div className="form-grid">
            <label className="field">
              <span>자동화 설계안 연결</span>
              <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>
                <option value="">연결 안 함</option>
                {scenarioItems.map((scenario) => (
                  <option key={scenario.scenario_id} value={scenario.scenario_id}>{scenarioOptionLabel(scenario)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>운영 예약 연결</span>
              <select value={triggerId} onChange={(event) => setTriggerId(event.target.value)}>
                <option value="">연결 안 함</option>
                {triggerItems.map((trigger) => (
                  <option key={trigger.trigger_id} value={trigger.trigger_id}>{triggerLinkLabel(trigger, scenarioByVersionId)}</option>
                ))}
              </select>
            </label>
          </div>
          {linkMismatch && (
            <p className="form-alert red" role="alert">
              선택한 운영 예약은 다른 자동화 설계안에 연결되어 있습니다. 같은 업무 자동화안의 예약을 선택하거나 새 운영 예약을 만드세요.
            </p>
          )}
          <div className="inline-actions">
            <button className="btn" type="button" onClick={() => updateLinks.mutate(selected)} disabled={!canManageIdeas || updateLinks.isPending || linkMismatch}>연결 저장</button>
            <button
              className="btn"
              type="button"
              onClick={() => navigate("scenarioStudio", selected.scenario_id !== null ? { scenario: selected.scenario_id, focus: "test" } : { focus: "test" })}
              disabled={selected.scenario_id === null}
            >
              자동화 설계안 보기
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => navigate("automationOps", selected.run_trigger_id !== null ? { trigger: selected.run_trigger_id } : undefined)}
              disabled={selected.run_trigger_id === null}
            >
              운영 예약 보기
            </button>
            {updateLinks.isError && <span className="badge red">연결 실패</span>}
          </div>
          <AdoptionEvidencePanel selected={selected} evidence={evidence} />
        </div>
      )}
    </section>
  );
}
