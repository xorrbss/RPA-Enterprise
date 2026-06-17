import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import type { RunItem } from "../api/types";

// 지표 카드 — 클릭 시 해당 목록 화면으로 드릴다운(죽은 대시보드 → 진입점). 카드 자체가 버튼이라 키보드 포커스/Enter 동작.
// hash로 직접 이동(상태 필터 딥링크 포함) — '실행 중'은 #runTrace?status=running으로 카운트와 목록 모집단을 일치.
function Metric({ label, value, hash, hint }: { label: string; value: string; hash: string; hint: string }): JSX.Element {
  return (
    <button type="button" className="metric metric-link" onClick={() => { location.hash = hash; }}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <span className="metric-hint subtle">{hint} <span aria-hidden="true">→</span></span>
    </button>
  );
}

// 카운트 표기(조용한 false 금지): 서버 집계 엔드포인트가 없어 카운트는 '최신 50건' 페이지 기준이다.
// next_cursor가 있으면(=더 있음) `N+`(≥N 하한)로, 없으면 정확한 N으로 표기 — 페이지 길이를 총계처럼 보이지 않게 한다.
function pageCount(d: { items: readonly unknown[]; next_cursor: string | null } | undefined): string {
  if (d === undefined) return "—";
  return d.next_cursor !== null ? `${d.items.length}+` : String(d.items.length);
}

export function DashboardView(): JSX.Element {
  const api = useApiClient();
  // '실행 중'은 서버 status 필터로 정확히 집계(이전: 전체 50건을 클라에서 status==='running' 필터 → 50건 초과 시 구조적 오집계).
  const running = useQuery({ queryKey: ["runs", "running"], queryFn: () => api.listRuns({ status: "running", limit: 50 }), refetchInterval: 5_000 });
  const recent = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns({ limit: 50 }), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 5_000 });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: 5_000 });

  return (
    <>
      <div className="metrics">
        <Metric label="실행 중" value={pageCount(running.data)} hash="#runTrace?status=running" hint="실행 기록" />
        <Metric label="사람 확인 대기" value={pageCount(human.data)} hash="#humanTasks" hint="사람 확인" />
        <Metric label="작업항목 DLQ" value={pageCount(wiDlq.data)} hash="#workitems" hint="작업 목록" />
        <Metric label="외부 전달 DLQ" value={pageCount(sinkDlq.data)} hash="#workitems" hint="작업 목록" />
      </div>
      <p className="subtle" style={{ margin: "0 2px" }}>
        각 지표는 최신 50건 기준입니다. <strong>+</strong>는 표시 한도를 넘겨 더 있음을 뜻합니다(예: <code>50+</code> = 50건 이상).
      </p>
      <QueryPanel<RunItem>
        title="최근 실행"
        query={recent}
        rowKey={(r) => r.run_id}
        emptyMessage="아직 실행이 없습니다."
        columns={[
          {
            header: "실행 ID",
            render: (r) => (
              <button
                type="button"
                className="linklike"
                aria-label={`실행 ${r.run_id.slice(0, 8)} 상세 보기`}
                title="실행 상세 보기"
                onClick={() => { location.hash = `#runTrace?run=${r.run_id}`; }}
              >
                <code>{r.run_id.slice(0, 8)}</code>
              </button>
            ),
          },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { header: "현재 노드", render: (r) => r.current_node ?? "—" },
        ]}
      />
    </>
  );
}
