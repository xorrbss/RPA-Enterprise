import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { SlideOver } from "../components/SlideOver";
import { StatusBadge, statusLabel, errorCodeLabel } from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { mergeParams, navigate, useHashIdParam } from "../router";
import { WORKITEM_STATES } from "./filters";
import type { DeadLetterItem, WorkitemItem } from "../api/types";

const POLL_MS = 5_000;
const DLQ_REASON_LABELS: Record<string, string> = {
  VERIFY_FAILED: "검증 실패",
};

function trackingTitle(id: string): string {
  return `추적 번호 ${id}`;
}

// 추적번호 짧은 표기 — 호버(title)에만 숨기지 않고 가시 셀에 앞 8자리를 노출해
// 운영자가 호버 없이 항목을 구두/티켓으로 참조할 수 있게 한다(전체 번호는 title 유지).
function shortRef(id: string): string {
  return `#${id.slice(0, 8)}`;
}

function dedupeTrackingTitle(id: string): string {
  return `중복 방지 추적 번호 ${id}`;
}

function dlqReasonLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code.trim().length === 0) return "—";
  return DLQ_REASON_LABELS[code] ?? errorCodeLabel(code);
}

export function WorkitemsView(): JSX.Element {
  const api = useApiClient();
  const wi = useListView<WorkitemItem>(["workitems"], (p) => api.listWorkitems(p), { refetchInterval: POLL_MS });
  // DLQ 두 소스도 작업항목 표와 동일하게 페이저 부착(useListView) — 51건째부터 조용히 누락되던 것 해소(백엔드 keyset 커서 재사용).
  const wiDlq = useListView<DeadLetterItem>(["dlq", "workitem"], (p) => api.listDlq("workitem", p), { refetchInterval: POLL_MS });
  const sinkDlq = useListView<DeadLetterItem>(["dlq", "sink"], (p) => api.listDlq("sink", p), { refetchInterval: POLL_MS });
  const wiDlqItems = wiDlq.query.data?.items ?? [];
  const sinkDlqItems = sinkDlq.query.data?.items ?? [];
  // 선택 작업항목을 해시(`#workitems?wi=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(RunTrace 패턴 재사용).
  const sel = useHashIdParam("wi");
  const detail = useQuery({ queryKey: ["workitem-detail", sel], queryFn: () => api.getWorkitem(sel as string), enabled: sel !== null });

  return (
    <>
      {sel !== null && <WorkitemDetailPanel detail={detail} onClose={() => { mergeParams({ wi: null }); }} />}
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
          { header: "작업 항목", render: (r) => <span title={trackingTitle(r.workitem_id)}>작업 항목</span> },
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
        title="작업 항목 재처리 대기"
        query={wiDlq.query}
        pager={wiDlq.pager}
        actions={
          wiDlqItems.length > 0 ? (
            <ActionButton
              label="전체 일괄 재처리"
              action="dlq.replay"
              confirmText="재처리 대기 중인 작업 항목을 다시 처리 대기로 되돌릴까요? (현재 페이지 너머 적격 전체)"
              run={async (key) => {
                // 서버측 일괄(현재 페이지 50건 한도 없이 적격 전체, 캡 500). 충돌(이미 처리/진행)·절단은 표면화(조용한 실패 금지).
                const r = await api.replayAllDlq("workitem", key);
                const parts = [`${r.replayed}건 재처리됨`];
                if (r.conflicts > 0) parts.push(`${r.conflicts}건은 이미 처리/진행 중`);
                if (r.truncated) parts.push("500건 초과분은 다시 눌러 계속");
                if (r.conflicts > 0 || r.truncated) throw new Error(parts.join(" · "));
              }}
              successText="전체 재처리 요청됨"
              invalidateKeys={[["dlq", "workitem"], ["workitems"]]}
            />
          ) : undefined
        }
        rowKey={(r) => r.dead_letter_id}
        emptyMessage="재처리 대기 중인 작업 항목이 없습니다."
        columns={[
          { header: "실패 항목", render: (r) => <span title={trackingTitle(r.dead_letter_id)}>작업 항목 재처리 대기 <code>{shortRef(r.dead_letter_id)}</code></span> },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "원본 작업", render: (r) => (r.source_id ? <span title={trackingTitle(r.source_id)}>원본 작업 연결됨</span> : "—") },
          // reason_code는 운영자 라벨 우선 표시, 원문 코드는 title로 보존한다. 부재 시 "—"(조용한 공백 금지).
          { header: "사유", render: (r) => <span title={r.reason_code ?? undefined}>{dlqReasonLabel(r.reason_code)}</span> },
          { header: "발생", render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "—") },
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
        title="외부 전달 재시도 대상"
        query={sinkDlq.query}
        pager={sinkDlq.pager}
        actions={
          sinkDlqItems.length > 0 ? (
            <ActionButton
              label="전체 일괄 재처리"
              action="sink_dlq.replay"
              confirmText="재처리 대기 중인 외부 전달 실패를 재시도할까요? (현재 페이지 너머 적격 전체)"
              run={async (key) => {
                const r = await api.replayAllDlq("sink", key);
                const parts = [`${r.replayed}건 재시도 요청됨`];
                if (r.conflicts > 0) parts.push(`${r.conflicts}건은 이미 처리됨`);
                if (r.truncated) parts.push("500건 초과분은 다시 눌러 계속");
                if (r.conflicts > 0 || r.truncated) throw new Error(parts.join(" · "));
              }}
              successText="전체 재시도 요청됨"
              invalidateKeys={[["dlq", "sink"]]}
            />
          ) : undefined
        }
        rowKey={(r) => r.dead_letter_id}
        emptyMessage="재처리 대기 중인 외부 전달 실패가 없습니다."
        columns={[
          { header: "전달 실패", render: (r) => <span title={trackingTitle(r.dead_letter_id)}>외부 전달 재시도 대상 <code>{shortRef(r.dead_letter_id)}</code></span> },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "중복 방지", render: (r) => (r.sink_idempotency_key ? <span title={dedupeTrackingTitle(r.sink_idempotency_key)}>중복 방지 적용됨</span> : "적용되지 않음") },
          {
            header: "작업",
            render: (r) => (
              <ActionButton
                label="재처리"
                action="sink_dlq.replay"
                confirmText="이 외부 전달 실패를 재시도할까요?"
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
  detail,
  onClose,
}: {
  detail: UseQueryResult<WorkitemItem>;
  onClose: () => void;
}): JSX.Element {
  return (
    <SlideOver title="작업항목 상세" onClose={onClose}>
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
          <dt className="subtle">처리 담당</dt>
          <dd style={{ margin: 0 }}>{detail.data.checked_out_by ?? "— (미점유)"}</dd>
          <dt className="subtle">처리 시작 시각</dt>
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
