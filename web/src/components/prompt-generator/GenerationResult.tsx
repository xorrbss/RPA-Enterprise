import { FileVideo, Image, Play } from "lucide-react";

import { navigate } from "../../router";
import type { ScenarioGenerationResult } from "../../api/types";
import { GenerationArtifactsPanel } from "../GenerationArtifactsPanel";
import { EvidenceStorageChip, ReadinessBadge } from "./shared";
import {
  blockerLabel,
  canRunGenerationWithCorrections,
  correctionGuideReady,
  evidenceReviewActionLabel,
  generationStatusLabel,
  generationStatusTone,
  hasRequestedImageEvidence,
  hasRequestedVideoEvidence,
  hasVisibleCorrectionSteps,
  plannerLabel,
  screenshotPolicyLabel,
  videoPolicyLabel,
  type CorrectionGuideState,
} from "./helpers";

export function GenerationResult({
  result,
  correctionGuide,
  runPending,
  modelConfirmationRequired,
  onRunWithCorrections,
  onFocusStartUrl,
  onFocusTarget,
  onOpenSiteCreate,
  onFocusParams,
  onDisableVideoEvidence,
}: {
  result: ScenarioGenerationResult;
  correctionGuide: CorrectionGuideState | null;
  runPending: boolean;
  modelConfirmationRequired: boolean;
  onRunWithCorrections: (generation: ScenarioGenerationResult) => void;
  onFocusStartUrl: () => void;
  onFocusTarget: () => void;
  onOpenSiteCreate: () => void;
  onFocusParams: () => void;
  onDisableVideoEvidence: () => void;
}): JSX.Element {
  const canRunWithCorrections = canRunGenerationWithCorrections(result);
  const correctionReady = correctionGuide === null || correctionGuideReady(correctionGuide);
  const resultActionLabel = evidenceReviewActionLabel(result.evidence_policy);
  return (
    <div className="generation-result" role="status">
      <div className="generation-result-head">
        <span className={`badge ${generationStatusTone(result.status)}`}>{generationStatusLabel(result.status)}</span>
      </div>
      <div className="result-grid">
        <span className="subtle">자동화</span>
        <strong>{result.scenario_id === null ? "아직 저장 전" : "저장됨"}</strong>
        <span className="subtle">버전</span>
        <strong>{result.scenario_version_id === null ? "아직 없음" : "생성됨"}</strong>
        <span className="subtle">실행</span>
        <strong>{result.run_id === null ? "아직 실행 전" : "실행 기록 연결됨"}</strong>
        <span className="subtle">AI 모델</span>
        <strong>{result.model ?? "기본값 자동 선택"}</strong>
        <span className="subtle">AI 방식</span>
        <strong>{plannerLabel(result.planner)}</strong>
      </div>
      <details className="developer-details result-raw-details">
        <summary>고급/원문 식별값 보기</summary>
        <div className="result-grid">
          <span className="subtle">생성 추적 번호</span>
          <code>{result.generation_id}</code>
          <span className="subtle">자동화 추적 번호</span>
          <code>{result.scenario_id ?? "-"}</code>
          <span className="subtle">버전 추적 번호</span>
          <code>{result.scenario_version_id ?? "-"}</code>
          <span className="subtle">실행 추적 번호</span>
          <code>{result.run_id ?? "-"}</code>
        </div>
      </details>
      {result.evidence_policy !== undefined && (
        <div className="inline-facts" aria-label="증거 저장 설정">
          <span className="evidence-chip">
            <Image size={14} aria-hidden="true" />
            {screenshotPolicyLabel(result.evidence_policy.screenshot)}
          </span>
          <span className="evidence-chip">
            <FileVideo size={14} aria-hidden="true" />
            {videoPolicyLabel(result.evidence_policy.video)}
          </span>
        </div>
      )}
      {result.run_id !== null && (
        <div className="inline-facts" aria-label="실행 기록 연결">
          <span className="badge blue">실행 기록 연결</span>
          <EvidenceStorageChip policy={result.evidence_policy} />
          <span className="subtle">실행 기록 산출물에서 확인</span>
        </div>
      )}
      {result.blockers.length > 0 && (
        <div className="blocker-section" aria-label="검토 필요 사유">
          <strong>검토 필요 사유</strong>
          <ul className="blocker-list">
            {result.blockers.map((blocker) => (
              <li key={blocker}>{blockerLabel(blocker)}</li>
            ))}
          </ul>
        </div>
      )}
      {canRunWithCorrections && correctionGuide !== null && hasVisibleCorrectionSteps(correctionGuide) && (
        <BlockedCorrectionGuide
          guide={correctionGuide}
          onFocusStartUrl={onFocusStartUrl}
          onFocusTarget={onFocusTarget}
          onOpenSiteCreate={onOpenSiteCreate}
          onFocusParams={onFocusParams}
          onDisableVideoEvidence={onDisableVideoEvidence}
        />
      )}
      <GenerationArtifactsPanel generationId={result.generation_id} />
      {result.run_id !== null && (
        <GenerationArtifactsPanel generationId={result.generation_id} source="result" title="실행 결과 증빙" />
      )}
      {canRunWithCorrections && (
        <>
          <button
            className="btn primary"
            type="button"
            onClick={() => onRunWithCorrections(result)}
            disabled={runPending || modelConfirmationRequired || !correctionReady}
          >
            <Play size={15} aria-hidden="true" />
            {runPending ? "실행 보정 중" : "보정값으로 실행"}
          </button>
          {modelConfirmationRequired && <span className="subtle">AI 모델 확인 후 실행할 수 있습니다.</span>}
        </>
      )}
      {result.scenario_id !== null && (
        <div className="inline-actions" aria-label="저장된 자동화 연결">
          <button className="btn" type="button" onClick={() => navigate("playground", { scenario: result.scenario_id! })}>
            자동화 보기
          </button>
          <button className="btn" type="button" onClick={() => navigate("automationOps", { scenario: result.scenario_id! })}>
            운영 예약
          </button>
          <button className="btn" type="button" onClick={() => navigate("coePipeline", { scenario: result.scenario_id! })}>
            CoE 연결
          </button>
        </div>
      )}
      {result.run_id !== null && (
        <button className="btn" type="button" onClick={() => navigate("runTrace", { run: result.run_id!, generation: result.generation_id, focus: "artifacts" })}>
          {hasRequestedImageEvidence(result.evidence_policy) && <Image size={15} aria-hidden="true" />}
          {hasRequestedVideoEvidence(result.evidence_policy) && <FileVideo size={15} aria-hidden="true" />}
          {!hasRequestedImageEvidence(result.evidence_policy) && !hasRequestedVideoEvidence(result.evidence_policy) && <Play size={15} aria-hidden="true" />}
          {resultActionLabel}
        </button>
      )}
    </div>
  );
}

