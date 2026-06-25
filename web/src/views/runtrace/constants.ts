import { tone, type Tone } from "../../components/badges";

export const POLL_MS = 5_000; // 실행 목록/상세 fallback 재조회 간격.
export const TERMINAL = new Set([
  "completed",
  "cancelled",
  "failed_business",
  "failed_system",
]);
export const HUMAN_TASK_TERMINAL = new Set(["resolved", "expired", "cancelled"]);
// '사람 확인 대기'가 확실한 비-터미널 status만(state-machine). StatusBadge가 suspended를 '사람 확인 대기'로 라벨링하는 것과 정합.
// suspending은 bookmark 저장 중 전이 상태(R11→suspended / R12→failed_system, 미정착)라 StatusBadge가 '보류 중'으로 라벨링하므로
// 배너의 '대기 중'과 어휘가 충돌 + '대기' 단정이 한 발 앞선다 → 제외(suspended 단일 게이팅 = 배지와 동일 출처 정합).
// resume_requested/resuming도 이미 resolve 진행 중이라 '대기' 단정이 과해 제외(보수적 게이팅).
export const SUSPENDED = new Set(["suspended"]);

export function runDetailRefetchInterval(
  status: string | undefined,
): number | false {
  return status !== undefined && TERMINAL.has(status) ? false : POLL_MS;
}

// F3 터미널 '도착' 톤 — 터미널 여부는 TERMINAL Set 단일 출처가 게이팅하고(비-터미널이면 null = 배너 없음),
// 색은 badges.tone()에 위임해 도착 배너 배경과 내부 StatusBadge 색이 한 출처에서 항상 일치하게 한다(DRY·드리프트 방지).
// (completed=green, 실패=red, cancelled=muted; 어휘 체인 abort→cancelled. 비-터미널 null = 조용한 false 금지.)
export function arrivalTone(status: string): Tone | null {
  return TERMINAL.has(status) ? tone(status) : null;
}
