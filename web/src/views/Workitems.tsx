import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { SlideOver } from "../components/SlideOver";
import { StatusBadge, statusLabel } from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { mergeParams, navigate, useHashParam } from "../router";
import { WORKITEM_STATES } from "./filters";
import type { DeadLetterItem, WorkitemItem } from "../api/types";

const POLL_MS = 5_000;

export function WorkitemsView(): JSX.Element {
  const api = useApiClient();
  const wi = useListView<WorkitemItem>(["workitems"], (p) => api.listWorkitems(p), { refetchInterval: POLL_MS });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: POLL_MS });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: POLL_MS });
  // 선택 작업항목을 해시(`#workitems?wi=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(RunTrace 패턴 재사용).
  const sel = useHashParam("wi");
  const detail = useQuery({ queryKey: ["workitem-detail", sel], queryFn: () => api.getWorkitem(sel as string), enabled: sel !== null });

  return (
    <>
      {sel !== null && <WorkitemDetailPanel workitemId={sel} detail={detail} onClose={() => { mergeParams({ wi: null }); }} />}
      <QueryPanel<WorkitemItem>
        title="작업 목록"
        query={wi.query}
        pager={wi.pager}
        actions={<FilterSelect label="상태" value={wi.filter.status} options={WORKITEM_STATES} labelFor={statusLabel} onChange={(v) => wi.setFilter({ status: v })} />}
        rowKey={(r) => r.workitem_id}
        emptyMessage="조건에 맞는 작업 항목이 없습니다."
        columns={[
          { header: "참조", render: (r) => r.unique_reference },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "작업 ID", render: (r) => <code>{r.workitem_id.slice(0, 8)}</code> },
          {
            header: "작업",
            render: (r) => (
              <button className="btn" type="button" onClick={() => { mergeParams({ wi: r.workitem_id }); }}>
                상세
              </button>
            ),
          },
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
                confirmText="이 작업을 다시 처리 대기로 되돌릴까요?"
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

// 작업항목 상세 — getWorkitem(RLS 스코프). attempts/checked_out_by/checked_out_at/run_id는 mapWorkitem 실 투영(실측).
// run_id가 채워졌을 때만 '원본 실행 보기' 교차링크(null이면 버튼 미렌더 — 조용한 false 금지). RunDetailPanel 구조 복제.
function WorkitemDetailPanel({
  workitemId,
  detail,
  onClose,
}: {
  workitemId: string;
  detail: UseQueryResult<WorkitemItem>;
  onClose: () => void;
}): JSX.Element {
  return (
    <SlideOver title={`작업항목 상세 — ${workitemId.slice(0, 8)}`} onClose={onClose}>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState message="작업 항목을 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
      ) : detail.data !== undefined ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0 }}>
          <dt className="subtle">상태</dt>
          <dd style={{ margin: 0 }}>
            <StatusBadge status={detail.data.status} />
          </dd>
          <dt className="subtle">시도 횟수</dt>
          <dd style={{ margin: 0 }}>{detail.data.attempts}</dd>
          <dt className="subtle">점유자</dt>
          <dd style={{ margin: 0 }}>{detail.data.checked_out_by ?? "— (미점유)"}</dd>
          <dt className="subtle">점유 시각</dt>
          <dd style={{ margin: 0 }}>{detail.data.checked_out_at ?? "—"}</dd>
          <dt className="subtle">참조</dt>
          <dd style={{ margin: 0 }}>{detail.data.unique_reference}</dd>
          {detail.data.run_id !== null && (
            <>
              <dt className="subtle">원본 실행</dt>
              <dd style={{ margin: 0 }}>
                <button className="linklike" type="button" onClick={() => { navigate("runTrace", { run: detail.data!.run_id as string }); }}>
                  원본 실행 보기 <span aria-hidden="true">→</span>
                </button>
              </dd>
            </>
          )}
        </dl>
      ) : null}
    </SlideOver>
  );
}
