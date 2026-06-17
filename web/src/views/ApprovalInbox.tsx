import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError } from "../api/types";
import { COLLECT_SCENARIO_NAME, APPROVAL_ARTIFACT_TYPE, parseApprovalRows, summarize } from "../api/approval-inbox";
import { StatusBadge } from "../components/badges";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { ApprovalRow, RunDetail } from "../api/types";

// 결재 처리 run 의 종결 상태(폴링 중단 기준). state-machine §1.
const RUN_TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

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
  // latestRun 은 위 가드(latestRun===undefined → EmptyState)에서 이미 좁혀져 여기선 항상 정의됨.
  return <Inbox rows={rows} sourceRunId={latestRun.run_id} />;
}

function Inbox({ rows, sourceRunId }: { rows: readonly ApprovalRow[]; sourceRunId: string }): JSX.Element {
  const sum = summarize(rows);
  const can = useCan();
  const showActions = can("approval.decide"); // 비-approver 는 액션 열 숨김(백엔드가 최종 강제).
  // 이번 세션에서 결재한 문서 → 스폰된 처리 run id. 결정된 행은 버튼 대신 처리 상태(폴링)를 보인다.
  const [decided, setDecided] = useState<Record<string, string>>({});
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
                <tr>
                  <th>기안자</th><th>유형</th><th>제목</th><th>상태</th><th>기안일</th>
                  {showActions && <th>결재</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const spawnedRunId = decided[r.doc_ref];
                  return (
                    <tr key={r.approval_id ?? r.doc_ref}>
                      <td>{r.drafter}</td>
                      <td>{r.doc_type}</td>
                      <td>{r.title}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{r.drafted_at ?? "—"}</td>
                      {showActions && (
                        <td>
                          {spawnedRunId !== undefined ? (
                            <DecidedStatus runId={spawnedRunId} />
                          ) : (
                            <DecideButtons
                              sourceRunId={sourceRunId}
                              docRef={r.doc_ref}
                              onDecided={(runId) => setDecided((prev) => ({ ...prev, [r.doc_ref]: runId }))}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

// 건별 결재 버튼(승인/반려). 승인은 확인 1단계, 반려는 사유 입력 1단계(비가역 가드). 결정 성공 시 onDecided(spawned_run_id).
// 비-approver 는 부모(Inbox)가 열 자체를 숨기지만, 백엔드가 approval.decide 를 최종 강제한다.
function DecideButtons(props: { sourceRunId: string; docRef: string; onDecided: (runId: string) => void }): JSX.Element {
  const api = useApiClient();
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.decideApproval(
        {
          source_run_id: props.sourceRunId,
          doc_ref: props.docRef,
          decision,
          ...(decision === "reject" ? { reason: reason.trim() } : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: (res) => props.onDecided(res.spawned_run_id),
    onError: (e) => {
      // 이미 처리된 결재(다른 세션/중복)는 명시 표면화(조용한 false 금지). 그 외 코드도 표시.
      if (e instanceof ApiError && e.code === "APPROVAL_ALREADY_DECIDED") setErr("이미 처리된 결재입니다.");
      else setErr(e instanceof ApiError ? `${e.code} (${e.httpStatus})` : "결재 처리 실패");
    },
  });

  if (decide.isPending) return <span className="subtle">처리 중…</span>;

  if (mode === "reject") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="반려 사유(필수)"
          aria-label="반려 사유"
          style={{ fontSize: 13, padding: 6, minWidth: 160 }}
        />
        <button className="btn" type="button" disabled={reason.trim().length === 0} onClick={() => decide.mutate("reject")}>
          반려 제출
        </button>
        <button className="btn" type="button" onClick={() => { setMode("idle"); setReason(""); }}>취소</button>
        {err !== null && <span className="badge red">{err}</span>}
      </span>
    );
  }

  if (mode === "approve") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <span className="subtle">승인하시겠습니까?</span>
        <button className="btn" type="button" onClick={() => decide.mutate("approve")}>확인</button>
        <button className="btn" type="button" onClick={() => setMode("idle")}>취소</button>
        {err !== null && <span className="badge red">{err}</span>}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button className="btn" type="button" onClick={() => { setErr(null); setMode("approve"); }}>결재</button>
      <button className="btn" type="button" onClick={() => { setErr(null); setMode("reject"); }}>반려</button>
      {err !== null && <span className="badge red">{err}</span>}
    </span>
  );
}

// 결정 후 스폰된 처리 run 의 상태를 폴링(종결까지) + 실행 기록 딥링크. 비가역 클릭은 처리 run 이 수행(휴먼게이트 검증 대상).
function DecidedStatus({ runId }: { runId: string }): JSX.Element {
  const api = useApiClient();
  const run = useQuery<RunDetail>({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    refetchInterval: (q) => (q.state.data && RUN_TERMINAL.has(q.state.data.status) ? false : 3000),
  });
  const status = run.data?.status ?? "queued";
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <StatusBadge status={status} />
      {/* 크로스-뷰 딥링크: 결재 인박스 → 실행 기록(runTrace?run=<id>). hashWith 는 현재 뷰 유지라 직접 구성. */}
      <a href={`#runTrace?run=${runId}`} className="subtle" style={{ fontSize: 12 }}>실행 기록 보기</a>
    </span>
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
