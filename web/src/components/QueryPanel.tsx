import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, Loading, desktopStateForError, type DesktopStateKind } from "./states";
import type { Pager } from "../api/useListView";

export interface Column<T> {
  readonly header: string;
  readonly render: (row: T) => ReactNode;
}

/** read 쿼리 → 로딩/오류/빈 상태 + 테이블. 모든 list 뷰 공용(조용한 빈화면 금지). */
export function QueryPanel<T>(props: {
  title: string;
  query: UseQueryResult<{ items: readonly T[]; next_cursor: string | null }>;
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  emptyTitle?: string;
  emptyMessage: string;
  emptyAction?: ReactNode;
  actions?: ReactNode;
  pager?: Pager;
  collapsedErrorKind?: DesktopStateKind | null;
}): JSX.Element {
  const { title, query, columns, rowKey, emptyTitle, emptyMessage, emptyAction, actions, pager, collapsedErrorKind } = props;
  const errorState = query.isError ? desktopStateForError(query.error) : null;
  const collapseError = errorState !== null && collapsedErrorKind === errorState.kind;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>{actions}</span>
      </div>
      <div className="panel-body">
        {query.isLoading ? (
          <Loading />
        ) : query.isError && collapseError ? (
          <p className="form-alert red" role="alert">
            {title} 데이터를 확인하지 못했습니다. 위의 오류 요약을 확인하거나{" "}
            <button className="linklike" type="button" onClick={() => void query.refetch()}>
              다시 시도
            </button>
            하세요.
          </p>
        ) : query.isError ? (
          <ErrorState
            title={errorState?.title}
            message={`${title} 데이터를 확인하지 못했습니다. ${errorState?.message ?? ""}`}
            details={errorState?.details}
            onRetry={() => void query.refetch()}
          />
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.header}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(query.data?.items ?? []).map((row) => (
                  <tr key={rowKey(row)}>
                    {columns.map((c) => (
                      <td key={c.header}>{c.render(row)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pager !== undefined && (pager.hasPrev || pager.hasNext) && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", alignItems: "center" }}>
            <button className="btn" type="button" onClick={pager.onPrev} disabled={!pager.hasPrev}>
              이전
            </button>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{pager.pageIndex + 1} 페이지</span>
            <button className="btn" type="button" onClick={pager.onNext} disabled={!pager.hasNext}>
              다음
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
