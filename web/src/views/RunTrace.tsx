import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { ArtifactLookup } from "../components/ArtifactLookup";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge } from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { RUN_STATES } from "./filters";
import { useHashParam } from "../router";
import type { RunDetail, RunItem } from "../api/types";

const POLL_MS = 5_000; // 실시간 = outbox tail 폴링(v1)
const TERMINAL = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

export function RunTraceView(): JSX.Element {
  const api = useApiClient();
  const lv = useListView<RunItem>(["runs"], (p) => api.listRuns(p), { refetchInterval: POLL_MS });
  // 선택 run을 해시(`#runTrace?run=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(useState 휘발 대체).
  const sel = useHashParam("run");
  const detail = useQuery({ queryKey: ["run-detail", sel], queryFn: () => api.getRun(sel as string), enabled: sel !== null });

  return (
    <div>
      <ArtifactLookup />
      {sel !== null && <RunDetailPanel runId={sel} detail={detail} onClose={() => { location.hash = "#runTrace"; }} />}
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
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <button className="btn" type="button" onClick={() => { location.hash = `#runTrace?run=${r.run_id}`; }}>
                  상세
                </button>
                {!TERMINAL.has(r.status) && (
                  <ActionButton
                    label="취소"
                    action="run.abort"
                    confirmText={`실행 ${r.run_id.slice(0, 8)}을(를) 취소할까요? (abort→cancelled)`}
                    run={(key) => api.abortRun(r.run_id, key)}
                    invalidateKeys={[["runs"]]}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}

// 실행 상세 — getRun(RLS 스코프). 진행 노드/단계 트레이스는 run_steps read 노출 시 후속.
function RunDetailPanel({
  runId,
  detail,
  onClose,
}: {
  runId: string;
  detail: UseQueryResult<RunDetail>;
  onClose: () => void;
}): JSX.Element {
  return (
    <section className="panel" style={{ marginBottom: 16, padding: 16 }} aria-label="실행 상세">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>실행 상세 — {runId.slice(0, 8)}</strong>
        <button className="btn" type="button" onClick={onClose}>
          닫기
        </button>
      </header>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState message="실행을 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
      ) : detail.data !== undefined ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0 }}>
          <dt className="subtle">상태</dt>
          <dd style={{ margin: 0 }}>
            <StatusBadge status={detail.data.status} />
          </dd>
          <dt className="subtle">워커</dt>
          <dd style={{ margin: 0 }}>{detail.data.worker_id ?? "— (미할당)"}</dd>
          <dt className="subtle">시도 횟수</dt>
          <dd style={{ margin: 0 }}>{detail.data.attempts}</dd>
          <dt className="subtle">기준 시각(as_of)</dt>
          <dd style={{ margin: 0 }}>{detail.data.as_of ?? "—"}</dd>
        </dl>
      ) : null}
    </section>
  );
}
