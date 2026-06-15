import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import type { RunItem } from "../api/types";

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function DashboardView(): JSX.Element {
  const api = useApiClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns({ limit: 50 }), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 5_000 });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: 5_000 });

  const count = (n?: number): string => (n === undefined ? "—" : n >= 50 ? "50+" : String(n));
  const runningCount = (runs.data?.items ?? []).filter((r) => r.status === "running").length;

  return (
    <>
      <div className="metrics">
        <Metric label="실행 중" value={count(runningCount)} />
        <Metric label="사람 확인 대기" value={count(human.data?.items.length)} />
        <Metric label="작업항목 DLQ" value={count(wiDlq.data?.items.length)} />
        <Metric label="외부 전달 DLQ" value={count(sinkDlq.data?.items.length)} />
      </div>
      <QueryPanel<RunItem>
        title="최근 실행"
        query={runs}
        rowKey={(r) => r.run_id}
        emptyMessage="아직 실행이 없습니다."
        columns={[
          { header: "실행 ID", render: (r) => <code>{r.run_id.slice(0, 8)}</code> },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "현재 노드", render: (r) => r.current_node ?? "—" },
        ]}
      />
    </>
  );
}
