import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError } from "../api/types";
import { COLLECT_SCENARIO_NAME, APPROVAL_ARTIFACT_TYPE, isHttpUrl, parseApprovalRows, summarize } from "../api/approval-inbox";
import { StatusBadge, errorLabel } from "../components/badges";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { ApprovalRow, RunArtifactItem, RunDetail, ScenarioItem } from "../api/types";

// 결재 처리 자동화 실행의 종결 상태(폴링 중단 기준). state-machine §1.
const RUN_TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

const POLL_MS = 10_000;

async function findCollectScenario(
  api: ReturnType<typeof useApiClient>,
): Promise<ScenarioItem | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await api.listScenarios({
      limit: 50,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const found = res.items.find((s) => s.name === COLLECT_SCENARIO_NAME);
    if (found !== undefined) return found;
    if (res.next_cursor === null) return null;
    cursor = res.next_cursor;
  }
  return null;
}

async function findApprovalArtifact(
  api: ReturnType<typeof useApiClient>,
  runId: string,
): Promise<RunArtifactItem | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await api.listRunArtifacts(runId, {
      limit: 50,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const found = res.items.find((a) => a.type === APPROVAL_ARTIFACT_TYPE);
    if (found !== undefined) return found;
    if (res.next_cursor === null) return null;
    cursor = res.next_cursor;
  }
  return null;
}

