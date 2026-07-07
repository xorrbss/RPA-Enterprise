import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ApiError } from "../../api/types";
import { errorLabel } from "../../components/badges";

// fan-out 버튼 — 수집 목록의 각 행을 검토 run(@human_task)으로 일괄 스폰(범용 '사람 확인' 인박스에 뜸). 행별 claim 으로
//   중복 스폰 차단(재클릭 시 already_fanned_out 스킵). 결정을 내리지 않고 검토 대기만 생성 → 사람이 인박스에서 승인/반려(휴먼 게이트).
//   N건 run 생성이라 확인 1단계. 결과(스폰/스킵 건수) 명시 표면화(조용한 false 금지).
export function FanOutButton({ sourceRunId }: { sourceRunId: string }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [enableAuto, setEnableAuto] = useState(false); // '앞으로 자동으로'(②) — 이 수집 시나리오 auto_fan_out 켜기.
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const run = useMutation({
    mutationFn: () => api.fanOutApprovals(sourceRunId, crypto.randomUUID(), enableAuto),
    onSuccess: (r) => {
      setConfirming(false);
      const autoNote = r.auto_enabled === true ? " 이후 수집분은 자동으로 보냅니다." : "";
      setMsg({
        tone: "green",
        text:
          (r.spawned_count > 0
            ? `${r.spawned_count}건을 검토 인박스로 보냈습니다${r.skipped_count > 0 ? ` (${r.skipped_count}건 제외).` : "."}`
            : `새로 보낼 항목이 없습니다${r.skipped_count > 0 ? ` (${r.skipped_count}건은 이미 보냈거나 처리 불가).` : "."}`) + autoNote,
      });
      void qc.invalidateQueries({ queryKey: ["human-tasks"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e) => {
      setConfirming(false);
      setMsg({ tone: "red", text: e instanceof ApiError ? errorLabel(e) : "검토 인박스 보내기 실패" });
    },
  });

  if (run.isPending) return <span className="subtle">검토 인박스로 보내는 중…</span>;
  if (confirming) {
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="subtle">이 목록의 모든 항목을 검토 인박스로 보낼까요?</span>
        <label className="checkbox-inline" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={enableAuto} onChange={(e) => setEnableAuto(e.target.checked)} aria-label="앞으로 자동으로 검토 인박스로 보내기" />
          <span className="subtle">앞으로 자동으로</span>
        </label>
        <button className="btn primary" type="button" onClick={() => run.mutate()}>확인</button>
        <button className="btn" type="button" onClick={() => setConfirming(false)}>취소</button>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button className="btn" type="button" onClick={() => { setMsg(null); setConfirming(true); }}>
        검토 인박스로 보내기
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
    </span>
  );
}
