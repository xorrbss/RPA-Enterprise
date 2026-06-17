import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ApiError } from "../api/types";
import { COLLECT_SCENARIO_NAME, APPROVAL_ARTIFACT_TYPE, parseApprovalRows, summarize } from "../api/approval-inbox";
import { StatusBadge } from "../components/badges";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { ApprovalRow } from "../api/types";

const POLL_MS = 10_000;

// 결재 인박스 — '하이웍스 결재 수집' run이 남긴 아티팩트(결재 목록)를 읽어 구조화 요약 + 목록 표시(읽기 전용).
// 발견 경로: listScenarios(이름 매칭) → listRuns(scenario_version_id, completed) 최신 → listRunArtifacts → getArtifact.
// 건별 승인/반려 버튼은 Phase 2에서 추가(approver-게이트 결재 run). 여기까지는 부작용 없음.
export function ApprovalInboxView(): JSX.Element {
  const api = useApiClient();

  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }) });
  const collect = scenarios.data?.items.find((s) => s.name === COLLECT_SCENARIO_NAME);

  const runs = useQuery({
    queryKey: ["runs", "collect", collect?.latest_version_id ?? ""],
    queryFn: () => api.listRuns({ scenario_version_id: collect!.latest_version_id, status: "completed", limit: 1 }),
    enabled: collect !== undefined,
    refetchInterval: POLL_MS,
  });
  const latestRun = runs.data?.items[0];

  const arts = useQuery({
    queryKey: ["run-artifacts", latestRun?.run_id ?? ""],
    queryFn: () => api.listRunArtifacts(latestRun!.run_id, { limit: 50 }),
    enabled: latestRun !== undefined,
  });
  const inboxArt = arts.data?.items.find((a) => a.type === APPROVAL_ARTIFACT_TYPE) ?? arts.data?.items[0];

  const detail = useQuery({
    queryKey: ["artifact", inboxArt?.artifact_id ?? ""],
    queryFn: () => api.getArtifact(inboxArt!.artifact_id),
    enabled: inboxArt !== undefined,
    retry: false,
  });

  const recollect = collect !== undefined ? <RunScenarioButton scenario={collect} /> : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <p className="subtle" style={{ margin: 0 }}>
          최근 수집된 하이웍스 결재 목록입니다{latestRun?.as_of ? ` · 기준 ${latestRun.as_of}` : ""}. 건별 승인/반려는 다음 단계에서 제공됩니다.
        </p>
        {recollect}
      </div>
      <Body
        scenarios={scenarios}
        collect={collect}
        runs={runs}
        latestRun={latestRun}
        arts={arts}
        inboxArt={inboxArt}
        detail={detail}
      />
    </div>
  );
}

type Q = { isLoading: boolean; isError: boolean; refetch: () => unknown };

function Body(props: {
  scenarios: Q;
  collect: { scenario_id: string } | undefined;
  runs: Q;
  latestRun: { run_id: string } | undefined;
  arts: Q;
  inboxArt: { artifact_id: string } | undefined;
  detail: Q & { data?: { content: string } };
}): JSX.Element {
  const { scenarios, collect, runs, latestRun, arts, inboxArt, detail } = props;

  if (scenarios.isLoading) return <Loading />;
  if (scenarios.isError) return <ErrorState message="시나리오 목록을 불러오지 못했습니다." onRetry={() => void scenarios.refetch()} />;
  if (collect === undefined) {
    return <EmptyState message={`'${COLLECT_SCENARIO_NAME}' 시나리오가 아직 없습니다. 자동화 만들기에서 등록하세요.`} />;
  }
  if (runs.isLoading) return <Loading />;
  if (runs.isError) return <ErrorState message="수집 실행 기록을 불러오지 못했습니다." onRetry={() => void runs.refetch()} />;
  if (latestRun === undefined) {
    return <EmptyState message="아직 수집된 결재가 없습니다. 위 ‘실행’으로 결재 수집을 시작하세요." />;
  }
  if (arts.isLoading || detail.isLoading) return <Loading />;
  if (arts.isError) return <ErrorState message="수집 산출물 목록을 불러오지 못했습니다." onRetry={() => void arts.refetch()} />;
  if (inboxArt === undefined) {
    return <EmptyState message="수집 실행은 끝났지만 결재 목록 산출물이 없습니다." />;
  }
  if (detail.isError) {
    const e = (detail as { error?: unknown }).error;
    const msg = e instanceof ApiError && e.code === "RESOURCE_NOT_FOUND"
      ? "결재 목록이 아직 준비(redaction)되지 않았거나 조회 권한이 없습니다."
      : "결재 목록 본문을 불러오지 못했습니다.";
    return <ErrorState message={msg} onRetry={() => void detail.refetch()} />;
  }
  if (detail.data === undefined) return <Loading />;

  let rows: ApprovalRow[];
  try {
    rows = parseApprovalRows(detail.data.content);
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : "결재 목록을 해석하지 못했습니다."} />;
  }
  if (rows.length === 0) return <EmptyState message="수집된 결재 항목이 없습니다." />;

  return <Inbox rows={rows} />;
}

function Inbox({ rows }: { rows: readonly ApprovalRow[] }): JSX.Element {
  const sum = summarize(rows);
  return (
    <>
      <section className="panel" style={{ padding: 16, marginBottom: 16 }} aria-label="결재 요약">
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>결재 {sum.total}건</div>
        <Chips label="상태" entries={sum.byStatus} />
        <Chips label="유형" entries={sum.byType} />
      </section>
      <section className="panel" aria-label="결재 목록">
        <div className="panel-head"><h2>결재 목록</h2></div>
        <div className="panel-body">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>기안자</th><th>유형</th><th>제목</th><th>상태</th><th>기안일</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.approval_id ?? r.doc_ref}>
                    <td>{r.drafter}</td>
                    <td>{r.doc_type}</td>
                    <td>{r.title}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{r.drafted_at ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

function Chips({ label, entries }: { label: string; entries: ReadonlyArray<readonly [string, number]> }): JSX.Element {
  return (
    <div className="step-line" style={{ marginTop: 4 }}>
      <span className="subtle" style={{ minWidth: 32 }}>{label}</span>
      {entries.map(([k, n]) => (
        <span key={k} className="badge muted">{k} {n}</span>
      ))}
    </div>
  );
}