function BlockedCorrectionGuide({
  guide,
  onFocusStartUrl,
  onFocusTarget,
  onOpenSiteCreate,
  onFocusParams,
  onDisableVideoEvidence,
}: {
  guide: CorrectionGuideState;
  onFocusStartUrl: () => void;
  onFocusTarget: () => void;
  onOpenSiteCreate: () => void;
  onFocusParams: () => void;
  onDisableVideoEvidence: () => void;
}): JSX.Element {
  return (
    <div className="site-create-inline recovery-guide" aria-label="실행 전 보정 안내">
      <strong>실행 전 보정</strong>
      <ul className="recovery-guide-list">
        {guide.needsStartUrl && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.startUrlReady} />
              <span>시작 주소</span>
              <span className="subtle">{guide.startUrlReady ? "입력됨" : "자동 실행에 필요한 첫 페이지 주소를 입력하세요."}</span>
            </span>
            <button className="linklike" type="button" onClick={onFocusStartUrl}>
              시작 주소 입력
            </button>
          </li>
        )}
        {guide.needsTarget && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.targetReady} />
              <span>실행 대상</span>
              <span className="subtle">
                {guide.targetReady
                  ? "사이트·로그인 세션·보안 정책이 준비됐습니다."
                  : guide.targetPartial
                    ? "실행 대상 구성을 완료하세요."
                    : "기존 사이트를 선택하거나 새 사이트를 등록하세요."}
              </span>
            </span>
            <span className="inline-facts recovery-guide-actions">
              {guide.hasSelectableSites && (
                <button className="linklike" type="button" onClick={onFocusTarget}>
                  사이트 선택
                </button>
              )}
              {guide.canCreateSite && (
                <button className="linklike" type="button" onClick={onOpenSiteCreate}>
                  새 사이트 등록
                </button>
              )}
            </span>
          </li>
        )}
        {!guide.targetStartUrlMatches && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={false} />
              <span>사이트 주소 일치</span>
              <span className="subtle">시작 주소와 선택한 사이트 주소를 맞추세요.</span>
            </span>
            <span className="inline-facts recovery-guide-actions">
              <button className="linklike" type="button" onClick={onFocusStartUrl}>
                시작 주소 확인
              </button>
              <button className="linklike" type="button" onClick={onFocusTarget}>
                사이트 확인
              </button>
            </span>
          </li>
        )}
        {guide.needsVideoPolicy && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.videoPolicyReady} />
              <span>동영상 증거</span>
              <span className="subtle">{guide.videoPolicyReady ? "동영상 저장 안 함" : "녹화 포트가 없으면 동영상을 끄고 실행하세요."}</span>
            </span>
            <button className="linklike" type="button" onClick={onDisableVideoEvidence}>
              동영상 끄기
            </button>
          </li>
        )}
        {guide.needsParams && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.paramsReady} />
              <span>실행 입력값</span>
              <span className="subtle">{guide.paramsReady ? "입력됨" : "마스킹된 값을 다시 입력하세요."}</span>
            </span>
            <button className="linklike" type="button" onClick={onFocusParams}>
              입력값 수정
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
