import { Inbox, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { ApiError } from "../api/types";

// 빈/오류/로딩 상태 — HTML 콘솔 emptyState/errorState 이식. 조용한 빈화면 금지(상태를 명시).

// action: 빈 상태 안에서 직접 다음 행동으로 유도하는 CTA(예: '첫 자동화 만들기'). 권한 게이팅은 호출부 책임.
export function EmptyState({ title = "데이터 없음", message, action }: { title?: string; message: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty-state" role="status">
      <div className="es-icon" aria-hidden="true">
        <Inbox size={18} />
      </div>
      <strong>{title}</strong>
      <span>{message}</span>
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  );
}

export type DesktopStateKind = "api" | "permission" | "setup" | "failure";

export function desktopStateForError(error: unknown): { kind: DesktopStateKind; title: string; message: string; details: string } {
  if (error instanceof ApiError) {
    if (error.httpStatus === 401 || error.httpStatus === 403 || error.code === "AUTHZ_FORBIDDEN" || error.code === "UNAUTHENTICATED") {
      return {
        kind: "permission",
        title: "권한 확인 필요",
        message: "현재 역할로 이 데이터를 읽을 수 없습니다. 권한 있는 담당자에게 확인을 요청하세요.",
        details: technicalErrorDetails(error),
      };
    }
    if (error.httpStatus === 404 || error.code === "HTTP_404" || error.code === "RESOURCE_NOT_FOUND") {
      return {
        kind: "api",
        title: "API 연결 필요",
        message: "콘솔은 열렸지만 이 데이터의 API 응답을 확인하지 못했습니다. 로컬 API 서버 또는 라우팅 설정을 확인하세요.",
        details: technicalErrorDetails(error),
      };
    }
    if (error.httpStatus === 409 || error.httpStatus === 412 || error.httpStatus === 422) {
      return {
        kind: "setup",
        title: "설정 필요",
        message: "필요한 설정이나 입력 조건이 아직 맞지 않습니다. 세부 정보를 확인한 뒤 다시 시도하세요.",
        details: technicalErrorDetails(error),
      };
    }
    if (error.httpStatus >= 500 || error.code.includes("INTERNAL")) {
      return {
        kind: "failure",
        title: "운영 실패",
        message: "운영 데이터 처리 중 오류가 발생했습니다. 다시 시도하고, 반복되면 지원 담당자에게 세부 정보를 전달하세요.",
        details: technicalErrorDetails(error),
      };
    }
  }
  if (error instanceof TypeError) {
    return {
      kind: "api",
      title: "API 연결 필요",
      message: "브라우저에서 API 서버에 연결하지 못했습니다. 네트워크와 로컬 실행 상태를 확인하세요.",
      details: technicalErrorDetails(error),
    };
  }
  return {
    kind: "failure",
    title: "운영 실패",
    message: "요청을 처리하지 못했습니다. 다시 시도하고, 반복되면 지원 담당자에게 세부 정보를 전달하세요.",
    details: technicalErrorDetails(error),
  };
}

export function technicalErrorDetails(error: unknown): string {
  if (error instanceof ApiError) {
    return JSON.stringify(
      {
        httpStatus: error.httpStatus,
        code: error.code,
        message: error.body?.message ?? error.message,
        correlation_id: error.body?.correlation_id,
        details: error.body?.details,
      },
      null,
      2,
    );
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

export function ErrorState({
  title,
  message,
  details,
  onRetry,
}: {
  title?: string;
  message: string;
  details?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="error-state" role="alert">
      <div className="es-icon" aria-hidden="true">
        <AlertTriangle size={18} />
      </div>
      <strong>{title ?? "불러오지 못했습니다"}</strong>
      <span>{message}</span>
      {onRetry !== undefined && (
        <button className="btn" type="button" onClick={onRetry}>
          다시 시도
        </button>
      )}
      {details !== undefined && details.trim().length > 0 && (
        <details className="technical-details">
          <summary>admin/support details</summary>
          <pre>{details}</pre>
        </details>
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
