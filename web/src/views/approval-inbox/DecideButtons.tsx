import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ApiError } from "../../api/types";
import { isHttpUrl } from "../../api/approval-inbox";
import { StatusBadge, errorLabel } from "../../components/badges";
import type { RunDetail } from "../../api/types";

// 결재 처리 자동화 실행의 종결 상태(폴링 중단 기준). state-machine §1.
const RUN_TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

// 건별 결재 버튼(승인/반려). 승인은 확인 1단계, 반려는 사유 입력 1단계(되돌릴 수 없음 안내). 결정 성공 시 onDecided(spawned_run_id).
// 비-approver 는 부모(Inbox)가 열 자체를 숨기지만, 백엔드가 approval.decide 를 최종 강제한다.
export function DecideButtons(props: { sourceRunId: string; docRef: string; onDecided: (runId: string) => void }): JSX.Element {
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
export function DecidedStatus({ runId }: { runId: string }): JSX.Element {
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
export function DocRefLink({ docRef }: { docRef: string }): JSX.Element {
  if (!isHttpUrl(docRef)) return <span className="subtle" style={{ fontSize: 12 }}>원문 링크 불가</span>;
  return (
    <a href={docRef} target="_blank" rel="noopener noreferrer" className="subtle" style={{ fontSize: 12 }}>
      원문 보기 ↗
    </a>
  );
}
