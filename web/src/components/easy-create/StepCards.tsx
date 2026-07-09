import { useState } from "react";

import { renderIrSentences, type StepSentence } from "./step-sentences";

// E2: IR → 사람 말 단계 카드 — 만들기(초안 확인)·스튜디오(계획 미리보기)·실행 트레이스가 같은 번역기
// (step-sentences)를 공유한다. 원시 노드 id·IREL 식은 기본 뷰에서 제거하고 [자세히]에만 둔다(감사 P1-7).
// stepStates: E4 인라인 테스트가 카드에 실시간 상태를 오버레이하는 슬롯(선택).

export type StepUiState = "waiting" | "running" | "success" | "failed" | "uncertain" | "skipped" | "suspended";

const STATE_LABELS: Record<StepUiState, { label: string; tone: string }> = {
  waiting: { label: "대기", tone: "muted" },
  running: { label: "실행 중", tone: "blue" },
  success: { label: "성공", tone: "green" },
  failed: { label: "실패", tone: "red" },
  uncertain: { label: "확인 필요", tone: "amber" },
  skipped: { label: "건너뜀", tone: "muted" },
  suspended: { label: "사람 확인 대기", tone: "amber" },
};

export function StepCards({
  ir,
  stepStates,
  emptyMessage = "표시할 단계가 없습니다.",
}: {
  readonly ir: unknown;
  readonly stepStates?: ReadonlyMap<string, StepUiState>;
  readonly emptyMessage?: string;
}): JSX.Element {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const sentences = renderIrSentences(ir);
  if (sentences.length === 0) {
    return <p className="subtle">{emptyMessage}</p>;
  }
  const main = sentences.filter((s) => !s.offMainPath);
  const others = sentences.filter((s) => s.offMainPath);
  return (
    <div className="step-cards">
      <ol className="step-card-list">
        {main.map((step) => (
          <StepCard key={step.nodeId} step={step} state={stepStates?.get(step.nodeId)} />
        ))}
      </ol>
      {others.length > 0 && (
        <details className="step-cards-others">
          <summary>기타 경로 {others.length}단계 — 조건에 따라 실행되는 단계</summary>
          <ol className="step-card-list">
            {others.map((step) => (
              <StepCard key={step.nodeId} step={step} state={stepStates?.get(step.nodeId)} />
            ))}
          </ol>
        </details>
      )}
      <button className="linklike step-cards-advanced" type="button" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "정의 닫기" : "정의 보기 (전문가)"}
      </button>
      {showAdvanced && (
        <pre className="step-cards-raw">{JSON.stringify(ir, null, 2)}</pre>
      )}
    </div>
  );
}

function StepCard({ step, state }: { readonly step: StepSentence; readonly state?: StepUiState }): JSX.Element {
  const stateMeta = state !== undefined ? STATE_LABELS[state] : null;
  return (
    <li className={`step-card${step.fallback ? " step-card-fallback" : ""}`}>
      <span className="step-card-order" aria-hidden="true">{step.order}</span>
      <span className="step-card-body">
        <span className="step-card-sentence">{step.sentence}</span>
        {(step.detail !== undefined || step.verify !== undefined || step.flow?.detail !== undefined) && (
          <span className="subtle step-card-detail">
            {[step.detail, ...(step.verify ?? [])].filter((v): v is string => v !== undefined).join(" · ")}
            {step.flow?.detail !== undefined && (
              <details className="step-card-branch">
                <summary>분기 조건 자세히</summary>
                <pre>{step.flow.detail}</pre>
              </details>
            )}
          </span>
        )}
      </span>
      <span className="step-card-badges">
        {step.flow !== undefined && <span className="badge blue">{step.flow.label}</span>}
        {step.fallback && <span className="badge amber">원문 확인 필요</span>}
        {stateMeta !== null && <span className={`badge ${stateMeta.tone}`}>{stateMeta.label}</span>}
      </span>
    </li>
  );
}
