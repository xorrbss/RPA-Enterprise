import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge } from "../components/badges";
import { RUN_STATES } from "./filters";
import type { RunItem } from "../api/types";

const POLL_MS = 5_000; // 실시간 = outbox tail 폴링(v1)
const TERMINAL = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

export function RunTraceView(): JSX.Element {
  const api = useApiClient();
  const lv = useListView<RunItem>(["runs"], (p) => api.listRuns(p), { refetchInterval: POLL_MS });
  return (
    <QueryPanel<RunItem>
      title="실행 기록"
      query={lv.query}
      pager={lv.pager}
      actions={<FilterSelect label="상태" value={lv.filter.status} options={RUN_STATES} onChange={(v) => lv.setFilter({ status: v })} />}
      rowKey={(r) => r.run_id}
      emptyMessage="조건에 맞는 실행 기록이 없습니다."
      columns={[
        { header: "실행 ID", render: (r) => <code>{r.run_id.slice(0, 8)}</code> },
        { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
        { header: "현재 노드", render: (r) => r.current_node ?? "—" },
        { header: "기준 시각", render: (r) => r.as_of ?? "—" },
        {
          header: "작업",
          render: (r) =>
            TERMINAL.has(r.status) ? (
              "—"
            ) : (
              <ActionButton
                label="취소"
                confirmText={`실행 ${r.run_id.slice(0, 8)}을(를) 취소할까요? (abort→cancelled)`}
                run={(key) => api.abortRun(r.run_id, key)}
                invalidateKeys={[["runs"]]}
              />
            ),
        },
      ]}
    />
  );
}
