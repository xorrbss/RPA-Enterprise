import type { MutableRefObject } from "react";

import { SiteCreateForm, type CreatedSite } from "../SiteCreateForm";
import type { GatewayPolicy, SiteItem } from "../../api/types";
import {
  PROMPT_EXAMPLES,
  httpOrigin,
  siteLabel,
  siteNetworkLabel,
  siteSessionLabel,
} from "./helpers";

export interface GeneratorFormFieldsProps {
  readonly prompt: string;
  readonly onPromptChange: (value: string) => void;
  readonly startUrl: string;
  readonly onStartUrlChange: (value: string) => void;
  readonly startUrlInputRef: MutableRefObject<HTMLInputElement | null>;
  readonly siteSelectRef: MutableRefObject<HTMLSelectElement | null>;
  readonly siteItems: readonly SiteItem[] | undefined;
  readonly siteProfileId: string;
  readonly onSelectSite: (siteId: string) => void;
  readonly model: string;
  readonly onModelChange: (value: string) => void;
  readonly gatewayPolicies: readonly GatewayPolicy[];
  readonly defaultGatewayPolicy: GatewayPolicy | null;
  readonly modelRequired: { readonly available: number } | null;
  readonly modelConfirmed: boolean;
  readonly checkedModel: string;
  readonly onConfirmModel: () => void;
  readonly policyCheckFetching: boolean;
  readonly policyCheckError: boolean;
  readonly policyCheckModel: string | undefined;
  readonly siteCreateRef: MutableRefObject<HTMLDivElement | null>;
  readonly siteCreateOpenSignal: number;
  readonly onSiteCreated: (created: CreatedSite) => void;
  readonly selectedSite: SiteItem | null;
  readonly canCreateSite: boolean;
  readonly onOpenSiteCreate: () => void;
  readonly onOpenSiteSecurity: (siteId?: string) => void;
}

