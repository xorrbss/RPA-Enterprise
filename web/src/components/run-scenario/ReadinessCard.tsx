// 실행 전 준비 점검 카드 — 실행값/실행 전 검사/모델 정책/사이트·세션 상태를 톤(신호등)으로 요약.

import { useQuery } from "@tanstack/react-query";

import type { GatewayPolicy, Paginated, SiteItem } from "../../api/types";
import type { ScenarioParamField } from "../../api/scenario-params";
import { navigate } from "../../router";
import { assessTargetSiteReadiness, type ReadinessTone } from "../readiness";

function CheckRow({ tone, label, detail, action }: { tone: ReadinessTone; label: string; detail: string; action?: JSX.Element }): JSX.Element {
  return (
    <div className="readiness-row">
      <span className={`badge ${tone}`}>{label}</span>
      <span className="subtle">{detail}</span>
      {action}
    </div>
  );
}

export function ReadinessCard({
  hasIr,
  fields,
  missing,
  invalid,
  policies,
  sites,
  validation,
  modelRequired,
  modelConfirmed,
  targetUrls,
}: {
  hasIr: boolean;
  fields: readonly ScenarioParamField[];
  missing: readonly ScenarioParamField[];
  invalid: readonly ScenarioParamField[];
  policies: ReturnType<typeof useQuery<Paginated<GatewayPolicy>>>;
  sites: ReturnType<typeof useQuery<Paginated<SiteItem>>>;
  validation: ReturnType<typeof useQuery<{ valid: boolean; report: unknown }>>;
  modelRequired: { available: number } | null;
  modelConfirmed: boolean;
  targetUrls: readonly string[];
}): JSX.Element {
  const policyItems = policies.data?.items ?? [];
  const hasDefault = policyItems.some((p) => p.is_default === true);
  const modelTone = modelRequired !== null && !modelConfirmed
    ? "red"
    : policies.isError || policyItems.length === 0 || (!hasDefault && policyItems.length > 1)
      ? "amber"
      : "green";
  const modelText = modelRequired !== null && !modelConfirmed
    ? "AI 모델을 선택하고 확인해야 실행할 수 있습니다."
    : policies.isLoading
      ? "모델 정책 확인 중입니다."
      : policies.isError
        ? "모델 정책을 불러오지 못했습니다. 실행 시 서버가 최종 판정합니다."
        : policyItems.length === 0
          ? "등록된 모델 정책이 없습니다."
          : hasDefault || policyItems.length === 1
            ? "기본 또는 단일 모델 정책으로 실행할 수 있습니다."
            : "기본 정책이 없어 실행 시 AI 모델 선택이 필요할 수 있습니다.";
  const validationTone = !hasIr
    ? "amber"
    : validation.isLoading
      ? "blue"
      : validation.isError
        ? "amber"
        : validation.data?.valid === true
          ? "green"
          : "red";
  const validationText = !hasIr
    ? "자동화 정의를 불러오지 못해 실행 전 검사를 먼저 확인할 수 없습니다."
    : validation.isLoading
      ? "자동화 정의를 확인하는 중입니다."
      : validation.isError
        ? "실행 전 검사 호출에 실패했습니다. 저장 시 검증과 실행 시 서버 판정을 따릅니다."
        : validation.data?.valid === true
          ? "자동화 정의 검사를 통과했습니다."
          : "자동화 정의 검사 오류가 있습니다. 실행 전 자동화 검사를 권장합니다.";
  const paramTone = missing.length === 0 && invalid.length === 0 ? "green" : "red";
  const paramText = fields.length === 0
    ? "추가 실행값 없이 실행할 수 있습니다."
    : invalid.length > 0
      ? `입력값 형식을 확인하세요: ${invalid.map((field) => field.label).join(", ")}.`
      : missing.length === 0
      ? "필수 실행값이 모두 입력되었습니다."
      : `필수 실행값 ${missing.map((field) => field.label).join(", ")} 입력이 필요합니다.`;
  const site = assessTargetSiteReadiness(targetUrls, sites);
  const sessionSiteId = site.siteId;
  return (
    <section className="readiness-card" aria-label="실행 전 준비 점검">
      <strong>실행 전 준비 점검</strong>
      <CheckRow tone={paramTone} label="실행값" detail={paramText} />
      {/* R2: 수동 검사 화면(irValidation) 은퇴 — 검증은 저장·실행 시 자동 수행되므로 상태 표시만 남긴다. */}
      <CheckRow tone={validationTone} label="실행 전 검사" detail={validationText} />
      <CheckRow
        tone={modelTone}
        label="모델 정책"
        detail={modelText}
        action={<button className="linklike" type="button" onClick={() => navigate("llmGateway")}>정책 보기</button>}
      />
      <CheckRow
        tone={site.tone}
        label="사이트/세션"
        detail={site.detail}
        action={
          sessionSiteId !== undefined ? (
            <button className="linklike" type="button" onClick={() => navigate("security", { section: "sites", site: sessionSiteId })}>
              세션 등록하러 가기
            </button>
          ) : targetUrls.length > 0 ? (
            <button className="linklike" type="button" onClick={() => navigate("security", { section: "sites" })}>
              사이트·세션 설정
            </button>
          ) : undefined
        }
      />
    </section>
  );
}
