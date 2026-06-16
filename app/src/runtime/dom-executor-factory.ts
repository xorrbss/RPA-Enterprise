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
import type { LLMRequest } from "../../../ts/security-middleware-contract";
import type { CdpSessionProvider } from "../executor/cdp-session";
import {
  StagehandDomExecutor,
  type ActionPlanCache,
  type LlmGatewayCaller,
} from "../executor/stagehand-dom-executor";
import { UtilityExecutor } from "../executor/utility-executor";
import { CompositeExecutor } from "./composite-executor";

/** worker run-drive 컨텍스트(executorFactory seam): dom config 의 run-scoped ActionPlanCache 키 필드. */
export interface DomExecutorRunContext {
  readonly scenarioVersionId: string;
  readonly browserIdentityVersion: number;
}

/** deploy-time LLM 정책(dom 액션 LLMRequest 파라미터). run-scoped 아님(운영자/오케스트레이터 고정 값). */
export interface DomExecutorLlmPolicy {
  readonly model: string;
  readonly promptTemplateVersion: string;
  readonly budget: LLMRequest["budget"];
}

/**
 * gateway + LLM 정책(+선택 ActionPlanCache)을 캡처해, run 단위로 호출되는 run-executor 팩토리를 만든다.
 * 호출 시 bound provider + run-scoped 컨텍스트로 dom/utility CompositeExecutor 를 생성한다.
 */
export function createDomUtilityExecutorFactory(
  gateway: LlmGatewayCaller,
  policy: DomExecutorLlmPolicy,
  cache?: ActionPlanCache,
): (provider: CdpSessionProvider, run: DomExecutorRunContext) => ExecutorPlugin {
  return (provider, run) =>
    new CompositeExecutor(
      new StagehandDomExecutor(
        gateway,
        provider,
        {
          model: policy.model,
          promptTemplateVersion: policy.promptTemplateVersion,
          budget: policy.budget,
          scenarioVersionId: run.scenarioVersionId,
          browserIdentityVersion: run.browserIdentityVersion,
        },
        cache,
      ),
      new UtilityExecutor(provider),
    );
}
