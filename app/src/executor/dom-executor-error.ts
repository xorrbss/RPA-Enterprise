/**
 * dom 실행기 공용 에러 — StagehandDomExecutor 와 extract-row-anchor 가 공유한다(순환 import 회피로 별도 모듈).
 * code 는 error-catalog 의 공개 코드 부분집합(IR_SCHEMA_INVALID 등) — 드라이버가 이 코드로 실패 StepResult 로 환원.
 */
export type DomExecutorErrorCode = "EXECUTOR_CAPABILITY_MISMATCH" | "IR_SCHEMA_INVALID" | "RUN_ABORTED";

export class StagehandDomExecutorError extends Error {
  constructor(
    readonly code: DomExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StagehandDomExecutorError";
  }
}
