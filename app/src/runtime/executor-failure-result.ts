/**
 * executor 플러그인 실행이 throw 했을 때, 그 예외를 분류해 실패 StepResult 로 흡수한다(제어흐름).
 *
 * 과거엔 executor-step-orchestrator.ts(테스트 전용으로 휴면이던 PgExecutorStepOrchestrator 클래스 보유)에 함께
 * 있었으나, 그 중복 오케스트레이터를 제거하면서 production(run-step-driver)이 실제로 쓰는 이 헬퍼만 분리했다.
 * 분류: ERROR_CATALOG[code].exceptionClass → failed_business/challenge/security/system. 미분류 예외는 system
 * (조용한 false/unknown 금지 — CONTROL_PLANE_INTERNAL_ERROR 로 흡수).
 */
import type { IRActionType, RedactedString, RunContext, StepResult } from "../../../ts/core-types";
import { ERROR_CATALOG, type ErrorCode } from "../../../ts/error-catalog";
import { pageStateRef } from "../executor/page-state-resolver";

export function executorFailureStepResult(
  input: { readonly stepId: string; readonly actionType: IRActionType },
  context: RunContext,
  startedAt: string,
  error: unknown,
): StepResult {
  const code = catalogCodeFromError(error);
  const catalogClass = ERROR_CATALOG[code].exceptionClass;
  const exceptionClass = catalogClass === "business" || catalogClass === "challenge" || catalogClass === "security"
    ? catalogClass
    : "system";
  const status =
    exceptionClass === "business"
      ? "failed_business"
      : exceptionClass === "challenge"
        ? "failed_challenge"
        : exceptionClass === "security"
          ? "failed_security"
          : "failed_system";
  const endedAt = new Date().toISOString();
  return {
    stepId: input.stepId,
    action: input.actionType,
    status,
    pageStateBefore: pageStateRef(context.pageState),
    pageStateAfter: pageStateRef(context.pageState),
    artifacts: [],
    cache: { mode: "bypass" },
    exception: {
      class: exceptionClass,
      code,
      message: `executor plugin failed: ${code}` as RedactedString,
    },
    timings: {
      startedAt,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    },
  };
}

function catalogCodeFromError(error: unknown): ErrorCode {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof candidate === "string" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, candidate)) {
    return candidate as ErrorCode;
  }
  return "CONTROL_PLANE_INTERNAL_ERROR";
}
