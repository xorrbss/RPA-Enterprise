import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import type { HumanTaskItem } from "../api/types";

export function HumanTasksView(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["human-tasks"],
    queryFn: () => api.listHumanTasks({ limit: 50 }),
    refetchInterval: 5_000,
  });
  return (
    <QueryPanel<HumanTaskItem>
      title="사람 확인 인박스"
      query={query}
      rowKey={(r) => r.human_task_id}
      emptyMessage="대기 중인 사람 확인 업무가 없습니다."
      columns={[
        { header: "종류", render: (r) => r.kind },
        { header: "상태", render: (r) => <StatusBadge status={r.state} /> },
        { header: "담당자", render: (r) => (r.assignee ? <code>{r.assignee.slice(0, 8)}</code> : "미배정") },
        { header: "마감", render: (r) => r.timeout ?? "—" },
      ]}
    />
  );
}
