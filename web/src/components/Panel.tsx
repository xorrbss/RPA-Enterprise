import type { ReactNode } from "react";

// 카드형 패널(제목/부제 + 본문) 단일 출처. OpenGate·Idempotency가 바이트-동일로 복제하던 로컬 Panel과
// Placeholder의 인라인 panel 변형을 통합한다(중복 제거 — 신규 추상화 아님, 기존 마크업 이전).
// right: 헤더 우측 슬롯(예: Placeholder의 '준비 중' 배지). subtitle과 right는 공존 케이스가 없어 분기 단순.
// 값을 생성·가공·추론하지 않고 props를 그대로 통과시킨다(카운트·사유·확신도 미생성 — 정직성 불변).
export function Panel({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h2>{title}</h2>
        {subtitle !== undefined && <span style={{ color: "var(--muted)", fontSize: 12 }}>{subtitle}</span>}
        {right !== undefined && right}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
