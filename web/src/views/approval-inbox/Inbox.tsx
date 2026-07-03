import { useRef, useState } from "react";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { ApiError } from "../../api/types";
import { summarize } from "../../api/approval-inbox";
import { StatusBadge, errorLabel } from "../../components/badges";
import type { ApprovalRow } from "../../api/types";
import { DecideButtons, DecidedStatus, DocRefLink } from "./DecideButtons";

export function Inbox({ rows, sourceRunId }: { rows: readonly ApprovalRow[]; sourceRunId: string }): JSX.Element {
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
