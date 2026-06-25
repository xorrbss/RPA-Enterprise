import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useCan } from "../api/permissions";
import { ConfirmDialog } from "./ConfirmDialog";
import { errorLabel } from "./badges";

// 운영자 명령 버튼: 클릭 → 포커스 트랩 확인 다이얼로그 → mutate(Idempotency-Key 1회 생성) → 관련 쿼리
// invalidate → 결과/오류 인라인. 조용한 실패 금지: 오류는 ApiError 코드로 표면화. action 지정 시 역할이
// 없으면 숨김(RBAC UI 게이팅; 최종 강제는 백엔드). inputLabel 지정 시 다이얼로그에 텍스트 입력(예: 담당자
// uuid)을 받아 run의 2번째 인자로 전달(빈 값이면 확인 비활성 — native prompt 대체).
// inputOptions 지정 시 datalist 제안(예: 담당자 디렉터리)을 붙인다 — value=배정값(sub), label=표시이름. 입력은
// 여전히 자유형이라 목록 밖 값도 허용(폴백 유지).
export function ActionButton(props: {
  label: string;
  confirmText: string;
  run: (idempotencyKey: string, input?: string) => Promise<unknown>;
  invalidateKeys: readonly QueryKey[];
  disabled?: boolean;
  action?: string;
  inputLabel?: string;
  inputOptional?: boolean; // true면 입력이 비어도 확인 가능(예: 이관 사유=선택). 기본 false(입력 필수).
  inputOptions?: readonly { value: string; label?: string }[];
  title?: string;
  successText?: string | null;
}): JSX.Element | null {
  const can = useCan();
  const listId = useId();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const mut = useMutation({
    mutationFn: (value: string | undefined) => props.run(crypto.randomUUID(), value),
    onSuccess: () => {
      setMsg(props.successText === null ? null : { tone: "green", text: props.successText ?? "완료" });
      for (const key of props.invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });
  // 권한 없는 명령은 표시하지 않는다(viewer 등 읽기 전용). 백엔드가 최종 강제하므로 보안 경계는 아니다.
  if (props.action !== undefined && !can(props.action)) return null;

  const needsInput = props.inputLabel !== undefined;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        className="btn"
        type="button"
        title={props.title}
        disabled={props.disabled === true || mut.isPending}
        onClick={() => {
          setInput("");
          setConfirming(true);
        }}
      >
        {mut.isPending ? "처리 중…" : props.label}
      </button>
      {/* 명령 성패를 SR에 전달(role=status=polite / alert=assertive) — '조용한 실패 금지'를 청각 채널에도 적용. */}
      {msg !== null && <span className={`badge ${msg.tone}`} role={msg.tone === "green" ? "status" : "alert"}>{msg.text}</span>}
      {confirming && (
        <ConfirmDialog
          title={props.confirmText}
          confirmDisabled={needsInput && props.inputOptional !== true && input.trim() === ""}
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
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                list={props.inputOptions !== undefined ? listId : undefined}
                autoFocus
              />
              {props.inputOptions !== undefined && (
                <datalist id={listId}>
                  {props.inputOptions.map((opt) => (
                    <option key={opt.value} value={opt.value} label={opt.label} />
                  ))}
                </datalist>
              )}
            </label>
          )}
        </ConfirmDialog>
      )}
    </span>
  );
}
