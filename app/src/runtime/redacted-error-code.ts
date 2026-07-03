/**
 * 실패 사유 → 비민감 오류 코드 정규화(R2-5 단일화).
 *
 * 외부 전달 원장(ops_notification_attempts·integration_handoff_dispatch_attempts)에 남기는 실패
 * 코드는 원문 메시지(내부 경로/비밀 누출 위험)를 싣지 않고 영숫자 코드로 정규화한다. 종전에
 * ops-notification-delivery 와 integration-handoff-dispatch 가 폴백 상수만 다른 동일 구현을
 * 중복 보유 — 폴백을 매개변수화해 통합(동작 무변경).
 */
export function redactedErrorCode(reason: string, fallback: string): string {
  const normalized = reason
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return (normalized.length === 0 ? fallback : normalized).slice(0, 120);
}
