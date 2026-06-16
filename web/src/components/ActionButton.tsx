import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../api/types";
import { useCan } from "../api/permissions";
import { ConfirmDialog } from "./ConfirmDialog";

// 운영자 명령 버튼: 클릭 → 포커스 트랩 확인 다이얼로그 → mutate(Idempotency-Key 1회 생성) → 관련 쿼리
// invalidate → 결과/오류 인라인. 조용한 실패 금지: 오류는 ApiError 코드로 표면화. action 지정 시 역할이
// 없으면 숨김(RBAC UI 게이팅; 최종 강제는 백엔드). inputLabel 지정 시 다이얼로그에 텍스트 입력(예: 담당자
// uuid)을 받아 run의 2번째 인자로 전달(빈 값이면 확인 비활성 — native prompt 대체).
export function ActionButton(props: {
  label: string;
  confirmText: string;
  run: (idempotencyKey: string, input?: string) => Promise<unknown>;
  invalidateKeys: readonly QueryKey[];
  disabled?: boolean;
  action?: string;
  inputLabel?: string;
}): JSX.Element | null {
  const can = useCan();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const mut = useMutation({
    mutationFn: (value: string | undefined) => props.run(crypto.randomUUID(), value),
    onSuccess: () => {
      setMsg({ tone: "green", text: "완료" });
      for (const key of props.invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) =>
      setMsg({ tone: "red", text: e instanceof ApiError ? `${e.code} (${e.httpStatus})` : "실패" }),
  });
  // 권한 없는 명령은 표시하지 않는다(viewer 등 읽기 전용). 백엔드가 최종 강제하므로 보안 경계는 아니다.
  if (props.action !== undefined && !can(props.action)) return null;

  const needsInput = props.inputLabel !== undefined;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        className="btn"
        type="button"
        disabled={props.disabled === true || mut.isPending}
        onClick={() => {
          setInput("");
          setConfirming(true);
        }}
      >
        {mut.isPending ? "처리 중…" : props.label}
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
      {confirming && (
        <ConfirmDialog
          title={props.confirmText}
          confirmDisabled={needsInput && input.trim() === ""}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            const value = needsInput ? input.trim() : undefined;
            setConfirming(false);
            mut.mutate(value);
          }}
        >
          {needsInput && (
            <label style={{ display: "grid", gap: 4 }}>
              <span className="label">{props.inputLabel}</span>
              <input value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
            </label>
          )}
        </ConfirmDialog>
      )}
    </span>
  );
}
