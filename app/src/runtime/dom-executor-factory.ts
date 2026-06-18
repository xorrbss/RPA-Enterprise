/**
 * production run-executor 팩토리 빌더 — worker executorFactory seam(P5b)용. `CompositeExecutor(StagehandDomExecutor(LLM
 * Gateway), UtilityExecutor)` 를 만든다: dom 프리미티브(act/observe/extract)는 게이트웨이 경유 LLM, utility(navigate/download
 * /upload 등)는 결정형. 인터프리터는 단일 ExecutorPlugin 만 받으므로 CompositeExecutor 가 action.type 으로 라우팅한다.
 *
 * 주입 경계: 게이트웨이/LLM 정책/캐시는 **deploy-time** 주입(클로저 캡처 — CODEX_* 자격은 게이트웨이 안에만). run-scoped 값
 * (scenarioVersionId/browserIdentityVersion — ActionPlanCache 키 스코프)은 **worker seam 이 run 단위로 주입**(아래 run 인자).
 * 반환 타입은 worker `RunExecutorFactory` 와 구조적으로 부합(worker import 없음 — 역의존/사이클 회피).
 *
 * 미주입(기본 UtilityExecutor)이면 dom 액션은 EXECUTOR_CAPABILITY_MISMATCH 로 거부되고 LLM/suspend 트리거 불가 —
 * 본 팩토리 주입으로 production LLM 액션이 가동된다. 라이브 게이트웨이 검증은 별도 env-gated 경로(CI 밖).
 */
import type { ExecutorPlugin } from "../../../ts/core-types";
import type { AuthenticatedPrincipal, LLMRequest, SecretStoreBoundary } from "../../../ts/security-middleware-contract";
import type { CdpSessionProvider } from "../executor/cdp-session";
import {
  StagehandDomExecutor,
  type ActionPlanCache,
  type LlmGatewayCaller,
} from "../executor/stagehand-dom-executor";
import type { GatewayArtifactSink } from "../gateway/llm-gateway";
import { UtilityExecutor } from "../executor/utility-executor";
import { CompositeExecutor } from "./composite-executor";

/**
 * deploy-time 주입 의존(클로저 캡처). cache=ActionPlanCache(plan 재생), secrets/executorPrincipal=자격증명 fill 경계,
 * extractArtifactSink=extract.rowAnchor 로 결정형 강화한 행을 typed artifact(approval_inbox 등)로 영속(인박스 소스).
 */
export interface DomExecutorFactoryDeps {
  readonly cache?: ActionPlanCache;
  readonly secrets?: SecretStoreBoundary;
  readonly executorPrincipal?: AuthenticatedPrincipal;
  readonly extractArtifactSink?: GatewayArtifactSink;
}

/** worker run-drive 컨텍스트(executorFactory seam): dom config 의 run-scoped ActionPlanCache 키 필드 + 자격증명 fill 감사용 tenant. */
export interface DomExecutorRunContext {
  readonly scenarioVersionId: string;
  readonly browserIdentityVersion: number;
  /** run 테넌트 — 자격증명 fill 시 executorPrincipal 에 per-run 으로 주입(secret.resolve 감사 row 테넌트 정합). */
  readonly tenantId?: string;
  readonly model?: string;
}

/** deploy-time LLM 정책(dom 액션 LLMRequest 파라미터). run-scoped 아님(운영자/오케스트레이터 고정 값). */
export interface DomExecutorLlmPolicy {
  readonly model: string;
  readonly promptTemplateVersion: string;
  readonly budget: LLMRequest["budget"];
}

/**
 * gateway + LLM 정책(+선택 deps: cache/secrets/principal/extractArtifactSink)을 캡처해, run 단위로 호출되는 run-executor
 * 팩토리를 만든다. 호출 시 bound provider + run-scoped 컨텍스트로 dom/utility CompositeExecutor 를 생성한다.
 */
export function createDomUtilityExecutorFactory(
  gateway: LlmGatewayCaller,
  policy: DomExecutorLlmPolicy,
  deps: DomExecutorFactoryDeps = {},
): (provider: CdpSessionProvider, run: DomExecutorRunContext) => ExecutorPlugin {
  return (provider, run) => {
    // 자격증명 fill 경계: secrets+executorPrincipal 주입 시 principal.tenantId 를 run 테넌트로 per-run 고정한다
    //   (secret.resolve 감사 row 의 테넌트 정합 — resolve 권한은 runtime_identity 매트릭스 기반이라 tenant 무관, 감사만 정합용).
    const principal =
      deps.executorPrincipal !== undefined && run.tenantId !== undefined
        ? { ...deps.executorPrincipal, tenantId: run.tenantId as (typeof deps.executorPrincipal)["tenantId"] }
        : deps.executorPrincipal;
    return new CompositeExecutor(
      new StagehandDomExecutor(
        gateway,
        provider,
        {
          model: run.model ?? policy.model,
          promptTemplateVersion: policy.promptTemplateVersion,
          budget: policy.budget,
          scenarioVersionId: run.scenarioVersionId,
          browserIdentityVersion: run.browserIdentityVersion,
        },
        deps.cache,
        deps.secrets,
        principal,
        deps.extractArtifactSink,
      ),
      new UtilityExecutor(provider),
    );
  };
}
