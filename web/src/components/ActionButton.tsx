import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../api/types";

// 운영자 명령 버튼: 확인 → mutate(Idempotency-Key 1회 생성) → 관련 쿼리 invalidate → 결과/오류 인라인.
// 조용한 실패 금지: 오류는 ApiError 코드로 표면화.
export function ActionButton(props: {
  label: string;
  confirmText: string;
  run: (idempotencyKey: string) => Promise<unknown>;
  invalidateKeys: readonly QueryKey[];
  disabled?: boolean;
}): JSX.Element {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const mut = useMutation({
    mutationFn: () => props.run(crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "완료" });
      for (const key of props.invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) =>
      setMsg({ tone: "red", text: e instanceof ApiError ? `${e.code} (${e.httpStatus})` : "실패" }),
  });
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        className="btn"
        type="button"
        disabled={props.disabled === true || mut.isPending}
        onClick={() => {
          if (window.confirm(props.confirmText)) mut.mutate();
        }}
      >
        {mut.isPending ? "처리 중…" : props.label}
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
    </span>
  );
}