// 결재 인박스 — '하이웍스 결재 수집' 자동화 실행이 남긴 아티팩트(결재 목록)를 읽어 구조화 요약 + 목록 표시(읽기 전용).
// 발견 경로: listScenarios(이름 매칭) → listRuns(scenario_version_id, completed) 최신 → listRunArtifacts → getArtifact.
// Phase 2c 부터 approval.decide 권한 시 행별 [결재]/[반려] 버튼 노출(DecideButtons) — 되돌릴 수 없는 결재 처리를 위한 자동화 실행 생성(휴먼게이트). 백엔드가 최종 강제.
export function ApprovalInboxView(): JSX.Element {
  const api = useApiClient();

  const collect = useQuery({
    queryKey: ["scenarios", "approval-inbox-collector"],
    queryFn: () => findCollectScenario(api),
  });
  const collectScenario = collect.data ?? undefined;

  const runs = useQuery({
    queryKey: ["runs", "collect", collectScenario?.latest_version_id ?? ""],
    queryFn: () => api.listRuns({ scenario_version_id: collectScenario!.latest_version_id, status: "completed", limit: 1 }),
    enabled: collectScenario !== undefined,
    refetchInterval: POLL_MS,
  });
  const latestRun = runs.data?.items[0];

  const arts = useQuery({
    queryKey: ["run-artifacts", "approval-inbox", latestRun?.run_id ?? ""],
    queryFn: () => findApprovalArtifact(api, latestRun!.run_id),
    enabled: latestRun !== undefined,
  });
  const inboxArt = arts.data ?? undefined;

  const detail = useQuery({
    queryKey: ["artifact", inboxArt?.artifact_id ?? ""],
    queryFn: () => api.getArtifact(inboxArt!.artifact_id),
    enabled: inboxArt !== undefined,
    retry: false,
  });

  const recollect = collectScenario !== undefined ? <RunScenarioButton scenario={collectScenario} /> : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <p className="subtle" style={{ margin: 0 }}>
          최근 수집된 하이웍스 결재 목록입니다{latestRun?.as_of ? ` · 기준 ${latestRun.as_of}` : ""}. 결재 권한이 있으면 행별로 승인/반려할 수 있습니다.
        </p>
        {recollect}
      </div>
      <Body
        scenarios={collect}
        collect={collectScenario}
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
  if (scenarios.isError) return <ErrorState message="자동화 목록을 불러오지 못했습니다." onRetry={() => void scenarios.refetch()} />;
  if (collect === undefined) {
    return <EmptyState message={`'${COLLECT_SCENARIO_NAME}' 자동화가 아직 없습니다. 자동화 만들기에서 등록하세요.`} />;
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
      ? "결재 목록 조회 준비가 끝나지 않았거나 조회 권한이 없습니다."
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
  const api = useApiClient();
  const sum = summarize(rows);
  const can = useCan();
  const showActions = can("approval.decide"); // 비-approver 는 액션 열 숨김(백엔드가 최종 강제).
  // 이번 세션에서 결재한 문서 → 생성된 처리 자동화 실행 ID. 결정된 행은 버튼 대신 처리 상태(폴링)를 보인다.
  const [decided, setDecided] = useState<Record<string, string>>({});
  const [pendingOnly, setPendingOnly] = useState(false);
  // 일괄 승인(다중선택 + 배치 단일 확인). 되돌릴 수 없으므로 per-row 자동승인이 아니라 운영자가 행을 선택→1회 확인한다.
  //   반려는 건별 유지(사유 필수). 실패한 건은 행별로 표면화(조용한 false 금지).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  // 일괄 승인 결과 집계 — 완료 후 '성공 N건 · 실패 M건'을 한눈에(행별 에러를 스크롤로 찾지 않게). null = 미실행.
  const [bulkResult, setBulkResult] = useState<{ ok: number; failed: number } | null>(null);
  // 동기 이중제출 가드: bulkRunning(state)은 다음 렌더에야 true 라 같은 틱 연타를 못 막는다 → ref 로 즉시 차단.
  const bulkSubmitting = useRef(false);
  const pendingRows = rows.filter((r) => !["approved", "rejected", "completed"].includes(r.status));
  const visibleRows = pendingOnly ? pendingRows : rows;
  // 선택 가능: approver + 미결정 + 처리대기 행만(이미 결정/완료된 건은 일괄 대상 아님).
  const isSelectable = (r: ApprovalRow): boolean =>
    showActions && decided[r.doc_ref] === undefined && !["approved", "rejected", "completed"].includes(r.status);
  const toggle = (docRef: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docRef)) next.delete(docRef);
      else next.add(docRef);
      return next;
    });
  // 결정된 문서 = decided 기록 + selected 에서 제거(IRR-03): 이미 건별 결정된 건이 일괄 경로로 재제출돼
  //   APPROVAL_ALREADY_DECIDED(409)가 행(DecidedStatus 분기)에서 조용히 묻히는 것 방지 + 선택 카운트 정확 유지.
  const markDecided = (docRef: string, runId: string): void => {
    setDecided((prev) => ({ ...prev, [docRef]: runId }));
    setSelected((prev) => {
      if (!prev.has(docRef)) return prev;
      const next = new Set(prev);
      next.delete(docRef);
      return next;
    });
  };
  // 배치 승인: 선택 스냅샷을 순차 처리(건별 멱등키). 성공=decided 로 처리상태 전환, 실패=bulkErrors 로 행에 표면화.
  async function runBulkApprove(): Promise<void> {
    if (bulkSubmitting.current) return; // 동기 이중제출 가드(연타·Enter 반복 → 한 번만 실행)
    bulkSubmitting.current = true;
    setBulkConfirm(false);
    setBulkRunning(true);
    setBulkResult(null);
    let ok = 0;
    let failed = 0;
    try {
      for (const docRef of selected) {
        if (decided[docRef] !== undefined) continue; // 이미 결정된 건은 재제출 안 함(409 묻힘 방지, IRR-03)
        try {
          const res = await api.decideApproval({ source_run_id: sourceRunId, doc_ref: docRef, decision: "approve" }, crypto.randomUUID());
          markDecided(docRef, res.spawned_run_id);
          ok += 1;
          setBulkErrors((prev) => {
            const next = { ...prev };
            delete next[docRef];
            return next;
          });
        } catch (e) {
          failed += 1;
          setBulkErrors((prev) => ({ ...prev, [docRef]: e instanceof ApiError ? errorLabel(e) : "결재 처리 실패" }));
        }
      }
      setSelected(new Set());
      setBulkResult({ ok, failed });
    } finally {
      setBulkRunning(false);
      bulkSubmitting.current = false;
    }
  }
  return (
    <>
      <section className="panel" style={{ padding: 16, marginBottom: 16 }} aria-label="결재 요약">
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>결재 {sum.total}건</div>
        <Chips label="상태" entries={sum.byStatus} />
        <Chips label="유형" entries={sum.byType} />
      </section>
      <section className="panel queue-controls" aria-label="결재 업무 제어">
        <div>
          <strong>결재 업무</strong>
          <p className="subtle">결재 결정은 되돌릴 수 없으므로 건별 확인을 유지하고, 처리 대기 항목만 빠르게 좁힙니다.</p>
        </div>
        <div className="quick-actions">
          <button className="btn" type="button" aria-pressed={pendingOnly} onClick={() => setPendingOnly((v) => !v)}>
            처리 대기만 {pendingRows.length}
          </button>
          <button className="btn" type="button" disabled={pendingRows.length === 0} onClick={() => setPendingOnly(true)}>
            다음 결재 보기
          </button>
          {/* 일괄 승인: 선택 N건을 1회 배치 확인 후 순차 승인(되돌릴 수 없음 안내는 건별→배치 단위로 유지). 반려는 건별. */}
          {showActions && bulkRunning && <span className="subtle" role="status">일괄 승인 처리 중…</span>}
          {showActions && !bulkRunning && bulkResult !== null && (
            <span
              className={`badge ${bulkResult.failed > 0 ? "amber" : "green"}`}
              role={bulkResult.failed > 0 ? "alert" : "status"}
            >
              승인 완료 {bulkResult.ok}건{bulkResult.failed > 0 ? ` · 실패 ${bulkResult.failed}건(아래 표에서 확인)` : ""}
            </span>
          )}
          {showActions && !bulkRunning && !bulkConfirm && selected.size > 0 && (
            <button className="btn" type="button" onClick={() => setBulkConfirm(true)}>
              선택 {selected.size}건 일괄 승인
            </button>
          )}
          {showActions && bulkConfirm && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span className="badge red">선택 {selected.size}건을 일괄 승인합니다. 승인 후에는 되돌릴 수 없으며 자동화 실행 {selected.size}건이 생성됩니다.</span>
              <button className="btn" type="button" onClick={() => void runBulkApprove()}>일괄 승인 확인</button>
              <button className="btn" type="button" onClick={() => setBulkConfirm(false)}>취소</button>
            </span>
          )}
        </div>
      </section>
      <section className="panel" aria-label="결재 목록">
        <div className="panel-head"><h2>결재 목록</h2></div>
        <div className="panel-body">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {showActions && <th>선택</th>}
                  <th>기안자</th><th>유형</th><th>제목</th><th>상태</th><th>기안일</th><th>원문</th>
                  {showActions && <th>결재</th>}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const spawnedRunId = decided[r.doc_ref];
                  return (
                    <tr key={r.approval_id ?? r.doc_ref}>
                      {showActions && (
                        <td>
                          {isSelectable(r) ? (
                            <input
                              type="checkbox"
                              checked={selected.has(r.doc_ref)}
                              disabled={bulkRunning}
                              onChange={() => toggle(r.doc_ref)}
                              aria-label={`${r.title} 일괄 승인 선택`}
                            />
                          ) : null}
                        </td>
                      )}
                      <td>{r.drafter}</td>
                      <td>{r.doc_type}</td>
                      <td>{r.title}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{r.drafted_at ?? "—"}</td>
                      <td><DocRefLink docRef={r.doc_ref} /></td>
                      {showActions && (
                        <td>
                          {spawnedRunId !== undefined ? (
                            <DecidedStatus runId={spawnedRunId} />
                          ) : (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <DecideButtons
                                sourceRunId={sourceRunId}
                                docRef={r.doc_ref}
                                onDecided={(runId) => markDecided(r.doc_ref, runId)}
                              />
                              {bulkErrors[r.doc_ref] !== undefined && <span className="badge red">{bulkErrors[r.doc_ref]}</span>}
                            </span>
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

// 건별 결재 버튼(승인/반려). 승인은 확인 1단계, 반려는 사유 입력 1단계(되돌릴 수 없음 안내). 결정 성공 시 onDecided(spawned_run_id).
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
      else setErr(e instanceof ApiError ? errorLabel(e) : "결재 처리 실패");
    },
  });

  if (decide.isPending) return <span className="subtle">처리 중…</span>;

  if (mode === "reject") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <DocRefLink docRef={props.docRef} />
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
        <DocRefLink docRef={props.docRef} />
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

// 결정 후 생성된 처리 자동화 실행 상태를 폴링(종결까지) + 실행 기록 딥링크. 되돌릴 수 없는 클릭은 처리 자동화 실행이 수행(휴먼게이트 검증 대상).
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

// 결재 원문 링크 — 되돌릴 수 없는 결정 전 원문 확인 동선(승인/반려 단계·행에 노출). http(s) scheme만 새 탭 링크로
// (javascript:/data: XSS 가드); 그 외 scheme면 링크 대신 비활성 안내(조용한 false 금지). doc_ref scheme는 parser가
// 강제하지 않으므로 여기서 판정. rel=noopener noreferrer로 reverse-tabnabbing·Referer 누수 차단.
function DocRefLink({ docRef }: { docRef: string }): JSX.Element {
  if (!isHttpUrl(docRef)) return <span className="subtle" style={{ fontSize: 12 }}>원문 링크 불가</span>;
  return (
    <a href={docRef} target="_blank" rel="noopener noreferrer" className="subtle" style={{ fontSize: 12 }}>
      원문 보기 ↗
    </a>
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
