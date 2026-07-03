import { useEffect, useRef, type MutableRefObject } from "react";

import { useHashParam } from "../../router";
import type { ScenarioGenerationRequest, ScenarioGenerationResult, SiteItem } from "../../api/types";
import { extractFirstHttpUrl, singleMatchingSiteForUrl } from "./helpers";

export interface PrefillInput {
  readonly prompt: string;
  readonly startUrl: string;
  readonly siteItems: readonly SiteItem[] | undefined;
  readonly autoStartUrlRef: MutableRefObject<string | null>;
  readonly targetManuallyEditedRef: MutableRefObject<boolean>;
  readonly setPrompt: (value: string) => void;
  readonly setName: (value: string) => void;
  readonly setParamsText: (value: string) => void;
  readonly setAdvancedOpen: (value: boolean) => void;
  readonly setDeveloperOpen: (value: boolean) => void;
  readonly setMode: (value: ScenarioGenerationRequest["mode"]) => void;
  readonly setLocalError: (value: string | null) => void;
  readonly setResult: (value: ScenarioGenerationResult | null) => void;
  readonly setStartUrl: (value: string) => void;
  readonly setSiteProfileId: (value: string) => void;
  readonly setBrowserIdentityId: (value: string) => void;
  readonly setNetworkPolicyId: (value: string) => void;
  readonly applySiteDefaults: (site: SiteItem) => void;
}

// 해시 프리필(연결기 템플릿·실행 대상)과 프롬프트 URL 자동 감지 — 생성기 폼 상태에 반영한다.
export function usePrefill(input: PrefillInput): void {
  const {
    prompt,
    startUrl,
    siteItems,
    autoStartUrlRef,
    targetManuallyEditedRef,
    setPrompt,
    setName,
    setParamsText,
    setAdvancedOpen,
    setDeveloperOpen,
    setMode,
    setLocalError,
    setResult,
    setStartUrl,
    setSiteProfileId,
    setBrowserIdentityId,
    setNetworkPolicyId,
    applySiteDefaults,
  } = input;
  const prefillSiteId = useHashParam("site");
  const prefillStartUrl = useHashParam("start_url");
  const prefillBrowserIdentityId = useHashParam("browser_identity");
  const prefillNetworkPolicyId = useHashParam("network_policy");
  const prefillConnectorId = useHashParam("connector_id");
  const prefillTemplateId = useHashParam("template_id");
  const prefillPrompt = useHashParam("prompt");
  const prefillName = useHashParam("name");
  const prefillParams = useHashParam("params");
  const hashPrefillKeyRef = useRef<string | null>(null);
  const templatePrefillKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = JSON.stringify([prefillConnectorId, prefillTemplateId, prefillPrompt, prefillName, prefillParams]);
    if (templatePrefillKeyRef.current === key) return;
    if (
      prefillConnectorId === null &&
      prefillTemplateId === null &&
      prefillPrompt === null &&
      prefillName === null &&
      prefillParams === null
    ) {
      return;
    }

    templatePrefillKeyRef.current = key;
    if (prefillPrompt !== null) setPrompt(prefillPrompt);
    if (prefillName !== null) setName(prefillName);
    if (prefillParams !== null) {
      setParamsText(prefillParams);
      setAdvancedOpen(true);
      setDeveloperOpen(true);
    }
    if (prefillConnectorId !== null || prefillTemplateId !== null) setMode("save");
    setLocalError(null);
    setResult(null);
  }, [prefillConnectorId, prefillName, prefillParams, prefillPrompt, prefillTemplateId]);

  useEffect(() => {
    const key = JSON.stringify([prefillSiteId, prefillStartUrl, prefillBrowserIdentityId, prefillNetworkPolicyId]);
    if (hashPrefillKeyRef.current === key) return;
    hashPrefillKeyRef.current = key;
    if (
      prefillSiteId === null &&
      prefillStartUrl === null &&
      prefillBrowserIdentityId === null &&
      prefillNetworkPolicyId === null
    ) {
      return;
    }

    targetManuallyEditedRef.current = true;
    if (prefillSiteId !== null) setSiteProfileId(prefillSiteId);
    if (prefillStartUrl !== null) {
      setStartUrl(prefillStartUrl);
      autoStartUrlRef.current = prefillStartUrl;
    }
    if (prefillBrowserIdentityId !== null) setBrowserIdentityId(prefillBrowserIdentityId);
    if (prefillNetworkPolicyId !== null) setNetworkPolicyId(prefillNetworkPolicyId);
  }, [prefillBrowserIdentityId, prefillNetworkPolicyId, prefillSiteId, prefillStartUrl]);

  useEffect(() => {
    const detectedUrl = extractFirstHttpUrl(prompt);
    if (detectedUrl === null) return;

    const currentStartUrl = startUrl.trim();
    if (currentStartUrl.length > 0 && currentStartUrl !== autoStartUrlRef.current) return;

    autoStartUrlRef.current = detectedUrl;
    if (currentStartUrl !== detectedUrl) {
      setStartUrl(detectedUrl);
    }

    if (targetManuallyEditedRef.current) return;
    const matchedSite = singleMatchingSiteForUrl(detectedUrl, siteItems ?? []);
    if (matchedSite === null) return;

    setSiteProfileId(matchedSite.site_profile_id);
    applySiteDefaults(matchedSite);
  }, [prompt, siteItems, startUrl]);
}
