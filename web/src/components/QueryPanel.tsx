import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, Loading } from "./states";
import { ApiError } from "../api/types";

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
  emptyMessage: string;
  actions?: ReactNode;
}): JSX.Element {
  const { title, query, columns, rowKey, emptyMessage, actions } = props;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {actions}
      </div>
      <div className="panel-body">
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
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
        )}
      </div>
    </section>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}${err.httpStatus ? ` (${err.httpStatus})` : ""}`;
  return err instanceof Error ? err.message : "알 수 없는 오류";
}
