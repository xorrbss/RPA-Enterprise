// 시각 포매터 — Freshness(전역 라이브 표시)와 StepTrace(트레이스-로컬 갱신)에서 공유(DRY).
// HH:MM:SS 로컬 시각만 — 추정/창작 없이 관찰된 타임스탬프(예: react-query dataUpdatedAt)를 사람이 읽는 형태로.
export function hhmmss(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
