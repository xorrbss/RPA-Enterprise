// 아직 read 백엔드가 없거나 D7.2+ 워크플로우 대상인 뷰의 정직한 자리표시(빈화면 위장 금지).
export function PlaceholderView({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="badge muted">준비 중</span>
      </div>
      <div className="panel-body" style={{ padding: 16, color: "var(--muted)" }}>
        {note}
      </div>
    </section>
  );
}
