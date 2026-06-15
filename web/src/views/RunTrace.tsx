import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import type { RunItem } from "../api/types";

const POLL_MS = 5_000; // 실시간 = outbox tail 폴링(v1)

export function RunTraceView(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns({ limit: 50 }),
    refetchInterval: POLL_MS,
  });
  return (
    <QueryPanel<RunItem>
      title="실행 기록"
      query={query}
      rowKey={(r) => r.run_id}
      emptyMessage="아직 실행 기록이 없습니다."
      columns={[
        { header: "실행 ID", render: (r) => <code>{r.run_id.slice(0, 8)}</code> },
        { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
        { header: "현재 노드", render: (r) => r.current_node ?? "—" },
        { header: "기준 시각", render: (r) => r.as_of ?? "—" },
      ]}
    />
  );
}
