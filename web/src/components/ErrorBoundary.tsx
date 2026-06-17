import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// 렌더 예외를 잡아 백지 대신 오류 상태를 표시한다 — 데이터 계층의 ErrorState와 같은 "조용한 빈화면 금지" 원칙을
// 렌더 계층에 적용. App에서 view 단위 key를 주면 다른 화면으로 이동 시 경계가 remount되어 오류가 초기화된다.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 운영 로깅 훅은 후속 — 우선 콘솔에 표면화(은폐 금지).
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return (
        <div className="error-state" role="alert" style={{ minHeight: "50vh", justifyContent: "center" }}>
          <div className="es-icon" aria-hidden="true">!</div>
          <strong>화면을 표시하지 못했습니다</strong>
          <p className="subtle" style={{ margin: 0 }}>{error.message.length > 0 ? error.message : "알 수 없는 렌더 오류"}</p>
          <button className="btn" type="button" onClick={() => location.reload()}>
            새로고침
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
