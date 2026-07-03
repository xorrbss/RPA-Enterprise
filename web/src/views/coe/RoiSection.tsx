import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AutomationIdeaItem, RoiEstimate } from "../../api/types";
import { useApiClient } from "../../api/context";
import { currency, numberLabel, viabilityLabel } from "./labels";
import { idempotencyKey, type RoiFormState, type RoiPreview } from "./forms";
import { RoiActualsPanel } from "./RoiActualsPanel";

export function RoiSection({
  selected,
  selectedId,
  canManageIdeas,
  roiData,
  roiInput,
  setRoiInput,
  roiInvalidReason,
  preview,
}: {
  selected: AutomationIdeaItem | null;
  selectedId: string | null;
  canManageIdeas: boolean;
  roiData: RoiEstimate | null | undefined;
  roiInput: RoiFormState;
  setRoiInput: (value: RoiFormState) => void;
  roiInvalidReason: string | null;
  preview: RoiEstimate | RoiPreview;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();

  const saveRoi = useMutation({
    mutationFn: (idea: AutomationIdeaItem) =>
      api.upsertRoiEstimate(
        idea.idea_id,
        {
          frequency_per_month: Number(roiInput.frequency_per_month),
          minutes_per_case: Number(roiInput.minutes_per_case),
          exception_rate: Number(roiInput.exception_rate),
          hourly_cost: Number(roiInput.hourly_cost),
          implementation_effort: Number(roiInput.implementation_effort),
          platform_monthly_cost: Number(roiInput.platform_monthly_cost),
          avoided_license_cost: Number(roiInput.avoided_license_cost),
          confidence: roiInput.confidence,
        },
        idempotencyKey("roi-estimate"),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-ideas", selected?.idea_id, "roi"] }),
  });

  const canSaveRoi = canManageIdeas && selected !== null && roiInvalidReason === null && !saveRoi.isPending;

  return (
    <section className="panel coe-roi" aria-label="ROI 계산">
      <div className="panel-head">
        <h2>ROI 산정</h2>
        {roiData === null && <span className="badge amber">미저장</span>}
        {roiData !== null && roiData !== undefined && <span className="badge green">저장됨</span>}
      </div>
      <div className="form-grid coe-roi-grid">
        <label className="field">
          <span>월 처리 건수</span>
          <input type="number" min={0} value={roiInput.frequency_per_month} onChange={(event) => setRoiInput({ ...roiInput, frequency_per_month: event.target.value })} />
        </label>
        <label className="field">
          <span>건당 소요 시간(분)</span>
          <input type="number" min={0} value={roiInput.minutes_per_case} onChange={(event) => setRoiInput({ ...roiInput, minutes_per_case: event.target.value })} />
        </label>
        <label className="field">
          <span>예외율</span>
          <input type="number" min={0} max={1} step={0.01} value={roiInput.exception_rate} onChange={(event) => setRoiInput({ ...roiInput, exception_rate: event.target.value })} />
        </label>
        <label className="field">
          <span>시간당 비용</span>
          <input type="number" min={0} value={roiInput.hourly_cost} onChange={(event) => setRoiInput({ ...roiInput, hourly_cost: event.target.value })} />
        </label>
        <label className="field">
          <span>자동화 구축 예상 비용</span>
          <input type="number" min={0} value={roiInput.implementation_effort} onChange={(event) => setRoiInput({ ...roiInput, implementation_effort: event.target.value })} />
        </label>
        <label className="field">
          <span>월 플랫폼 비용</span>
          <input type="number" min={0} value={roiInput.platform_monthly_cost} onChange={(event) => setRoiInput({ ...roiInput, platform_monthly_cost: event.target.value })} />
        </label>
        <label className="field">
          <span>회피 라이선스 비용</span>
          <input type="number" min={0} value={roiInput.avoided_license_cost} onChange={(event) => setRoiInput({ ...roiInput, avoided_license_cost: event.target.value })} />
        </label>
        <label className="field">
          <span>추정 신뢰도</span>
          <select value={roiInput.confidence} onChange={(event) => setRoiInput({ ...roiInput, confidence: event.target.value as RoiFormState["confidence"] })}>
            <option value="low">낮음</option>
            <option value="medium">보통</option>
            <option value="high">높음</option>
          </select>
        </label>
      </div>
      <div className="coe-roi-summary">
        <span><strong>{numberLabel(preview.monthly_hours_saved, "시간")}</strong><small>월 절감 시간</small></span>
        <span><strong>{currency(preview.estimated_monthly_value)}</strong><small>월 절감액</small></span>
        <span><strong>{currency(preview.platform_monthly_cost)}</strong><small>월 플랫폼 비용</small></span>
        <span><strong>{currency(preview.avoided_license_cost)}</strong><small>회피 비용</small></span>
        <span><strong>{currency(preview.monthly_value)}</strong><small>순 월가치</small></span>
        <span><strong>{numberLabel(preview.payback_months, "개월")}</strong><small>회수 기간</small></span>
        <span><strong>{viabilityLabel(preview.viability)}</strong><small>ROI 판정</small></span>
        <button className="btn primary" type="button" onClick={() => selected !== null && roiInvalidReason === null && saveRoi.mutate(selected)} disabled={!canSaveRoi}>
          {saveRoi.isPending ? "저장 중" : "ROI 저장"}
        </button>
        {roiInvalidReason !== null && <span className="badge red coe-roi-alert" role="alert">{roiInvalidReason}</span>}
        {saveRoi.isError && <span className="badge red">ROI 저장 실패</span>}
      </div>
      <RoiActualsPanel selected={selected} selectedId={selectedId} canManageIdeas={canManageIdeas} />
    </section>
  );
}
