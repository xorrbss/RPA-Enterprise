import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";

import type { ListParams, Paginated } from "./types";

export interface Pager {
  readonly hasNext: boolean;
  readonly hasPrev: boolean;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly pageIndex: number;
}

export interface ListView<T> {
  readonly query: UseQueryResult<Paginated<T>>;
  readonly filter: ListParams;
  readonly setFilter: (f: ListParams) => void;
  readonly pager: Pager;
}

/**
 * 커서 페이지네이션 + 닫힌 enum 필터 상태 공용 훅. 모든 list 뷰가 동일 패턴을 쓴다.
 * - 필터 변경 시 첫 페이지로 리셋(스택 비움) — 일관 UX, 잘못된 커서×필터 조합 방지.
 * - keyset 커서는 백엔드가 발급(next_cursor). 뒤로가기는 커서 스택으로 구현.
 */
export function useListView<T>(
  baseKey: readonly unknown[],
  fetcher: (params: ListParams) => Promise<Paginated<T>>,
  opts: { refetchInterval?: number; limit?: number; initialFilter?: ListParams } = {},
): ListView<T> {
  // initialFilter: 딥링크(예: 대시보드 '실행 중' → #runTrace?status=running)로 진입 시 첫 필터를 시드(드릴다운 모집단 일치).
  const [filter, setFilterState] = useState<ListParams>(opts.initialFilter ?? {});
  const [stack, setStack] = useState<string[]>([]); // 커서 히스토리(top=현재 페이지)
  const cursor = stack[stack.length - 1];
  const query = useQuery({
    queryKey: [...baseKey, filter, cursor ?? "p0"],
    queryFn: () => fetcher({ limit: opts.limit ?? 50, ...filter, ...(cursor !== undefined ? { cursor } : {}) }),
    refetchInterval: opts.refetchInterval,
  });
  const nextCursor = query.data?.next_cursor ?? null;
  return {
    query,
    filter,
    setFilter: (f: ListParams) => {
      setFilterState(f);
      setStack([]); // 필터 변경 → 첫 페이지
    },
    pager: {
      hasNext: nextCursor !== null,
      hasPrev: stack.length > 0,
      onNext: () => {
        if (nextCursor !== null) setStack((s) => [...s, nextCursor]);
      },
      onPrev: () => setStack((s) => s.slice(0, -1)),
      pageIndex: stack.length,
    },
  };
}
