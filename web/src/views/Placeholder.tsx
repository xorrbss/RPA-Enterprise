import { Panel } from "../components/Panel";

// 아직 read 백엔드가 없거나 D7.2+ 워크플로우 대상인 뷰의 정직한 자리표시(빈화면 위장 금지).
// '준비 중' 배지(백엔드 미연결을 위장하지 않는 정직성 표식)는 Panel right 슬롯으로 보존.
export function PlaceholderView({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <Panel title={title} right={<span className="badge muted">준비 중</span>}>
      <div style={{ padding: 16, color: "var(--muted)" }}>{note}</div>
    </Panel>
  );
}
