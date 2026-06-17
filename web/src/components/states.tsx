import { Inbox, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

// 빈/오류/로딩 상태 — HTML 콘솔 emptyState/errorState 이식. 조용한 빈화면 금지(상태를 명시).

// action: 빈 상태 안에서 직접 다음 행동으로 유도하는 CTA(예: '첫 자동화 만들기'). 권한 게이팅은 호출부 책임.
export function EmptyState({ message, action }: { message: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty-state" role="status">
      <div className="es-icon" aria-hidden="true">
        <Inbox size={18} />
      </div>
      <strong>{message}</strong>
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="error-state" role="alert">
      <div className="es-icon" aria-hidden="true">
        <AlertTriangle size={18} />
      </div>
      <strong>불러오지 못했습니다</strong>
      <span>{message}</span>
      {onRetry !== undefined && (
        <button className="btn" type="button" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

export function Loading(): JSX.Element {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      불러오는 중…
    </div>
  );
}
