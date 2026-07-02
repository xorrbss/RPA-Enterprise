import type { ReactNode } from "react";

import { EmptyState, ErrorState, desktopStateForError, type DesktopStateKind } from "./states";

export interface DashboardEnvironmentError {
  readonly label: string;
  readonly error: unknown;
  readonly onRetry?: () => void;
}

export function environmentErrorKind(errors: readonly DashboardEnvironmentError[]): DesktopStateKind | null {
  const first = errors[0];
  return first === undefined ? null : desktopStateForError(first.error).kind;
}

export function DashboardEnvironmentState(props: {
  readonly errors: readonly DashboardEnvironmentError[];
  readonly isEmptyTenant?: boolean;
  readonly emptyTitle?: string;
  readonly emptyMessage?: string;
  readonly emptyAction?: ReactNode;
}): JSX.Element | null {
  if (props.errors.length > 0) {
    const first = props.errors[0]!;
    const state = desktopStateForError(first.error);
    return (
      <ErrorState
        title={state.title}
        message={`${first.label} 데이터를 확인하지 못했습니다. ${props.errors.length > 1 ? `${props.errors.length}개 영역에서 확인이 필요합니다. ` : ""}${state.message}`}
        details={state.details}
        onRetry={first.onRetry}
      />
    );
  }
  if (props.isEmptyTenant === true) {
    return (
      <EmptyState
        title={props.emptyTitle ?? "첫 실행 전"}
        message={props.emptyMessage ?? "아직 실행 기록이 없습니다. 첫 자동화 초안과 테스트 실행을 준비해보세요."}
        action={props.emptyAction}
      />
    );
  }
  return null;
}
