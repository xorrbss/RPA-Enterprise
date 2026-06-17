/**
 * LLM Gateway worker 주입 포트(PR-B0 — dom run-drive). binding.kind 로 test_fake 를 프로덕션에서 차단하는
 * allowTestLlmGatewayProvider 게이트 — browserSessionProvider/sinkDeliveryPort 와 동형 fail-closed.
 * narrow LlmGatewayCaller(stagehand-dom-executor.ts) 만 노출 — 포트 오염 없음. 미주입 → undefined(dom 미구성 =
 * utility 단독, 기존 동작). test_fake 가 opt-in 없이 들어오면 throw(실 run 의 LLM plan 위조 방지).
 *
 * production caller 조립(CodexSseAdapter + transport + CODEX_BASE_URL/SecretStore API키 + validator/redaction)은
 * deploy-time(release-open-checklist) — 본 모듈은 주입점·게이트만 정의한다(코드 하드코딩 금지).
 */
import type { LlmGatewayCaller } from "./stagehand-dom-executor";

export interface LlmGatewayProvider {
  readonly binding: { readonly kind: "real" | "test_fake" };
  readonly caller: LlmGatewayCaller;
}

export function gateLlmGatewayProvider(
  provider: LlmGatewayProvider | undefined,
  allowTestProvider: boolean,
): LlmGatewayCaller | undefined {
  if (provider === undefined) return undefined;
  if (provider.binding.kind === "test_fake" && allowTestProvider !== true) {
    throw new Error(
      "RuntimeWorker: test_fake llm gateway provider requires explicit allowTestLlmGatewayProvider opt-in",
    );
  }
  return provider.caller;
}
