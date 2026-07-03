import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AutomationIdeaItem, RoiActualEvidence, RoiActualSuggestion } from "../../api/types";
import { useApiClient } from "../../api/context";
import { numberLabel, percentLabel } from "./labels";
import {
  currentMonthActualDefaults,
  idempotencyKey,
  roiActualValidationMessage,
  type RoiActualFormState,
} from "./forms";

export function RoiActualsPanel({
  selected,
  selectedId,
  canManageIdeas,
}: {
  selected: AutomationIdeaItem | null;
  selectedId: string | null;
  canManageIdeas: boolean;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [roiActualInput, setRoiActualInput] = useState<RoiActualFormState>(() => currentMonthActualDefaults());
  // 제안 배지의 근거 — non-null 이면 현재 건수/실패율 값의 출처가 운영 실행 통계 제안이라는 뜻. 사람이 해당
  // 값·기간을 손대거나 다른 아이디어를 고르면 해제(그때부터는 수기 확정값). 저장 metadata 귀속에도 쓰인다.
  const [roiActualSuggestion, setRoiActualSuggestion] = useState<RoiActualSuggestion | null>(null);

  // 다른 아이디어로 전환하면 제안 근거는 무효 — 폼 값은 유지되더라도 '제안값' 배지/귀속은 해제한다.
  useEffect(() => {
    setRoiActualSuggestion((current) => (current !== null && current.automation_idea_id !== selectedId ? null : current));
  }, [selectedId]);

  const roiActuals = useQuery({
    queryKey: ["automation-ideas", selected?.idea_id, "roi-actuals"],
    queryFn: () => (
      selected === null
        ? Promise.resolve({ items: [] as RoiActualEvidence[], next_cursor: null })
        : api.listRoiActualEvidence(selected.idea_id, { limit: 5 })
    ),
    enabled: selected !== null,
  });

  // 제안값 불러오기 — read-only 조회. 성공 시 건수/실패율만 프리필(개입/재처리 시간은 run 통계로 도출 불가 — 날조 금지).
  const loadRoiSuggestion = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.getRoiActualSuggestion(idea.idea_id, {
        period_start: roiActualInput.period_start,
        period_end: roiActualInput.period_end,
      }),
    onSuccess: (suggestion) => {
      setRoiActualSuggestion(suggestion);
      if (suggestion.suggested_actual_transaction_count === null || suggestion.suggested_actual_failure_rate === null) return;
      const count = suggestion.suggested_actual_transaction_count;
      const rate = suggestion.suggested_actual_failure_rate;
      setRoiActualInput((current) => ({
        ...current,
        actual_transaction_count: String(count),
        actual_failure_rate: String(rate),
      }));
    },
  });

  const saveRoiActual = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.recordRoiActualEvidence(
        idea.idea_id,
        {
          period_start: roiActualInput.period_start,
          period_end: roiActualInput.period_end,
          actual_transaction_count: Number(roiActualInput.actual_transaction_count),
          actual_failure_rate: Number(roiActualInput.actual_failure_rate),
          human_intervention_minutes: Number(roiActualInput.human_intervention_minutes),
          reprocessing_minutes: Number(roiActualInput.reprocessing_minutes),
          evidence_ref: roiActualInput.evidence_ref.trim(),
          summary: roiActualInput.summary.trim(),
          // 자동값은 제안일 뿐 — 저장(사람 확정)이 증거다. 프리필을 손대지 않고 확정하면 출처를 정직하게 남기고,
          // 사람이 값을 고쳤으면(제안 해제) 수기 확정으로 귀속한다. 감사 귀속(recorded_by)은 서버가 확정자를 기록.
          metadata: {
            measurement_method:
              roiActualSuggestion !== null && roiActualSuggestion.suggested_actual_transaction_count !== null
                ? "prod_run_stats_prefill_operator_confirmed"
                : "manual_pilot_reconciliation",
          },
        },
        idempotencyKey("roi-actual"),
      ),
    onSuccess: () => {
      setRoiActualSuggestion(null);
      return queryClient.invalidateQueries({ queryKey: ["automation-ideas", selected?.idea_id, "roi-actuals"] });
    },
  });

  const roiActualInvalidReason = roiActualValidationMessage(roiActualInput);
  const canSaveRoiActual = canManageIdeas && selected !== null && roiActualInvalidReason === null && !saveRoiActual.isPending;
  const roiActualItems = roiActuals.data?.items ?? [];

  return (
    <div className="panel-subsection">
      <div className="panel-head compact">
        <h3>파일럿 실제값</h3>
        {roiActualItems.length === 0 ? <span className="badge amber">근거 없음</span> : <span className="badge green">{roiActualItems.length}건</span>}
      </div>
      <div className="coe-roi-suggestion">
        <button
          className="btn"
          type="button"
          onClick={() => selected !== null && loadRoiSuggestion.mutate(selected)}
          disabled={selected === null || selected.scenario_id === null || loadRoiSuggestion.isPending}
        >
          {loadRoiSuggestion.isPending ? "불러오는 중" : "운영 실행 실적 제안값 불러오기"}
        </button>
        {selected !== null && selected.scenario_id === null && (
          <span className="subtle">위 연결 설정에서 자동화를 연결하면 운영 실행 통계로 제안값을 채울 수 있습니다.</span>
        )}
        {roiActualSuggestion !== null && roiActualSuggestion.suggested_actual_transaction_count !== null && (
          <>
            <span className="badge amber">제안값</span>
            <span className="subtle">
              운영 실행 완료 {roiActualSuggestion.completed_runs}건·실패 {roiActualSuggestion.failed_runs}건 기준 제안 —
              사람 개입/재처리 시간은 직접 입력하세요. 자동값은 제안일 뿐, 저장 시 본인이 확정한 수치로 기록됩니다.
            </span>
          </>
        )}
        {roiActualSuggestion !== null && roiActualSuggestion.scenario_id !== null && roiActualSuggestion.suggested_actual_transaction_count === null && (
          <span className="subtle">이 기간에 집계할 종결된 운영 실행이 없어 제안값이 없습니다.</span>
        )}
        {loadRoiSuggestion.isError && <span className="badge red">제안값 불러오기 실패</span>}
      </div>
      <div className="form-grid coe-roi-grid">
        <label className="field">
          <span>시작일</span>
          <input
            type="date"
            value={roiActualInput.period_start}
            onChange={(event) => {
              setRoiActualInput({ ...roiActualInput, period_start: event.target.value });
              setRoiActualSuggestion(null); // 기간이 바뀌면 기존 제안 근거는 무효
            }}
          />
        </label>
        <label className="field">
          <span>종료일</span>
          <input
            type="date"
            value={roiActualInput.period_end}
            onChange={(event) => {
              setRoiActualInput({ ...roiActualInput, period_end: event.target.value });
              setRoiActualSuggestion(null); // 기간이 바뀌면 기존 제안 근거는 무효
            }}
          />
        </label>
        <label className="field">
          <span>실제 처리 건수</span>
          <input
            type="number"
            min={0}
            value={roiActualInput.actual_transaction_count}
            onChange={(event) => {
              setRoiActualInput({ ...roiActualInput, actual_transaction_count: event.target.value });
              setRoiActualSuggestion(null); // 사람이 고친 값 — 이후 저장은 수기 확정으로 귀속
            }}
          />
        </label>
        <label className="field">
          <span>실제 실패율</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={roiActualInput.actual_failure_rate}
            onChange={(event) => {
              setRoiActualInput({ ...roiActualInput, actual_failure_rate: event.target.value });
              setRoiActualSuggestion(null); // 사람이 고친 값 — 이후 저장은 수기 확정으로 귀속
            }}
          />
        </label>
        <label className="field">
          <span>사람 개입 시간(분)</span>
          <input type="number" min={0} value={roiActualInput.human_intervention_minutes} onChange={(event) => setRoiActualInput({ ...roiActualInput, human_intervention_minutes: event.target.value })} />
        </label>
        <label className="field">
          <span>재처리 시간(분)</span>
          <input type="number" min={0} value={roiActualInput.reprocessing_minutes} onChange={(event) => setRoiActualInput({ ...roiActualInput, reprocessing_minutes: event.target.value })} />
        </label>
        <label className="field">
          <span>근거 참조</span>
          <input value={roiActualInput.evidence_ref} onChange={(event) => setRoiActualInput({ ...roiActualInput, evidence_ref: event.target.value })} />
        </label>
        <label className="field wide">
          <span>요약</span>
          <input value={roiActualInput.summary} onChange={(event) => setRoiActualInput({ ...roiActualInput, summary: event.target.value })} />
        </label>
      </div>
      <div className="coe-roi-summary">
        <span><strong>{roiActualItems[0]?.actual_transaction_count ?? "-"}</strong><small>최근 실제 건수</small></span>
        <span><strong>{percentLabel(roiActualItems[0]?.actual_failure_rate ?? null)}</strong><small>최근 실패율</small></span>
        <span><strong>{numberLabel(roiActualItems[0]?.human_intervention_minutes ?? null, "분")}</strong><small>사람 개입</small></span>
        <span><strong>{numberLabel(roiActualItems[0]?.reprocessing_minutes ?? null, "분")}</strong><small>재처리</small></span>
        <button className="btn" type="button" onClick={() => selected !== null && roiActualInvalidReason === null && saveRoiActual.mutate(selected)} disabled={!canSaveRoiActual}>
          {saveRoiActual.isPending ? "저장 중" : "실제값 저장"}
        </button>
        {roiActualInvalidReason !== null && <span className="badge red coe-roi-alert" role="alert">{roiActualInvalidReason}</span>}
        {saveRoiActual.isError && <span className="badge red">실제값 저장 실패</span>}
      </div>
      {roiActuals.isError && <p className="form-alert red" role="alert">ROI 실제값을 불러오지 못했습니다.</p>}
      {roiActualItems.length > 0 && (
        <div className="mini-table" aria-label="ROI 실제값 근거 목록">
          {roiActualItems.map((item) => (
            <div className="mini-table-row" key={item.roi_actual_id}>
              <span>{item.period_start} - {item.period_end}</span>
              <strong>{item.actual_transaction_count}건</strong>
              <span>{percentLabel(item.actual_failure_rate)}</span>
              <span>{item.evidence_ref}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
