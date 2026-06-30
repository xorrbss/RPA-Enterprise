import type { StudioValidationStage, StudioValidationStageName, StudioValidationStageStatus } from "../api/types";

const STAGE_ORDER: readonly StudioValidationStageName[] = [
  "well_formed",
  "runnable",
  "operable",
  "prod_ready",
];

const STAGE_LABELS: Record<StudioValidationStageName, string> = {
  well_formed: "구조 검증",
  runnable: "실행 가능성",
  operable: "운영 준비",
  prod_ready: "Prod 준비",
};

const STATUS_LABELS: Record<StudioValidationStageStatus, string> = {
  pass: "통과",
  failed: "실패",
  blocked: "차단",
  not_run: "미실행",
};

const STATUS_TONES: Record<StudioValidationStageStatus, "green" | "red" | "amber" | "muted"> = {
  pass: "green",
  failed: "red",
  blocked: "amber",
  not_run: "muted",
};

export function stageStatusTone(status: StudioValidationStageStatus): "green" | "red" | "amber" | "muted" {
  return STATUS_TONES[status];
}

export function studioStageLabel(stage: StudioValidationStageName): string {
  return STAGE_LABELS[stage];
}

export function studioStageStatusLabel(status: StudioValidationStageStatus): string {
  return STATUS_LABELS[status];
}

export function StudioValidationStages({
  stages,
  compact = false,
}: {
  stages: readonly StudioValidationStage[] | undefined;
  compact?: boolean;
}): JSX.Element {
  const byStage = new Map((stages ?? []).map((stage) => [stage.stage, stage]));
  return (
    <div className={compact ? "studio-validation-stages compact" : "studio-validation-stages"}>
      {STAGE_ORDER.map((stageName) => {
        const stage = byStage.get(stageName);
        const status = stage?.status ?? "not_run";
        return (
          <div className="studio-validation-stage" key={stageName} data-status={status}>
            <span>
              <strong>{STAGE_LABELS[stageName]}</strong>
              <span className={`badge ${STATUS_TONES[status]}`}>{STATUS_LABELS[status]}</span>
            </span>
            {!compact && (
              <small>
                {stage?.detail ??
                  (stageName === "well_formed"
                    ? "검증 결과가 아직 없습니다."
                    : "이 단계는 아직 실행되지 않았습니다.")}
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}
