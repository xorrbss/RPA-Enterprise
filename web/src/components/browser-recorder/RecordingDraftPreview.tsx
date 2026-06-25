import { useState } from "react";

import { navigate } from "../../router";
import type { BrowserRecordingSession, BrowserRecordingValidationIssue, ScenarioMutationResult } from "../../api/types";
import { draftStartLabel, draftSummary, recordingIssueSummary } from "./helpers";

export function RecordingDraftPreview(props: {
  session: BrowserRecordingSession;
  canSave: boolean;
  saving: boolean;
  savedScenario: ScenarioMutationResult | null;
  onSave: () => void;
}): JSX.Element {
  const { session } = props;
  const report = session.validation_report;
  const errors = report?.errors ?? [];
  const warnings = report?.warnings ?? [];
  const saveDisabled =
    !props.canSave ||
    props.saving ||
    session.draft_ir === null ||
    report === null ||
    errors.length > 0;
  const tone =
    errors.length > 0
      ? "red"
      : warnings.length > 0
        ? "amber"
        : report === null
          ? "muted"
          : "green";
  const [developerOpen, setDeveloperOpen] = useState(false);
  const summary = draftSummary(session);
  const startLabel = draftStartLabel(summary);
  const label =
    report === null
        ? "검사 대기"
      : errors.length > 0
        ? `수정 필요 ${errors.length}건`
        : warnings.length > 0
          ? `경고 ${warnings.length}건`
          : "자동화 검사 통과";
  return (
    <details className="browser-recorder-draft" open>
      <summary>
        생성된 자동화 확인
        <span className={`badge ${tone}`}>{label}</span>
      </summary>
      {report !== null && (
        <div
          className="browser-recorder-validation"
          role={errors.length > 0 ? "alert" : "status"}
        >
          <ValidationIssueList title="오류" items={errors} tone="red" />
          <ValidationIssueList title="경고" items={warnings} tone="amber" />
          {errors.length === 0 && warnings.length === 0 && (
            <p className="subtle">
              저장 전 자동화와 같은 실행 전 검사를 통과했습니다. 실제 사이트
              상태와 입력값은 첫 실행에서 다시 확인해야 합니다.
            </p>
          )}
        </div>
      )}
      <div className="browser-recorder-draft-summary" aria-label="자동화 요약">
        <span>
          <strong>{summary.name}</strong>
          <small>자동화 이름</small>
        </span>
        <span>
          <strong>{summary.steps.length}</strong>
          <small>녹화 동작</small>
        </span>
        <span>
          <strong>{startLabel}</strong>
          <small>처음 동작</small>
        </span>
      </div>
      {summary.steps.length === 0 ? (
        <p className="empty-state">
          표시할 녹화 동작 요약이 없습니다. 고급 세부 정보에서 생성 결과를 확인하세요.
        </p>
      ) : (
        <ol
          className="browser-recorder-draft-steps"
          aria-label="녹화 동작 요약"
        >
          {summary.steps.slice(0, 8).map((step, index) => (
            <li key={step.id}>
              <span className="badge muted">{index + 1}번째</span>
              <strong>{step.action}</strong>
              {step.detail !== null && <span>{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {summary.steps.length > 8 && (
        <p className="subtle">
          나머지 {summary.steps.length - 8}개 녹화 동작은 고급 세부 정보에서
          확인할 수 있습니다.
        </p>
      )}
      <details className="developer-details" open={developerOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setDeveloperOpen((open) => !open);
          }}
        >
          고급 세부 정보 보기
        </summary>
        {developerOpen && (
          <pre>{JSON.stringify(session.draft_ir, null, 2)}</pre>
        )}
      </details>
      <div className="browser-recorder-draft-actions">
        <button
          className="btn primary"
          type="button"
          disabled={saveDisabled}
          onClick={props.onSave}
        >
          {props.saving ? "저장 중" : "자동화로 저장"}
        </button>
        {props.savedScenario !== null && (
          <>
            <span className="badge green">
              저장됨: 변경 {props.savedScenario.version}
            </span>
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigate("playground", {
                  scenario: props.savedScenario?.scenario_id ?? "",
                })
              }
            >
              미리보기
            </button>
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigate("automationOps", {
                  scenario: props.savedScenario?.scenario_id ?? "",
                })
              }
            >
              운영 예약
            </button>
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigate("coePipeline", {
                  scenario: props.savedScenario?.scenario_id ?? "",
                })
              }
            >
              CoE 연결
            </button>
          </>
        )}
        {!props.canSave && (
          <span className="badge amber">자동화 생성 권한 필요</span>
        )}
        {errors.length > 0 && (
          <span className="badge red">검사 오류 수정 필요</span>
        )}
      </div>
    </details>
  );
}

function ValidationIssueList(props: {
  title: string;
  items: readonly BrowserRecordingValidationIssue[];
  tone: "red" | "amber";
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <div>
      <strong>
        {props.title} ({props.items.length})
      </strong>
      <ul>
        {props.items.map((issue, index) => (
          <li key={`${issue.rule ?? issue.code ?? props.title}-${index}`}>
            <span className={`badge ${props.tone}`}>
              {props.tone === "red" ? "확인 필요" : "주의"}
            </span>
            <span>{recordingIssueSummary(issue)}</span>
            {(issue.nodeId ?? issue.node_id) !== undefined && (
              <span className="subtle">
                {" "}
                확인할 녹화 동작 연결 정보가 있습니다.
              </span>
            )}
            <details className="developer-details">
              <summary>고급 검사 정보 보기</summary>
              <pre>{JSON.stringify(issue, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
