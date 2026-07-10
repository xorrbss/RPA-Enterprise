import { useState } from "react";

import { renderIrSentences, type StepSentence } from "./step-sentences";
import type { StepChangeMark } from "./step-diff";

// E2: IR → 사람 말 단계 카드 — 만들기(초안 확인)·스튜디오(계획 미리보기)·실행 트레이스가 같은 번역기
// (step-sentences)를 공유한다. 원시 노드 id·IREL 식은 기본 뷰에서 제거하고 [자세히]에만 둔다(감사 P1-7).
// stepStates: E4 인라인 테스트가 카드에 실시간 상태를 오버레이하는 슬롯(선택).
// changeMarks: F2 말로 고치기 diff(step-diff)를 카드에 겹치는 슬롯(선택, stepStates와 동형).
//   removed 단계는 카드가 없으므로 removedCount 요약 행으로, 전면 교체는 안내 1행으로 정직 표기.

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

const CHANGE_LABELS: Record<StepChangeMark, { label: string; tone: string }> = {
  added: { label: "새 단계", tone: "green" },
  changed: { label: "달라진 단계", tone: "blue" },
};

export function StepCards({
  ir,
  stepStates,
  changeMarks,
  removedCount = 0,
  fullReplacement = false,
  emptyMessage = "표시할 단계가 없습니다.",
}: {
  readonly ir: unknown;
  readonly stepStates?: ReadonlyMap<string, StepUiState>;
  readonly changeMarks?: ReadonlyMap<string, StepChangeMark>;
  readonly removedCount?: number;
  readonly fullReplacement?: boolean;
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
      {removedCount > 0 && (
        <p className="subtle step-cards-diff-note" role="note">
          이전 초안에서 빠진 단계 {removedCount}개
        </p>
      )}
      {fullReplacement && (
        <p className="subtle step-cards-diff-note" role="note">
          이전 초안과 이어지지 않아 전체가 새 단계로 표시됩니다.
        </p>
      )}
      <ol className="step-card-list">
        {main.map((step) => (
          <StepCard key={step.nodeId} step={step} state={stepStates?.get(step.nodeId)} change={changeMarks?.get(step.nodeId)} />
        ))}
      </ol>
      {others.length > 0 && (
        <details className="step-cards-others">
          <summary>기타 경로 {others.length}단계 — 조건에 따라 실행되는 단계</summary>
          <ol className="step-card-list">
            {others.map((step) => (
              <StepCard key={step.nodeId} step={step} state={stepStates?.get(step.nodeId)} change={changeMarks?.get(step.nodeId)} />
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

function StepCard({
  step,
  state,
  change,
}: {
  readonly step: StepSentence;
  readonly state?: StepUiState;
  readonly change?: StepChangeMark;
}): JSX.Element {
  const stateMeta = state !== undefined ? STATE_LABELS[state] : null;
  const changeMeta = change !== undefined ? CHANGE_LABELS[change] : null;
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
        {changeMeta !== null && <span className={`badge ${changeMeta.tone}`}>{changeMeta.label}</span>}
        {step.flow !== undefined && <span className="badge blue">{step.flow.label}</span>}
        {step.fallback && <span className="badge amber">원문 확인 필요</span>}
        {stateMeta !== null && <span className={`badge ${stateMeta.tone}`}>{stateMeta.label}</span>}
      </span>
    </li>
  );
}
