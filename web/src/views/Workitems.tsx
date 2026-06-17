import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge } from "../components/badges";
import { WORKITEM_STATES } from "./filters";
import type { DeadLetterItem, WorkitemItem } from "../api/types";

const POLL_MS = 5_000;

export function WorkitemsView(): JSX.Element {
  const api = useApiClient();
  const wi = useListView<WorkitemItem>(["workitems"], (p) => api.listWorkitems(p), { refetchInterval: POLL_MS });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: POLL_MS });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: POLL_MS });

  return (
    <>
      <QueryPanel<WorkitemItem>
        title="작업 목록"
        query={wi.query}
        pager={wi.pager}
        actions={<FilterSelect label="상태" value={wi.filter.status} options={WORKITEM_STATES} onChange={(v) => wi.setFilter({ status: v })} />}
        rowKey={(r) => r.workitem_id}
        emptyMessage="조건에 맞는 작업 항목이 없습니다."
        columns={[
          { header: "참조", render: (r) => r.unique_reference },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "작업 ID", render: (r) => <code>{r.workitem_id.slice(0, 8)}</code> },
        ]}
      />
      <QueryPanel<DeadLetterItem>
        title="데드레터 — 작업항목(W5/W7)"
        query={wiDlq}
        rowKey={(r) => r.dead_letter_id}
        emptyMessage="작업항목 데드레터가 없습니다."
        columns={[
          { header: "DLQ ID", render: (r) => <code>{r.dead_letter_id.slice(0, 8)}</code> },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "원본", render: (r) => (r.source_id ? <code>{r.source_id.slice(0, 8)}</code> : "—") },
          {
            header: "작업",
            render: (r) => (
              <ActionButton
                label="재처리"
                action="dlq.replay"
                confirmText="이 작업항목을 재처리(W10: abandoned→new)할까요?"
                run={(key) => api.replayDeadLetter(r.dead_letter_id, key, "workitem")}
                invalidateKeys={[["dlq", "workitem"], ["workitems"]]}
              />
            ),
          },
        ]}
      />
      <QueryPanel<DeadLetterItem>
        title="데드레터 — 외부 전달(sink)"
        query={sinkDlq}
        rowKey={(r) => r.dead_letter_id}
        emptyMessage="외부 전달 데드레터가 없습니다."
        columns={[
          { header: "전달 ID", render: (r) => <code>{r.dead_letter_id.slice(0, 8)}</code> },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "멱등키", render: (r) => <code>{r.sink_idempotency_key ?? "—"}</code> },
          {
            header: "작업",
            render: (r) => (
              <ActionButton
                label="재처리"
                action="sink_dlq.replay"
                confirmText="이 외부 전달 실패를 재처리(sink delivery 재시도)할까요?"
                run={(key) => api.replayDeadLetter(r.dead_letter_id, key, "sink")}
                invalidateKeys={[["dlq", "sink"]]}
              />
            ),
          },
        ]}
      />
    </>
  );
}