// 자연어 요청 입력 + 실행 대상(시작 주소/사이트/AI 모델) 폼과 대상 요약·준비 안내(notice).
export function GeneratorFormFields(props: GeneratorFormFieldsProps): JSX.Element {
  const {
    prompt,
    onPromptChange,
    startUrl,
    onStartUrlChange,
    startUrlInputRef,
    siteSelectRef,
    siteItems,
    siteProfileId,
    onSelectSite,
    model,
    onModelChange,
    gatewayPolicies,
    defaultGatewayPolicy,
    modelRequired,
    modelConfirmed,
    checkedModel,
    onConfirmModel,
    policyCheckFetching,
    policyCheckError,
    policyCheckModel,
    siteCreateRef,
    siteCreateOpenSignal,
    onSiteCreated,
    selectedSite,
    canCreateSite,
    onOpenSiteCreate,
    onOpenSiteSecurity,
  } = props;
  const targetSetupNotice = targetSetupNoticeFor(selectedSite, startUrl);
  return (
    <>
      <div className="prompt-examples" role="group" aria-label="예시 프롬프트">
        <span className="subtle">예시로 시작하기</span>
        {PROMPT_EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            className="prompt-example-chip"
            aria-label={`예시 프롬프트 채우기: ${ex.label}`}
            onClick={() => onPromptChange(ex.prompt)}
          >
            {ex.label}
          </button>
        ))}
      </div>
      <label className="field field-wide">
        <span>자연어 요청</span>
        <textarea
          id="scenario-natural-language-request"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          rows={4}
          placeholder="예: https://example.com 에서 오늘 신규 주문 목록을 확인하고 요약해줘"
        />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>시작 주소</span>
          <input ref={startUrlInputRef} value={startUrl} onChange={(event) => onStartUrlChange(event.target.value)} placeholder="https://..." />
        </label>
        <label className="field">
          <span>사이트</span>
          <select ref={siteSelectRef} value={siteProfileId} onChange={(event) => onSelectSite(event.target.value)}>
            <option value="">사이트 선택 안 함</option>
            {(siteItems ?? []).map((site) => (
              <option key={site.site_profile_id} value={site.site_profile_id}>
                {siteLabel(site)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>AI 모델</span>
          <select aria-label="AI 모델" value={model} onChange={(event) => onModelChange(event.target.value)}>
            <option value="">{defaultGatewayPolicy === null ? "기본 AI 모델 사용" : `기본 AI 모델 사용 (${defaultGatewayPolicy.model})`}</option>
            {gatewayPolicies.map((policy) => (
              <option key={policy.model} value={policy.model}>
                {policy.model}
                {policy.is_default === true ? " · 기본" : ""}
              </option>
            ))}
          </select>
          {modelRequired !== null && (
            <span className="model-confirm-row">
              <button className="btn" type="button" onClick={onConfirmModel} disabled={model.trim().length === 0 || policyCheckFetching}>
                확인
              </button>
              <span className="subtle" role="status">
                {policyCheckFetching
                  ? "AI 모델 확인 중..."
                  : modelConfirmed
                    ? `확인됨 - '${policyCheckModel ?? checkedModel}' 사용`
                    : checkedModel.length > 0 && checkedModel === model.trim() && policyCheckError
                      ? `'${checkedModel}'을 사용할 수 없습니다. AI 모델명을 확인하세요.`
                      : "AI 모델을 선택하고 확인 후 다시 실행하세요."}
              </span>
            </span>
          )}
        </label>
        <div className="field field-wide" ref={siteCreateRef}>
          <SiteCreateForm
            embedded
            title="새 사이트 온보딩"
            triggerLabel="등록"
            initialUrl={startUrl}
            openSignal={siteCreateOpenSignal}
            onCreated={onSiteCreated}
          />
        </div>
      </div>
      <div className="target-summary" aria-label="실행 대상 요약">
        <span>
          <span className="subtle">로그인 세션</span>
          <strong>{siteSessionLabel(selectedSite)}</strong>
        </span>
        <span>
          <span className="subtle">보안 정책</span>
          <strong>{siteNetworkLabel(selectedSite)}</strong>
        </span>
        <span>
          <span className="subtle">AI 모델</span>
          <strong>{model.trim().length > 0 ? model.trim() : defaultGatewayPolicy?.model ?? "기본값 자동 선택"}</strong>
        </span>
      </div>
      {targetSetupNotice !== null && (
        <div className={`form-alert ${targetSetupNotice.tone}`} role="status" style={{ display: "grid", gap: 6 }}>
          <span>{targetSetupNotice.text}</span>
          <span className="inline-facts">
            {targetSetupNotice.showCreate && canCreateSite && (
              <button className="linklike" type="button" onClick={onOpenSiteCreate}>
                새 사이트 등록
              </button>
            )}
            <button className="linklike" type="button" onClick={() => onOpenSiteSecurity(targetSetupNotice.siteId)}>
              사이트·세션 설정
            </button>
            {targetSetupNotice.siteId !== undefined && (
              <button className="linklike" type="button" onClick={() => onOpenSiteSecurity(targetSetupNotice.siteId)}>
                세션 등록하러 가기
              </button>
            )}
          </span>
        </div>
      )}
    </>
  );
}

type TargetSetupNotice = {
  readonly tone: "amber" | "red";
  readonly text: string;
  readonly siteId?: string;
  readonly showCreate: boolean;
};

function targetSetupNoticeFor(site: SiteItem | null, startUrl: string): TargetSetupNotice | null {
  if (site !== null) {
    const name = site.name ?? "선택한 사이트";
    if (site.login_capable === true && site.session_ready !== true) {
      return {
        tone: "amber",
        text: `${name}의 로그인 세션을 등록해야 저장 후 실행할 수 있습니다.`,
        siteId: site.site_profile_id,
        showCreate: false,
      };
    }
    if (site.login_capable === true && (site.default_browser_identity_id === null || site.default_browser_identity_id === undefined)) {
      return {
        tone: "amber",
        text: `${name}에 사용할 로그인 세션을 연결하세요.`,
        siteId: site.site_profile_id,
        showCreate: false,
      };
    }
    if (site.default_network_policy_id === null || site.default_network_policy_id === undefined) {
      return {
        tone: "amber",
        text: `${name}에 보안 정책을 연결해야 실행 대상이 완성됩니다.`,
        siteId: site.site_profile_id,
        showCreate: false,
      };
    }
    return null;
  }
  if (httpOrigin(startUrl) !== null) {
    return {
      tone: "amber",
      text: "이 주소로 저장 후 실행하려면 사이트와 로그인 세션 설정을 먼저 확인하세요.",
      showCreate: true,
    };
  }
  return null;
}
