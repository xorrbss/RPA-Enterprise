// runtime-worker.ts 에서 추출 — resume-token/세션복원 파싱 + 원시 입력 검증 leaf 유틸(동작 무변경).
// PgRuntimeWorker 및 artifact-lifecycle 클러스터가 공유하는 무상태 헬퍼.
import type { ResumeTokenEnvelope, SessionRestoreResult } from "../../../ts/runtime-contract";
import type { RunId } from "../../../ts/security-middleware-contract";

export function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`RuntimeWorker: ${label} is required`);
}

export function parseResumeTokenEnvelope(value: unknown, expectedRunId: string): ResumeTokenEnvelope | null {
  if (!isRecord(value)) return null;
  const runId = stringField(value, "runId");
  const resumeNodeId = stringField(value, "resumeNodeId");
  const pageStateRef = stringField(value, "pageStateRef");
  const issuedAt = stringField(value, "issuedAt");
  const expiresAt = stringField(value, "expiresAt");
  const kid = stringField(value, "kid");
  const hmac = stringField(value, "hmac");
  if (
    runId === null ||
    runId !== expectedRunId ||
    resumeNodeId === null ||
    pageStateRef === null ||
    issuedAt === null ||
    expiresAt === null ||
    kid === null ||
    hmac === null
  ) {
    return null;
  }

  const loopContext = parseLoopContext(value.loopContext);
  if (loopContext === false) return null;
  return {
    runId: runId as RunId,
    resumeNodeId,
    pageStateRef,
    ...(loopContext === undefined ? {} : { loopContext }),
    issuedAt: issuedAt as ResumeTokenEnvelope["issuedAt"],
    expiresAt: expiresAt as ResumeTokenEnvelope["expiresAt"],
    kid,
    hmac,
  };
}

function parseLoopContext(
  value: unknown,
): { iteration: number; pageCount: number } | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const iteration = value.iteration;
  const pageCount = value.pageCount;
  if (
    typeof iteration !== "number" ||
    typeof pageCount !== "number" ||
    !Number.isInteger(iteration) ||
    !Number.isInteger(pageCount) ||
    iteration < 0 ||
    pageCount < 0
  ) {
    return false;
  }
  return { iteration, pageCount };
}

// SessionRestoreResult → R18(restore_ok)/R19·R20(restore_failed) 전이. 모든 변형을 명시 처리 + never 가드로
// 미정의 변형을 loud throw(조용한 unknown 금지 — catch-all 흡수 금지). loginBypassPossible=true 만 R19(재로그인 우회),
// false 는 R20(failed_system). resume-token 검증 실패(invalid_token)는 신뢰 불가 토큰이라 우회 불가 → R20(security-contracts §5).
export function restoreTransitionFor(
  result: SessionRestoreResult,
  expectedPageStateRef: string,
):
  | { event: { type: "restore_ok" }; guard: { restoreOk: true } }
  | { event: { type: "restore_failed" }; guard: { loginBypassPossible: boolean } } {
  switch (result.kind) {
    case "restored":
      // pageStateRef 대조 — 일치 시에만 R18. 불일치(restorer 자기모순)는 fail-closed R20(우회 불가).
      return result.pageStateRef === expectedPageStateRef
        ? { event: { type: "restore_ok" }, guard: { restoreOk: true } }
        : { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
    case "login_bypass":
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: true } };
    case "page_state_mismatch":
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: result.loginBypassPossible } };
    case "invalid_token":
      // resume-token 검증 실패(만료=CHALLENGE_UNRESOLVED / 위변조·kid 불일치=IR_EXPRESSION_RUNTIME, security-contracts §5).
      // 신뢰 불가 토큰의 resumeNodeId 로 재로그인 우회 금지 → R20 failed_system("resume 거부 → system 예외"). 조용히 흘리지 않음.
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
    case "terminal_failure":
      return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
    default: {
      // 미정의 SessionRestoreResult 변형 — catch-all 흡수(조용한 unknown) 금지. 컴파일 시 exhaustive 강제 + 런타임 loud throw.
      const exhaustive: never = result;
      throw new Error(`restoreTransitionFor: unhandled SessionRestoreResult kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function isOnlyRestoreSessionPending(pending: readonly { kind: string }[]): boolean {
  return pending.length === 1 && pending[0]?.kind === "restoreSession";
}

export function isOnlyAbortLeasePending(
  pending: readonly { kind: string; lease?: string }[],
  event: "drain_ok" | "drain_timeout",
): boolean {
  const expectedKind = event === "drain_timeout" ? "killLease" : "releaseLease";
  return pending.length === 1 && pending[0]?.kind === expectedKind && pending[0]?.lease === "browser";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function unknownToReason(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) return value.message;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "session restore failed";
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`RuntimeWorker: ${label} must be a non-empty string when provided`);
}
