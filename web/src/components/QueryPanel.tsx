import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, Loading } from "./states";
import { ApiError } from "../api/types";
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
  emptyMessage: string;
  actions?: ReactNode;
  pager?: Pager;
}): JSX.Element {
  const { title, query, columns, rowKey, emptyMessage, actions, pager } = props;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>{actions}</span>
      </div>
      <div className="panel-body">
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <EmptyState message={emptyMessage} />
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

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}${err.httpStatus ? ` (${err.httpStatus})` : ""}`;
  return err instanceof Error ? err.message : "알 수 없는 오류";
}
