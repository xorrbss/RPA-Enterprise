// utility-executor.ts 에서 추출 — UtilityExecutor 도메인 에러(본체·검증 사이블링이 공유, 순환 import 회피로
// 별도 leaf 모듈 — dom-executor-error.ts 동형). 동작 무변경.

/**
 * UtilityExecutor 도메인 에러코드 — error-catalog.ts 의 `ErrorCode` 와 **별개 네임스페이스**다.
 * (PageStateResolverError 와 동일 패턴.) 런타임 예외 분류기가 이 코드를 ExceptionClass 로 매핑하며,
 * `ERROR_CATALOG[code]` 로 직접 인덱싱하지 않는다. 타입을 좁혀 카탈로그 오인덱싱을 컴파일 단계에서 차단한다
 * (bare `string` 이면 `EXECUTOR_CAPABILITY_MISMATCH` 등이 ERROR_CATALOG[undefined] 크래시로 새는 것을 막지 못함).
 */
export type UtilityErrorCode =
  | "IR_SCHEMA_INVALID"
  | "EXECUTOR_CAPABILITY_MISMATCH"
  | "ARTIFACT_RETENTION_FAILED"
  | "DOMAIN_POLICY_VIOLATION"
  | "RUN_ABORTED";

export class UtilityExecutorError extends Error {
  constructor(
    readonly code: UtilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UtilityExecutorError";
  }
}
