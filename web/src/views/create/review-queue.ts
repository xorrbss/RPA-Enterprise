import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useSubject } from "../../api/permissions";
import type { HumanTaskItem, Paginated } from "../../api/types";
import { kindLabel } from "../../components/badges";
import { isActiveHumanTask } from "../humanTaskFilters";

const POLL_MS = 5_000; // MyWork 관례(확인 큐 폴링 주기) 공유.

// 사람 개입 큐 카드의 제목 — payload 의 제목/title 이 있으면 그걸, 없으면 업무 종류로(날조 없이 실 데이터만).
export function taskTitle(t: HumanTaskItem): string {
  const p = t.payload;
  if (p !== null && typeof p === "object" && !Array.isArray(p)) {
    const rec = p as Record<string, unknown>;
    for (const k of ["제목", "title", "subject"]) {
      if (typeof rec[k] === "string" && (rec[k] as string).length > 0) return rec[k] as string;
    }
  }
  return kindLabel(t.kind);
}

// 인터프리터가 이미 순수 continue 신호(보안문자/추가 인증)와 구조화 검토를 가른다 — 여기선 목록 라벨만 구분.
export function isSimpleGate(kind: string): boolean {
  return kind === "captcha" || kind === "mfa";
}

export interface MyReviewQueue {
  readonly tasks: readonly HumanTaskItem[];
  readonly assigned: UseQueryResult<Paginated<HumanTaskItem>>;
  readonly unassigned: UseQueryResult<Paginated<HumanTaskItem>>;
}

// E1: 내 확인 큐(내게 배정 + 미배정 활성 업무 병합·중복 제거) — MyWork 큐 로직을 공용 훅으로 이관.
// 만들기 홈의 확인 스트립과 MyWork(R4 은퇴 전까지)가 같은 판정을 공유한다.
export function useMyReviewQueue(): MyReviewQueue {
  const api = useApiClient();
  const subject = useSubject();
  const assigned = useQuery({
    queryKey: ["my-work", "human-tasks", subject],
    queryFn: () =>
      subject !== null && subject.length > 0
        ? api.listHumanTasks({ assignee: subject, terminal: "false" })
        : Promise.resolve({ items: [], next_cursor: null }),
    refetchInterval: POLL_MS,
  });
  const unassigned = useQuery({
    queryKey: ["my-work", "human-tasks", "unassigned"],
    queryFn: () => api.listHumanTasks({ unassigned: true, terminal: "false" }),
    refetchInterval: POLL_MS,
  });
  const tasks = useMemo(() => {
    const byId = new Map<string, HumanTaskItem>();
    for (const task of [...(assigned.data?.items ?? []), ...(unassigned.data?.items ?? [])]) {
      if (isActiveHumanTask(task)) byId.set(task.human_task_id, task);
    }
    return [...byId.values()];
  }, [assigned.data, unassigned.data]);
  return { tasks, assigned, unassigned };
}
